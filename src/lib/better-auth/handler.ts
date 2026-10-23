import { createHmac } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { destroySession, getLogin, normalizeEmail } from "@/lib/auth";
import { baOn, baSecret } from "@/lib/auth-engine";
import { SESSION_COOKIE, readCookie } from "@/lib/cookie-names";
import { globalKey } from "@/lib/keys";
import { verifyOwed } from "@/lib/login-finish";
import { MAGIC_TOKEN } from "@/lib/magic-token";
import { mailReady } from "@/lib/notify";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { captchaRefusal } from "@/lib/turnstile";
import { magicEligible } from "./magic";
import { BA_BASE_PATH, BA_PASSWORD_MAX, BA_SESSION_COOKIE, getAuth } from "./server";

/**
 * The wrapper around better-auth's handler (`/api/better-auth/[...all]`, rules 3410, 3412-3415). better-auth never
 * sees the browser's request and the browser never sees better-auth's answer as it is:
 *
 * - Off switch first: 404 before reading the body or the store (rule 3400).
 * - An allow-list of method + path (rule 3413). An upgrade that adds an endpoint adds nothing reachable.
 * - Thakeen's rate limits before better-auth reads anything (rules 3414, 3415); better-auth's limiter is off.
 * - One cookie (rule 3410): the request reaches better-auth with only `thakeen.session_token`, signed from the browser's
 *   `thakeen_session` with `BETTER_AUTH_SECRET`; every `Set-Cookie` better-auth answers is dropped. The browser cookie is
 *   written by `issueSession` (through `cookies()`, merged into this response by Next) and cleared by `destroySession`.
 * - No session token in any answer (rule 3412): `token` goes from sign-in, the whole session row is cut to its public
 *   fields, and errors come back in the legacy shape `{ok: false, error}` the log-in form already reads.
 */

/** `password` and `magic` start a sign-in; `read` routes only read (or end) the caller's own session. */
type Route = { method: "GET" | "POST"; kind: "password" | "magic" | "read" };
/** Every path better-auth answers through HTTP. Anything else is 404, before better-auth runs. */
export const BA_ROUTES: Readonly<Record<string, Route>> = {
  "/sign-in/email": { method: "POST", kind: "password" },
  "/sign-in/magic-link": { method: "POST", kind: "magic" },
  "/get-session": { method: "GET", kind: "read" },
  "/sign-out": { method: "POST", kind: "read" },
  "/list-accounts": { method: "GET", kind: "read" },
};

const notFound = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
const BODY_MAX = 4096;
/** A cookie value worth signing: what `createSession` writes (64 hex) or an older token shape; nothing with separators. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
/** The address check of POST /api/auth/forgot, which the link request mirrors. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The cookie better-auth reads, in better-call's signed format (`value.base64(HMAC-SHA256)`, URI-encoded). */
export function signedSessionCookie(token: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(token).digest("base64");
  return `${BA_SESSION_COOKIE}=${encodeURIComponent(`${token}.${sig}`)}`;
}

/** Fields of better-auth's session row a page may see. The token, IP and user agent never leave the server. */
const publicSession = (s: Record<string, unknown>) => ({ id: s.id, userId: s.userId, expiresAt: s.expiresAt, createdAt: s.createdAt, updatedAt: s.updatedAt });
const publicUser = (u: Record<string, unknown>) => ({ id: u.id, email: u.email, name: u.name, emailVerified: u.emailVerified, image: u.image ?? null, createdAt: u.createdAt, updatedAt: u.updatedAt });
const publicAccount = (a: Record<string, unknown>) => ({ id: a.id, providerId: a.providerId, accountId: a.providerId === "credential" ? undefined : a.accountId, createdAt: a.createdAt, updatedAt: a.updatedAt });
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A better-auth error as the legacy answer. A gate refusal (src/lib/better-auth/gate.ts) already carries it. */
export function legacyError(status: number, body: unknown): NextResponse {
  if (isRecord(body) && body.ok === false && typeof body.error === "string") {
    const out: Record<string, unknown> = { ok: false, error: body.error };
    if (typeof body.until === "string") out.until = body.until;
    if (body.mfa === true) out.mfa = true;
    return NextResponse.json(out, { status: status === 403 ? 403 : 401 });
  }
  if (status === 403) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (status === 429) return retryLater({ ok: false, error: "slow_down" }, 900);
  if (status >= 500) return NextResponse.json({ ok: false, error: "failed" }, { status: 500 });
  // A wrong password, an unknown address, a malformed address, a body better-auth refused: one answer, as POST /api/auth/login gives.
  return NextResponse.json({ ok: false, error: "invalid" }, { status: 401 });
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => "");
  if (text.length > BODY_MAX) return null;
  try {
    const v = JSON.parse(text || "{}") as unknown;
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The headers better-auth sees: the browser's origin headers and nothing else. No address header: src/lib/rate.ts stays
 * the only reader of one (rule 773), better-auth's limiter is off, and the session row's `ipAddress` is projected empty
 * and never stored.
 */
function forwardHeaders(req: Request): Headers {
  const h = new Headers();
  for (const name of ["origin", "referer", "user-agent", "accept-language"]) {
    const v = req.headers.get(name);
    if (v) h.set(name, v);
  }
  return h;
}

/** The request better-auth sees: `forwardHeaders`, only better-auth's own cookie, a rebuilt JSON body. */
async function inner(req: Request, path: string, secret: string, body: Record<string, unknown> | null): Promise<Request> {
  const h = forwardHeaders(req);
  const token = readCookie(await cookies(), SESSION_COOKIE);
  if (token && TOKEN_SHAPE.test(token)) h.set("cookie", signedSessionCookie(token, secret));
  const url = new URL(req.url);
  const target = new URL(BA_BASE_PATH + path, url.origin);
  if (req.method === "GET") return new Request(target, { method: "GET", headers: h });
  h.set("content-type", "application/json");
  return new Request(target, { method: "POST", headers: h, body: JSON.stringify(body ?? {}) });
}

/** A sign-in that ended in a session: the answer of POST /api/auth/login, plus better-auth's public user fields. */
async function signedIn(email: string, user: Record<string, unknown>): Promise<NextResponse> {
  const l = await getLogin(email);
  const verify = l ? verifyOwed(l) : undefined;
  return NextResponse.json({ ok: true, ...(verify === undefined ? {} : { verify }), redirect: false, user: publicUser(user) }, { headers: { "cache-control": "no-store" } });
}

/**
 * `POST /sign-in/magic-link` (rule 3415): the reset link's shape (POST /api/auth/forgot). The address check, the per-IP
 * bucket, Turnstile when configured, the per-address bucket, then better-auth only for an address `magicEligible` lets
 * in and only while mail can go out. Every other case gets the same answer, so the form never tells whether an address
 * has an account; `mail` says whether delivery is configured at all, as the reset form reads it.
 */
async function magicRequest(req: Request, auth: NonNullable<ReturnType<typeof getAuth>>, secret: string): Promise<Response> {
  const mail = mailReady();
  const sent = () => NextResponse.json({ ok: true, status: true, mail }, { headers: { "cache-control": "no-store" } });
  const raw = await readBody(req);
  const email = normalizeEmail(typeof raw?.email === "string" ? raw.email : "");
  if (!raw || !EMAIL_SHAPE.test(email)) return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  const lang = raw.lang === "en" ? "en" : "ar";
  // The per-IP limit first: every Turnstile token costs an outbound siteverify call (rule 427).
  if (!(await allow(globalKey.magicIpBucket(clientIp(req)), 8, 900))) return sent();
  const refused = await captchaRefusal(req, raw.turnstile);
  if (refused) return refused;
  if (!(await allow(globalKey.magicEmailBucket(email), 3, 900))) return sent();
  if (mail && magicEligible(await getLogin(email))) {
    // Only the address and the language go to better-auth: no `callbackURL` (the mailed link is Thakeen's own, with the
    // token in the fragment), no `name` (sign-up is off), no metadata from the browser.
    await auth.handler(await inner(req, "/sign-in/magic-link", secret, { email, metadata: { lang } }));
  }
  return sent();
}

export async function handleBetterAuth(req: Request): Promise<Response> {
  if (!baOn()) return notFound();
  const secret = baSecret();
  const auth = getAuth();
  if (!secret || !auth) return notFound();
  const pathname = new URL(req.url).pathname;
  if (!pathname.startsWith(BA_BASE_PATH + "/")) return notFound();
  const path = pathname.slice(BA_BASE_PATH.length);
  const route = Object.hasOwn(BA_ROUTES, path) ? BA_ROUTES[path] : undefined;
  if (!route || route.method !== req.method) return notFound();
  if (route.kind === "magic") return magicRequest(req, auth, secret);

  let body: Record<string, unknown> | null = null;
  let email = "";
  if (route.kind === "read") {
    if (!(await allow(globalKey.baReadIpBucket(clientIp(req)), 300, 300))) return retryLater({ ok: false, error: "slow_down" }, 300);
  } else {
    const raw = await readBody(req);
    email = normalizeEmail(typeof raw?.email === "string" ? raw.email : "");
    const password = typeof raw?.password === "string" ? raw.password : "";
    // The log-in buckets of POST /api/auth/login: one budget whichever form the guesses come through.
    if (!(await allow(globalKey.loginIpBucket(clientIp(req)), 20, 900)) || !(await allow(globalKey.loginEmailBucket(email), 8, 900))) return retryLater({ ok: false, error: "slow_down" }, 900);
    if (!raw || !email || !password || password.length > BA_PASSWORD_MAX) return NextResponse.json({ ok: false, error: "invalid" }, { status: 401 });
    // Only the two fields: no `rememberMe` (a one-day session would differ from every other), no `callbackURL`.
    body = { email, password };
  }

  const res = await auth.handler(await inner(req, path, secret, body));
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) return legacyError(res.status, data);

  const headers = { "cache-control": "no-store" };
  switch (path) {
    case "/sign-in/email": {
      if (!isRecord(data) || !isRecord(data.user)) return legacyError(500, null);
      return signedIn(email, data.user);
    }
    case "/get-session": {
      if (!isRecord(data) || !isRecord(data.session) || !isRecord(data.user)) return NextResponse.json(null, { headers });
      return NextResponse.json({ session: publicSession(data.session), user: publicUser(data.user) }, { headers });
    }
    case "/sign-out": {
      // better-auth deleted the record through the adapter; this also clears the browser cookie and the legacy name.
      await destroySession();
      return NextResponse.json({ success: true }, { headers });
    }
    case "/list-accounts": {
      return NextResponse.json(Array.isArray(data) ? data.filter(isRecord).map(publicAccount) : [], { headers });
    }
  }
  return notFound();
}

/** better-auth's verify errors (redirects to `?error=`) that mean "this link no longer opens anything". */
const DEAD_LINK = new Set(["INVALID_TOKEN", "new_user_signup_disabled", "user_not_found"]);

/**
 * The magic link's verify (rule 3416), for POST /api/auth/magic, which has checked the switch and the rate limit. The
 * token arrives in a JSON body (the page read it from the fragment), and better-auth's `magicLinkVerify` runs here,
 * server-side, so the token is never in a URL any server receives; its GET endpoint stays off the allow-list. No
 * `callbackURL`: better-auth answers JSON. The session gate runs as for a password (refusals, two-step sign-in), and a
 * link that is malformed, expired, used or names an address with no login answers `bad_token`.
 */
export async function verifyMagic(req: Request, token: string): Promise<NextResponse> {
  const auth = getAuth();
  if (!auth) return notFound();
  const dead = () => NextResponse.json({ ok: false, error: "bad_token" }, { status: 401 });
  if (!MAGIC_TOKEN.test(token)) return dead();
  const res = await auth.api.magicLinkVerify({ query: { token }, headers: forwardHeaders(req), asResponse: true });
  if (res.status >= 300 && res.status < 400) {
    // better-auth reports a dead link as a redirect to `/?error=CODE`; anything else it redirects for is a failure.
    const code = new URL(res.headers.get("location") ?? "/", "http://x").searchParams.get("error") ?? "";
    return DEAD_LINK.has(code) ? dead() : NextResponse.json({ ok: false, error: "failed" }, { status: 500 });
  }
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) return legacyError(res.status, data);
  if (!isRecord(data) || !isRecord(data.user) || typeof data.user.email !== "string") return legacyError(500, null);
  return signedIn(normalizeEmail(data.user.email), data.user);
}
