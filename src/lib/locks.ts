import { db } from "./db";

/**
 * The shared Redis lock of src/lib/team.ts and src/lib/person.ts (multi-workspace membership, release M1): SET NX with a
 * 10 s expiry, retried every 50 ms for about 3 s, always released. Moved here unchanged from team.ts so the team locks
 * (`lock:team`, `lock:login`, `lock:member`) and the person lock (`lock:person`) are one implementation. Locks are not
 * reentrant: a callee that runs under a held lock takes a `locked` flag instead of taking it again (rule 2139).
 *
 * `timeoutError` is the message of the error thrown when the lock cannot be had (`team_lock_timeout`,
 * `person_lock_timeout`), which routes map to a "busy" answer.
 */
const LOCK_TTL_SECONDS = 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `ttlSeconds` (default 10) is how long the lock lives if it is never released. Only a holder whose work is known to run
 * longer passes more (the owner address move's `lock:team`, src/lib/team.ts `withMoveTeamLock`); there is no renewal.
 */
export async function withNamedLock<T>(key: string, fn: () => Promise<T>, timeoutError: string, ttlSeconds = LOCK_TTL_SECONDS): Promise<T> {
  let got = false;
  for (let i = 0; i < 60 && !got; i++) {
    got = await db.lock(key, ttlSeconds);
    if (!got) await sleep(50);
  }
  if (!got) throw new Error(timeoutError);
  try {
    return await fn();
  } finally {
    await db.unlock(key);
  }
}
