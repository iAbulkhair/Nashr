import { NextResponse } from "next/server";
import { checkCode, secondFactorStatus } from "./admin-2fa";
import { currentSessionKey, isFounderActor, type User } from "./auth";
import { db } from "./db";
import { globalKey, type PersonId } from "./keys";
import { checkMfaCode, mfaActive } from "./mfa";
import { actingLogin } from "./own-password";
import { credHash, listPasskeys, recordUse, resolvePasskeyLogin } from "./passkeys";
import { PASSKEY_CHALLENGE_TTL, passkeysOn } from "./passkey-switch";
import { sameSecret } from "./secret";
import { sha } from "./staff";
import { authenticationOptions, responseId, verifyAuthentication } from "./webauthn";

/**
 * The founder's fresh step-up before creating the first staff owner from their own customer session (rule 3700,
 * amending rule 1639). The customer session never becomes a staff session (rule 1630): it only issues the setup code,
 * and only after a proof made for THIS request, never a step-up still open from earlier:
 *
 *  - a passkey of the founder's own person (when passkeys are on and the founder has one), against a challenge bound to
 *    this customer session (`staffbootpk:{sha256}`, 300 s, taken with GETDEL), or
 *  - 6 digits from the console authenticator (`admin:2fa`) or from the founder's own two-step sign-in. A recovery code
 *    is refused here: a console recovery code would remove the console enrolment as a side effect.
 *
 * A founder with none of the three gets 403 `step_up_unavailable` and uses the key session (break-glass).
 */

export type FounderFactors = { console: boolean; mfa: boolean; passkey: boolean };
type BootChallenge = { challenge: string; at: number };
const bootKey = (sessionKey: string) => globalKey.staffBootPasskey(sha("nashr-staff-boot:" + sessionKey));
const no = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status });

/** The founder's own login when `u` is the founder signed in as themselves (not a member, not impersonating). */
async function founderLogin(u: User | null) {
  if (!u || !isFounderActor(u)) return null;
  return actingLogin(u);
}

/** Which proofs this founder can make now. */
export async function founderFactors(u: User | null): Promise<FounderFactors> {
  const me = await founderLogin(u);
  if (!me) return { console: false, mfa: false, passkey: false };
  const [status, mfa, on] = await Promise.all([secondFactorStatus(), mfaActive(me.email, me.bornAt), passkeysOn()]);
  const passkey = on && (await listPasskeys(me.pid, me.bornAt).catch(() => [])).length > 0;
  return { console: status.enrolled, mfa: !!mfa, passkey };
}

/** WebAuthn options for the founder's passkey step-up, the challenge bound to this customer session. */
export async function founderPasskeyOptions(u: User | null): Promise<NextResponse> {
  const [me, sess] = await Promise.all([founderLogin(u), currentSessionKey()]);
  if (!me || !sess) return no(403, "forbidden");
  if (!(await founderFactors(u)).passkey) return no(403, "step_up_unavailable");
  const { options, challenge } = await authenticationOptions();
  await db.set(bootKey(sess), { challenge, at: Date.now() } satisfies BootChallenge, PASSKEY_CHALLENGE_TTL);
  return NextResponse.json({ ok: true, options }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Null when the founder made a fresh proof in this request; otherwise the refusal. `body.passkey` is a WebAuthn response
 * to the options above; `body.code` is 6 digits.
 */
export async function founderStepUpRefusal(req: Request, u: User | null, body: { code?: unknown; passkey?: unknown }): Promise<NextResponse | null> {
  const me = await founderLogin(u);
  if (!me) return no(403, "forbidden");
  const factors = await founderFactors(u);
  if (!factors.console && !factors.mfa && !factors.passkey) return no(403, "step_up_unavailable");
  if (body.passkey !== undefined && body.passkey !== null) return (await passkeyMatches(me.pid, body.passkey)) ? null : no(403, "step_up_failed");
  const code = typeof body.code === "string" ? body.code.replace(/\s/g, "") : "";
  if (!code) return no(403, "fresh_code");
  if (!/^\d{6}$/.test(code)) return no(400, "bad_code");
  if (factors.console) {
    const r = await checkCode(req, code);
    if (r.ok) return null;
    if (r.res.status === 429) return r.res;
  }
  if (factors.mfa) {
    const r = await checkMfaCode(req, me.email, me.bornAt, code, { recovery: false });
    if (r.ok) return null;
    if (r.res.status === 429) return r.res;
  }
  return no(400, "bad_code");
}

/** The passkey path: the order of POST /api/auth/passkey/verify, plus "the passkey belongs to the founder's person". */
async function passkeyMatches(pid: PersonId, response: unknown): Promise<boolean> {
  const sess = await currentSessionKey();
  if (!sess || !(await passkeysOn())) return false;
  const ch = await db.getdel<BootChallenge>(bootKey(sess));
  if (!ch || typeof ch.challenge !== "string" || typeof ch.at !== "number" || Date.now() - ch.at > PASSKEY_CHALLENGE_TTL * 1000) return false;
  const id = responseId(response);
  if (!id) return false;
  const found = await resolvePasskeyLogin(credHash(id));
  if (!found || found.pid !== pid) return false;
  const v = await verifyAuthentication(response, ch.challenge, { id: found.cred.id, pk: found.cred.pk, transports: found.cred.transports });
  if (!v.ok || !v.userHandle || !sameSecret(v.userHandle, found.set.uid)) return false;
  const used = await recordUse(found.pid, found.born, found.cred.id, v.newCounter).catch(() => ({ result: "gone" as const }));
  return used.result === "ok";
}
