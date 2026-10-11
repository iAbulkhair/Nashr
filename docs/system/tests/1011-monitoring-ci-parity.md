# Coverage: monitoring, store health, cron heartbeats and CI parity (rules 1011-1019)

Status on 2026-10-11 on branch `claude/monitoring-ci-parity` (no PR). Rules 987-1010 are taken by drafts #319 and #320, so this change starts at 1011. Flows section 62. Findings F-004, F-017 and B-001 of the 360 study.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 1011 | `GET /api/health` without a query is exactly `{ ok, commit, built }` and reads no key. `?store=1` is public, shares the 60-a-minute limiter, reads one key, adds only `store: { ok, ms }`, and is 503 with `ok: false` when the read fails or hangs past 2 s, naming no key, host or error | `tests/monitoring-ci-parity.test.ts` (rule 1011 block), `tests/health.test.ts` for the plain answer | — |
| 1012 | `?crons=1` needs `Authorization: Bearer ${CRON_SECRET}` compared with `sameSecret`: 401 `{ ok: false }` without it, with a wrong one, and when the secret is unset; the limiter counts the call first; the public answer never carries `crons` | `tests/monitoring-ci-parity.test.ts` (rule 1012 block) | — |
| 1013 | `?crons=1` is 503 when the store is down or a job is late (older than `CRON_MAX_AGE_SEC`), 200 otherwise; a job with no heartbeat is `waiting`, not late; a job exactly at its limit is on time | `tests/monitoring-ci-parity.test.ts` (rule 1013 block) | — |
| 1014 | Each of the eight cron routes records `cronbeat:{job}` after it authenticates and finishes, and not on a 401 or a 409; a store that fails the write does not fail the cron; the job list equals the route directories; every `vercel.json` path is covered and every limit exceeds its schedule's gap | `tests/monitoring-ci-parity.test.ts` (rule 1014 block: stores, weekly, daily, evening run for real; golden checked for the 409; the rest by source check) | A real `media`, `routines` and `secretary` run asserting the key, once those routes have a harness |
| 1015 | `GET /api/admin/overview` carries `crons` (one entry per job; empty when the store cannot be read) and the Usage page renders it; no new admin route | `tests/monitoring-ci-parity.test.ts` (rule 1015 block); the rendering is a source check | A component test of the red "late" state |
| 1016 | The founder's uptime monitor is documented by URL, keyword, interval and alert address (flows section 62); the code holds no monitoring vendor, key or address | `tests/monitoring-ci-parity.test.ts` (rule 1016 block) | — |
| 1017 | CI uses Node 22 and runs `npm run build:hostinger` (`next build --webpack`) in the one Build step; the end-to-end server is built with the same script; no second job, no matrix | `tests/monitoring-ci-parity.test.ts` (rule 1017 block), `tests/ci-workflow.test.ts` (rule 772, unchanged) | — |
| 1018 | No store command in a loop on the new paths: `cronStatuses` is one `MGET`, `recordCronRun` one `SET`, the health route has no loop | `tests/monitoring-ci-parity.test.ts` (rule 1018 block, source check) | — |
| 1019 | Permissions row 153, architecture (heartbeats, health, Build row), variables (`CRON_SECRET`) and flows section 62 name the change; the new code reads no environment variable beyond `BUILD_COMMIT`, `BUILD_TIME` and `CRON_SECRET` | `tests/monitoring-ci-parity.test.ts` (rule 1019 block) | — |

## Notes

- Nothing stored changes shape: `cronbeat:{job}` is a new key, written by the new code and read by nothing older. Release step: none (rule 679 not involved). The first day after the release every job shows `waiting` on the Usage page until its next run.
- The webpack build in CI is slower than Turbopack's; read the first run's time and say so in the pull request. The Vercel project's own build is not touched.
- Production behaviour that the unit tests cannot show: that hPanel and QStash keep calling the crons (the heartbeat shows it after a day), that Redis answers in under 2 s from Hostinger, and that the uptime monitor reaches `/api/health?store=1` past the hcdn cache (the route sends `no-store`).

## Not pinned

- No email or message is sent when a cron is late. The Usage page and the bearer check say so; telling the founder needs the external monitor (flows section 62, item 5) or a follow-up change that mails from `daily`.
- `golden` is checked for the 409 branch only when the test environment has no model key; with a key it would start a real run, so that case asserts only the 200.
- Backups of the store (F-005) are not part of this change.
