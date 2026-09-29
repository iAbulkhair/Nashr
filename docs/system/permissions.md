# Nashr: permissions (as implemented)

What the code enforces today, at HEAD `4959f7e`, with the media routes of 2026-09-29 (rows 39 and 92-96, section 3.2, section 5 items 17, 20 and 26), the review fixes of the same day (rows 38 and 48, section 3.2, section 5 items 13, 24 and 27), and main's changes of the same day merged into them: the agent-team steps 1 and 2 (rows 18, 20, 21, 31, 32, 38, 39, 48, 53 and 91, section 3.1 items 6 and 7, section 5 items 6, 17 and 18) and the shared-link onboarding fix (rows 33 and 33a, the chat page in section 2), and phase 1 of Reem, the secretary (rows 30, 53 and 101-103, the `todo` page in section 2, section 3.2, and the section "Reem, the secretary" at the end), with its review fixes of the same day (rows 30, 53, 88 and 102-103, section 3.2, section 5 item 6, items 2 and 4-7 of the Reem section), then the five fixes from the Taskuary comparison (rows 9 and 101-103, section 3.2, items 5 and 7-10 of the Reem section), and the `file:line` references into the files they moved re-derived. Paths are relative to the repository root; API route files are under `src/app/api/` and are written without that prefix in the tables. `file:line` points at the line where the check happens.

## 0. Actors and the functions that identify them

| Actor | How the code identifies it | Function |
|---|---|---|
| Anonymous | No check | none |
| Signed-in user | Cookie `nashr_session` to `session:{token}` to `user:{email}`; rejects missing and `suspended` users; attaches `brandId` and `scope` | `currentUser()` `src/lib/auth.ts:99-111` |
| Workspace owner of the resource | Same as signed-in user, and the record is read under the caller's own scope `sc(u)` (`src/lib/auth.ts:32`) so ids from the request only resolve inside that scope. There is no membership or role model: one account owns its brands and nobody else can be granted access. | `sc(u)` plus the scoped getters in `src/lib/brand.ts`, `files.ts`, `conversations.ts`, `connectors/store.ts` |
| Founder admin | `WAITLIST_ADMIN_KEY` presented as `?key=`, header `x-admin-key`, or cookie `nashr_admin`; or a signed-in user whose email is in `ADMIN_EMAILS` | `isAdmin(req)` `src/lib/auth.ts:120-131` (APIs), `isAdminCookie()` `src/lib/auth.ts:134-142` (pages) |
| Cron | Header `Authorization: Bearer ${CRON_SECRET}`; denied when the variable is unset | inline in each cron route |
| MCP bearer | Header `Authorization: Bearer nashr_...` to `mcptoken:{token}` to `user:{email}`; refuses a `suspended` account and sets `scope` from the active brand like a session | `userFromBearer(req)` `src/lib/mcp.ts:25-39` |

There is no global guard. `src/proxy.ts` does not authenticate (`src/proxy.ts:15-30`); every handler enforces its own rule, and a handler without a check is public.

## 1. API routes (71 route files, 109 exported handlers)

Counted on 2026-09-29 after main was merged into the media change: `find src/app/api -name route.ts | wc -l` gives 66 and `grep -rhoE "export (async )?function (GET|POST|PUT|PATCH|DELETE|OPTIONS)" src/app/api | wc -l` gives 102 (5 of them `OPTIONS`). Before the media change the tree had 59 files and 95 handlers while this heading said 57 and 90; the media change added 5 files and 5 handlers (rows 92-96), and main added 2 of each the same day (`onboard/confirm`, row 33a, and `cron/routines`, row 91; main's heading said 60 and 91). Rows 56d and 56e (`mcp/grants`) were missing and are added below. The updates and wishlist change added 3 files and 4 exports (rows 97-100), giving 69 and 106. Reem's phase 1 added 2 files and 3 exports (rows 101-103), giving 71 and 109.

Legend for "Who": A = anonymous, U = signed-in user, O = workspace owner of the addressed resource (U plus scope binding), F = founder admin, C = cron secret, M = MCP bearer token.

### 1.1 Auth and account

| # | Method | Path | Who | Enforced by |
|---|---|---|---|---|
| 1 | POST | `/api/auth/signup` | A | No auth. Validation only: `auth/signup/route.ts:9-13`. No rate limit. |
| 2 | POST | `/api/auth/login` | A | Password check `auth/login/route.ts:8`; suspended block `:9`. No rate limit. |
| 3 | POST | `/api/auth/logout` | A | No check; `destroySession()` acts on the caller's own cookie `auth/logout/route.ts:5`. |
| 4 | POST | `/api/auth/forgot` | A | Rate limit `auth/forgot/route.ts:23` (`allow`, `src/lib/rate.ts:5`). |
| 5 | POST | `/api/auth/reset` | A holding a valid reset token | Rate limit `auth/reset/route.ts:11`; token lookup `:15-18`; suspended block `:20`. |
| 6 | PATCH | `/api/account` | U plus current password | `currentUser` `account/route.ts:9-10`; `verifyPassword` `:13`. |
| 7 | DELETE | `/api/account` | U plus password | `currentUser` `account/route.ts:20-21`; `verifyPassword` `:23`. Wipes the caller's own email only `:24`. |

### 1.2 Workspace data (all scope-bound through `sc(u)` unless noted)

| # | Method | Path | Who | Enforced by |
|---|---|---|---|---|
| 8 | GET | `/api/brand` | O | `currentUser` `brand/route.ts:8-9`; `getBrand(sc(u))` `:10`. |
| 9 | PUT | `/api/brand` | O | `currentUser` `brand/route.ts:14-15`; `saveBrand(sc(u))` `:41`. Since 2026-09-29 `timeZone` is stored only when it is one of the six zones in `src/lib/zones.ts` (`isZone`, `:39`); anything else is dropped, and every reader falls back through `zoneOf`. |
| 10 | GET | `/api/brands` | U (own brand list) | `currentUser` `brands/route.ts:8-9`; keyed by `u.email` `:10`. |
| 11 | POST | `/api/brands` | U; brand `id` must exist in the caller's own list | `currentUser` `brands/route.ts:20-21`; `listBrands(u.email)` and `find` `:27-29`; plan limit in `addBrand` `src/lib/brands.ts:33`. |
| 12 | GET | `/api/profile` | U | `currentUser` `profile/route.ts:9-10`. |
| 13 | PUT | `/api/profile` | U | `currentUser` `profile/route.ts:33-34`. Editable user fields are whitelisted to `name`, `phone`, `lang` `:36-38`. |
| 14 | GET | `/api/files` | O | `currentUser` `files/route.ts:6-7`; `readFile/listFiles(sc(u))` `:9-10`. |
| 15 | PUT | `/api/files` | O | `currentUser` `files/route.ts:13-14`; name sanitized by `safeName` `src/lib/files.ts:9`. |
| 16 | DELETE | `/api/files` | O | `currentUser` `files/route.ts:20-21`. |
| 17 | GET | `/api/governance` | O | `currentUser` `governance/route.ts:6-7`. |
| 18 | PUT | `/api/governance` | O | `currentUser` `governance/route.ts:11-12`; written to `gov:{sc(u)}` only. `saveGov` validates every field (2026-09-29): `autoApprove` keys must be task types with boolean values, `agentCaps` keys must be agent ids with finite values (truncated, clamped 0..100000; `null` or "" removes a cap), NaN never replaces `weeklyCap` or `notifyMinutes`, unknown keys and a non-object body change nothing. |
| 19 | GET | `/api/schedule` | O | `currentUser` `schedule/route.ts:9-10`. |
| 20 | PUT | `/api/schedule` | O | `currentUser` `schedule/route.ts:14-15`. Writes `schedule:{sc(u)}` only; scope-like body fields are ignored. Routine switches (`routines: {id: boolean}`) keep only ids in `ROUTINES` (membership test, not `in`) with boolean values and are merged per id; a non-object body changes nothing. |
| 21 | POST | `/api/schedule` | O | `currentUser` `schedule/route.ts:32-33`. Runs weekly (charges credits) or daily for the caller. Routines have no "Run now": they run only from the cron. |
| 22 | GET | `/api/brief` | O | `currentUser` `brief/route.ts:6-7`. |
| 23 | GET | `/api/notifications` | U (account level, keyed by `u.email`) | `currentUser` `notifications/route.ts:6-7`. |
| 24 | POST | `/api/notifications` | U | `currentUser` `notifications/route.ts:14-15`. |
| 25 | GET | `/api/conversations` | O | `currentUser` `conversations/route.ts:7-8`. |
| 26 | POST | `/api/conversations` | O | `currentUser` `conversations/route.ts:14-15`. |
| 27 | PATCH | `/api/conversations` | O; `id` from body resolved under `sc(u)` | `currentUser` `conversations/route.ts:20-21`; `renameConversation(sc(u), id)` `:24`. |
| 28 | DELETE | `/api/conversations` | O; `id` from query resolved under `sc(u)` | `currentUser` `conversations/route.ts:28-29`; `deleteConversation(sc(u), id)` `:32`. |
| 101 | GET | `/api/secretary` | O | `currentUser` first (401); `allow("sec:read:{email}", 600, 3600)` (429); `agendaFor(sc(u))` (the agenda computed now, with the approvals count; items whose linked inbox task under `sc(u)` is approved are closed by code first), or `?view=done` (`listDone`) / `?view=deleted` (`listDeleted`, restorable only). |
| 102 | POST | `/api/secretary` | O | `currentUser` first (401); `createItem` in `src/lib/secretary.ts`: fields typed, cleaned (control and direction-override characters removed) and bounded (title 200, description 2000, party 80; too long is 400, never cut), dates parsed in the brand's zone (`zoneOf`, Riyadh by default) and refused when impossible or outside a year back to five years ahead; then `allow("sec:create:{email}", 200, 86400)` per account across its brands (429), at most 500 open items per brand (409 `open_limit`), and a `taskId` must be a task of `sc(u)` (400 `unknown_task`). An `id`, `scope`, `email`, `source`, `rev` or state field in the body is ignored. The owner may link any task of the brand; chat and MCP `todo_create` only a `pending` one (400 `link_not_pending`). A they-owe item without a date gets `expectBy` (two working days in the brand's zone, or the date sent). Free: no credits, no model call. |
| 103 | PATCH | `/api/secretary/{id}` | O; `id` must match `^s[a-f0-9]{16}$` before any key is built and resolve under `sc(u)` | `currentUser` first (401); format check (404); `allow("sec:write:{email}", 600, 3600)` (429); `parseOwnerChange` validates the action and its arguments; `changeItem(sc(u), id, …, {actor: "owner", via: "web"}, rev)` under `sec:lock:{scope}:{id}` (another account's id is 404 and untouched; a stale `rev` is 409 `conflict` with the current item). The only route that completes (a written result is required), confirms or rejects a proposed "done", deletes (soft, 30 days) or restores (410 after expiry; 409 `open_limit` when the restore would reopen an item past 500 open items). A `scope` or `email` in the body is ignored: the scope is `sc(u)`. Changing an item's `taskId` is the owner's here only. `{action: "chased"}` records a follow-up (`lastChasedAt`, a `chased` note) on someone else's item and never closes it (409 `not_theirs` on the owner's own). Dates are read in the brand's zone (`zoneFor`). |

### 1.3 Agents, content, tasks

| # | Method | Path | Who | Enforced by |
|---|---|---|---|---|
| 29 | GET | `/api/chat` | O; `conv` from query is a key suffix under `sc(u)` | `currentUser` `chat/route.ts:11-12`; `history(sc(u), conv)` `:14`. |
| 30 | POST | `/api/chat` | O | `currentUser` `chat/route.ts:23-24`. Tool side effects run under `user.scope` `src/lib/chat.ts:292`. Reem's four tools (`agenda_get`, `todo_create`, `todo_update`, `todo_propose_done`, offered to every agent) are free and cannot complete, delete or restore an item, change an item's inbox link or write a private note: `changeItem` and `mutateItem` refuse those unless the actor is the owner on the web (`owner_only`; a note from chat is stored shared). Their `scope` and `email` arguments are ignored (`sc(user)`). |
| 31 | POST | `/api/chat/feedback` | U | `currentUser` `chat/feedback/route.ts:8-9`; written to `fblog:{sc(u)}` `:13`. Since 2026-09-29 a thumbs-down reason reaches that agent's chat prompt in the same scope, escaped as data (`feedbackFor`, `src/lib/feedback.ts`), never generation, publishing, spending or the brand file. No rate limit; the prompt takes only the 5 newest reasons, 200 characters each. |
| 32 | POST | `/api/generate` | O | `currentUser` `generate/route.ts:16-17`; trial check `:23`; `missingData` (cart-recovery needs a synced store, 409 `no_cart_data` before any charge); `charge` with the owning agent and the owner's cap for it in `gov:{sc(u)}`, 402 `agent_cap` before any model call and without debiting (`flows.md` 8.9-8.10). |
| 33 | POST | `/api/onboard` | O | `currentUser` `onboard/route.ts:28-29`; builds only from the URL the owner confirmed, `onboardok:{sc(u)}` (403 `unconfirmed` `:39`, before the crawl, the model and the daily allowance); per-scope lock `:44`. |
| 33a | POST | `/api/onboard/confirm` | O | `currentUser` `onboard/confirm/route.ts:12-13`; writes only `onboardok:{sc(u)}` (1 day), 409 when the scope already has a brand `:18`. No crawl, no model call. Cross-site submission is stopped by the SameSite=Lax session cookie. |
| 34 | GET | `/api/onboard/plan` | O | `currentUser` `onboard/plan/route.ts:10-11`. |
| 35 | POST | `/api/onboard/plan` | O | `currentUser` `onboard/plan/route.ts:17-18`. |
| 36 | POST | `/api/catalog` | O | `currentUser` `catalog/route.ts:9-10`. Fetches a user-supplied URL server-side `:12,19`. |
| 37 | GET | `/api/tasks` | O | `currentUser` `tasks/route.ts:6-7`. |
| 38 | PATCH | `/api/tasks/{id}` | O; `id` resolved under `sc(u)` by `updateTask(sc(u), id, …)`; decision records appended to `decisions:{sc(u)}` only (the body cannot name a scope) | `currentUser` `tasks/[id]/route.ts:14-15`; the change is applied with `updateTask(scope, id, …)` `:29`, under `tasklock:{scope}:{id}`, to the task as stored (404 when there is none under the scope, `:58`); brand gate on an approved result `:52-55`, 409 with nothing saved `:59`; the decisions the change made are collected inside the update and recorded with `recordDecisions(scope, ...)` inside `after()`. |
| 39 | POST | `/api/tasks/{id}/image` | O | `currentUser` `tasks/[id]/image/route.ts:15-16`; task and brand under `sc(u)` `:18-19`; `renderImage` `:27` (`src/lib/media/start.ts`): trial ended 402, catalogue model of kind image (default `img-fast`) 400, `IMAGE_TYPES` 400, availability 409, or the uncharged placeholder card for `img-fast`, written through `updateTask` only onto an item without artwork (an item with a generated image keeps it: 409 `model_unavailable`, `start.ts:66`); the charge happens inside `startMedia` (`src/lib/media/jobs.ts`) after the balance pre-check, the flight lock, the per-account limits (30 per hour, 150 per day) and the provider throttle, against the agent that owns the item and the owner's monthly cap for it in `gov:{sc(u)}` (402 `agent_cap`, nothing charged); a refund returns the credit and the agent's counter. `maxDuration = 120`. |
| 92 | POST | `/api/tasks/{id}/video` | O | `currentUser` `tasks/[id]/video/route.ts:15-16`; task and brand under `sc(u)` `:18-19`; `renderVideo` `:25`: trial ended 402 `trial_over`, a catalogue video model (no default) 400, `VIDEO_TYPES` 400, a trial account and a model outside `TRIAL_VIDEO_MODELS` 402 `plan_required`, availability 409, Photo to motion without our image 409; in `startMedia`: one kept video per trial (`mtrialvid:{email}`, 402 `trial_video_used`), 6 per hour and 20 per day per account, then the charge (12 or 24 credits), against the agent that owns the item and the owner's monthly cap for it in `gov:{sc(u)}` (402 `agent_cap`, nothing charged); a refund returns the credits and the agent's counter. `maxDuration = 120`. |
| 40 | GET | `/api/tasks/{id}/pptx` | O | `currentUser` `tasks/[id]/pptx/route.ts:34-35`; scope lookup `:37-38`. |
| 41 | POST | `/api/tools/{tool}` | A (5 per IP per UTC day) or U (unlimited, no credit charge) | Anonymous counter `tools/[tool]/route.ts:15-20`. |

### 1.4 Connectors and publishing

| # | Method | Path | Who | Enforced by |
|---|---|---|---|---|
| 42 | GET | `/api/connect` | O | `currentUser` `connect/route.ts:7-8`. Returns connection metadata, never decrypted `data`. |
| 43 | DELETE | `/api/connect/{provider}` | O | `currentUser` `connect/[provider]/route.ts:11-12`; `deleteConnection(sc(u), provider)` `:14`. |
| 44 | POST | `/api/connect/{provider}` | O | `currentUser` `connect/[provider]/route.ts:20-21`; `getFreshConnection(sc(u), provider)`. Actions: `import_products` (Shopify, WooCommerce, Odoo, PrestaShop, Salla, Zid), `sync_sales` (Salla, Shopify, Zid), `select_page` (Meta; the Page id must be one Meta returned for this connection). For `meta_ads` and `snapchat`: `sync_ads` (read only, results saved under `sc(u)`) and `select_ad_account` (only an id the platform listed). |
| 45 | GET | `/api/connect/{provider}/start` | O | `currentUser` `connect/[provider]/start/route.ts:10-11`; scope written into state `:25`. |
| 46 | GET | `/api/connect/{provider}/callback` | O who started the flow: a valid, unused `state` issued for this provider, the matching `nashr_oauth` cookie, and a signed-in account that owns the state's scope | `currentUser` and `sameSecret(cookie, state)` in `connect/[provider]/callback/route.ts`, before any code exchange; Shopify also verifies the query `hmac`. Target scope comes from the state record. |
| 47 | POST | `/api/connect/{provider}/key` | O | `currentUser` `connect/[provider]/key/route.ts:12-13`; saved under `sc(u)` `:54`. |
| 48 | POST | `/api/publish/{id}` | O; `id` resolved with `getTask(sc(u), id)`; connection read under `sc(u)`; a `publish` decision recorded under `sc(u)` when the item was pending | `currentUser` `publish/[id]/route.ts:13-14`; scope lookup `:16-17`; rejected item 409 `:21`; brand gate 409 `:24-25`; `targetsFor` 400 `wrong_target` `:27`; `publishTask(sc(u), ...)` `:29`; the result written with `updateTask(sc(u), id, …)` `:34` to the task as stored after the publish; `recordDecisions(sc(u), ...)` `:49`, only when the stored item was pending. |
| 49 | GET | `/api/integrations` | A gets the static catalog; F gets the request list | `isAdmin` branch `integrations/route.ts:7`. |
| 50 | POST | `/api/integrations` | U | `currentUser` `integrations/route.ts:15-16`. |

### 1.5 MCP and the OAuth authorization server

| # | Method | Path | Who | Enforced by |
|---|---|---|---|---|
| 51 | OPTIONS | `/api/mcp` | A | CORS preflight `mcp/route.ts:53`. |
| 52 | GET | `/api/mcp` | A | Static descriptor `mcp/route.ts:56`. |
| 53 | POST | `/api/mcp` | A for `initialize`, `ping`, `notifications/initialized`, `tools/list` (`mcp/route.ts:66-68`); M for `tools/call` | `userFromBearer` `mcp/route.ts:70-71`. All data access uses `user.scope ?? user.email` (`sc(u)`), the bearer's active brand. `get_brand_rules` and `check_brand` read only the caller's own brand and spend nothing. `save_draft` writes one `pending` task with `source:"external"` to `sc(u)` only (arguments naming a scope, email or id are ignored), is never auto-approved, runs the brand gate in code, spends no credits and calls no model, and is rate limited per account by `draftAllowed` (30 an hour, 150 a day). `generate_content` charges against the owning agent's monthly cap in the active brand and returns a tool error at the cap, charging nothing. Reem's `agenda_get`, `todo_create`, `todo_update` and `todo_propose_done` (2026-09-29) are free, run in the bearer's active brand with `source:"mcp"`, share the per-account allowances of rows 102-103, and cannot complete, delete or restore an item or change its inbox link (arguments are not checked against the schema here; `toolFields` and `mutateItem` decide in code). |
| 54 | GET | `/api/mcp/token` | U | `currentUser` `mcp/token/route.ts:6-7`. Returns only a 12-char prefix. |
| 55 | POST | `/api/mcp/token` | U | `currentUser` `mcp/token/route.ts:12-13`. |
| 56 | DELETE | `/api/mcp/token` | U | `currentUser` `mcp/token/route.ts:19-20`. |
| 56a | GET | `/api/performance` | O | `currentUser` `performance/route.ts`; `getPerf(sc(u))`. |
| 56b | POST | `/api/performance` | O | `currentUser`; `allow("perf:{email}", 20, 3600)`; body capped at 2,000,000 characters (413); parsed as data; saved under `sc(u)`. No model call, no credits. |
| 56c | DELETE | `/api/performance` | O | `currentUser`; `clearPerf(sc(u))` deletes `perfimport:{scope}` and `performance-learnings.md`. |
| 56d | GET | `/api/mcp/grants` | U (account level) | `currentUser` `mcp/grants/route.ts:7-8`; `listGrants(u.email)` `:9`, without tokens. |
| 56e | DELETE | `/api/mcp/grants` | U; grant `id` from the query resolved under `u.email` | `currentUser` `mcp/grants/route.ts:12-13`; `?all=1` revokes every grant of the caller `:15`; `id` must match `^[a-f0-9]{16}$` `:17`; another account's id is 404 `:19`. |
| 57 | POST | `/api/oauth/register` | A | `allow("oauth:register:ip:{ip}", OAUTH_REGISTER_PER_IP, OAUTH_REGISTER_WINDOW)` (30 per hour, `src/lib/rate.ts`) first, else 429 `{error:"slow_down"}` with CORS and `Retry-After` `oauth/register/route.ts:6`; a refused registration counts. Then `registerClient` validates redirect URIs `src/lib/oauth.ts:56-60`. |
| 58 | OPTIONS | `/api/oauth/register` | A | CORS `oauth/register/route.ts:16`. |
| 59 | POST | `/api/oauth/approve` | U | `currentUser` `oauth/approve/route.ts:7-8`; client and redirect URI match `:10-11`; PKCE S256 required `:18`. Code is bound to `u.email` `:19`. |
| 60 | POST | `/api/oauth/token` | Registered OAuth client holding a valid code plus PKCE verifier, or a valid refresh token | `allow("oauth:token:ip:{ip}", OAUTH_TOKEN_PER_IP, OAUTH_TOKEN_WINDOW)` (60 per 15 min, `src/lib/rate.ts`) before the body is read, else 429 `{error:"slow_down"}` with CORS and `Retry-After` `oauth/token/route.ts:9`; client lookup `:18`; a client with a secret must send it (body or Basic), compared with `sameSecret`, a non-string secret counts as wrong `:21`; a public client (no secret) authenticates by PKCE alone. `redeemCode` `src/lib/oauth.ts:75-83`; `rotateRefresh` `src/lib/oauth.ts:108-113`. |
| 61 | OPTIONS | `/api/oauth/token` | A | CORS `oauth/token/route.ts:35`. |
| 62 | GET | `/api/oauth/meta` | A | Public metadata `oauth/meta/route.ts:4`. |
| 63 | OPTIONS | `/api/oauth/meta` | A | `oauth/meta/route.ts:9`. |
| 64 | GET | `/api/oauth/resource` | A | Public metadata `oauth/resource/route.ts:3`. |
| 65 | OPTIONS | `/api/oauth/resource` | A | `oauth/resource/route.ts:6`. |

### 1.6 Growth and inbound

| # | Method | Path | Who | Enforced by |
|---|---|---|---|---|
| 66 | GET | `/api/referral` | U | `currentUser` `referral/route.ts:6-7`. |
| 67 | POST | `/api/referral/share` | U | `currentUser` `referral/share/route.ts:11-12`; once-per-platform flag `:15-17`. |
| 68 | GET | `/api/referral/share` | U | `currentUser` `referral/share/route.ts:22-23`. |
| 69 | POST | `/api/support` | A (session attached when present) | Rate limit 10 per IP per hour `support/route.ts:8`; every accepted ticket emails `WAITLIST_TO`. |
| 70 | GET | `/api/support` | F | `isAdmin` `support/route.ts:16`. |
| 71 | POST | `/api/affiliates` | A | Rate limit 10 per IP per hour `affiliates/route.ts:7`. |
| 72 | GET | `/api/affiliates` | F | `isAdmin` `affiliates/route.ts:13`. |
| 73 | POST | `/api/waitlist` | A | Rate limit 10 per IP per hour `waitlist/route.ts:18`. |
| 74 | GET | `/api/waitlist` | Holder of `WAITLIST_ADMIN_KEY` in the query string only | Inline compare `waitlist/route.ts:55-58`. Does not use `isAdmin`; founder session and admin cookie are not accepted. |
| 97 | POST | `/api/wishlist/vote` | U | `currentUser` first (401); rate limit 60 per account per hour (`rate:wishvote:{email}`); the item id must be a known item (`votableId`: a seeded id not hidden, or a promoted id; 400 `unknown_item` before any key is built). The voter is always the session's `u.email`: an email, user or scope in the body is ignored. Votes are per account, not per brand. |
| 98 | POST | `/api/wishlist/suggest` | U | `currentUser` first (401); text cleaned (`cleanText`: control, invisible and direction-override characters removed, one line) and bounded to 5..280 characters (400); then 5 per account per day (`rate:wishsuggest:{email}`, 429). Goes to the `wish:suggestions` queue only; no public route reads it. |

### 1.7 Founder console

| # | Method | Path | Who | Enforced by |
|---|---|---|---|---|
| 75 | POST | `/api/admin/login` | A presenting the admin key | Rate limit `admin/login/route.ts:11`; `timingSafeEqual` `:13-16`. |
| 76 | DELETE | `/api/admin/login` | A | None; clears the caller's `nashr_admin` cookie `admin/login/route.ts:22-25`. |
| 77 | GET | `/api/admin/overview` | F | `isAdmin` `admin/overview/route.ts:9`. |
| 78 | GET | `/api/admin/plan` | F | `isAdmin` `admin/plan/route.ts:11`. |
| 79 | POST | `/api/admin/plan` | F; target `email` from body | `isAdmin` `admin/plan/route.ts:26`; existence check `:28`. |
| 80 | GET | `/api/admin/users/{email}` | F; target email from path | `isAdmin` `admin/users/[email]/route.ts:18`. |
| 81 | POST | `/api/admin/users/{email}` | F; target email from path | `isAdmin` `admin/users/[email]/route.ts:45`. Actions `:53-99`. |
| 82 | POST | `/api/admin/impersonate` | A holding a `nashr_return` cookie | No `isAdmin` call. The cookie value must be a live `session:{token}` `admin/impersonate/route.ts:9-12`. |
| 83 | GET | `/api/admin/export` | F | `isAdmin` `admin/export/route.ts:10`. |
| 84 | GET | `/api/admin/log` | F | `isAdmin` `admin/log/route.ts:7`. |
| 85 | GET | `/api/admin/evals` | F | `isAdmin` `admin/evals/route.ts:7`. |
| 86 | GET | `/api/admin/golden` | F | `isAdmin` `admin/golden/route.ts:12`. |
| 87 | POST | `/api/admin/golden` | F | `isAdmin` `admin/golden/route.ts:20`. |
| 96 | GET | `/api/admin/media` | F | `isAdmin` `admin/media/route.ts:39`, else 401 and no provider call; `maxDuration = 60` `:18`. Calls the kie balance and Higgsfield `/estimate` only for configured providers, writes and deletes one tiny Blob file (`probeBlob`), and reads the open-set sizes, `renderSpend()`, `media:off` and `mjobs:recent`. Answers flags (`configured`), model ids, balances, estimates, error codes and spend; never a variable value, an email or a scope (`recentRow` passes only id, model, state, error, credits, cost and time). |
| 99 | GET | `/api/admin/wishlist` | F | `isAdmin` first. Returns the suggestion queue (with the suggesters' emails) and every wishlist item, hidden ones included, with counts. |
| 100 | POST | `/api/admin/wishlist` | F | `isAdmin` first. Actions `promote` (the founder writes the public title in both languages, each cleaned and at most 120 characters; the suggester's text is never published), `status` (`planned`/`in_progress`/`shipped`), `delete` (hides a seeded item, deletes a promoted one with its votes), `restore`, `dismiss`. Ids are checked with `existingId` / `wellFormedId`; every action is written to `admin:log`. |

### 1.8 Cron

| # | Method | Path | Who | Enforced by |
|---|---|---|---|---|
| 88 | GET | `/api/cron/daily` | C | `sameSecret(bearer, CRON_SECRET)` `cron/daily/route.ts:85`. Serves every active brand scope (`dailyFor`), then, in the same resumable batch, only Reem's purge for the idle scopes (`purgeIdle`: archived brands and every brand of a suspended account, which get no other scheduled work, charge or email). |
| 89 | GET | `/api/cron/weekly` | C | `sameSecret` `cron/weekly/route.ts:15`. |
| 90 | GET | `/api/cron/golden` | C | `sameSecret` `cron/golden/route.ts:12`. |
| 91 | GET | `/api/cron/routines` | C | `sameSecret` `cron/routines/route.ts:18-19`. Runs the routines owners turned on (`src/lib/routines.ts`), each under its own brand scope from `allUsers()`; charges credits against the owning agent's cap in that scope. |
| 95 | GET | `/api/cron/media` | C | `sameSecret(bearer, CRON_SECRET)` `cron/media/route.ts:17`, 401 otherwise or when the variable is unset; then `sweepMedia` `:18`. `maxDuration = 300` `:7`. Advances only jobs found in the open sets, each under its own stored scope. |

### 1.9 Media jobs and provider callbacks

| # | Method | Path | Who | Enforced by |
|---|---|---|---|---|
| 93 | GET | `/api/media/{jobId}` | O; `jobId` resolved with `getJob(sc(u), jobId)` | `currentUser` `media/[jobId]/route.ts:18-19`; `getJob(sc(u), jobId)` `:22-23` reads nothing unless the id matches `^[a-f0-9]{32}$` (`JOB_ID`), and another account's id is 404 with no provider call; `allow("mpoll:u:{email}", 120, 60)` `:24` (429 `slow_down`); `advance` `:27` bounds provider calls to one status call per job per 4 s. The task is read under `sc(u)` `:33`. `maxDuration = 120`. |
| 94 | POST | `/api/media/hook/{provider}` | A (public webhook) | Only `kie` and `higgsfield`, and only when configured, else 404 `media/hook/[provider]/route.ts:47`; per-IP `allow("mhook:{provider}:{ip}", 240, 60)` `:49` (429), before the body is read; body at most 64 KB on the declared length and a running total `:14,52-53` (413); JSON `:54-57` (400); only the provider task id is read (`kieTaskIdFrom` / `hfRequestIdFrom`) and it must match `PROVIDER_TASK_ID` `:59-60` (400); kie with `KIE_WEBHOOK_HMAC_KEY` set: `verifyKieSignature` (timestamp ±300 s, HMAC compared with `sameSecret`) `:62-65` (401); `jobForHook` `:66` takes the scope from the stored `mjobref` pointer and requires the job's provider and task id to match; `advance` in `after()` without `force` `:68`, so hints share the job's 4 s throttle and job lock and the status is re-fetched with our key. 200 whether or not a job matched. `maxDuration = 120`. |

Related non-API surface: `/oauth/authorize` (`src/app/oauth/authorize/page.tsx:10-12`) requires a session and redirects anonymous visitors to `/ar/app/login?next=...`; `/.well-known/oauth-*` are public rewrites (`next.config.ts:4-11`).

## 2. App pages under `src/app/[lang]/app`

Two layers exist. Layer 1, the layout (`layout.tsx:21-24`): reads `x-pathname` set by the proxy (`src/proxy.ts:28`); if there is no user, the path is non-empty and it does not end with `/login`, `/signup`, `/forgot`, `/reset` or `/admin`, redirect to `/{lang}/app/login`. Layer 2, the page's own check, listed below. The proxy itself enforces nothing.

| Page | Access rule | Page-level enforcement | Data scope used by the page |
|---|---|---|---|
| `layout.tsx` | see above | `layout.tsx:14-24` | `getBrand(sc(user))` `:40` |
| `page.tsx` (inbox) | U with a brand; else `/start` | `page.tsx:19-22` | `sc(u)` |
| `chat/page.tsx` | U; without a brand runs onboarding only for the URL confirmed in `onboardok:{sc(u)}`, else `/start?url=` with the `?onboard=` value pre-filled for review | `chat/page.tsx:27-42` | `sc(u)` (one `Promise.all`, `:47`), except `listNotifs(u.email)`, which is per account |
| `conversations/page.tsx` | U | `:15-16` | `sc(u)` |
| `generate/page.tsx` | U with a brand | `:11-13` | brand existence checked with `getBrand(sc(u))` (active brand, fixed 2026-09-18) |
| `calendar/page.tsx` | U | `:11-12` | `sc(u)` |
| `files/page.tsx` | U | `:13-14` | `listFiles(sc(u))` (active brand, fixed 2026-09-18) |
| `tasks/page.tsx` | U | `:11-12` | `getSchedule(sc(u))` (active brand, fixed 2026-09-18) |
| `governance/page.tsx` | U | `:13-14` | `getGov(sc(u))` (active brand, fixed 2026-09-18) |
| `integrations/page.tsx` | U | `:11` | via `/api/connect` (`sc(u)`) |
| `mcp/page.tsx` | U | `:10` | account |
| `billing/page.tsx` | U | `:9-10` | account |
| `refer/page.tsx` | U | `:12-13` | account |
| `reports/page.tsx` | U with a brand | `:20-22` | `sc(u)`, except `listConnections(u.email)` `:23` |
| `notifications/page.tsx` | U | `:13-14` | account |
| `todo/page.tsx` | U | `currentUser` then `redirect` | `todoPage(sc(u))`: Reem's agenda, recent done and restorable deleted items of the active brand; dates formatted on the server in Riyadh time |
| `profile/page.tsx` | U | `:10` | via `/api/profile` |
| `brands/page.tsx` | U | `:9` | account |
| `inspo/page.tsx` | U | `:10` | static |
| `help/page.tsx` | U | `:8` | static |
| `start/page.tsx` | U | `:11` | none |
| `onboarding/page.tsx` | U | `:11-12` | `getBrand(sc(u))` (active brand, fixed 2026-09-18); the form saves through `PUT /api/brand` to `sc(u)` |
| `login/page.tsx` | A; signed-in users are redirected to `/app` | `:11` | none |
| `signup/page.tsx` | A; signed-in users redirected | `:11` | none |
| `forgot/page.tsx` | A; signed-in users redirected | `:9` | none |
| `reset/page.tsx` | A | none (`:8` language check only) | none |
| `admin/page.tsx` | F; others get 404, or the key form when `?login=1` | `isAdminCookie()` `admin/page.tsx:15-18` | global |

The sidebar shows the console link when `isFounder(user.email)` (`layout.tsx:44`); this is display only. It also links every signed-in user to the public `/{lang}/updates` page.

Public page `/{lang}/updates` (outside the app shell, 2026-09-29): anyone can read it. It reads `currentUser()` only to show the viewer's own votes and the vote and suggestion controls; anonymous visitors get the counts and sign-in links. The page reads wishlist data through `listWishes` only and never reads `wish:suggestions`.

## 3. Cross-tenant isolation

### 3.1 How a scope is derived
1. `currentUser()` loads the user, then `activeBrandId(email)` reads `activebrand:{email}` (default `"default"`) and `scopeFor(email, brandId)` returns `email` for the default brand or `` `${email}#${brandId}` `` otherwise (`src/lib/auth.ts:163-165`, `src/lib/brands.ts:21-29`).
2. `sc(u) = u.scope ?? u.email` (`src/lib/auth.ts:32`). `scope` and `brandId` are runtime only and stripped by `saveUser` (`auth.ts:57`).
3. The active brand can only be set to an id found in the caller's own `brands:{email}` list (`brands/route.ts:27-30`), or to a brand just created by `addBrand` (`brands.ts:37`). Archiving the active brand resets it to `default` (`brands/route.ts:36`). `activeBrandId` does not re-validate that the stored id still exists or is active.
4. Brand ids are 8 base36 characters from `Math.random()` (`brands.ts:34`).
5. Every brand-scoped key embeds the scope string (see `architecture.md` section 3). Isolation between tenants therefore depends on (a) the session to email mapping and (b) scope strings of different accounts never being equal.
6. Account-level (not brand-level) records: user, credits, sessions, notifications, MCP tokens, referral data, usage, analytics. The per-agent monthly counters live on the account's user record but are keyed by brand scope (`agentSpend.by[scope]`), and the caps they are checked against are per brand (`gov:{scope}.agentCaps`), so one brand's spend and caps never apply to another. Chat thumbs are per brand scope since 2026-09-21 (`fblog:{scope}`), and so is the feedback built from them, the decision records and the judge's notes for an agent's prompts (`feedbackFor`, 2026-09-29). Media: a job record is per scope (`mjob:{sc(u)}:{id}`) but charges and refunds the account (`job.email`); the trial video marker (`mtrialvid:{email}`) and the render limits (`rate:media:*:{email}`) are per account; the render spend counters (`render:_all:*`) are global and carry no email.
7. Cron and admin code construct scopes with the same `scopeFor` (`dailyRoster()` and `allUsers()` in `schedule.ts:171-192`, `admin/users/[email]/route.ts:24`, `account.ts:27`). The routines cron keys every read and write by the `scope` `allUsers()` set (`routinelast:{scope}:{id}`, `routinelock:{scope}:{id}`, `routinecap:{scope}`, `routinehold:{scope}:{id}`, `routinetry:{scope}:{id}:{period}`, `schedule:{scope}`, `gov:{scope}`, the tasks).
8. MCP callers resolve the active brand the same way a browser session does (`userFromBearer`, `src/lib/mcp.ts`), so a bearer token works in the brand the owner has active. Fixed 2026-09-20; it used to always mean the default brand.

### 3.2 Routes that accept an id, email or other locator from the request

| Route | Locator | Binding to the caller |
|---|---|---|
| `PATCH /api/tasks/{id}`, `POST /api/tasks/{id}/image`, `POST /api/tasks/{id}/video`, `GET /api/tasks/{id}/pptx`, `POST /api/publish/{id}` | task id (path) | Key is `task:{sc(u)}:{id}`; a foreign id yields 404. No format check on `id`. The media job a render creates stores `scope = sc(u)` and `email = u.email` at creation, and the engine only ever writes the task under that stored scope, through `updateTask`, whose lock `tasklock:{scope}:{id}` is built from the same server-side scope and task id. |
| `POST /api/tasks/{id}/image` and `/video` body `model` | catalogue model id | `isMediaModelId` is a list membership test (not `in`), so `constructor` and other prototype keys are 400; the model must be of the route's kind. |
| `GET /api/media/{jobId}` | media job id (path) | `getJob(sc(u), jobId)`: the id must match `^[a-f0-9]{32}$` before a key is built, and the key is `mjob:{sc(u)}:{jobId}`, so another account's job id is 404 and causes no provider call. |
| `POST /api/media/hook/{provider}` | provider task id (kie `taskId` / `data.taskId` / `data.task_id`; Higgsfield `request_id`) | Format-checked against `PROVIDER_TASK_ID[provider]` (kie `^[A-Za-z0-9_-]{6,80}$`, Higgsfield a UUID) and used only to read the server-written pointer `mjobref:{provider}:{id}`; the workspace is the pointer's stored `scope`, never anything from the request, and the loaded job must carry the same provider and task id (`jobForHook`). Same shape as `oauthstate:{state}` below. Nothing else in the body is read, including result URLs. |
| Chat tools `generate_image`, `publish_item` (`src/lib/chat.ts:448,415`) | `task_id` chosen by the model | `getTask(user.scope, id)`; same binding. `generate_image` can only render the 1-credit default model: the tool has no `model` argument. |
| `GET/POST /api/chat` | `conv` (query or body) | Key `chat:{sc(u)}:{conv}`; not checked against `convs:{sc(u)}`; no format check (the chat page applies `^[a-f0-9]{6,16}$` at `chat/page.tsx:43`, the API does not). |
| `PATCH/DELETE /api/conversations` | conversation id | `conv:{sc(u)}:{id}` and `chat:{sc(u)}:{id}`. |
| `GET/PUT/DELETE /api/files` | file name | `safeName` reduces to `[a-z0-9._-]`, max 60 chars, then `file:{sc(u)}:{name}`. |
| `POST /api/brands` | brand id | Must be in `listBrands(u.email)`. |
| `/api/connect/{provider}*`, `POST /api/publish/{id}` body `provider` | provider id | `conn:{sc(u)}:{provider}`; start and key routes also require a registry match; `DELETE` and `POST /api/connect/{provider}` do not validate the provider id against the registry. |
| `GET /api/connect/{provider}/callback` | `state` | Scope is read from `oauthstate:{state}`; the current session (if any) is ignored; the path `provider` is not compared to the stored provider. |
| `POST /api/oauth/approve` | `client_id`, `redirect_uri` | Redirect URI must be registered for that client; the code is bound to the session email. |
| `POST /api/oauth/token` | `code`, `refresh_token`, `client_id` | Code and refresh token are bound to the issuing `client_id`; email comes from the stored record. |
| `POST /api/auth/reset` | reset token | Email comes from the stored `pwreset:` record. |
| `POST /api/auth/signup` | `ref` code | Referrer resolved from `ref:{CODE}`; self-referral blocked by equality. |
| `POST /api/support`, `/api/affiliates`, `/api/waitlist` | `email` in body | Not bound; free text. Support additionally records the session email separately as `user`. |
| `GET/POST /api/admin/users/{email}`, `POST /api/admin/plan` | target email | Founder only; no binding by design. The decoded path value is used raw for lock keys and for `wipeAccount` (`admin/users/[email]/route.ts:47,94`), while `getUser` normalizes case. |
| `POST /api/mcp` | bearer token | Email from `mcptoken:{token}`. |
| `PATCH /api/secretary/{id}`, chat and MCP `todo_update` / `todo_propose_done` | item id (path or tool argument) | Must match `^s[a-f0-9]{16}$` before a key is built; the key is `sec:item:{sc(u)}:{id}`, so another account's or another brand's id is 404 (tools: "No item with that id") and the item is untouched, whatever `scope` or `email` the body or the tool arguments name (tests rules 157 and 170). |
| `POST /api/secretary`, `PATCH /api/secretary/{id}`, chat and MCP `todo_create` | `taskId` / `task_id` (a link to an inbox item) | Must match `^[a-f0-9]{16}$` and exist as `task:{sc(u)}:{taskId}` (400 `unknown_task`); the automatic close reads the task under the same scope. From chat or MCP a link is accepted only by `todo_create` and only to a task still `pending` (400 `link_not_pending`), so the close always follows an approval the owner made after the link. `todo_update` never reads `task_id` (`toolFields`), and `mutateItem` refuses a link change from any actor but the owner on the web (`owner_only`): the MCP route passes arguments without checking them against the tool schema. |

No route accepts an email or scope from a non-founder request and uses it to read or write another tenant's workspace data.

## 4. Admin model

1. `adminEmails()` (`src/lib/auth.ts:114-116`): `ADMIN_EMAILS` split on commas, normalized. When the variable is unset the list defaults to one hard-coded address in the source.
2. `isFounder(email)` (`auth.ts:117`): membership test. Used for the sidebar link (`layout.tsx:44`), inside `isAdmin`/`isAdminCookie`, and as the recipient list for golden-set alerts (`golden.ts`, `adminEmails()`).
3. `isAdmin(req)` (`auth.ts:120-131`), used by every `/api/admin/*` data and action route plus the admin branches of `/api/support`, `/api/affiliates`, `/api/integrations`: true when `WAITLIST_ADMIN_KEY` is set and equals `?key=`, or header `x-admin-key`, or cookie `nashr_admin` (plain `===` comparison); otherwise true when `currentUser()` is a founder. Either path alone is sufficient.
4. `isAdminCookie()` (`auth.ts:134-142`), used by `admin/page.tsx`: same without the query and header forms.
5. `nashr_admin` cookie: set by `POST /api/admin/login` after a rate-limited, constant-time comparison; the cookie value is the key itself; 30 days; httpOnly; lax (`admin/login/route.ts:9-19`).
6. Founder accounts are ordinary users: they sign up through the public signup route. Whoever registers an address listed in `ADMIN_EMAILS` (or the default address) becomes a founder, because signup has no email verification (`auth/signup/route.ts`).
7. A suspended founder loses the session path (`currentUser` returns `null`) but the key path still works.
8. Impersonation (`admin/users/[email]/route.ts:84-92`): requires `isAdmin`. Saves the caller's current `nashr_session` value in `nashr_return` (2 h), sets `nashr_impersonate` to the target email (2 h), then issues a standard 30-day session for the target in `nashr_session`. While impersonating, the browser is indistinguishable from the target user to every API; founder-only APIs still work if the `nashr_admin` cookie is present, and stop working through the session path because the session is now the target's.
9. Return (`admin/impersonate/route.ts`): no admin check; restores `nashr_return` into `nashr_session` when that token is still a live session; clears helper cookies; logs `impersonate:stop` using the `nashr_impersonate` cookie value as the subject.
10. Audit: `admin:log` entries carry `actor:"founder"` as a constant, the target email, action, optional before/after and reason. The acting identity (which founder, or key versus session) is not recorded. Actions taken while impersonating are not marked in any record. `setLang` is not logged (`admin/users/[email]/route.ts:79-83`).
11. `WAITLIST_ADMIN_KEY` has two further roles: it gates `GET /api/waitlist` (query string only) and it is the fallback encryption secret for connector credentials when `CONNECT_SECRET` is unset (`src/lib/connectors/store.ts:14`).

## 5. Unclear or missing rules

Each item states what the code does and why the intended rule cannot be read from it. None of these is guessed as intended or unintended.

1. **Email characters versus scope strings.** Signup accepts any address matching `^[^\s@]+@[^\s@]+\.[^\s@]+$` (`auth/signup/route.ts:9`), which allows `#` and `:`. Extra-brand scopes are `email#brandId` (`brands.ts:28`) and keys are `prefix:{scope}[:{id}]`. An account registered as `victim@x.com#<brandId>` has a default scope equal to the victim's brand scope, and an account registered as `victim@x.com:<convId>` has a default thread key equal to the victim's `chat:{scope}:{convId}`. Both require knowing a random id. No rule forbids these characters and nothing states that scope strings must be unique across accounts.
2. **No email verification at signup.** Accounts become active immediately. Combined with `ADMIN_EMAILS` (and its hard-coded default), founder status is granted to whoever first registers a listed address. No rule says founder addresses must be pre-registered.
3. **Rate limits on the public routes.** Fixed for OAuth on 2026-09-29: `POST /api/oauth/register` allows 30 registrations per IP per hour and `POST /api/oauth/token` 60 requests per IP per 15 minutes (`OAUTH_*` in `src/lib/rate.ts`), counted on every attempt and answered 429 `{error:"slow_down"}` in OAuth's shape with the CORS headers. Hosted MCP clients (claude.ai, ChatGPT) call both from shared egress addresses for many accounts, so the ceilings are sized for that; if one of them is ever throttled, raise the constant rather than drop the limit. The token endpoint's secret check now uses `sameSecret` (was `!==`). Registered clients still never expire. Login and signup are throttled per IP and per email; support, affiliates and waitlist were given a per-IP limit on 2026-09-20; chat is bounded per account (`CHAT_PER_HOUR`, `CHAT_PER_DAY` in `src/lib/rate.ts`) because a turn costs no credits and can run up to five model calls. `clientIp` prefers the platform headers and falls back to the last `x-forwarded-for` hop (`rate.ts`).
4. **Password policy differs by route.** Reset requires 8 chars plus a letter and a digit (`auth/reset/route.ts:13`); signup and change-password require only 8 chars server-side (`auth/signup/route.ts:10`, `account/route.ts:12`); the signup form enforces the stricter rule client-side only.
5. **Sessions end when the password changes.** Fixed 2026-09-18. A session record is `{email, at}`; the user record carries `sessionsAfter`, set on password change, password reset and founder `resetPassword`; `currentUser` refuses any session issued before it, including the older bare-email records (treated as issued at 0). The device that changed the password gets a new session. Password writes now happen inside the user lock on the fresh record. Suspension is still enforced on read.
6. **Suspension.** Fixed: `userFromBearer` (`mcp.ts:31-32`) refuses a suspended account, so its MCP personal and OAuth tokens stop working, and `allUsers()` (`dailyRoster`, `schedule.ts:180`) skips suspended accounts, so no cron (weekly plan, routines, daily emails) charges or emails them; the daily cron only purges their brand scopes' expired to-dos (`purgeIdle`). The `User.suspended` comment says "login and all API access blocked" (`auth.ts:21`).
7. **MCP token revocation.** Fixed 2026-09-18. Every OAuth token pair belongs to a grant (`mcpgrant:{email}:{id}`, index `mcpgrants:{email}`). `GET /api/mcp/grants` lists connected apps without tokens, `DELETE ?id=` or `?all=1` revokes; the MCP page shows the list. Refresh rotation deletes the previous access token. Password reset, founder reset and `wipeAccount` revoke the personal token and every grant. Tokens issued before this change have no grant and cannot be listed; they expire on their own (30 d access, 90 d refresh) or die at the next password reset only if they were the personal token.
8. **MCP scope.** Partly fixed 2026-09-18: the approve route only writes scopes this server defines (`SCOPES`, today `noor`), and MCP `generate_content` applies the same trial-expiry check as `/api/generate`. On 2026-09-20 a token started resolving the active brand like a session, and `ask_noor` was put under the same per-account chat ceiling as the web route. Still open: there is one OAuth scope, so every token grants every MCP tool including `ask_noor` (which reaches `write_file`, `update_brand` and credit-spending tools; `publish_item` still needs an approved item).
9. **`POST /api/admin/impersonate` has no admin check.** It acts only on the caller's own cookies and requires `nashr_return` to be a live session token, so it cannot mint access, but the rule "founder only" is not enforced there.
10. **Impersonation lifetime and audit.** The log says `expiresInMin:120` and the banner says "2 hours max", but the impersonated session is a normal 30-day session and is not deleted on return (`admin/users/[email]/route.ts:87-90`, `admin/impersonate/route.ts:11-14`). Actions performed while impersonating are attributed to the target user; `admin:log` never records which founder acted.
11. **Admin key handling.** `isAdmin` accepts the key in the URL query (`auth.ts:124`), where it can end up in logs and browser history, and every comparison now goes through `sameSecret` (`isAdminCookie` used `===` until 2026-09-20). The `nashr_admin` cookie stores the key itself rather than a derived session. Rate limiting applies to `/api/admin/login` only, not to guesses sent as `?key=` or `x-admin-key` to other admin routes. The same key doubles as the connector encryption fallback (`connectors/store.ts:14`), with a fixed development string as the last fallback.
12. **`GET /api/waitlist` uses its own check** (query key only, `waitlist/route.ts:55`) instead of `isAdmin`. Whether founders without the key should reach it is not stated.
13. **Publishing and approval.** Changed since the baseline: the chat tool `publish_item` publishes only items the owner already approved (`chat.ts:423`) and only to a target `targetsFor` lists (`chat.ts:420`), and both it and `POST /api/publish/{id}` apply the brand gate (`chat.ts:425-426`, `publish/[id]/route.ts:24-25`). The HTTP route still publishes a pending item (the owner's click is the approval) but refuses a rejected one (`:21`) and a target `targetsFor` does not list (`:27`); afterwards both set the item `approved` through `updateTask` (`publish/[id]/route.ts:34`, `chat.ts:431`), the route recording `decidedAt` for a pending item. Whether the model publishes at all is still decided by the model on the owner's request; the approval it needs is checked in code.
14. **Model-controlled writes are not re-validated.** `update_brand` writes `brand[field] = value` using the model's `field` (`chat.ts:382-396`); the enum is enforced only by the strict tool schema. Text crawled from user-supplied sites and imported catalogs is placed into prompts and `products.md` without marking it as untrusted.
15. **Server-side fetches of user-supplied URLs** (`crawl.ts:50`, `catalog.ts:12,26`, WordPress/WooCommerce/Odoo/PrestaShop base URLs in `connect/[provider]/key`) have no allow-list, no private-address or metadata-address block, and follow redirects. Verify errors and publish errors return fragments of the remote response to the caller (`key/route.ts:27`, `publish/[id]/route.ts:53`). No rule is written for acceptable targets.
16. **Connector OAuth callback is sessionless.** The connection is saved to the scope stored in `state`, whoever completes the redirect (`callback/route.ts:28`); the path provider is not checked against the state's provider; Shopify callbacks are not HMAC-verified. OAuth tokens are never refreshed although `expiresAt` is stored.
17. **Account deletion leaves data behind.** `wipeAccount` (`account.ts:27-92`) deletes the `conns:{scope}` set but not the `conn:{scope}:{provider}` records holding encrypted third-party credentials; (fixed 2026-09-18: connector records, every task and conversation, the task index, the pending set, the personal MCP token and all OAuth grants are deleted); it still leaves `session:*` (harmless: the user record is gone),  `notifs:`, `notified:`, `notifseen:`, `usage:`, `uev:`/`ulast:`/`ufirst0:`, `fb:`/`fblog:` (fixed 2026-09-21: `fblog:{scope}` for every brand and the legacy `fb:` counters are now deleted — the log holds the free-text reason the owner typed; `decisions:{scope}`, added 2026-09-29, is deleted for every brand for the same reason; the `usage:` counters of the last 36 months are deleted from the list `usageMonthKeys` builds from `KINDS` and `AGENT_IDS`, so the per-agent counters added 2026-09-29 go too), `ref:`, `referrals:`, `referredBy:`, `shared:`, OAuth tokens, membership in `users:all` and `active:*` sets, tickets, and for non-default brands the `profile:{scope}` key. A `deleted-accounts` entry keeps the email. No retention rule is documented in code. Media (2026-09-29, spec A19): generated images and clips on Vercel Blob, and images still hot-linked at fal.ai, survive the wipe (public addresses that cannot be guessed, no tenant identifier in the path); the render records expire by TTL within 14 days (`mjob:` and `mjobref:` 7 days, `mtrialvid:` 14 days, the flight locks and per-account render limits within a day), and the global `render:_all:*` counters and `mjobs:recent` carry no email. A job of a wiped account still running is failed without a refund or a notification (`accountSince`), so `notifs:{email}` is not recreated. The privacy policy and the help centre state all of this; deleting the Blob files and job records with the account is a follow-up.
18. **Whole-record user saves outside the credit lock.** `PUT /api/profile`, `PATCH /api/account` and `POST /api/auth/reset` call `saveUser` with the record read at request start (`profile/route.ts:39`, `account/route.ts:15`, `reset/route.ts:22`), so a concurrent `charge` or `refund` can be overwritten, and since 2026-09-29 that includes the per-agent counters (`agentSpend`) the charge wrote. `POST /api/referral/share` checks and sets its once-only flag in two steps (`share/route.ts:16-18`), as do `once()` and `pushNotif` fingerprints.
19. **Brand-scope inconsistencies inside one account.** Pages fixed 2026-09-18: files, governance, tasks, generate, onboarding, and `listConnections` in chat and reports now read `sc(u)`; `tests/scope-usage.test.ts` fails when a page or customer API route passes the bare account email to a workspace reader. Still open: email preferences are written to `profile:{sc(u)}` and cron reads the scope first and the account second; the founder overview counts credits from the default brand only.
20. **Credits and plan limits not tied to a payment event.** Plans and credits change only through the founder console. Free tools are unlimited and free for signed-in users (`tools/[tool]/route.ts:15`), onboarding and catalog import are uncharged and repeatable. (Trial expiry has been checked on every image and video path since 2026-09-29, through `renderImage` / `renderVideo` in `src/lib/media/start.ts`.) `BRAND_LIMIT` is checked only when adding a brand, not after a downgrade. Whether these are intended is not stated.
21. **Layout guard depends on a header.** The layout redirect runs only when `x-pathname` is non-empty (`layout.tsx:24`) and public paths are matched with `endsWith`. Every current page has its own guard except `reset` (public by design), so this is defence in depth only; the rule for future pages is unwritten.
22. **`next` redirect parameter.** Login and signup accept `next` when it starts with `/` and not `//` (`AuthForm.tsx:23,76`). A value beginning with `/\` passes this test; browsers may treat it as protocol-relative. No server-side rule exists for post-login destinations.
23. **No CSRF token.** State-changing routes rely on `sameSite=lax` cookies and JSON bodies. `POST /api/oauth/approve` and `POST /api/admin/impersonate` accept form posts. MCP and OAuth endpoints send `Access-Control-Allow-Origin: *` (bearer or public by design).
24. **Anonymous counters without expiry.** Fixed 2026-09-18 for the free tools: the limiter is `allow("tool:{ip}")` with a 24 h window and the platform IP. The in-memory store honours TTL since 2026-09-18. Since 2026-09-29 every `allow()` window is set with EXPIRE NX on every hit (`rate.ts:13`, `db.expireNx`): before, only the first hit set the TTL with a SET, which reset hits landing in between, and when that one call failed the counter kept no expiry and refused every caller for good (for `rate:kie:create`, every tenant). A failed expiry call is logged and repaired by the next hit; a store that refuses the NX form falls back to the first hit's SET (`:18`).
25. **Email normalisation on founder actions.** `POST /api/admin/users/{email}` looks the user up with a normalized email but passes the raw decoded path value to `withUserLock` and `wipeAccount` (`admin/users/[email]/route.ts:47-48,94`). With a mixed-case path value the lookup succeeds while the wipe targets different keys and the log still records `delete`.
26. **Media webhooks are hints, and only kie's can be signed.** Higgsfield does not sign its webhooks, and kie's callbacks are checked (`verifyKieSignature`, `X-Webhook-Timestamp` within ±300 s, `X-Webhook-Signature` compared with `sameSecret`) only when `KIE_WEBHOOK_HMAC_KEY` is set; without it a kie callback is accepted unsigned. Both are therefore treated as hints: the body's only use is the provider task id, which selects a job through a pointer the server wrote, and the job then asks the provider itself, with our key, under the same 4 s throttle and job lock as a poll. A forged hint costs at most that one throttled status call per job per 4 s and cannot write outside the job's own scope; it cannot deliver a result, because result URLs in the body are never read. Anyone may still spend the per-IP allowance (240 per minute per provider and IP). Whether the founder will set `KIE_WEBHOOK_HMAC_KEY` is an owner step (`docs/Owner_Tasks_AR.md`, section ج2).
27. **Concurrent writes to one task.** Fixed 2026-09-29. `saveTask` replaces the whole task, and the approve and edit route, the publish route, the chat tool `publish_item`, the judge and the media engine each used to save a copy read before their slow work, so one could erase another's change: a publish or an approval undid a paid render that finished meanwhile, and a finalize undid an approval. Each now changes the task through `updateTask` (`src/lib/brand.ts:289`): re-read under `tasklock:{scope}:{id}` (10 s), apply only its own fields, save; a deleted task is not recreated. `tasklock` bounds a writer's wait to 3 s (`task_lock_timeout`) and, like the ledger lock, is released with an unconditional DEL. Whole-record USER saves outside the credit lock (item 18) are unchanged.

## Brand rules (2026-09-28)

The owner's banned words are enforced in code, not only in prompts (`src/lib/brand-rules.ts`). A customer-facing item whose text contains one cannot become `approved` through `PATCH /api/tasks/{id}` (409 `brand_violation`), cannot be published through `POST /api/publish/{id}` (409) or the chat tool `publish_item` (refused), and is created `pending` even when its type is auto-approved. The owner can still edit it, save it as pending, or remove the word from the brand file; no other actor can lift the rule.

## Drafts from the owner's own assistant (2026-09-29)

MCP `save_draft` lets a bearer (the owner's Claude, ChatGPT or any MCP client, through a personal token or an OAuth grant) put text into the approval inbox of its own active brand. It can create, never decide: the item is always `pending` whatever `gov.autoApprove` says, the brand gate applies to it like to any agent's draft, and approving, editing, rejecting and publishing stay with the signed-in owner in the app. It spends no credits, so its only bound is `draftAllowed` (30 an hour, 150 a day per account). The text is untrusted input: typed and bounded by `parseDraft`, rendered in the inbox like model output (`render`), never executed or followed.

## Reem, the secretary (2026-09-29)

Phase 1 of the secretary agent keeps the owner's own to-dos, follow-ups and "who owes what" per brand scope (`src/lib/secretary.ts`, spec `docs/superpowers/specs/2026-09-29-secretary-reem-phase1.md`). What code enforces, not prompts:

1. Scope. Every key is built from `sc(u)` (the session's or the bearer's active brand); an item id from a request is format-checked and resolved under that scope only (rows 101-103, section 3.2).
2. Only the owner closes. `complete` (a written result is required), `confirm_done`, `reject_done`, `delete` and `restore` are `OWNER_ONLY`: `changeItem` and `mutateItem` refuse them unless the actor is the owner through the web route. Chat and MCP tools can create, update, snooze, add notes and propose "done" with evidence; a proposal ends any snooze and waits under "needs your confirmation". The one other close is deterministic: an item linked to an inbox task of the same scope closes with the result "linked item approved" when that task is approved (`closeLinked`, re-checked under the item lock). Because a link can close an item, only the owner changes a link on an existing item; chat and MCP set one only at creation and only to a `pending` task, so the close always follows an approval the owner made after the link (row 253).
3. Concurrency. Writes to one item go through `sec:lock:{scope}:{id}` and bump `rev`; a request that sends an older `rev` gets 409.
4. Limits. 200 new items a day and 600 changes an hour per account (across brands), 600 reads an hour, 500 open items per brand, counted on create and on a restore that reopens an item.
5. Untrusted text. Titles, notes and evidence are cleaned and bounded; the chat tool answers quote them as JSON under a line that says they are data; private notes never reach a model (`itemLine` leaves them out of `agenda_get`, in chat and over MCP), and only the owner on the web can write one (a note from chat or MCP is stored shared). An agent's "done" (`proposedDone.evidence`) is the agent's claim: the page shows it attributed and marked as not checked, next to the fact code read from the stored linked task (`linkFactText` over `facts`: status, `decidedAt`, publish receipt) or "Nothing in the app confirms this"; the evidence text never becomes the checked fact.
6. Deletion. A delete is soft for 30 days; the daily cron purges after that in every brand scope, archived brands and suspended accounts included (`purgeIdle` over `dailyRoster().idle`); `wipeAccount` deletes every `sec:*` key of every brand scope (`secretaryKeys`).
7. No new vendor, no new environment variable, no WhatsApp or Telegram delivery, no time-based reminder job: reminders reach the owner through the page, the 8 AM brief (and its email, per the owner's preference) and the in-app overdue alerts (item 8). Nothing fires at an item's due time, and the copy (Reem's prompt and playbook, the chat chips, help and the site) says so instead of promising it.
8. Overdue alerts. One per overdue item on the local day it fell behind and 1, 3 and 7 days later, then only the brief; each step's marker (`notifseen:{email}:todo-due:{scope}:{id}:{dueAt ms}:{step}`) is claimed with SET NX before anything is pushed, at most 5 a brand a local day (`sec:alerts:{scope}:{day}`), claims past the allowance handed back. Every other follow-up's marker is claimed the same way (`pushNotif`), so two overlapping cron runs notify once.
9. Time zone. A brand's zone is one of six allow-listed Gulf zones (`zones.ts`), stored only through `PUT /api/brand` (row 9) and re-checked on every read (`zoneOf`); `update_brand` cannot set it. It decides local days, the reading and writing of dates, the snooze presets and the weekend the chase clock skips.
10. Chase clock. A they-owe item is due for a follow-up at its due time, else at `expectBy` (two working days after creation by default), else two working days after the last recorded follow-up; recording one (`chased`, the owner's action or `todo_update {chased: true}`) never closes the item.
