import { createHash } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { adminAudit } from "@/lib/admin-audit";
import { db } from "@/lib/db";
import { globalKey } from "@/lib/keys";
import { log } from "@/lib/log";
import { finishAnswer, finishLogin } from "@/lib/login-finish";
import { credHash, recordUse, resolvePasskeyLogin, shortHash } from "@/lib/passkeys";
import { PASSKEY_CHALLENGE_TTL, PASSKEY_COOKIE, PASSKEY_COOKIE_PATH, passkeysOn, type AuthChallenge } from "@/lib/passkey-switch";
import { isPersonLockTimeout } from "@/lib/person";
import { allow, clientIp, retryLater } from "@/lib/rate";
import { sameSecret } from "@/lib/secret";
import { responseId, verifyAuthentication } from "@/lib/webauthn";

/**
 * POST {response}: finish a passkey sign-in (customer passkeys, docs/specs/2026-10-20-passkeys.md flow C2, rules 2403,
 * 2405, 2408, 2409, 2418-2423). Public: nobody is signed in yet. The order is the spec's, step by step:
 *
 *  1. Read the `thakeen_pk` cookie and clear it, first, so every outcome clears it (404 and 429 included; rule 2408,
 *     pre-flight ruling 8). Clearing names the cookie's own path, or the browser would keep it.
 *  2. Off switch (404 `unavailable`, rule 2426).
 *  3. 20 per IP per 15 minutes (429 `slow_down`), before anything about a person is read (rule 2418).
 *  4. Take the challenge `pkauth:{sha256(nonce)}` with `getdel` (single use; missing or older than 300 s: refused).
 *  5. The response's credential id, its hash, and 10 per credential hash per 15 minutes (rule 2418).
 *  6. `resolvePasskeyLogin`: the reverse entry → the person → `getLogin(person.email)` naming the same pid → the set
 *     carrying the person's birth and holding the credential (rules 2402, 2405). Only the library turns the stored value
 *     into a pid; the hash is a lookup hint built from what the browser sent, never an ownership claim.
 *  7. The user handle is present and equals the set's `uid` (rule 2403, pre-flight ruling 7).
 *  8. The signature through the seam: challenge, origin and RP ID from `appOrigin()`, user verification required
 *     (rules 2406, 2409); the handle the seam read must be the same `uid`.
 *  9. Under the person lock: the counter check, then `counter` and `lastUsedAt` written with SET XX (rules 2421, 2422);
 *     a regression writes one audit row with an 8-hex hash, never the credential id or key.
 * 10. `finishLogin(login, { via: "passkey", codeDone: true })`: every refusal, the account pick, the device row, the
 *     session ids and the login count of the password path; no two-step code (rules 2419, 2420).
 *
 * Every failure before step 10 answers the same 401 `passkey_failed` (rule 2423); a refusal from `finishLogin` keeps the
 * password path's answer. A person lock that stays taken is 409 `busy` (rule 2414). Log lines carry a fixed reason only.
 */

const VERIFY_PER_IP = 20;
const VERIFY_PER_CREDENTIAL = 10;
const WINDOW_SECONDS = 900;
const CHALLENGE_MS = PASSKEY_CHALLENGE_TTL * 1000;
/** The nonce the options route sets: 32 random bytes in base64url. */
const NONCE = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const Body = z.object({ response: z.unknown() });

/** The one answer to every failure before `finishLogin` (rule 2423); the log names the reason, never a value. */
function failed(reason: string): NextResponse {
  log.info("passkey sign-in refused", { reason });
  return NextResponse.json({ ok: false, error: "passkey_failed" }, { status: 401 });
}
const slowDown = () => retryLater({ ok: false, error: "slow_down" }, WINDOW_SECONDS);

/** The user handle the browser sent, as it sent it (base64url), or null. */
function sentUserHandle(response: unknown): string | null {
  const r = response && typeof response === "object" ? (response as { response?: unknown }).response : undefined;
  const h = r && typeof r === "object" ? (r as { userHandle?: unknown }).userHandle : undefined;
  return typeof h === "string" && h ? h : null;
}

export async function POST(req: Request) {
  // 1. The cookie, read and cleared before anything can answer.
  const jar = await cookies();
  const nonce = jar.get(PASSKEY_COOKIE)?.value;
  jar.delete({ name: PASSKEY_COOKIE, path: PASSKEY_COOKIE_PATH });
  // 2, 3.
  if (!(await passkeysOn())) return NextResponse.json({ ok: false, error: "unavailable" }, { status: 404 });
  if (!(await allow(globalKey.passkeyVerifyIpBucket(clientIp(req)), VERIFY_PER_IP, WINDOW_SECONDS))) return slowDown();
  const body = Body.safeParse(await req.json().catch(() => null));
  // 4.
  if (!nonce || !NONCE.test(nonce)) return failed("no_challenge");
  const ch = await db.getdel<AuthChallenge>(globalKey.passkeyAuth(sha256(nonce)));
  if (!ch || typeof ch.challenge !== "string" || typeof ch.at !== "number" || Date.now() - ch.at > CHALLENGE_MS) return failed("no_challenge");
  // 5.
  const response = body.success ? body.data.response : null;
  const id = responseId(response);
  if (!id) return failed("bad_response");
  const hash = credHash(id);
  if (!(await allow(globalKey.passkeyCredBucket(hash), VERIFY_PER_CREDENTIAL, WINDOW_SECONDS))) return slowDown();
  // 6.
  const found = await resolvePasskeyLogin(hash);
  if (!found) return failed("unknown_credential");
  const { pid, born, login, set, cred } = found;
  // 7.
  const handle = sentUserHandle(response);
  if (!handle || !sameSecret(handle, set.uid)) return failed("user_handle");
  // 8.
  const v = await verifyAuthentication(response, ch.challenge, { id: cred.id, pk: cred.pk, transports: cred.transports });
  if (!v.ok) return failed("signature");
  if (!v.userHandle || !sameSecret(v.userHandle, set.uid)) return failed("user_handle");
  // 9.
  try {
    const used = await recordUse(pid, born, cred.id, v.newCounter);
    if (used.result === "counter") {
      await adminAudit({
        actor: "system",
        section: "users",
        what: "passkey counter refused",
        action: "passkey.counter_refused",
        target: login.person.email,
        before: { counter: used.stored ?? cred.counter },
        after: { counter: v.newCounter, cred: shortHash(cred.id) },
        reason: "counter",
      }).catch(() => log.error("passkey counter audit failed"));
      return failed("counter");
    }
    if (used.result !== "ok") return failed("gone");
  } catch (e) {
    if (isPersonLockTimeout(e)) return NextResponse.json({ ok: false, error: "busy" }, { status: 409 });
    throw e;
  }
  // 10.
  return finishAnswer(await finishLogin(login, { via: "passkey", codeDone: true }));
}
