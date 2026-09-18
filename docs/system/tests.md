# Test coverage map

Status on 2026-09-18 (evening): Vitest is set up (`npm test`, 6 files, 52 tests, under one second, memory store only, no network or model calls) and `.github/workflows/ci.yml` runs type-check, lint and tests on every push and pull request. First green run: commit `21ccd57` on 2026-09-18 (npm ci, type-check, whole-repo lint with 0 errors, 52 tests). Vercel still deploys from Git on its own: a red CI run does not block production until the "Nashr CI" check is added under Vercel Settings > Build and Deployment > Deployment Checks. Rules without a test below are still unverified.

Legend: **test** = pinned by an automated test in `tests/` · **none** = nothing verifies the rule today · **manual** = checked by hand once (date) · **live** = guarded by a production probe.

| # | Rule (source: docs/system/permissions.md, flows.md) | Verified today | First test to write |
|---|---|---|---|
| 1 | A user can never read or change another workspace's tasks, files, conversations, brand or connections | none | API test: two accounts, every id-taking route returns 404 for the other account's ids |
| 2 | Emails containing `:` or `#` are rejected at signup (key collision) | test (`auth-rules.test.ts`) + manual on prod | unit test on `validEmail` |
| 3 | Chat `publish_item` refuses items that are not approved | none (code read) | unit test on `runTool("publish_item")` with a pending task |
| 4 | User-supplied URLs never reach loopback, private, link-local or metadata addresses, including through redirects | test (`safe-fetch.test.ts`: 22 blocked spellings, redirect into a private address, redirect cap) | unit tests on `assertPublicUrl` and a redirect-hop test on `safeFetch` |
| 5 | Credits: charge before the model call, refund on failure, never negative, no double spend under concurrency | test (`credits.test.ts`: charge, refusal, refund, floor at zero, 12 concurrent charges on a balance of 50) | unit tests on `credits.ts` with the memory store and parallel charges |
| 6 | Admin routes reject everyone except founders and the admin key; the key is never accepted in the URL | manual 2026-09-18 on prod | API test over every `/api/admin/*` route |
| 7 | Cron routes require the exact bearer secret | none | API test |
| 8 | Login throttles per IP and per account; signup per IP; forgot, reset and admin key login are throttled | manual 2026-09-18 on prod (login) | API tests per route |
| 9 | Password reset token is single use, expires in one hour, never reveals whether the email exists | none | API test with the memory store |
| 10 | One password rule (8+, a letter, a digit) on signup, change and reset | test (`auth-rules.test.ts`) + manual on prod | unit test on `strongPassword` |
| 11 | Suspended accounts are blocked in the app, in MCP and in cron | none | unit tests on `currentUser`, `userFromBearer`, `allUsers` |
| 12 | Impersonation lasts two hours and its session is destroyed on return | none | API test |
| 13 | Account deletion removes connector records, sessions index entry and the users index entry | none | unit test on `wipeAccount` with the memory store |
| 14 | Onboarding runs once per workspace and at most three times a day per account, and never charges credits | none | API test |
| 15 | Markdown renderer never emits an attribute or tag from user or model text | test (`output-safety.test.ts`) | unit tests on `render` with link, quote and tag payloads |
| 16 | CSV exports neutralise formula cells and keep phone numbers intact | test (`output-safety.test.ts`) | unit test on `csvSafe` |
| 17 | Judge and reviewer parse a single JSON object, fenced JSON and bracketed placeholders | test (`output-safety.test.ts`) | unit tests on `parseObjectArray` |
| 18 | MCP OAuth: PKCE required, codes single use, redirect_uri bound to the registered client | none (audit read it as sound) | API tests on `/api/oauth/*` |
| 19 | Chat stream sends a heartbeat every 10 s and the client recovers a saved reply after a drop | none | integration test with a slow fake model |
| 20 | Weekly and daily cron serve every eligible user within the function time limit | test for the runner (`cron-batch.test.ts`: concurrency, budget, done markers, retries, chain cap, Sunday key); daily verified on prod 2026-09-18 (12 of 12, second run skipped all); weekly first real run is Sunday 2026-09-20 | fix first, then a test with 50 fake users and a fake model |

Next: rules 1, 6, 8, 9, 12, 13 and 14 as route-level tests against the memory store (they need a small helper that fakes the session cookie), rule 3 once `runTool` is exported for testing, then add the "Nashr CI" Deployment Check in Vercel so a red run blocks production.
