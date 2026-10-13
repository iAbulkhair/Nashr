import { randomBytes } from "crypto";
import { vi } from "vitest";
import { createUser, getUser, saveUser, sessionKey, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { createMember } from "@/lib/team";

const g = globalThis as unknown as { __testJar: Map<string, string>; __testAfter: Promise<unknown>[]; __testAfterInScope: boolean; __testHeaders?: Record<string, string> };

/** The cookie jar route handlers see. */
export const jar = () => g.__testJar;
/** No cookies at all: an anonymous visitor. */
export const signOut = () => g.__testJar.clear();
/**
 * Act as this login: a real session record plus its cookie, exactly what login creates. Works for owners and members
 * alike (the record holds the login email). `imp` makes it a founder impersonation session, as the console writes it.
 */
export async function signIn(email: string, opts: { imp?: string } = {}) {
  const token = randomBytes(32).toString("hex");
  // A key impersonation is tied to the current key as the console writes it (rule 429); WAITLIST_ADMIN_KEY must be set.
  const bind = opts.imp === "key" ? await (await import("@/lib/auth")).keyImpBinding() : null;
  await db.set(sessionKey(token), opts.imp ? { email, at: Date.now(), imp: opts.imp, ...(bind ?? {}) } : { email, at: Date.now() }, 3600);
  g.__testJar.clear();
  g.__testJar.set("thakeen_session", token);
  return token;
}
/**
 * The cookies the console's Impersonate action leaves next to the impersonation session: the founder's own live session
 * saved in `thakeen_return`, and `thakeen_impersonate` naming the account. Only these helper cookies are added, so the
 * caller's `thakeen_session` stays. Stubs ADMIN_EMAILS to `founder` (vi.unstubAllEnvs undoes it).
 *
 * Attribution never reads them (src/lib/actor.ts `byOf` reads the session's `actor` only): tests use this to prove the
 * cookies alone make nobody support. A real support session is `signIn(email, { imp: founder })`.
 */
export async function supportAccess(email: string, founder = "support-founder@test.example") {
  vi.stubEnv("ADMIN_EMAILS", founder);
  const token = randomBytes(32).toString("hex");
  await db.set(sessionKey(token), { email: founder, at: Date.now() }, 3600);
  g.__testJar.set("thakeen_return", token);
  g.__testJar.set("thakeen_impersonate", email);
  return token;
}
/**
 * Open a founder-console key session (what POST /api/admin/login does after a right key) and add its `nashr_admin`
 * cookie to the jar, keeping any other cookie. WAITLIST_ADMIN_KEY must be set. The cookie value is a random id.
 */
export async function adminSignIn() {
  const { createAdminSession } = await import("@/lib/auth");
  await createAdminSession();
  return g.__testJar.get("nashr_admin")!;
}
/** Wait for work a handler scheduled with `after()`. */
export const settle = async () => { await Promise.all(g.__testAfter.splice(0)); };

/** Run `fn` with these request headers visible to `headers()`, which decides whether a cookie is marked Secure. */
export async function withHeaders<T>(h: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = g.__testHeaders;
  g.__testHeaders = h;
  try { return await fn(); } finally { g.__testHeaders = before; }
}

/**
 * Run `fn` as if there were no request in progress, so `after()` throws exactly as it does in production.
 *
 * A cron chain continues itself from work scheduled by the previous hop, which is no longer inside a request. The
 * code has a fallback for that — `try { after(kick); } catch { void kick(); }` — and the mock's unconditional accept
 * meant the fallback had never been executed by a test.
 */
export async function outsideRequestScope<T>(fn: () => Promise<T>): Promise<T> {
  g.__testAfterInScope = false;
  try { return await fn(); } finally { g.__testAfterInScope = true; }
}

let n = 0;
/**
 * Stamp `emailVerifiedAt` on an existing owner, as the verify route does once the code matches (rule 751: an owner
 * without it reads as signed out). For fixtures that build the owner by hand (`createUser`, the signup route) and then
 * sign in. A plain read-modify-write: the account is brand new and nobody else holds it.
 */
export async function markVerified(email: string): Promise<User> {
  const stored = (await getUser(email))!;
  stored.emailVerifiedAt = new Date().toISOString();
  await saveUser(stored);
  return stored;
}

/**
 * A real owner account. Verified by default (`emailVerifiedAt` saved), because an unverified owner reads as signed out
 * (rule 751); pass `{ verified: false }` for the account `createUser` makes, which still has to prove its address.
 */
export async function newUser(prefix = "u", { verified = true }: { verified?: boolean } = {}): Promise<User> {
  const u = await createUser({ email: `${prefix}${++n}-${randomBytes(3).toString("hex")}@test.example`, name: "Test", phone: "", password: "abc12345", lang: "ar" });
  return verified ? markVerified(u.email) : u;
}

/**
 * A real member login in `owner`'s account (src/lib/team.ts `createMember`: member record plus roster entry, no seat
 * check). Sign in with `signIn(email)`.
 */
export async function newMember(owner: User, role: "admin" | "member" = "member", prefix = "m"): Promise<{ email: string; password: string }> {
  const email = `${prefix}${++n}-${randomBytes(3).toString("hex")}@test.example`;
  const password = "abc12345";
  await createMember(owner.email, { email, name: `Member ${n}`, password, lang: "ar", role, invitedBy: owner.email });
  return { email, password };
}

/**
 * The founder write routes that ask a reason (rule 1185). The console always sends one, so a test body without a
 * `reason` key gets this one; a test that checks the refusal sends `reason` itself (an empty string, or too short).
 */
const REASON_ROUTES = /^\/api\/admin\/(users\/[^/?]+|plan|topups|payments\/[^/?]+|partners)(\?|$)/;
export const TEST_REASON = "test reason";
const withTestReason = (url: string, method: string, body: unknown) =>
  method === "POST" && REASON_ROUTES.test(url) && body && typeof body === "object" && !Array.isArray(body) && !("reason" in body) ? { ...body, reason: TEST_REASON } : body;
export const json = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://nashr.test${url}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(withTestReason(url, method, body)) });
export const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
