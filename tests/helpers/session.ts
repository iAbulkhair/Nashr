import { randomBytes } from "crypto";
import { createUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";

const g = globalThis as unknown as { __testJar: Map<string, string>; __testAfter: Promise<unknown>[]; __testAfterInScope: boolean; __testHeaders?: Record<string, string> };

/** The cookie jar route handlers see. */
export const jar = () => g.__testJar;
/** No cookies at all: an anonymous visitor. */
export const signOut = () => g.__testJar.clear();
/** Act as this account: a real session record plus its cookie, exactly what login creates. */
export async function signIn(email: string) {
  const token = randomBytes(32).toString("hex");
  await db.set(`session:${token}`, { email, at: Date.now() }, 3600);
  g.__testJar.clear();
  g.__testJar.set("nashr_session", token);
  return token;
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
export async function newUser(prefix = "u"): Promise<User> {
  return createUser({ email: `${prefix}${++n}-${randomBytes(3).toString("hex")}@test.example`, name: "Test", phone: "", password: "abc12345", lang: "ar" });
}

export const json = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://nashr.test${url}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
export const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
