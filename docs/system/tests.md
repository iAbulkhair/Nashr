# Test coverage map

Status on 2026-09-20: Vitest is set up (`npm test`, 18 files, 123 tests, under two seconds, memory store only, no network or model calls) and `.github/workflows/ci.yml` runs type-check, lint and tests on every push and pull request. First green run: commit `21ccd57` on 2026-09-18 (npm ci, type-check, whole-repo lint with 0 errors, 52 tests). Vercel still deploys from Git on its own: a red CI run does not block production until the "Nashr CI" check is added under Vercel Settings > Build and Deployment > Deployment Checks. Rules without a test below are still unverified.

Legend: **test** = pinned by an automated test in `tests/` · **none** = nothing verifies the rule today · **manual** = checked by hand once (date) · **live** = guarded by a production probe.

| # | Rule (source: docs/system/permissions.md, flows.md) | Verified today | First test to write |
|---|---|---|---|
| 1 | A user can never read or change another workspace's tasks, files, conversations, brand or connections | test (`routes-isolation.test.ts`: another account's task id is 404 on PATCH, image, pptx and publish; lists, files, conversations, search and brand show only the caller's; ids and scopes in the body are ignored; 401 without a session) | done |
| 2 | Emails containing `:` or `#` are rejected at signup (key collision) | test (`auth-rules.test.ts`) + manual on prod | unit test on `validEmail` |
| 3 | Chat `publish_item` refuses items that are not approved | test (`routes-onboard-publish.test.ts`: `runTool("publish_item")` refuses pending and rejected items, the manual route refuses rejected items and wrong targets) | done |
| 4 | User-supplied URLs never reach loopback, private, link-local or metadata addresses, including through redirects | test (`safe-fetch.test.ts`: 22 blocked spellings, redirect into a private address, redirect cap) | unit tests on `assertPublicUrl` and a redirect-hop test on `safeFetch` |
| 5 | Credits: charge before the model call, refund on failure, never negative, no double spend under concurrency | test (`credits.test.ts`: charge, refusal, refund, floor at zero, 12 concurrent charges on a balance of 50) | unit tests on `credits.ts` with the memory store and parallel charges |
| 6 | Admin routes reject everyone except founders and the admin key; the key is never accepted in the URL | test (`routes-admin-cron.test.ts`: every `/api/admin/*` handler refuses anonymous callers, customers, the key in the URL and a wrong header key; accepts the header key and a founder session) + manual on prod | done |
| 7 | Cron routes require the exact bearer secret | test (`routes-admin-cron.test.ts`: missing, wrong, empty and unset secret are 401 on all three; daily runs with the right one) | done |
| 8 | Login throttles per IP and per account; signup per IP; forgot, reset and admin key login are throttled | test for login (`routes-auth.test.ts`: 8 per account, 20 per IP, window reopens) and forgot (3 links per account); signup and admin key login still manual | done |
| 9 | Password reset token is single use, expires in one hour, never reveals whether the email exists | test (`routes-auth.test.ts`: same answer for known and unknown email, token stored hashed, single use, dead after one hour, no token without mail) | done |
| 10 | One password rule (8+, a letter, a digit) on signup, change and reset | test (`auth-rules.test.ts`) + manual on prod | unit test on `strongPassword` |
| 11 | Suspended accounts are blocked in the app, in MCP and in cron | test (`routes-auth.test.ts`: `currentUser`, `userFromBearer`, `allUsers`, login) | done |
| 12 | Impersonation lasts two hours and its session is destroyed on return | test (`routes-admin-cron.test.ts`: temporary session expires after two hours, return burns it and restores the founder's) | done |
| 13 | Account deletion removes connector records, sessions index entry and the users index entry | test (`routes-onboard-publish.test.ts`, `task-index.test.ts`) | done |
| 14 | Onboarding runs once per workspace and at most three times a day per account, and never charges credits | test (`routes-onboard-publish.test.ts`: once per workspace, three a day per account, credits unchanged) | done |
| 15 | Markdown renderer never emits an attribute or tag from user or model text | test (`output-safety.test.ts`) | unit tests on `render` with link, quote and tag payloads |
| 16 | CSV exports neutralise formula cells and keep phone numbers intact | test (`output-safety.test.ts`) | unit test on `csvSafe` |
| 17 | Judge and reviewer parse a single JSON object, fenced JSON and bracketed placeholders | test (`output-safety.test.ts`) | unit tests on `parseObjectArray` |
| 18 | MCP OAuth: PKCE required, codes single use, redirect_uri bound to the registered client | test (`revocation.test.ts`: PKCE required, redirect bound to the client, code single use and burned by a failed try, unknown scopes never written) | token endpoint client authentication |
| 19 | Chat stream sends a heartbeat every 10 s and the client recovers a saved reply after a drop | none | integration test with a slow fake model |
| 20 | Weekly and daily cron serve every eligible user within the function time limit | test for the runner (`cron-batch.test.ts`: concurrency, budget, done markers, retries, chain cap, Sunday key); daily verified on prod 2026-09-18 (12 of 12, second run skipped all); weekly first real run is Sunday 2026-09-20 | fix first, then a test with 50 fake users and a fake model |
| 21 | Light task index: no body in a row, follows every save, survives parallel saves, sees past the 200 newest tasks, reads only the months of the window, indexes old workspaces once, rebuild repairs drift, never mixes workspaces; KPIs and edit metrics computed from it match the tasks | test (`task-index.test.ts`) | done |
| 22 | Lists that only grow are trimmed on write; account deletion removes every task and the whole index, not only the newest 200 | test (`task-index.test.ts`) | done |
| 23 | Onboarding parts: every output key is asked for by exactly one of the three parallel calls; each part requires its keys and allows nothing else | test (`onboard-parts.test.ts`); the split itself is not measured on prod yet | time a real onboarding before and after |
| 24 | Sessions issued before a password change, reset or founder reset stop working (legacy records included); the changing device keeps a fresh session; the password write does not undo a concurrent credit charge | test (`revocation.test.ts`) | done |
| 25 | OAuth grants: listed without tokens, revoked at once, another account's grant id is a 404, refresh keeps one grant and kills the previous access token, a reset revokes all | test (`revocation.test.ts`) | done |
| 26 | Pages and customer API routes pass the active scope, never the bare account email, to workspace readers | test (`scope-usage.test.ts`, static) | done |
| 27 | A whole customer path holds together: sign up, onboard, generate, approve with an edit, publish, and the pending count, the light index and the credit balance follow each step | test (`e2e-journey.test.ts`) | done |
| 28 | An MCP bearer token works in the brand the owner has active, not always the default one | test (`e2e-journey.test.ts`: an agency account's second brand; `regressions` for the scope itself) | done |
| 29 | A password change from Settings kills every other session **and** every MCP token and OAuth grant, exactly as a reset does | test (`e2e-journey.test.ts`) | done |
| 30 | Deleting a workspace file or a connection removes it from its index, not only its record | test (`regressions.test.ts`) | done |
| 31 | `update_brand` from a tool call writes only the allowlisted text fields; arrays (`channels`, `languages`) and structures are owner-only | test (`regressions.test.ts`) | done |
| 32 | The public write endpoints (`/api/waitlist`, `/api/support`, `/api/affiliates`) are throttled per IP | test (`regressions.test.ts`) | done |
| 33 | Chat is bounded per account (40/hour, 200/day) on the web route and on MCP `ask_noor` | test (`regressions.test.ts`: the ceiling and the 429) | the MCP side of the ceiling |
| 34 | The Shopify OAuth callback refuses a shop that is not a `myshopify.com` host before the client secret is posted to it | test (`regressions.test.ts`) | done |
| 36 | Every task the approvals badge counts is reachable in the inbox, past the 200 newest tasks: buried pending items are returned with their bodies, never duplicated, newest-first and stably ordered, and a pending id whose record is gone is cleared rather than counted | test (`pending-reachable.test.ts`) | done |
| 35 | Token cost is recorded per kind of call per account, so the cost of one request type is a read | test (`e2e-journey.test.ts`: generate/review/judge, arithmetic against the rates in `src/lib/usage.ts`) | done |
| 37 | Dates are formatted through `dateFormat` in `src/lib/dates.ts`: never the `ar-SA` locale, always UTC, and no direct `Intl.DateTimeFormat` outside `dates.ts` and the deliberate Hijri lookup in `seasons.ts` | test (`date-locale.test.ts`: the resolved calendar and time zone, plus a scan of every file under `src/`) and E2E (`app-routes.spec.ts` fails the route on any browser console error) | done |

Route-level tests call the real handlers. `tests/helpers/setup.ts` replaces `next/headers` cookies with a jar the test controls and runs `after()` at once; `tests/helpers/session.ts` has `signIn(email)` (a real `session:{token}` record plus its cookie), `signOut()`, `newUser()`, `json()`, `params()` and `settle()`. The memory store honours TTL since 2026-09-18, so expiry rules are testable with fake clocks. Each rule above was checked once by breaking the code and watching the test fail (publish gate, task scope, suspended check, admin check).

Rule 36 was added on 2026-09-20 with the fix it pins, and checked the same way: reverting `listTasks` fails four of its seven tests. It also corrected `task-index.test.ts`, whose 230 all-pending fixture asserted that `listTasks` returned only 200 of them — the defect written down as a pin; those tasks are now created decided, so the test still pins what it was for.

Rule 37 was added on 2026-09-20 for a hydration failure that only Safari saw. `/ar/app/calendar` asked for `ar-SA`,
which WebKit's system ICU resolves to the Umm al-Qura calendar and Node's bundled ICU resolves to the Gregorian one, so
the server sent "20 سبتمبر" and the iPhone rendered "9 ربيع الآخر" above Gregorian day numbers. React threw the whole
tree away (error #418). Two separate causes were confirmed by running the same formatter in both engines: the calendar
divergence above, and the abbreviated Arabic weekday, which is "الأحد" in Node's CLDR and "أحد" in WebKit's whatever
locale is asked for. The first is fixed, the second cannot be — it is data, not configuration — so the three elements
that render `Intl` output inside a client component carry `suppressHydrationWarning`, scoped to their own text.

Rules 27-35 were added on 2026-09-20 with the fixes they pin; each was checked by reverting its fix and watching the test fail (six of them did; the admin-cookie comparison has no observable behaviour difference, so its test guards behaviour only, not the constant-time property).

Next: rule 19 (chat heartbeat), the token endpoint's client authentication, and a cron test with 50 fake users.
