import { cookies, headers } from "next/headers";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { db } from "./db";

export type Plan = "trial" | "starter" | "pro" | "agency" | "enterprise";

export type User = {
  email: string;
  name: string;
  phone: string;
  passHash: string;
  plan: Plan;
  credits: number;
  trialEnds: string; // ISO
  createdAt: string; // ISO
  lang: "ar" | "en";
  /** YYYY-MM of the last monthly credit renewal (paid plans). */
  renewedAt?: string;
  /** Set by the admin: login and all API access blocked. */
  suspended?: boolean;
  /** ISO time of the last password change: every session issued before it is dead (src/lib/auth.ts `currentUser`). */
  sessionsAfter?: string;
  /** Runtime only: storage scope of the active brand (email for the default brand). Never persisted. */
  scope?: string;
  brandId?: string;
};
export const sc = (u: User) => u.scope ?? u.email;

export const PLAN_CREDITS: Record<Plan, number> = { trial: 50, starter: 200, pro: 700, agency: 2000, enterprise: 10000 };
/** Membership test for a plan name from a request body. Not `in`: that walks the prototype chain (see `isTaskType`). */
export const PLANS = Object.keys(PLAN_CREDITS) as Plan[];
export const isPlan = (v: unknown): v is Plan => typeof v === "string" && (PLANS as string[]).includes(v);
const SESSION_TTL = 60 * 60 * 24 * 30;
const COOKIE = "nashr_session";

/** Whole days left in a trial (0 when it has ended). Server-side: the clock is read per request here, never inside a component. */
/**
 * An ended trial may not spend. Written once because it was written five times: the image route and the chat's
 * generate_image tool were the two spending paths that never got a copy, so an expired trial went on paying for
 * fal.ai and Anthropic calls indefinitely.
 */
export const trialOver = (u: Pick<User, "plan" | "trialEnds">) => u.plan === "trial" && new Date(u.trialEnds) < new Date();

export const trialDaysLeft = (trialEnds: string) => Math.max(0, Math.ceil((new Date(trialEnds).getTime() - Date.now()) / 864e5));

/** One password rule for signup, change and reset: 8+ characters with a letter and a digit. */
export const strongPassword = (pw: string) => pw.length >= 8 && /\p{L}/u.test(pw) && /\d/.test(pw);
/** Emails become part of Redis keys (prefix:{scope}[:id], extra brands are email#brandId), so ":" and "#" could make two accounts share keys. */
export const validEmail = (e: string) => /^[^\s@:#]+@[^\s@:#]+\.[^\s@:#]+$/.test(e) && e.length <= 120;

export function normalizeEmail(e: string) {
  return e.trim().toLowerCase();
}

export function normalizePhone(p: string) {
  // Keep digits and leading +. Saudi numbers like 05xxxxxxxx become +9665xxxxxxxx.
  let d = p.replace(/[^\d+]/g, "");
  if (d.startsWith("00")) d = "+" + d.slice(2);
  if (/^05\d{8}$/.test(d)) d = "+966" + d.slice(1);
  if (/^5\d{8}$/.test(d)) d = "+966" + d;
  if (!d.startsWith("+")) d = "+" + d;
  return d;
}

export async function getUser(email: string): Promise<User | null> {
  return db.get<User>(`user:${normalizeEmail(email)}`);
}

export async function saveUser(u: User) {
  const { scope: _s, brandId: _b, ...persist } = u;
  void _s; void _b;
  await db.set(`user:${u.email}`, persist);
  await db.sadd("users:all", u.email);
}

export async function createUser(input: { email: string; name: string; phone: string; password: string; lang: "ar" | "en" }): Promise<User> {
  const email = normalizeEmail(input.email);
  const now = new Date();
  const u: User = {
    email,
    name: input.name.trim().slice(0, 80),
    phone: input.phone.trim() ? normalizePhone(input.phone) : "",
    passHash: await bcrypt.hash(input.password, 10),
    plan: "trial",
    credits: PLAN_CREDITS.trial,
    trialEnds: new Date(now.getTime() + 3 * 864e5).toISOString(),
    createdAt: now.toISOString(),
    lang: input.lang,
  };
  await saveUser(u);
  return u;
}

export async function verifyPassword(u: User, password: string) {
  return bcrypt.compare(password, u.passHash);
}

/** A session record. Sessions written before 2026-09-18 are a bare email with no issue time, which counts as "issued at 0". */
type SessionRec = string | { email: string; at: number };
const sessionOf = (rec: SessionRec | null) => (!rec ? null : typeof rec === "string" ? { email: rec, at: 0 } : rec);

/**
 * Sign every device out: sessions issued before this moment stop working at their next request. Called whenever the
 * password changes, so a stolen cookie does not outlive the password it was obtained with. Only marks the record: the
 * caller saves it, inside the user lock.
 */
export function revokeSessions(u: User) {
  u.sessionsAfter = new Date().toISOString();
}

/**
 * Cookie options every session-bearing cookie shares.
 *
 * `Secure` describes the TRANSPORT, not the build. It used to be `process.env.NODE_ENV === "production"`, which says
 * nothing about how the response travels: a production build served over plain http marks the cookie Secure, every
 * conforming client throws it away, and nobody can log in — with no error anywhere, because the request simply
 * arrives without a cookie. That is what happened to the end-to-end suite on WebKit, which (unlike Chromium, and
 * unlike WebKit on macOS) does not treat http://localhost as a trustworthy origin.
 *
 * So: Secure unless this is plain http to the loopback interface, which is the only case where no real traffic is at
 * risk. A deployment on a real host over http still gets Secure and still refuses to work, which is the right way for
 * that mistake to fail — loudly and locally, never by quietly dropping the flag on live traffic.
 */
export async function sessionCookie(maxAge: number) {
  const h = await headers();
  const host = (h.get("host") ?? "").toLowerCase();
  const plainHttp = (h.get("x-forwarded-proto") ?? "http") === "http";
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return { httpOnly: true, sameSite: "lax", secure: !(plainHttp && loopback), path: "/", maxAge } as const;
}

export async function createSession(email: string, ttlSeconds: number = SESSION_TTL) {
  const token = randomBytes(32).toString("hex");
  await db.set(`session:${token}`, { email, at: Date.now() } satisfies SessionRec, ttlSeconds);
  const jar = await cookies();
  jar.set(COOKIE, token, await sessionCookie(ttlSeconds));
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await db.del(`session:${token}`);
  jar.delete(COOKIE);
}

export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  const s = sessionOf(await db.get<SessionRec>(`session:${token}`));
  if (!s) return null;
  const email = s.email;
  const u = await getUser(email);
  if (!u || u.suspended) return null;
  if (u.sessionsAfter && s.at < new Date(u.sessionsAfter).getTime()) return null; // issued before the last password change
  const { activeBrandId, scopeFor } = await import("./brands");
  u.brandId = await activeBrandId(email);
  u.scope = scopeFor(email, u.brandId);
  return u;
}

/** Founder accounts: ADMIN_EMAILS env (comma-separated) with the founder's own email as the default. */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "hejazy@gmail.com").split(",").map((e) => normalizeEmail(e)).filter(Boolean);
}
export const isFounder = (email: string | undefined | null) => !!email && adminEmails().includes(normalizeEmail(email));

/** API access: admin key (header or cookie, never the URL: query strings end up in logs and history) or a logged-in founder account. */
export async function isAdmin(req: Request) {
  const key = process.env.WAITLIST_ADMIN_KEY;
  if (key) {
    const { sameSecret, allow, clientIp } = await import("./rate");
    const given = req.headers.get("x-admin-key");
    if (given !== null) {
      // Key guesses sent as a header are throttled like the login form.
      if (!(await allow(`adminhdr:${clientIp(req)}`, 30, 900))) return false;
      if (sameSecret(given, key)) return true;
    }
    const jar = await cookies();
    if (sameSecret(jar.get("nashr_admin")?.value, key)) return true;
  }
  const u = await currentUser();
  return isFounder(u?.email);
}

/** Page access: admin cookie or a logged-in founder account. */
export async function isAdminCookie() {
  const key = process.env.WAITLIST_ADMIN_KEY;
  if (key) {
    const { sameSecret } = await import("./rate");
    const jar = await cookies();
    if (sameSecret(jar.get("nashr_admin")?.value, key)) return true;
  }
  const u = await currentUser();
  return isFounder(u?.email);
}
