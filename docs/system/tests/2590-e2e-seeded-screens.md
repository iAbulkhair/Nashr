# Coverage: the held-routine and cron-count screens in a real browser (rules 2590-2594)

Status on 2026-10-21 on branch `claude/e2e-seeded-screens`, on the founder's "do 1 to 5" (item 5: a real browser test for the two screens of the paid-cron work, #404, that only render tests reached, `docs/system/tests/2530-held-routine-screens.md`). Rules 2595-2599 are held for this work and unused.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2590 | The end-to-end server's memory store starts with `E2E_SEED_KV` (a JSON object of key to value), read once in `seedForE2e` when the store is first made and only while `isTestServer()` (`APP_ENV=test`, not a production deploy); anything that is not a JSON object is ignored without throwing; Upstash is never seeded | `tests/e2e-seed.test.ts` ("rule 2590") | — |
| 2591 | `e2eSeed(owner)` holds this month's Razan routine for the owner and stores a daily cron report with its heartbeat, through the app's own key builders; `routinesHeld` and `cronStatuses` read both | `tests/e2e-seed.test.ts` ("rule 2591") | — |
| 2592 | `playwright.config.ts` starts the server with `E2E_SEED_KV: e2eSeed(OWNER.email)` beside `APP_ENV=test` and the per-run console key | `tests/e2e-seed.test.ts` ("rule 2592"), `tests/ci-build-once.test.ts`, `tests/launch-security.test.ts` | — |
| 2593 | In a browser, Scheduled tasks shows the held routine, and only it, with its note in Arabic and English, and its Run button posts `{run: "routine", id}` and gets 200 (`skip:mock`, the model being mocked: the resume itself is rule 2479) | `e2e/held-routine.spec.ts` ("rule 2593") | — |
| 2594 | In a browser, the console's key session opens Usage, and the daily job shows its last report's counts under its heartbeat, in both languages | `e2e/held-routine.spec.ts` ("rule 2594") | — |

## Notes

- The two founder options named in #413 were a test-only seeding route (a new attack surface) or test credentials. This takes neither route: no request can seed anything; the records are loaded at start-up into the memory store, which production never runs (rule 430). The console key is #417's per-run random key.
- Checked by hand on 2026-10-21: with the seed the three browser tests pass; started without it (`E2E_SEED_KV` empty) all three fail.
- Rule 1209 still holds: `APP_ENV` is read only in `src/lib/deploy-env.ts` (`isTestServer`) and `src/lib/verify-email.ts`.
- No stored shape, route or permission changes; one new variable, `E2E_SEED_KV`, test server only (`docs/system/variables.md` section 1).
