// The contract step of customer roles (rule 3755; docs/system/flows.md section 120): rewrites the Editor role's stored
// name from "member" to "editor" in every membership row (`mbr:{aid}:{pid}`) and every legacy member record
// (`member:{pid}`). Run by hand ONCE, only after the CONTRACT release (the one that writes "editor") is live and only on
// the founder's yes (it writes production data), never at build time and not as part of `npm run check`.
//
// Never before: a build from before customer roles parses neither "editor" nor "viewer" and signs such a member out. The
// expand release (customer roles M3) reads "editor" as "member" everywhere, so a rollback to it after this run is safe;
// a rollback to anything older is not. Invites are not touched: one lives 7 days, so none written before the contract
// release outlives the wait. Team log rows keep the name they were written with (history; both names read the same).
//
// Usage:  npx --no-install jiti scripts/editor-role.ts            (dry run: read-only, prints counts)
//         npx --no-install jiti scripts/editor-role.ts --apply    (rewrite)
// with the app's own KV_REST_API_URL / KV_REST_API_TOKEN already in the environment (set privately, never typed on a
// command line that is saved).
//
// For every id in `users:all`, its roster (`members:{aid}`), then the row and the record of every entry, read in bulk
// (no `await db.*` inside a loop: `pmap` and `mgetChunked`). A rewrite runs under the locks the app's own writers take
// (`lock:team` for the row, then `lock:member` for the record, the rule 2139 order) and reads both values again under
// them: only a value whose role is still "member" is rewritten, every other field kept as stored. Admins and viewers are
// never touched. A second run rewrites nothing (idempotent).
//
// Output is counts only: no email, id or key is printed.
// Exit codes: 0 done; 1 finished with at least one busy lock (run again); 2 could not run.
import { pathToFileURL } from "node:url";
import { db, mgetChunked } from "../src/lib/db";
import { pmap } from "../src/lib/parallel";
import { accountKey, globalKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "../src/lib/keys";
import { withNamedLock } from "../src/lib/locks";
import { withAccountTeamLock } from "../src/lib/team";

export type EditorReport = {
  apply: boolean;
  accounts: number;
  /** Roster entries read. */
  entries: number;
  /** Membership rows whose role is (or, in a dry run, would be) rewritten. */
  rows: number;
  /** Legacy member records of this account whose role is (or would be) rewritten. */
  records: number;
  /** Nothing to rename (already "editor", or an admin or a viewer): left as they are. */
  untouched: number;
  /** A lock that stayed held: run again. */
  busy: number;
};

const CHUNK = 50;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Pure: the value with its role renamed, or null when there is nothing to rename (the role is not the stored "member").
 * With `aid`, a legacy record counts only when its `memberOf` is that account: another home is that account's to convert.
 */
export function renamed(raw: unknown, aid?: AccountId): Record<string, unknown> | null {
  if (!isRecord(raw) || raw.role !== "member") return null;
  if (aid !== undefined && raw.memberOf !== aid) return null;
  return { ...raw, role: "editor" };
}

type Entry = { aid: AccountId; pid: PersonId };
type Outcome = { row: boolean; record: boolean; busy: boolean };

/** One entry, under `lock:team` → `lock:member`: both values read again, each rewritten only while still "member". */
async function applyOne(e: Entry): Promise<Outcome> {
  try {
    return await withAccountTeamLock(e.aid, () =>
      withNamedLock(accountKey.memberLock(e.pid), async () => {
        const [rowRaw, recRaw] = await Promise.all([db.get(accountKey.membership(e.aid, e.pid)), db.get(accountKey.member(e.pid))]);
        const row = renamed(rowRaw);
        const rec = renamed(recRaw, e.aid);
        await Promise.all([row ? db.set(accountKey.membership(e.aid, e.pid), row) : null, rec ? db.set(accountKey.member(e.pid), rec) : null]);
        return { row: !!row, record: !!rec, busy: false };
      }, "member_lock_timeout"),
    );
  } catch (err) {
    if (err instanceof Error && /(^|_)lock_timeout$/.test(err.message)) return { row: false, record: false, busy: true };
    throw err;
  }
}

export async function run(opts: { apply: boolean }): Promise<EditorReport> {
  const r: EditorReport = { apply: opts.apply, accounts: 0, entries: 0, rows: 0, records: 0, untouched: 0, busy: 0 };
  const ids = await db.smembers(globalKey.usersAll());
  r.accounts = ids.length;
  const rosters = await pmap(ids, (id) => db.smembers(accountKey.members(id)), CHUNK);
  const entries: Entry[] = ids.flatMap((id, i) => rosters[i].map((p) => ({ aid: storedAccountId(id), pid: storedPersonId(p) })));
  r.entries = entries.length;
  const [rows, recs] = await Promise.all([
    mgetChunked<unknown>(entries.map((e) => accountKey.membership(e.aid, e.pid))),
    mgetChunked<unknown>(entries.map((e) => accountKey.member(e.pid))),
  ]);
  const work: Entry[] = [];
  entries.forEach((e, i) => {
    const row = renamed(rows[i]);
    const rec = renamed(recs[i], e.aid);
    if (row) r.rows++;
    if (rec) r.records++;
    if (row || rec) work.push(e);
    else r.untouched++;
  });
  if (!opts.apply) return r;

  // Counted again from what the writes find under their locks: a value changed since the read above is not overwritten.
  r.rows = r.records = 0;
  const outcomes = await pmap(work, applyOne, CHUNK);
  for (const o of outcomes) {
    if (o.busy) r.busy++;
    if (o.row) r.rows++;
    if (o.record) r.records++;
  }
  return r;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error("KV_REST_API_URL and KV_REST_API_TOKEN must be set (the app's own store).");
    process.exitCode = 2;
    return;
  }
  const r = await run({ apply });
  const verb = apply ? "rewritten" : "to rewrite";
  console.log(`${apply ? "Applied" : "Dry run"}: accounts ${r.accounts}, roster entries ${r.entries}; membership rows ${verb} ${r.rows}, member records ${verb} ${r.records}; left as they are ${r.untouched}; busy ${r.busy}.`);
  process.exitCode = r.busy ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("The editor conversion stopped: the store could not be read or written. A second run finishes it.");
    process.exitCode = 2;
  });
}
