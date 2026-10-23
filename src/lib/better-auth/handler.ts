import { createHmac } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { destroySession, getLogin, normalizeEmail } from "@/lib/auth";
import { baOn, baSecret } from "@/lib/auth-engine";
import { SESSION_COOKIE, readCookie } from "@/lib/cookie-names";
import { globalKey } from "@/lib/keys";
import { verifyOwed } from "@/lib/login-finish";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { BA_BASE_PATH, BA_PASSWORD_MAX, BA_SESSION_COOKIE, getAuth } from "./server";

/**
 * The wrapper around better-auth's handler (`/api/better-auth/[...all]`, rules 3410, 3412-3414). better-auth never
 * sees the browser's request and the browser never sees better-auth's answer as it is:
 *
 * - Off switch first: 404 before reading the body or the store (rule 3400).
 * - An allow-list of method + path (rule 3413). An upgrade that adds an endpoint adds nothing reachable.
 * - Thakeen's rate limits before better-auth reads anything (rule 3414); better-auth's limiter is off.
 * - One cookie (rule 3410): the request reaches better-auth with only `thakeen.session_token`, signed from the browser's
 *   `thakeen_session` with `BETTER_AUTH_SECRET`; every `Set-Cookie` better-auth answers is dropped. The browser cookie is
 *   written by `issueSession` (through `cookies()`, merged into this response by Next) and cleared by `destroySession`.
 * - No session token in any answer (rule 3412): `token` goes from sign-in, the whole session row is cut to its public
 *   fields, and errors come back in the legacy shape `{ok: false, error}` the log-in form already reads.
 */

type Route = { method: "GET" | "POST"; read?: true };
/** Every path better-auth answers through HTTP. Anything else is 404, before better-auth runs. */
export const BA_ROUTES: Readonly<Record<string, Route>> = {
  "/sign-in/email": { method: "POST" },
  "/get-session": { method: "GET", read: true },
  "/sign-out": { method: "POST", read: true },
  "/list-accounts": { method: "GET", read: true },
};

const notFound = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
const BODY_MAX = 4096;
/** A cookie value worth signing: what `createSession` writes (64 hex) or an older token shape; nothing with separators. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

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
 * The request better-auth sees: the same origin headers, only better-auth's own cookie, a rebuilt JSON body. No address
 * header: src/lib/rate.ts stays the only reader of one (rule 773), better-auth's limiter is off, and the session row's
 * `ipAddress` is projected empty and never stored.
 */
async function inner(req: Request, path: string, secret: string, body: Record<string, unknown> | null): Promise<Request> {
  const h = new Headers();
  for (const name of ["origin", "referer", "user-agent", "accept-language"]) {
    const v = req.headers.get(name);
    if (v) h.set(name, v);
  }
  const token = readCookie(await cookies(), SESSION_COOKIE);
  if (token && TOKEN_SHAPE.test(token)) h.set("cookie", signedSessionCookie(token, secret));
  const url = new URL(req.url);
  const target = new URL(BA_BASE_PATH + path, url.origin);
  if (req.method === "GET") return new Request(target, { method: "GET", headers: h });
  h.set("content-type", "application/json");
  return new Request(target, { method: "POST", headers: h, body: JSON.stringify(body ?? {}) });
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

  let body: Record<string, unknown> | null = null;
  let email = "";
  if (route.read) {
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
      const l = await getLogin(email);
      const verify = l ? verifyOwed(l) : undefined;
      return NextResponse.json({ ok: true, ...(verify === undefined ? {} : { verify }), redirect: false, user: publicUser(data.user) }, { headers });
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
