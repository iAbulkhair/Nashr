import { createHash, randomBytes } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { sessionCookie } from "@/lib/auth";
import { db } from "@/lib/db";
import { globalKey } from "@/lib/keys";
import { PASSKEY_CHALLENGE_TTL, PASSKEY_COOKIE, PASSKEY_COOKIE_PATH, passkeysOn, type AuthChallenge } from "@/lib/passkey-switch";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { authenticationOptions } from "@/lib/webauthn";

/**
 * POST: the options of a passkey sign-in (customer passkeys, docs/specs/2026-10-20-passkeys.md flow C1, rules 2408, 2409,
 * 2417). Public: nobody is signed in yet. The log-in page calls it on load for the browser's autofill (conditional UI)
 * and again when "Sign in with a passkey" is pressed.
 *
 * Off switch (404 `unavailable`, rule 2426) → 60 per IP per 15 minutes (429 `slow_down`) → the options through the seam
 * (`allowCredentials` empty, user verification required: the answer names no person) → a fresh nonce, whose SHA-256
 * keys the challenge `pkauth:` for 300 s and which travels only in the `thakeen_pk` cookie (httpOnly, Secure outside
 * loopback http, SameSite=Lax, path `/api/auth/passkey`, 300 s). The nonce is never stored in clear and never logged.
 * This route takes no person lock and reads no person.
 */

const OPTIONS_PER_IP = 60;
const WINDOW_SECONDS = 900;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export async function POST(req: Request) {
  if (!(await passkeysOn())) return NextResponse.json({ ok: false, error: "unavailable" }, { status: 404 });
  if (!(await allow(globalKey.passkeyIpBucket(clientIp(req)), OPTIONS_PER_IP, WINDOW_SECONDS))) return retryLater({ ok: false, error: "slow_down" }, WINDOW_SECONDS);
  const { options, challenge } = await authenticationOptions();
  const nonce = randomBytes(32).toString("base64url");
  await db.set(globalKey.passkeyAuth(sha256(nonce)), { challenge, at: Date.now() } satisfies AuthChallenge, PASSKEY_CHALLENGE_TTL);
  (await cookies()).set(PASSKEY_COOKIE, nonce, { ...(await sessionCookie(PASSKEY_CHALLENGE_TTL)), path: PASSKEY_COOKIE_PATH });
  return NextResponse.json({ ok: true, options });
}
