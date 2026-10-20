import { db } from "./db";
import { globalKey } from "./keys";

/**
 * The customer passkey off switch (rule 2426, docs/specs/2026-10-20-passkeys.md flow E), on the `skills:paused` pattern:
 * `passkeys:off` = `"1"` turns off passkey sign-in and adding, absent means on (the default). Server only: this module
 * imports the store, so client code takes the limits from `src/lib/passkey-limits.ts`.
 */

export { PASSKEY_CHALLENGE_TTL, PASSKEY_NAME_MAX, PASSKEYS_MAX } from "./passkey-limits";

/**
 * The sign-in nonce cookie (rule 2408, pre-flight rulings 8 and 19): 32 random bytes, base64url, set by
 * POST /api/auth/passkey/options and read and cleared first by POST /api/auth/passkey/verify. Its path is the two routes'
 * own folder, so no other request ever carries it; clearing it must name the same path (a cookie is name + path).
 */
export const PASSKEY_COOKIE = "thakeen_pk";
export const PASSKEY_COOKIE_PATH = "/api/auth/passkey";
/** The stored sign-in challenge `pkauth:{sha256(nonce)}` (spec, data shapes). */
export type AuthChallenge = { challenge: string; at: number };

/**
 * Whether passkeys are on. The client parses a stored "1" back as the number 1 (db.ts), so it is compared as text. A
 * read error throws like every other read (the route answers 500); it is never read as "on".
 */
export async function passkeysOn(): Promise<boolean> {
  return String(await db.get(globalKey.passkeysOff())) !== "1";
}

/** Turns passkeys on (deletes the key) or off (writes `"1"`). Only the console owner route calls it (rule 2426). */
export async function setPasskeysOn(on: boolean): Promise<void> {
  if (on) await db.del(globalKey.passkeysOff());
  else await db.set(globalKey.passkeysOff(), "1");
}
