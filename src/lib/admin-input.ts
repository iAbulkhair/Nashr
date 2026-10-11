/**
 * What the founder console accepts from its prompts before it sends a request (rule 960). Client-safe: no imports.
 * The server checks again; these only stop a request the founder did not mean to send.
 */

/** The longest trial extension, in days. POST /api/admin/users/{email} `extendTrial` clamps to the same bound. */
export const TRIAL_EXTEND_MAX_DAYS = 90;

/**
 * "Extend trial": the number of days typed, a whole number from 1 to TRIAL_EXTEND_MAX_DAYS, or null for anything else.
 * Cancel (the prompt's null) is not a number either: before this, `Number(null) || 7` sent 7 days on Cancel.
 */
export function parseTrialDays(raw: string | null): number | null {
  if (raw === null) return null;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= TRIAL_EXTEND_MAX_DAYS ? n : null;
}
