# Coverage: cron routes pass the staging lock (rules 4840-4842, 4843-4849 reserved)

Status on 2026-10-26 on branch `claude/staging-cron-open` (from `main` 886f9273). Flow in `flows.md` section 51 step 9; `permissions.md` "Staging visitor"; `architecture.md` `staging-access.ts`. Release step: none of rule 679 (no stored shape changes). Staging only: on the live site the lock never runs, so nothing changes there.

Why: the staging queue cron (`*/15`, `GET /api/cron/queue`) answered 404 on 2026-10-26 because the lock demanded the `thakeen_staging` cookie, and a cookie copied into the cron header file breaks at every change of `STAGING_ACCESS_KEY`. The founder chose to open the cron routes on the condition of the `CRON_SECRET` bearer.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 4840 | On staging, `/api/cron/{name}` (exactly one lowercase segment, `^/api/cron/[a-z]+$`) passes the lock without the cookie and still carries `X-Robots-Tag: noindex, nofollow`; `/api/cron`, `/api/cron/`, a deeper path, a trailing slash, another case and look-alike prefixes stay a bare 404 | yes | `tests/staging.test.ts` ("rules 4840-4842" block) |
| 4841 | Every route under `src/app/api/cron/` has a lowercase one-segment name and compares the bearer with `sameSecret(bearer, process.env.CRON_SECRET)`, so a new cron route that skips the check fails the test | yes (source) | `tests/staging.test.ts` ("rule 4841" block) |
| 4842 | The other open paths are unchanged: the four exact paths and `/m/` (rule 1760); everything else without the cookie is a bare 404 | yes | `tests/staging.test.ts` (rules 674, 677 and 1760 blocks) |
| 4843-4849 | Reserved | | |

Not verified today: the hPanel cron's answer after the merge (expected 200 `{ok:true, off:true}` while `QUEUE` is off).
