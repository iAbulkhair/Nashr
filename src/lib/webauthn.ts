import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { log } from "./log";
import { appOrigin } from "./origin";

/**
 * The WebAuthn seam (customer passkeys, spec docs/specs/2026-10-20-passkeys.md). Server only, and the only file that
 * imports `@simplewebauthn/server` (rule 2427), so the library can be swapped or patched in one place and every caller
 * talks in plain strings.
 *
 * - RP ID and the one accepted origin come from `appOrigin()` alone (rule 2406): never from the incoming request's Host,
 *   Origin or forwarded values, and no new variable.
 * - User verification is required in both option sets and in both verifications, registration asks for a resident
 *   (discoverable) key and no attestation (rule 2409).
 * - Every failure of the library, a malformed response included, is `{ ok: false, reason: "invalid" }`. The log line is a
 *   fixed text with no value: the library's error text can echo the client data, so it is never logged or returned.
 * - The counter is not judged here: the stored counter is handed to the library as 0, so the library never refuses on it,
 *   and `counterOk` in the passkeys store decides (rule 2421).
 * - The user handle of an assertion is answered as `string | null` (preflight ruling 7): with discoverable credentials
 *   the caller requires it and compares it with the set's `uid` (rule 2403).
 */

export const rp = () => ({ id: new URL(appOrigin()).hostname, origin: appOrigin(), name: "Thakeen" });

const B64U = /^[A-Za-z0-9_-]+$/;
/** A `uid` is 32 random bytes in base64url (43 characters, no padding); the WebAuthn `user.id` is those 32 bytes. */
const UID = /^[A-Za-z0-9_-]{43}$/;
/** A credential id as the authenticator gave it, base64url (the `PasskeyCred.id` shape). */
const CRED_ID = /^[A-Za-z0-9_-]{16,1366}$/;

/** ES256, EdDSA, RS256, in that order of preference. */
const ALGORITHMS = [-7, -8, -257];

export type RegOptionsIn = { uid: string; userName: string; displayName: string; exclude: { id: string; transports: string[] }[] };

export async function registrationOptions(i: RegOptionsIn): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challenge: string }> {
  if (!UID.test(i.uid)) throw new Error("webauthn: uid must be 32 bytes of base64url");
  const r = rp();
  const options = await generateRegistrationOptions({
    rpName: r.name,
    rpID: r.id,
    userID: new Uint8Array(Buffer.from(i.uid, "base64url")),
    userName: i.userName,
    userDisplayName: i.displayName,
    attestationType: "none",
    excludeCredentials: i.exclude.map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    supportedAlgorithmIDs: ALGORITHMS,
  });
  return { options, challenge: options.challenge };
}

export type RegisteredCred = { id: string; pk: string; counter: number; transports: string[]; aaguid: string; backedUp: boolean };

export async function verifyRegistration(response: unknown, challenge: string): Promise<{ ok: true; cred: RegisteredCred } | { ok: false; reason: "invalid" }> {
  const r = rp();
  try {
    const v = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: r.origin,
      expectedRPID: r.id,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITHMS,
    });
    const info = v.verified ? v.registrationInfo : null;
    if (!info || !info.userVerified || !CRED_ID.test(info.credential.id)) throw new Error("not verified");
    return {
      ok: true,
      cred: {
        id: info.credential.id,
        pk: Buffer.from(info.credential.publicKey).toString("base64url"),
        counter: info.credential.counter,
        transports: (info.credential.transports ?? []).filter((t): t is string => typeof t === "string"),
        aaguid: info.aaguid,
        backedUp: info.credentialBackedUp,
      },
    };
  } catch {
    log.warn("webauthn reg invalid");
    return { ok: false, reason: "invalid" };
  }
}

export async function authenticationOptions(): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challenge: string }> {
  const options = await generateAuthenticationOptions({ rpID: rp().id, allowCredentials: [], userVerification: "required" });
  return { options, challenge: options.challenge };
}

export async function verifyAuthentication(
  response: unknown,
  challenge: string,
  cred: { id: string; pk: string; transports: string[] },
): Promise<{ ok: true; newCounter: number; userHandle: string | null } | { ok: false; reason: "invalid" }> {
  const r = rp();
  try {
    // The library does not compare the response's id with the stored credential; the caller looked the credential up
    // by that id, so a mismatch is a wrong response.
    if (responseId(response) !== cred.id) throw new Error("credential mismatch");
    const res = response as AuthenticationResponseJSON;
    const v = await verifyAuthenticationResponse({
      response: res,
      expectedChallenge: challenge,
      expectedOrigin: r.origin,
      expectedRPID: r.id,
      credential: { id: cred.id, publicKey: new Uint8Array(Buffer.from(cred.pk, "base64url")), counter: 0, transports: cred.transports },
      requireUserVerification: true,
    });
    if (!v.verified || !v.authenticationInfo.userVerified) throw new Error("not verified");
    const h = res.response?.userHandle;
    const userHandle = typeof h === "string" && B64U.test(h) ? h : null;
    return { ok: true, newCounter: v.authenticationInfo.newCounter, userHandle };
  } catch {
    log.warn("webauthn auth invalid");
    return { ok: false, reason: "invalid" };
  }
}

/** The `id` of a browser response when it is a well-formed credential id (base64url, 16-1366 characters), else null. */
export function responseId(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const id = (response as { id?: unknown }).id;
  return typeof id === "string" && CRED_ID.test(id) ? id : null;
}
