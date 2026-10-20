/**
 * Customer passkey limits (docs/specs/2026-10-20-passkeys.md, rules 2401, 2407, 2408). This module imports nothing, so
 * client components (the security settings card, the log-in form) and server code read the same numbers without the
 * store (`src/lib/passkey-switch.ts` imports `db`) ever reaching the browser bundle.
 */

/** The most passkeys one person holds (rule 2401). */
export const PASSKEYS_MAX = 10;

/** The longest passkey name, in characters after cleaning (rule 2401). */
export const PASSKEY_NAME_MAX = 40;

/** Seconds a registration (`pkreg:`) or sign-in (`pkauth:`) challenge lives, and the `thakeen_pk` cookie's max age (rules 2407, 2408). */
export const PASSKEY_CHALLENGE_TTL = 300;
