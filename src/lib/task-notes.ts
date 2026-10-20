import { db } from "./db";
import { readFile, writeFile } from "./files";
import { wsKey, type Scope } from "./keys";
import { log } from "./log";

/**
 * What a person types about a draft: the reason for an edit or a rejection (PATCH /api/tasks/[id]) and a line note (POST
 * /api/tasks/[id]/revise, rule 2491). Moved here from the task route so both read the same rule.
 */

/** The longest reason or note a person may give. */
export const NOTE_MAX = 300;

/**
 * The typed text as it is stored: a string or nothing, on one line, without control or direction characters, at most
 * `NOTE_MAX` characters. Any member may reject or leave a note (role "drafts"), and the text lands in preferences.md, a core
 * file every agent reads, so it is the member's words inside a fixed sentence, never a block of text or a new markdown section.
 */
export function cleanNote(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX).trim();
}

/** Learned notes are appended to preferences.md one request at a time: two rejections at once must not drop one. */
const PREFS_LOCK_S = 10;
export async function appendPreferences(scope: Scope, lines: string) {
  const key = wsKey.prefsFileLock(scope);
  let token: string | null = null;
  // Waiting for the lock is the one awaited call that repeats, as in updateTask (src/lib/brand.ts): ~3 s at most.
  for (let i = 0; i < 60 && !token; i++) {
    token = await db.lockOwned(key, PREFS_LOCK_S);
    if (!token) await new Promise((r) => setTimeout(r, 50));
  }
  if (!token) throw new Error("prefs_lock_timeout");
  try {
    const f = await readFile(scope, "preferences.md");
    await writeFile(scope, "preferences.md", `${f?.content ?? "# Preferences learned from the owner\n"}\n${lines}`.slice(-20000), "noor");
  } finally {
    await db.unlockOwned(key, token).catch((e) => log.error("prefs lock release failed", e));
  }
}
