# Coverage: CI minutes and the coverage map's layout (rules 772, 788)

Status on 2026-10-09 on branch `claude/ci-minutes-cache`: rule 772 changed (its row stays in `docs/system/tests.md`) and rule 788 added (below). `.github/workflows/ci.yml` runs the unit tests alone on a push to main, caches Next's build cache and Playwright's browsers; the coverage map is split so that a pull request no longer edits the end of one shared table.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 788 | The coverage map is split so pull requests stop conflicting on it: `docs/system/tests.md` keeps rules 1-786 and their notes, and each later change adds its own file `docs/system/tests/NNNN-slug.md` (NNNN = the first rule it adds, four digits) that opens with a heading and its status line, then the same four-column table with its rows, then its notes. A rule number is used once across all the files (a range row such as `723-729` reserves its numbers). Tests read a rule's row through `coverageRow` in `tests/helpers/coverage.ts`, never from tests.md alone | test (`coverage-map.test.ts`: the file names and header, a file's first row is the number in its name, every row in the directory is above 786, no number used twice across tests.md and the directory, the pointer in tests.md; `handoffs.test.ts` and `cross-review.test.ts` read rows 274 and 270 through the helper) | — |

## Notes

Why: every pull request added its rows at the end of the one table in `tests.md`, its status line at the top and its note at the top of the notes, so a merge to main conflicted with every open pull request that had done the same. Each conflict meant a resync commit and one more full CI run (about 20 minutes). A file per change has no shared last line, so two pull requests never touch the same lines unless they change the same existing row.

How to add rules from now on:
- Claim the rule numbers as before (the next free number is the highest in tests.md and the directory, plus one; check open pull requests and the reservations in tests.md's status lines).
- Add `docs/system/tests/NNNN-slug.md` with the first new rule as NNNN, a heading, the branch's status line, the table header exactly as above, the rows in number order, and the branch's notes under it. Reserving a block for later is a range row (`| 790-808 | Reserved for ... |`) in the same file.
- A change to a rule that already has a row edits that row where it is, in tests.md or in its file.
- A test that reads a row uses `coverageRow(n)`.

Pull requests opened before this change: rows they already added to tests.md (787 profile fields, 775 home scenes, 776-777 admin badge, 790-808 agent scope part B, 810-866 model routing, 870-899 admin shell, and any other) may stay there; the tests accept a row in either place and only refuse a number used twice. Moving those rows into a file of their own when the pull request next merges main removes their remaining conflicts. Nothing in tests.md moved, so no open pull request's tests.md edits conflict with this change beyond the usual: this change edits row 772 in place and adds one paragraph after the legend.

Not pinned: a new row added to tests.md (the open pull requests above still add theirs, so a test cannot refuse it yet); the status line and notes of a file are free text.

Rule 772 (CI minutes), changed on this branch: the push to main runs only the unit tests. Vercel still makes a production deployment of every commit on main and its Deployment Check (on since 2026-09-18, `docs/Owner_Tasks_AR.md`) waits for `Nashr CI` on that commit; on 2026-10-09 main's commit `8dab9ea` showed Vercel's status "Checks for Deployment have failed" next to the failed `Nashr CI` run, so the check is live. With no run on main that deployment would wait forever, so a cheap run stays (install, unit tests, and once per Playwright version a browser download that seeds the cache every pull request can read). Once the founder removes the Deployment Check in Vercel (the live site is Hostinger, from `production`), the `push` trigger can go. Next's build cache (`.next/cache`, Turbopack's persistent build cache is on by default since Next 16.3) is cached per pull request: the first run of a pull request builds cold, later pushes start warm. Playwright's browsers are cached by version; a hit still installs the system packages (`playwright install-deps`). The test runs the Scope step's shell in throwaway repositories as before and pins the cache keys, paths and step conditions; it was checked to fail with the push run's build turned back on.
