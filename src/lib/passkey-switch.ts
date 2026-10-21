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

/**
 * Turns passkeys on (deletes the key) or off (writes `"1"`) and answers whether they were on just before, read by the
 * write itself so the audit row's `before` is the state this write replaced, not one read a command earlier (rule 2426).
 * On: GETDEL, one command. Off: SET NX, one command when the key was absent (it was on); when the key is already there
 * it holds "1" (only this function writes it, so it was off) or, should anything else ever have written it, a value
 * `passkeysOn` reads as on, which is then overwritten with "1". Only the console owner route calls it.
 */
export async function setPasskeysOn(on: boolean): Promise<boolean> {
  const k = globalKey.passkeysOff();
  if (on) return String(await db.getdel(k)) !== "1";
  if (await db.setNx(k, "1")) return true;
  if (String(await db.get(k)) === "1") return false;
  await db.set(k, "1");
  return true;
}
