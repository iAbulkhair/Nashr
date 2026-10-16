import { NextResponse } from "next/server";
import { clientIp } from "./rate";
import { isProductionDeploy } from "./deploy-env";
import { log } from "./log";

/**
 * Cloudflare Turnstile on signup and forgot-password (rules 426-428, tests/launch-security.test.ts; issue #49, the
 * interim brake until email verification exists).
 *
 * On only when BOTH keys are set: TURNSTILE_SITE_KEY (public, handed to the form by the server page as a prop) and
 * TURNSTILE_SECRET_KEY (secret, read here only). With both unset nothing is checked (fail open), so nothing breaks
 * before the founder adds the keys; a production deploy logs that once per process (names only).
 *
 * Exactly one key set is a half-configured deploy (rule 978). Outside production it is still off, as before. In a
 * production deploy (`isProductionDeploy()`, staging included) it fails closed: every check is 503
 * `captcha_unavailable` and the missing name is logged once per process, so a lost secret cannot switch the CAPTCHA
 * off silently on live. The form gets no site key then, and the refusal tells the visitor to try again later.
 *
 * The token is checked at a FIXED Cloudflare URL (never a user-supplied one, so `safeFetch` does not apply), as a
 * form POST with the secret, the token and the client IP, with a 5-second timeout. A missing, malformed or rejected
 * token is 400 `captcha_failed`; Cloudflare not answering is 503 `captcha_unavailable`. Both checked before the
 * account is created or a reset link is made.
 */
export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TIMEOUT_MS = 5000;
/** Cloudflare's documented maximum token length. */
const MAX_TOKEN = 2048;

/** The public site key when Turnstile is on (both keys set), else null. Server-only: the page passes it as a prop. */
export function turnstileSiteKey(): string | null {
  const site = process.env.TURNSTILE_SITE_KEY, secret = process.env.TURNSTILE_SECRET_KEY;
  return site && secret ? site : null;
}

/** "on" with both keys, "off" with neither, "half" with exactly one (rule 978). Read at call time. */
export type TurnstileState = "on" | "off" | "half";
export function turnstileState(): TurnstileState {
  const site = !!process.env.TURNSTILE_SITE_KEY, secret = !!process.env.TURNSTILE_SECRET_KEY;
  return site && secret ? "on" : site || secret ? "half" : "off";
}

/** The messages already logged by this process, so a refusal per signup does not flood the log. */
const logged = new Set<string>();
const logOnce = (message: string) => {
  if (logged.has(message)) return;
  logged.add(message);
  log.error(message);
};

export type CaptchaResult = "ok" | "failed" | "unavailable";

/** Check a widget token. "ok" when Turnstile is off; "unavailable" when half-configured in production. Never throws. */
export async function verifyTurnstile(token: unknown, ip: string, f: typeof fetch = fetch): Promise<CaptchaResult> {
  const state = turnstileState();
  if (state !== "on") {
    if (!isProductionDeploy()) return "ok";
    if (state === "off") {
      logOnce("turnstile off: TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are unset");
      return "ok";
    }
    logOnce(`turnstile half-configured, refusing: ${process.env.TURNSTILE_SITE_KEY ? "TURNSTILE_SECRET_KEY" : "TURNSTILE_SITE_KEY"} is unset`);
    return "unavailable";
  }
  const secret = process.env.TURNSTILE_SECRET_KEY!;
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN) return "failed";
  const body = new URLSearchParams({ secret, response: token });
  if (ip && ip !== "unknown") body.set("remoteip", ip);
  try {
    const res = await f(TURNSTILE_VERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return "unavailable";
    const j = (await res.json().catch(() => null)) as { success?: unknown } | null;
    if (!j) return "unavailable";
    return j.success === true ? "ok" : "failed";
  } catch {
    return "unavailable";
  }
}

/** The route's answer when the check did not pass, or null when the request may go on. */
export async function captchaRefusal(req: Request, token: unknown): Promise<NextResponse | null> {
  const r = await verifyTurnstile(token, clientIp(req));
  if (r === "ok") return null;
  return r === "failed"
    ? NextResponse.json({ ok: false, error: "captcha_failed" }, { status: 400 })
    : NextResponse.json({ ok: false, error: "captcha_unavailable" }, { status: 503 });
}
