// Gives every stored account and member its frozen id and every sign-in address its login index (account-id release R1,
// docs/specs/2026-10-17-account-id.md "Releases", rule 1994; docs/system/flows.md section 87). Run by hand ONCE, after
// the R1 release is live and only on the founder's yes (it writes production data), never at build time and not as part
// of `npm run check`. R1 already writes both for every new signup, invite and move; this fills in the records from
// before it. Nothing reads them as required yet, so a run that stops halfway is harmless and the next run finishes it.
//
// Usage:  npx --no-install jiti scripts/account-ids.ts            (dry run: read-only, prints counts)
//         npx --no-install jiti scripts/account-ids.ts --apply    (write the missing ids and indexes)
// with the app's own KV_REST_API_URL / KV_REST_API_TOKEN already in the environment (set privately, never typed on a
// command line that is saved).
//
// For every id in `users:all` (in parallel, 50 at a time; no `await db.*` inside a loop):
//   - the owner record gets `id` = the key it is stored under, if it has none (under the account lock, `withUserLock`);
//   - `login:{address}` gets `{ kind: "person", pid: id }` if absent (under `lock:login:{address}`, read again first);
//   - every member on its roster gets `id` = its address and its own `login:{address}`, the same way; a member whose
//     stored `id` is not its address is a conflict, left as it is.
// It never overwrites: an index that names someone else, an owner record whose address differs from its key, and a
// roster entry with no member record (or one of another team) are counted as conflicts or orphans and left as they are.
// A second run writes nothing (idempotent).
//
// Output is counts only: no email, id or key is printed.
// The work itself lives in src/lib/conversions/account-ids.ts, which the founder console runs too (rule 4100), so the
// founder needs no terminal and no store credentials for it.
// Exit codes: 0 done with no conflict; 1 finished with at least one conflict or orphan; 2 could not run.
import { pathToFileURL } from "node:url";
import { convertAccountIds } from "../src/lib/conversions/account-ids";

export { convertAccountIds, type IdsReport } from "../src/lib/conversions/account-ids";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error("KV_REST_API_URL and KV_REST_API_TOKEN must be set (the app's own store).");
    process.exitCode = 2;
    return;
  }
  const r = await convertAccountIds(apply);
  const verb = apply ? "set" : "to set";
  console.log(`${apply ? "Applied" : "Dry run"}: accounts ${r.accounts} (missing records ${r.missing}), members ${r.members}; ids ${verb} ${r.idsSet}, login indexes ${verb} ${r.indexesSet}; conflicts ${r.conflicts}, orphans ${r.orphans}.`);
  process.exitCode = r.conflicts || r.orphans ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
