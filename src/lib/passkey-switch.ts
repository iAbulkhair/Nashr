import { db } from "./db";
import { globalKey } from "./keys";

/**
 * The customer passkey off switch (rule 2426, docs/specs/2026-10-20-passkeys.md flow E), on the `skills:paused` pattern:
 * `passkeys:off` = `"1"` turns off passkey sign-in and adding, absent means on (the default). Server only: this module
 * imports the store, so client code takes the limits from `src/lib/passkey-limits.ts`.
 */

export { PASSKEY_CHALLENGE_TTL, PASSKEY_NAME_MAX, PASSKEYS_MAX } from "./passkey-limits";

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
