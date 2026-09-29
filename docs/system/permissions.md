# Nashr: permissions (as implemented)

What the code enforces today, at HEAD `4959f7e`. Paths are relative to the repository root; API route files are under `src/app/api/` and are written without that prefix in the tables. `file:line` points at the line where the check happens.

## 0. Actors and the functions that identify them

| Actor | How the code identifies it | Function |
|---|---|---|
| Anonymous | No check | none |
| Signed-in user | Cookie `nashr_session` to `session:{token}` to `user:{email}`; rejects missing and `suspended` users; attaches `brandId` and `scope` | `currentUser()` `src/lib/auth.ts:93-105` |
| Workspace owner of the resource | Same as signed-in user, and the record is read under the caller's own scope `sc(u)` (`src/lib/auth.ts:26`) so ids from the request only resolve inside that scope. There is no membership or role model: one account owns its brands and nobody else can be granted access. | `sc(u)` plus the scoped getters in `src/lib/brand.ts`, `files.ts`, `conversations.ts`, `connectors/store.ts` |
| Founder admin | `WAITLIST_ADMIN_KEY` presented as `?key=`, header `x-admin-key`, or cookie `nashr_admin`; or a signed-in user whose email is in `ADMIN_EMAILS` | `isAdmin(req)` `src/lib/auth.ts:114-125` (APIs), `isAdminCookie()` `src/lib/auth.ts:128-136` (pages) |
| Cron | Header `Authorization: Bearer ${CRON_SECRET}`; denied when the variable is unset | inline in each cron route |
| MCP bearer | Header `Authorization: Bearer nashr_...` to `mcptoken:{token}` to `user:{email}`; refuses a `suspended` account and sets `scope` from the active brand like a session | `userFromBearer(req)` `src/lib/mcp.ts:25-39` |

There is no global guard. `src/proxy.ts` does not authenticate (`src/proxy.ts:15-30`); every handler enforces its own rule, and a handler without a check is public.

## 1. API routes (60 route files, 91 exported handlers)

Legend for "Who": A = anonymous, U = signed-in user, O = workspace owner of the addressed resource (U plus scope binding), F = founder admin, C = cron secret, M = MCP bearer token.

### 1.1 Auth and account

| # | Method | Path | Who | Enforced by |
|---|---|---|---|---|
| 1 | POST | `/api/auth/signup` | A | No auth. Validation only: `auth/signup/route.ts:9-13`. No rate limit. |
| 2 | POST | `/api/auth/login` | A | Password check `auth/login/route.ts:8`; suspended block `:9`. No rate limit. |
| 3 | POST | `/api/auth/logout` | A | No check; `destroySession()` acts on the caller's own cookie `auth/logout/route.ts:5`. |
| 4 | POST | `/api/auth/forgot` | A | Rate limit `auth/forgot/route.ts:23` (`allow`, `src/lib/rate.ts:4`). |
| 5 | POST | `/api/auth/reset` | A holding a valid reset token | Rate limit `auth/reset/route.ts:11`; token lookup `:15-18`; suspended block `:20`. |
| 6 | PATCH | `/api/account` | U plus current password | `currentUser` `account/route.ts:9-10`; `verifyPassword` `:13`. |
| 7 | DELETE | `/api/account` | U plus password | `currentUser` `account/route.ts:20-21`; `verifyPassword` `:23`. Wipes the caller's own email only `:24`. |

### 1.2 Workspace data (all scope-bound through `sc(u)` unless noted)

| # | Method | Path | Who | Enforced by |
|---|---|---|---|---|
| 8 | GET | `/api/brand` | O | `currentUser` `brand/route.ts:7-8`; `getBrand(sc(u))` `:9`. |
| 9 | PUT | `/api/brand` | O | `currentUser` `brand/route.ts:13-14`; `saveBrand(sc(u))` `:38`. |
| 10 | GET | `/api/brands` | U (own brand list) | `currentUser` `brands/route.ts:8-9`; keyed by `u.email` `:10`. |
| 11 | POST | `/api/brands` | U; brand `id` must exist in the caller's own list | `currentUser` `brands/route.ts:20-21`; `listBrands(u.email)` and `find` `:27-29`; plan limit in `addBrand` `src/lib/brands.ts:33`. |
| 12 | GET | `/api/profile` | U | `currentUser` `profile/route.ts:9-10`. |
| 13 | PUT | `/api/profile` | U | `currentUser` `profile/route.ts:33-34`. Editable user fields are whitelisted to `name`, `phone`, `lang` `:36-38`. |
| 14 | GET | `/api/files` | O | `currentUser` `files/route.ts:6-7`; `readFile/listFiles(sc(u))` `:9-10`. |
| 15 | PUT | `/api/files` | O | `currentUser` `files/route.ts:13-14`; name sanitized by `safeName` `src/lib/files.ts:9`. |
| 16 | DELETE | `/api/files` | O | `currentUser` `files/route.ts:20-21`. |
| 17 | GET | `/api/governance` | O | `currentUser` `governance/route.ts:6-7`. |
| 18 | PUT | `/api/governance` | O | `currentUser` `governance/route.ts:11-12`; written to `gov:{sc(u)}` only. `saveGov` validates every field (2026-09-29): `autoApprove` keys must be task types with boolean values, `agentCaps` keys must be agent ids with finite values (truncated, clamped 0..100000; `null` or "" removes a cap), NaN never replaces `weeklyCap` or `notifyMinutes`, unknown keys and a non-object body change nothing. |
| 19 | GET | `/api/schedule` | O | `currentUser` `schedule/route.ts:8-9`. |
| 20 | PUT | `/api/schedule` | O | `currentUser` `schedule/route.ts:14-15`. Writes `schedule:{sc(u)}` only; scope-like body fields are ignored. Routine switches (`routines: {id: boolean}`) keep only ids in `ROUTINES` (membership test, not `in`) with boolean values and are merged per id; a non-object body changes nothing. |
| 21 | POST | `/api/schedule` | O | `currentUser` `schedule/route.ts:32-33`. Runs weekly (charges credits) or daily for the caller. Routines have no "Run now": they run only from the cron. |
| 22 | GET | `/api/brief` | O | `currentUser` `brief/route.ts:6-7`. |
| 23 | GET | `/api/notifications` | U (account level, keyed by `u.email`) | `currentUser` `notifications/route.ts:6-7`. |
| 24 | POST | `/api/notifications` | U | `currentUser` `notifications/route.ts:14-15`. |
| 25 | GET | `/api/conversations` | O | `currentUser` `conversations/route.ts:7-8`. |
| 26 | POST | `/api/conversations` | O | `currentUser` `conversations/route.ts:14-15`. |
| 27 | PATCH | `/api/conversations` | O; `id` from body resolved under `sc(u)` | `currentUser` `conversations/route.ts:20-21`; `renameConversation(sc(u), id)` `:24`. |
| 28 | DELETE | `/api/conversations` | O; `id` from query resolved under `sc(u)` | `currentUser` `conversations/route.ts:28-29`; `deleteConversation(sc(u), id)` `:32`. |

### 1.3 Agents, content, tasks

| # | Method | Path | Who | Enforced by |
|---|---|---|---|---|
| 29 | GET | `/api/chat` | O; `conv` from query is a key suffix under `sc(u)` | `currentUser` `chat/route.ts:11-12`; `history(sc(u), conv)` `:14`. |
| 30 | POST | `/api/chat` | O | `currentUser` `chat/route.ts:23-24`. Tool side effects run under `user.scope` `src/lib/chat.ts:220`. |
| 31 | POST | `/api/chat/feedback` | U | `currentUser` `chat/feedback/route.ts:8-9`; written to `fblog:{sc(u)}` `:13`. Since 2026-09-29 a thumbs-down reason reaches that agent's chat prompt in the same scope, escaped as data (`feedbackFor`, `src/lib/feedback.ts`), never generation, publishing, spending or the brand file. No rate limit; the prompt takes only the 5 newest reasons, 200 characters each. |
| 32 | POST | `/api/generate` | O | `currentUser` `generate/route.ts:16-17`; trial check `:23`; `missingData` (cart-recovery needs a synced store, 409 `no_cart_data` before any charge); `charge` with the owning agent and the owner's cap for it in `gov:{sc(u)}`, 402 `agent_cap` before any model call and without debiting (`flows.md` 8.9-8.10). |
| 33 | POST | `/api/onboard` | O | `currentUser` `onboard/route.ts:28-29`; builds only from the URL the owner confirmed, `onboardok:{sc(u)}` (403 `unconfirmed` `:39`, before the crawl, the model and the daily allowance); per-scope lock `:44`. |
| 33a | POST | `/api/onboard/confirm` | O | `currentUser` `onboard/confirm/route.ts:12-13`; writes only `onboardok:{sc(u)}` (1 day), 409 when the scope already has a brand `:18`. No crawl, no model call. Cross-site submission is stopped by the SameSite=Lax session cookie. |
| 34 | GET | `/api/onboard/plan` | O | `currentUser` `onboard/plan/route.ts:10-11`. |
| 35 | POST | `/api/onboard/plan` | O | `currentUser` `onboard/plan/route.ts:17-18`. |
| 36 | POST | `/api/catalog` | O | `currentUser` `catalog/route.ts:9-10`. Fetches a user-supplied URL server-side `:12,19`. |
| 37 | GET | `/api/tasks` | O | `currentUser` `tasks/route.ts:6-7`. |
| 38 | PATCH | `/api/tasks/{id}` | O; `id` resolved with `getTask(sc(u), id)`; decision records appended to `decisions:{sc(u)}` only (the body cannot name a scope) | `currentUser` `tasks/[id]/route.ts:9-10`; scope lookup `:12-13`; `recordDecisions(scope, ...)` inside `after()`. |
| 39 | POST | `/api/tasks/{id}/image` | O | `currentUser` `tasks/[id]/image/route.ts:11-12`; scope lookup `:14-15`; `charge` against the agent that owns the item and its cap (402 `agent_cap`); a placeholder or a failure refunds the credit and the agent's counter. |
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
| 48 | POST | `/api/publish/{id}` | O; `id` resolved with `getTask(sc(u), id)`; connection read under `sc(u)`; a `publish` decision recorded under `sc(u)` when the item was pending | `currentUser` `publish/[id]/route.ts:10-11`; scope lookup `:13-14`; `publishTask(sc(u), ...)` `:18`; `recordDecisions(sc(u), ...)`. |
| 49 | GET | `/api/integrations` | A gets the static catalog; F gets the request list | `isAdmin` branch `integrations/route.ts:7`. |
| 50 | POST | `/api/integrations` | U | `currentUser` `integrations/route.ts:15-16`. |

### 1.5 MCP and the OAuth authorization server

| # | Method | Path | Who | Enforced by |
|---|---|---|---|---|
| 51 | OPTIONS | `/api/mcp` | A | CORS preflight `mcp/route.ts:36`. |
| 52 | GET | `/api/mcp` | A | Static descriptor `mcp/route.ts:39`. |
| 53 | POST | `/api/mcp` | A for `initialize`, `ping`, `notifications/initialized`, `tools/list` (`mcp/route.ts:49-51`); M for `tools/call` | `userFromBearer` `mcp/route.ts:53-54`. All data access uses `user.scope ?? user.email` (`sc(u)`), the bearer's active brand. `get_brand_rules` and `check_brand` read only the caller's own brand and spend nothing. `save_draft` writes one `pending` task with `source:"external"` to `sc(u)` only (arguments naming a scope, email or id are ignored), is never auto-approved, runs the brand gate in code, spends no credits and calls no model, and is rate limited per account by `draftAllowed` (30 an hour, 150 a day). `generate_content` charges against the owning agent's monthly cap in the active brand and returns a tool error at the cap, charging nothing. |
| 54 | GET | `/api/mcp/token` | U | `currentUser` `mcp/token/route.ts:6-7`. Returns only a 12-char prefix. |
| 55 | POST | `/api/mcp/token` | U | `currentUser` `mcp/token/route.ts:12-13`. |
| 56 | DELETE | `/api/mcp/token` | U | `currentUser` `mcp/token/route.ts:19-20`. |
| 56a | GET | `/api/performance` | O | `currentUser` `performance/route.ts`; `getPerf(sc(u))`. |
| 56b | POST | `/api/performance` | O | `currentUser`; `allow("perf:{email}", 20, 3600)`; body capped at 2,000,000 characters (413); parsed as data; saved under `sc(u)`. No model call, no credits. |
| 56c | DELETE | `/api/performance` | O | `currentUser`; `clearPerf(sc(u))` deletes `perfimport:{scope}` and `performance-learnings.md`. |
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

### 1.8 Cron

| # | Method | Path | Who | Enforced by |
|---|---|---|---|---|
| 88 | GET | `/api/cron/daily` | C | `sameSecret` `cron/daily/route.ts:67-68`. |
| 89 | GET | `/api/cron/weekly` | C | `sameSecret` `cron/weekly/route.ts:14-15`. |
| 90 | GET | `/api/cron/golden` | C | `sameSecret` `cron/golden/route.ts:11-12`. |
| 91 | GET | `/api/cron/routines` | C | `sameSecret` `cron/routines/route.ts:17-18`. Runs the routines owners turned on (`src/lib/routines.ts`), each under its own brand scope from `allUsers()`; charges credits against the owning agent's cap in that scope. |

Related non-API surface: `/oauth/authorize` (`src/app/oauth/authorize/page.tsx:10-12`) requires a session and redirects anonymous visitors to `/ar/app/login?next=...`; `/.well-known/oauth-*` are public rewrites (`next.config.ts:4-11`).

## 2. App pages under `src/app/[lang]/app`

Two layers exist. Layer 1, the layout (`layout.tsx:21-24`): reads `x-pathname` set by the proxy (`src/proxy.ts:28`); if there is no user, the path is non-empty and it does not end with `/login`, `/signup`, `/forgot`, `/reset` or `/admin`, redirect to `/{lang}/app/login`. Layer 2, the page's own check, listed below. The proxy itself enforces nothing.

| Page | Access rule | Page-level enforcement | Data scope used by the page |
|---|---|---|---|
| `layout.tsx` | see above | `layout.tsx:14-24` | `getBrand(sc(user))` `:40` |
| `page.tsx` (inbox) | U with a brand; else `/start` | `page.tsx:15-17` | `sc(u)` |
| `chat/page.tsx` | U; without a brand runs onboarding only for the URL confirmed in `onboardok:{sc(u)}`, else `/start?url=` with the `?onboard=` value pre-filled for review | `chat/page.tsx:26-41` | `sc(u)`, except `listConnections(u.email)` `:38` and `listNotifs(u.email)` |
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

The sidebar shows the console link when `isFounder(user.email)` (`layout.tsx:44`); this is display only.

## 3. Cross-tenant isolation

### 3.1 How a scope is derived
1. `currentUser()` loads the user, then `activeBrandId(email)` reads `activebrand:{email}` (default `"default"`) and `scopeFor(email, brandId)` returns `email` for the default brand or `` `${email}#${brandId}` `` otherwise (`src/lib/auth.ts:163-165`, `src/lib/brands.ts:21-29`).
2. `sc(u) = u.scope ?? u.email` (`src/lib/auth.ts:26`). `scope` and `brandId` are runtime only and stripped by `saveUser` (`auth.ts:51`).
3. The active brand can only be set to an id found in the caller's own `brands:{email}` list (`brands/route.ts:27-30`), or to a brand just created by `addBrand` (`brands.ts:37`). Archiving the active brand resets it to `default` (`brands/route.ts:36`). `activeBrandId` does not re-validate that the stored id still exists or is active.
4. Brand ids are 8 base36 characters from `Math.random()` (`brands.ts:34`).
5. Every brand-scoped key embeds the scope string (see `architecture.md` section 3). Isolation between tenants therefore depends on (a) the session to email mapping and (b) scope strings of different accounts never being equal.
6. Account-level (not brand-level) records: user, credits, sessions, notifications, MCP tokens, referral data, usage, analytics. The per-agent monthly counters live on the account's user record but are keyed by brand scope (`agentSpend.by[scope]`), and the caps they are checked against are per brand (`gov:{scope}.agentCaps`), so one brand's spend and caps never apply to another. Chat thumbs are per brand scope since 2026-09-21 (`fblog:{scope}`), and so is the feedback built from them, the decision records and the judge's notes for an agent's prompts (`feedbackFor`, 2026-09-29).
7. Cron and admin code construct scopes with the same `scopeFor` (`allUsers()` in `schedule.ts:157-167`, `admin/users/[email]/route.ts:24`, `account.ts:26`). The routines cron keys every read and write by the `scope` `allUsers()` set (`routinelast:{scope}:{id}`, `routinelock:{scope}:{id}`, `routinecap:{scope}`, `routinehold:{scope}:{id}`, `routinetry:{scope}:{id}:{period}`, `schedule:{scope}`, `gov:{scope}`, the tasks).
8. MCP callers resolve the active brand the same way a browser session does (`userFromBearer`, `src/lib/mcp.ts`), so a bearer token works in the brand the owner has active. Fixed 2026-09-20; it used to always mean the default brand.

### 3.2 Routes that accept an id, email or other locator from the request

| Route | Locator | Binding to the caller |
|---|---|---|
| `PATCH /api/tasks/{id}`, `POST /api/tasks/{id}/image`, `GET /api/tasks/{id}/pptx`, `POST /api/publish/{id}` | task id (path) | Key is `task:{sc(u)}:{id}`; a foreign id yields 404. No format check on `id`. |
| Chat tools `generate_image`, `publish_item` (`src/lib/chat.ts:302,329`) | `task_id` chosen by the model | `getTask(user.scope, id)`; same binding. |
| `GET/POST /api/chat` | `conv` (query or body) | Key `chat:{sc(u)}:{conv}`; not checked against `convs:{sc(u)}`; no format check (the chat page applies `^[a-f0-9]{6,16}$` at `chat/page.tsx:36`, the API does not). |
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

No route accepts an email or scope from a non-founder request and uses it to read or write another tenant's workspace data.

## 4. Admin model

1. `adminEmails()` (`src/lib/auth.ts:108-110`): `ADMIN_EMAILS` split on commas, normalized. When the variable is unset the list defaults to one hard-coded address in the source.
2. `isFounder(email)` (`auth.ts:111`): membership test. Used for the sidebar link (`layout.tsx:44`), inside `isAdmin`/`isAdminCookie`, and as the recipient list for golden-set alerts (`golden.ts`, `adminEmails()`).
3. `isAdmin(req)` (`auth.ts:114-125`), used by every `/api/admin/*` data and action route plus the admin branches of `/api/support`, `/api/affiliates`, `/api/integrations`: true when `WAITLIST_ADMIN_KEY` is set and equals `?key=`, or header `x-admin-key`, or cookie `nashr_admin` (plain `===` comparison); otherwise true when `currentUser()` is a founder. Either path alone is sufficient.
4. `isAdminCookie()` (`auth.ts:128-136`), used by `admin/page.tsx`: same without the query and header forms.
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
6. **Suspension.** Fixed: `userFromBearer` (`mcp.ts:31-32`) refuses a suspended account, so its MCP personal and OAuth tokens stop working, and `allUsers()` (`schedule.ts:163`) skips suspended accounts, so no cron (weekly plan, routines, daily emails) charges or emails them. The `User.suspended` comment says "login and all API access blocked" (`auth.ts:21`).
7. **MCP token revocation.** Fixed 2026-09-18. Every OAuth token pair belongs to a grant (`mcpgrant:{email}:{id}`, index `mcpgrants:{email}`). `GET /api/mcp/grants` lists connected apps without tokens, `DELETE ?id=` or `?all=1` revokes; the MCP page shows the list. Refresh rotation deletes the previous access token. Password reset, founder reset and `wipeAccount` revoke the personal token and every grant. Tokens issued before this change have no grant and cannot be listed; they expire on their own (30 d access, 90 d refresh) or die at the next password reset only if they were the personal token.
8. **MCP scope.** Partly fixed 2026-09-18: the approve route only writes scopes this server defines (`SCOPES`, today `noor`), and MCP `generate_content` applies the same trial-expiry check as `/api/generate`. On 2026-09-20 a token started resolving the active brand like a session, and `ask_noor` was put under the same per-account chat ceiling as the web route. Still open: there is one OAuth scope, so every token grants every MCP tool including `ask_noor` (which reaches `write_file`, `update_brand` and credit-spending tools; `publish_item` still needs an approved item).
9. **`POST /api/admin/impersonate` has no admin check.** It acts only on the caller's own cookies and requires `nashr_return` to be a live session token, so it cannot mint access, but the rule "founder only" is not enforced there.
10. **Impersonation lifetime and audit.** The log says `expiresInMin:120` and the banner says "2 hours max", but the impersonated session is a normal 30-day session and is not deleted on return (`admin/users/[email]/route.ts:87-90`, `admin/impersonate/route.ts:11-14`). Actions performed while impersonating are attributed to the target user; `admin:log` never records which founder acted.
11. **Admin key handling.** `isAdmin` accepts the key in the URL query (`auth.ts:118`), where it can end up in logs and browser history, and every comparison now goes through `sameSecret` (`isAdminCookie` used `===` until 2026-09-20). The `nashr_admin` cookie stores the key itself rather than a derived session. Rate limiting applies to `/api/admin/login` only, not to guesses sent as `?key=` or `x-admin-key` to other admin routes. The same key doubles as the connector encryption fallback (`connectors/store.ts:14`), with a fixed development string as the last fallback.
12. **`GET /api/waitlist` uses its own check** (query key only, `waitlist/route.ts:55`) instead of `isAdmin`. Whether founders without the key should reach it is not stated.
13. **Publishing does not require approval.** `POST /api/publish/{id}` and the chat tool `publish_item` publish a task in any status and then set it to `approved` (`publish/[id]/route.ts:18-20`, `chat.ts:307-309`). The HTTP route also skips `targetsFor`, so any task type can be sent to any connected provider. The product copy describes an approval inbox; the code does not gate publishing on it. For the model-driven path, "only when the owner explicitly asks" is a prompt instruction (`chat.ts:82`), not a code check.
14. **Model-controlled writes are not re-validated.** `update_brand` writes `brand[field] = value` using the model's `field` (`chat.ts:283-286`); the enum is enforced only by the strict tool schema. Text crawled from user-supplied sites and imported catalogs is placed into prompts and `products.md` without marking it as untrusted.
15. **Server-side fetches of user-supplied URLs** (`crawl.ts:50`, `catalog.ts:12,26`, WordPress/WooCommerce/Odoo/PrestaShop base URLs in `connect/[provider]/key`) have no allow-list, no private-address or metadata-address block, and follow redirects. Verify errors and publish errors return fragments of the remote response to the caller (`key/route.ts:27`, `publish/[id]/route.ts:25`). No rule is written for acceptable targets.
16. **Connector OAuth callback is sessionless.** The connection is saved to the scope stored in `state`, whoever completes the redirect (`callback/route.ts:28`); the path provider is not checked against the state's provider; Shopify callbacks are not HMAC-verified. OAuth tokens are never refreshed although `expiresAt` is stored.
17. **Account deletion leaves data behind.** `wipeAccount` (`account.ts:8-21`) deletes the `conns:{scope}` set but not the `conn:{scope}:{provider}` records holding encrypted third-party credentials; (fixed 2026-09-18: connector records, every task and conversation, the task index, the pending set, the personal MCP token and all OAuth grants are deleted); it still leaves `session:*` (harmless: the user record is gone),  `notifs:`, `notified:`, `notifseen:`, `usage:`, `uev:`/`ulast:`/`ufirst0:`, `fb:`/`fblog:` (fixed 2026-09-21: `fblog:{scope}` for every brand and the legacy `fb:` counters are now deleted — the log holds the free-text reason the owner typed; `decisions:{scope}`, added 2026-09-29, is deleted for every brand for the same reason; the `usage:` counters of the last 36 months are deleted from the list `usageMonthKeys` builds from `KINDS` and `AGENT_IDS`, so the per-agent counters added 2026-09-29 go too), `ref:`, `referrals:`, `referredBy:`, `shared:`, OAuth tokens, membership in `users:all` and `active:*` sets, tickets, and for non-default brands the `profile:{scope}` key. A `deleted-accounts` entry keeps the email. No retention rule is documented in code.
18. **Whole-record user saves outside the credit lock.** `PUT /api/profile`, `PATCH /api/account` and `POST /api/auth/reset` call `saveUser` with the record read at request start (`profile/route.ts:39`, `account/route.ts:15`, `reset/route.ts:22`), so a concurrent `charge` or `refund` can be overwritten, and since 2026-09-29 that includes the per-agent counters (`agentSpend`) the charge wrote. `POST /api/referral/share` checks and sets its once-only flag in two steps (`share/route.ts:16-18`), as do `once()` and `pushNotif` fingerprints.
19. **Brand-scope inconsistencies inside one account.** Pages fixed 2026-09-18: files, governance, tasks, generate, onboarding, and `listConnections` in chat and reports now read `sc(u)`; `tests/scope-usage.test.ts` fails when a page or customer API route passes the bare account email to a workspace reader. Still open: email preferences are written to `profile:{sc(u)}` and cron reads the scope first and the account second; the founder overview counts credits from the default brand only.
20. **Credits and plan limits not tied to a payment event.** Plans and credits change only through the founder console. Free tools are unlimited and free for signed-in users (`tools/[tool]/route.ts:15`), onboarding and catalog import are uncharged and repeatable, and trial expiry is not checked for image generation. `BRAND_LIMIT` is checked only when adding a brand, not after a downgrade. Whether these are intended is not stated.
21. **Layout guard depends on a header.** The layout redirect runs only when `x-pathname` is non-empty (`layout.tsx:24`) and public paths are matched with `endsWith`. Every current page has its own guard except `reset` (public by design), so this is defence in depth only; the rule for future pages is unwritten.
22. **`next` redirect parameter.** Login and signup accept `next` when it starts with `/` and not `//` (`AuthForm.tsx:23,75`). A value beginning with `/\` passes this test; browsers may treat it as protocol-relative. No server-side rule exists for post-login destinations.
23. **No CSRF token.** State-changing routes rely on `sameSite=lax` cookies and JSON bodies. `POST /api/oauth/approve` and `POST /api/admin/impersonate` accept form posts. MCP and OAuth endpoints send `Access-Control-Allow-Origin: *` (bearer or public by design).
24. **Anonymous counters without expiry.** Fixed 2026-09-18 for the free tools: the limiter is `allow("tool:{ip}")` with a 24 h window and the platform IP. The in-memory store honours TTL since 2026-09-18.
25. **Email normalisation on founder actions.** `POST /api/admin/users/{email}` looks the user up with a normalized email but passes the raw decoded path value to `withUserLock` and `wipeAccount` (`admin/users/[email]/route.ts:47-48,94`). With a mixed-case path value the lookup succeeds while the wipe targets different keys and the log still records `delete`.

## Brand rules (2026-09-28)

The owner's banned words are enforced in code, not only in prompts (`src/lib/brand-rules.ts`). A customer-facing item whose text contains one cannot become `approved` through `PATCH /api/tasks/{id}` (409 `brand_violation`), cannot be published through `POST /api/publish/{id}` (409) or the chat tool `publish_item` (refused), and is created `pending` even when its type is auto-approved. The owner can still edit it, save it as pending, or remove the word from the brand file; no other actor can lift the rule.

## Drafts from the owner's own assistant (2026-09-29)

MCP `save_draft` lets a bearer (the owner's Claude, ChatGPT or any MCP client, through a personal token or an OAuth grant) put text into the approval inbox of its own active brand. It can create, never decide: the item is always `pending` whatever `gov.autoApprove` says, the brand gate applies to it like to any agent's draft, and approving, editing, rejecting and publishing stay with the signed-in owner in the app. It spends no credits, so its only bound is `draftAllowed` (30 an hour, 150 a day per account). The text is untrusted input: typed and bounded by `parseDraft`, rendered in the inbox like model output (`render`), never executed or followed.
