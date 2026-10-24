// Script S1 of multi-workspace membership (docs/specs/2026-10-18-multi-org.md, table "Script S1" and rule 2133;
// docs/system/flows.md section 93.1): fills the M1 records for every login from before release M1. Run by hand ONCE,
// after M1 is live and only on the founder's yes (it writes production data), never at build time and not as part of
// `npm run check`. M1 already writes these records for every new signup, invite and move, and reads the legacy records
// as a fallback, so nothing needs them yet: a run that stops halfway is harmless and the next run finishes it.
//
// Usage:  npx --no-install jiti scripts/multi-org-index.ts            (dry run: read-only, prints counts)
//         npx --no-install jiti scripts/multi-org-index.ts --apply    (write the missing records)
// with the app's own KV_REST_API_URL / KV_REST_API_TOKEN already in the environment (set privately, never typed on a
// command line that is saved).
//
// For every id in `users:all` (in parallel, 50 at a time; no `await db.*` inside a loop):
//   - the owner: `person:{pid}` copied from the legacy owner record if absent (`createPersonRecord`), `orgs:{pid}`
//     naming the account, and `login:{address}` naming the person if absent. An account that names its owner in
//     `ownerPid` already has its person: only `orgs:` and the index are filled;
//   - every member on its roster: `person:{pid}` from the legacy `member:` record if absent, `mbr:{aid}:{pid}` from the
//     same record if absent (`writeMembership`, which also fills `orgs:{pid}`; a paused member stays paused, since the
//     row carries the record's own `disabled`), and `login:{address}` if absent.
// Every write runs under the locks M1's own writers take (rule 2139: `lock:team` → `lock:login` → `lock:person` →
// `lock:member`) and reads the records again under them first; only what is still absent is written.
// It never overwrites: a `person:` row that is unreadable or whose hash or address differs from the legacy record, a
// `login:` index that names someone else, an owner record it cannot read as a person, a member record whose `memberOf`
// account is missing, and a roster entry without a record are counted and left as they are. A second run writes nothing
// (idempotent).
//
// The work itself lives in src/lib/conversions/multi-org-index.ts, which the founder console runs too, as a dry run only
// (rule 4100).
// Output is counts only: no email, id or key is printed.
// Exit codes: 0 done with no conflict; 1 finished with at least one conflict, orphan or busy lock; 2 could not run.
import { pathToFileURL } from "node:url";
import { run } from "../src/lib/conversions/multi-org-index";

export { run, type IndexReport } from "../src/lib/conversions/multi-org-index";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error("KV_REST_API_URL and KV_REST_API_TOKEN must be set (the app's own store).");
    process.exitCode = 2;
    return;
  }
  const r = await run({ apply });
  const verb = apply ? "set" : "to set";
  console.log(`${apply ? "Applied" : "Dry run"}: accounts ${r.accounts} (missing records ${r.missing}), owners ${r.owners}, members ${r.members} (paused ${r.paused}); persons ${verb} ${r.personsSet}, memberships ${verb} ${r.membershipsSet}, orgs entries ${verb} ${r.orgsSet}, login indexes ${verb} ${r.loginsSet}.`);
  console.log(`Left as they are: person conflicts ${r.personConflicts}, login conflicts ${r.loginConflicts}, owner conflicts ${r.ownerConflicts}, orphan member records ${r.orphanRecords}, orphan roster entries ${r.orphanEntries}, busy ${r.busy}.`);
  process.exitCode = r.personConflicts || r.loginConflicts || r.ownerConflicts || r.orphanRecords || r.orphanEntries || r.busy ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("S1 stopped: the store could not be read or written. Nothing is half-written that a second run does not finish.");
    process.exitCode = 2;
  });
}
