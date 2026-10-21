# Coverage: the held-routine and cron-count screens, rendered (rules 2533-2535)

Status on 2026-10-20 on branch `claude/e2e-held-routine`. The two screens of the paid-cron work (#404, rules 2479 and 2484-2485, `docs/system/tests/2470-paid-cron-held.md`) that the browser check of that pull request could not reach. Rules 2533-2539 are held for this work and unused.

The rules were numbered 2530-2532 when they merged (#413); they moved to 2533-2535 because #415 already used 2530-2532 (2026-10-21).

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2533 | Scheduled tasks shows a held routine, and only it, with the held note and a Run button, in Arabic and English; a read-only member still gets Run | `tests/held-routine-screens.test.ts` ("rule 2533") | A browser test, once the end-to-end server can stage a held run (see Notes) |
| 2534 | The founder's Usage page shows each job's last batch counts under its heartbeat (`CronList`, `data-cron-report`), only for a job with a report, in both languages | `tests/held-routine-screens.test.ts` ("rule 2534") | A browser test, once the end-to-end server can run a cron and sign the founder in |
| 2535 | The Usage section renders the list through the extracted `CronList` (no change in what it shows) | `tests/held-routine-screens.test.ts` ("rule 2535"); rule 1015's pins in `tests/monitoring-ci-parity.test.ts` still pass | — |

## Notes

- Why not a browser test: a held routine needs a run killed more than 10 minutes earlier, and the page is rendered on the server, so the browser cannot fake it. The cron counts need a cron run and a founder sign-in. The end-to-end server runs with `APP_ENV=test` only: no cron secret, no admin credentials, and no route that writes test data. Either one is a founder decision: a test-only seeding route (gated like `devCodeExposed`, a new attack surface), or test values for the cron secret and the founder key in the end-to-end server's environment.
- The render tests fail when the held block is removed (checked by hand on 2026-10-20). The Run request itself is pinned by `tests/paid-cron-held.test.ts` (rule 2479).
- No stored shape, route, permission or environment variable changes.
