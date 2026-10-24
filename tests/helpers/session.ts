import { randomBytes } from "crypto";
import { vi } from "vitest";
import { acct, createUser, getLogin, getUser, normalizeEmail, PLAN_CREDITS, saveUser, sessionIds, sessionKey, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { createMember, withAccountTeamLock, writeMembership } from "@/lib/team";
import { updatePerson } from "@/lib/person";
import { legacyHomeFrom, ownerOf } from "@/lib/membership";
import { activeBrandIn, setActiveBrandIn } from "@/lib/brands";
import { newPersonId } from "@/lib/multi-org";
import { accountKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "@/lib/keys";
import { saveBrand, saveTask } from "@/lib/brand";
import { wsHandle } from "@/lib/ws-handle";
import { WS_HEADER } from "@/lib/ws-path";

const g = globalThis as unknown as { __testJar: Map<string, string>; __testAfter: Promise<unknown>[]; __testAfterInScope: boolean; __testHeaders?: Record<string, string>; __testWs?: string };

/** The cookie jar route handlers see. */
export const jar = () => g.__testJar;
/** No cookies at all: an anonymous visitor. */
export const signOut = () => { g.__testJar.clear(); g.__testWs = undefined; };
/**
 * The workspace handle the signed-in page sends with every API call (multi-workspace M2, rule 3811): `signIn` sets it to
 * the handle of the account the session opens, as the browser's `api()` helper sends its page's handle in `x-thakeen-ws`.
 * `json()` adds it to a request that names no workspace itself; `useWorkspace(null)` stops it, for a test of the 409.
 */
export const useWorkspace = (handle: string | null) => { g.__testWs = handle ?? undefined; };
/**
 * Act as this login: a real session record plus its cookie, exactly what login creates. Works for owners and members
 * alike (the record holds the login email). `imp` makes it a founder impersonation session, as the console writes it.
 *
 * The record has the M1 shape (multi-workspace M1): `{email, at, pid, acct}` from `sessionIds`, the person and the
 * account sign-in would pick. `legacyShape` writes a session from before R1, `{email, at}` (rule 2135); `acct` writes
 * the chosen account instead of the pick (rules 2111, 2119, 2122). An impersonation carries the ids `createSession`
 * writes for one (`sessionIds(email, { imp: true })`: the account the address owns and its owner), so a `p_` owner is
 * impersonated as production would; with `legacyShape` it is `{email, at, imp}` as before R1.
 */
export async function signIn(email: string, opts: { imp?: string; legacyShape?: boolean; acct?: string } = {}) {
  const token = randomBytes(32).toString("hex");
  // A key impersonation is tied to the current key as the console writes it (rule 429); WAITLIST_ADMIN_KEY must be set.
  const bind = opts.imp === "key" ? await (await import("@/lib/auth")).keyImpBinding() : null;
  const ids = opts.legacyShape ? {} : await sessionIds(email, { imp: !!opts.imp });
  const opens = opts.acct ?? (opts.legacyShape ? (await sessionIds(email)).acct : ids.acct);
  g.__testWs = opens ? wsHandle(opens) : undefined;
  const plain = { email, at: Date.now(), ...ids, ...(opts.acct && !opts.legacyShape ? { acct: opts.acct } : {}) };
  await db.set(sessionKey(token), opts.imp ? { email, at: Date.now(), imp: opts.imp, ...(bind ?? {}), ...ids } : plain, 3600);
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
let shadows = 0;

/**
 * Which persons the fixtures make (multi-workspace M1, rule 2132), read once. Default `"p"`: every owner and member is a
 * `p_` person (credentials on `person:{pid}` only, no legacy credential record), the shape release M2 signs up. With
 * `TEST_PERSONS=legacy` they are today's legacy persons (an owner's person id is its account id, a member's its
 * address), the shape production holds during M1. In both modes every person also gets a shadow membership
 * (`addShadowMembership`). A fixture that pins the legacy shape on purpose passes `{ legacy: true }`.
 */
export const PERSONS: "p" | "legacy" = process.env.TEST_PERSONS === "legacy" ? "legacy" : "p";
const pMode = (legacy: boolean) => PERSONS === "p" && !legacy;
/**
 * What a fixture may ask for. `legacy`: a legacy person whatever `PERSONS` says (a test that reads `user:{email}`'s
 * hash, `member:{email}`, R1's exact keys). `shadow: false`: no shadow membership, for a test that pins what happens to
 * a person who holds nothing else (a removal or a deletion that takes the login with it, a count of other workspaces).
 * `addressId` (owners only): an account made before R2 enable, its id its address, as every account production held
 * then and still holds after the flip (rule 3815); without it a new account's id is an opaque `a_` one.
 */
export type Fixture = { legacy?: boolean; shadow?: boolean; addressId?: boolean };
/** The marker text the shadow account's brand and task hold: a response that contains it read the wrong account. */
export const SHADOW_MARKER = "SHADOW-";

/**
 * A second, unrelated workspace for `pid` (multi-workspace M1, rule 2132): a fresh account `shadow{n}-{hex}@test.example`
 * (verified, trial) written with `db.set` only, so it is NOT in `users:all` and crons and console counts are unchanged,
 * and a plain `member` membership of `pid` in it through `writeMembership` (`mbr:`, the roster and `orgs:{pid}`; never the
 * legacy `member:` record, which stays the person's home). Its `acceptedAt` is one second after `homeAt` (the owned
 * account's creation, or the home membership's acceptance), so sign-in still picks the home account: owned first, then
 * the oldest membership. The shadow scope holds a brand and one pending task named `SHADOW-{n}`: a site that reads the
 * wrong account returns that text.
 */
export async function addShadowMembership(pid: PersonId, homeAt: string): Promise<{ aid: AccountId; marker: string }> {
  const k = ++shadows;
  const email = `shadow${k}-${randomBytes(3).toString("hex")}@test.example`;
  const aid = storedAccountId(email);
  const marker = `${SHADOW_MARKER}${k}`;
  const home = new Date(homeAt).getTime();
  const at = new Date(home + 1000).toISOString();
  // Created no later than the membership, so `membershipHolds` keeps it (a membership older than its account is refused).
  const createdAt = new Date(home).toISOString();
  const account: User = {
    id: email,
    email,
    name: "Shadow",
    phone: "",
    plan: "trial",
    credits: PLAN_CREDITS.trial,
    trialEnds: new Date(home + 3 * 864e5).toISOString(),
    createdAt,
    lang: "ar",
    emailVerifiedAt: createdAt,
  };
  await db.set(accountKey.user(aid), account);
  await withAccountTeamLock(aid, () => writeMembership(aid, pid, { aid, pid, role: "member", acceptedAt: at, invitedBy: email }, { home: false, teamLocked: true }));
  await Promise.all([
    saveBrand(email, { name: marker, website: "", industry: marker, dialect: "saudi", languages: ["ar"], tone: "", products: marker, audience: "", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "", updatedAt: createdAt }),
    saveTask(email, { id: `shadow${k}${randomBytes(4).toString("hex")}`, type: "social", channel: "instagram", title: marker, body: marker, status: "pending", createdAt, lang: "ar" }, true),
  ]);
  return { aid, marker };
}

/**
 * Stamp `emailVerifiedAt` on an existing owner, as the verify route does once the code matches (rule 751: an owner
 * without it reads as signed out). For fixtures that build the owner by hand (`createUser`, the signup route) and then
 * sign in. Through `updatePerson` (multi-workspace M1, reconciliation 11): the owner person and every account it owns
 * get the stamp, as production writes it. An account whose owner no record holds (a hand-built `ownerPid`) gets the
 * stamp directly.
 */
export async function markVerified(email: string): Promise<User> {
  // With `MULTI_ORG` on (M2 test files) a new owner's account is an opaque `a_` id: found through the login index.
  const byLogin = async () => { const l = await getLogin(email); return l?.kind === "owner" ? l.user : null; };
  const stored = ((await getUser(email)) ?? (await byLogin()))!;
  const at = new Date().toISOString();
  await updatePerson(ownerOf(stored), { emailVerifiedAt: at });
  const after = (await getUser(acct(stored)))!;
  if (after.emailVerifiedAt) return after;
  after.emailVerifiedAt = at;
  await saveUser(after);
  return after;
}

/**
 * A real owner account. Verified by default (`emailVerifiedAt` saved), because an unverified owner reads as signed out
 * (rule 751); pass `{ verified: false }` for the account `createUser` makes, which still has to prove its address.
 * Multi-workspace M1: in `"p"` mode (`PERSONS`) the owner is a `p_` person (`createUser(..., { person: "p" })`: the
 * account at its address names it in `ownerPid`, the credentials live on `person:`); `{ legacy: true }` or
 * `TEST_PERSONS=legacy` makes today's legacy owner. Either way the owner also holds a shadow membership.
 */
export async function newUser(prefix = "u", { verified = true, legacy = false, shadow = true, addressId = false }: Fixture & { verified?: boolean } = {}): Promise<User> {
  const u = await createUser({ email: `${prefix}${++n}-${randomBytes(3).toString("hex")}@test.example`, name: "Test", phone: "", password: "abc12345", lang: "ar" }, { person: pMode(legacy) ? "p" : "legacy", ...(addressId ? { opaque: false } : {}) });
  if (shadow) await addShadowMembership(ownerOf(u), u.createdAt);
  return verified ? markVerified(u.email) : u;
}

/**
 * An owner account whose id is opaque (`a_…`, rule 1985): the shape every new account has once release R2 turns
 * `OPAQUE_IDS` on. Its record lives at `user:{id}`, never at its address, so a key built from `u.email` misses it.
 * Verified like `newUser`, and a `p_` person with a shadow membership like `newUser`.
 */
export async function newOpaqueUser(prefix = "o", { verified = true, legacy = false, shadow = true }: Fixture & { verified?: boolean } = {}): Promise<User> {
  const u = await createUser({ email: `${prefix}${++n}-${randomBytes(3).toString("hex")}@test.example`, name: "Test", phone: "", password: "abc12345", lang: "ar" }, { opaque: true, person: pMode(legacy) ? "p" : "legacy" });
  if (shadow) await addShadowMembership(ownerOf(u), u.createdAt);
  return verified ? markVerified(acct(u)) : u;
}

/**
 * A real member login in `owner`'s account (src/lib/team.ts `createMember`, no seat check). Sign in with
 * `signIn(email)`. Multi-workspace M1: in `"p"` mode a `p_` person with a membership row and no legacy `member:` record;
 * `{ legacy: true }` or `TEST_PERSONS=legacy` makes today's legacy member (record plus roster entry, person id = its
 * address). Either way the member also holds a shadow membership, accepted one second after the home one.
 */
export async function newMember(owner: User, role: "admin" | "member" = "member", prefix = "m", { legacy = false, shadow = true }: Fixture = {}): Promise<{ email: string; password: string; pid: PersonId }> {
  const email = `${prefix}${++n}-${randomBytes(3).toString("hex")}@test.example`;
  const password = "abc12345";
  const input = { email, name: `Member ${n}`, password, lang: "ar" as const, role, invitedBy: owner.email };
  const p = pMode(legacy);
  const pid = storedPersonId(p ? newPersonId() : normalizeEmail(email));
  const m = await createMember(acct(owner), p ? { ...input, invitedByPid: ownerOf(owner) } : input, p ? { pid } : {});
  if (shadow) await addShadowMembership(pid, m.acceptedAt);
  return { email, password, pid };
}

/**
 * The active brand a sign-in address works in (rule 2119), seeded and read the way `resolveSession` reads it: the person
 * and the account the login resolves to, and the legacy per-login key only when that account is the person's home
 * (`legacyHomeFrom`). The same answer for a `p_` person and a legacy one, so a brand-scope test runs in both fixture modes.
 */
async function brandSeat(email: string): Promise<{ pid: PersonId; aid: AccountId; homeLogin: string | null }> {
  const l = await getLogin(email);
  if (!l?.acct) throw new Error("brandSeat: the address signs in to no workspace");
  const [rawUser, rawMember] = await Promise.all([db.get<unknown>(accountKey.user(l.pid)), db.get<unknown>(accountKey.member(l.pid))]);
  return { pid: l.pid, aid: l.acct, homeLogin: legacyHomeFrom(l.pid, rawUser, rawMember) === l.acct ? normalizeEmail(email) : null };
}
/** Choose the active brand of the address's person in its workspace (`setActiveBrandIn`, as the brands route does). */
export async function seedActiveBrand(email: string, id: string): Promise<void> {
  const s = await brandSeat(email);
  await setActiveBrandIn(s.pid, s.aid, id, s.homeLogin);
}
/** The active brand of the address's person in its workspace (`activeBrandIn`). */
export async function readActiveBrand(email: string): Promise<string> {
  const s = await brandSeat(email);
  return activeBrandIn(s.pid, s.aid, s.homeLogin);
}

/**
 * The founder write routes that ask a reason (rule 1185). The console always sends one, so a test body without a
 * `reason` key gets this one; a test that checks the refusal sends `reason` itself (an empty string, or too short).
 */
const REASON_ROUTES = /^\/api\/admin\/(users\/[^/?]+|plan|topups|payments\/[^/?]+|partners)(\?|$)/;
export const TEST_REASON = "test reason";
const withTestReason = (url: string, method: string, body: unknown) =>
  method === "POST" && REASON_ROUTES.test(url) && body && typeof body === "object" && !Array.isArray(body) && !("reason" in body) ? { ...body, reason: TEST_REASON } : body;
/** A JSON request as the signed-in page sends it: with its workspace handle (`useWorkspace`) unless `headers` names one. */
export const json = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://nashr.test${url}`, { method, headers: { "content-type": "application/json", ...(g.__testWs && !(WS_HEADER in headers) ? { [WS_HEADER]: g.__testWs } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(withTestReason(url, method, body)) });
export const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
