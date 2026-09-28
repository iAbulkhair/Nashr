# Nashr: flows (as implemented)

Step-by-step behaviour with the files involved. Paths relative to the repository root. "scope" is `sc(u)`: the account email for the default brand, `email#brandId` for extra brands (`src/lib/auth.ts:26`, `src/lib/brands.ts:27`). Statements describe the code at HEAD `4959f7e`.

## 1. Signup (email first, then name and password)

Files: `src/app/[lang]/app/signup/page.tsx`, `src/components/app/AuthForm.tsx:16-70`, `src/app/api/auth/signup/route.ts`, `src/lib/auth.ts`, `src/lib/referral.ts`, `src/lib/track.ts`.

1. Page redirects an already signed-in user to `/{lang}/app` (`signup/page.tsx:11`).
2. Client step 1: email is validated with `^[^\s@]+@[^\s@]+\.[^\s@]+$` (`AuthForm.tsx:33`). Step 2 asks for name and password; the client requires length >= 8, one letter, one digit (`AuthForm.tsx:29`). Query params read: `ref` (referral code), `url` (site for onboarding), `next` (must start with `/` and not `//`, `AuthForm.tsx:23`).
3. `POST /api/auth/signup` with `{email, name, password, lang, ref, phone?}`.
4. Server: normalizes email (trim, lowercase); same email regex; password length >= 8 only (no letter/digit rule server-side, `signup/route.ts:10`); optional phone needs >= 9 digits; 409 `exists` if `user:{email}` exists.
5. `createUser` (`auth.ts:57`): bcrypt cost 10, plan `trial`, 50 credits, `trialEnds` = now + 3 days, name clipped to 80 chars. Writes `user:{email}`, adds to `users:all`.
6. `registerCode` writes `ref:{CODE}`. If `ref` matches `^[A-Za-z0-9]{6,10}$`, `applyReferral` runs (section 15).
7. `createSession(email)` sets cookie `nashr_session`. `track(email,"signup")`.
8. Client navigates to `next`, or `/{lang}/app/start?url={url}` when a site URL was carried (the owner reviews and confirms it there before anything is read, section 6), else `/{lang}/app/start`. A carried URL never starts onboarding by itself: until 2026-09-28 it went straight to `/{lang}/app/chat?onboard={url}`, so a link like `/en/app/signup?url=attacker.example` chose the new workspace's brand.
9. No rate limit, no email verification, no CAPTCHA on this route.

## 2. Login

Files: `login/page.tsx`, `AuthForm.tsx:72-110`, `src/app/api/auth/login/route.ts`.

1. `POST /api/auth/login {email, password}`.
2. `getUser(normalizeEmail(email))`; bcrypt compare. Unknown user or bad password: 401 `invalid` (same response for both). Suspended: 403 `suspended` (only after a correct password).
3. `createSession`, `track("login")`, `{ok:true}`. Client goes to `next` (same `/` and not `//` rule) or `/{lang}/app`.
4. No rate limit or lockout on this route.

## 3. Logout

`src/components/app/LogoutButton.tsx` posts to `POST /api/auth/logout` (`src/app/api/auth/logout/route.ts`), which calls `destroySession()` (`auth.ts:86`): deletes `session:{token}` and the `nashr_session` cookie. It does not touch `nashr_admin`, `nashr_return` or `nashr_impersonate`.

## 4. Password reset

### Forgot
Files: `forgot/page.tsx`, `AuthForm.tsx` (`ForgotForm`), `src/app/api/auth/forgot/route.ts`, `src/lib/notify.ts`, `src/lib/rate.ts`.

1. `POST /api/auth/forgot {email, lang}`. Bad email format: 400.
2. Rate limits: 8 per 15 min per IP and 3 per 15 min per email. When exceeded the route still answers `{ok:true, mail}` (`forgot/route.ts:23`).
3. If the account exists and `RESEND_API_KEY` is set: a 32-byte hex token is generated, its SHA-256 is stored as `pwreset:{hash}` with `{email}` for 3600 s, and a link `${APP_ORIGIN}/{lang}/app/reset?token=...` is emailed.
4. Response is always `{ok:true, mail:boolean}`; `mail` says whether email delivery is configured, not whether the account exists. The forgot page shows a WhatsApp link when `SUPPORT_WHATSAPP` is set.

### Reset
Files: `reset/page.tsx`, `AuthForm.tsx:150-166`, `src/app/api/auth/reset/route.ts`.

1. `POST /api/auth/reset {token, password}`. Rate limit 10 per 15 min per IP (429).
2. Password rule server-side: length >= 8, one Unicode letter, one digit. Token must match `^[a-f0-9]{64}$`.
3. Looks up `pwreset:{sha256(token)}` and the user. Missing: 400 `bad_token`. The key is deleted before the suspended check (token is single use even when the account is suspended, 403).
4. New bcrypt hash saved with `saveUser` (not under the user lock), `createSession`, `{ok:true}`. Existing sessions for the account are not revoked.

### Change password while signed in
`PATCH /api/account {currentPassword, newPassword}` (`src/app/api/account/route.ts:8`): requires session, new password length >= 8, verifies the current password, saves. Other sessions are not revoked.

## 5. Session handling and cookie names

| Cookie | Set by | Value | Attributes | Lifetime |
|---|---|---|---|---|
| `nashr_session` | `auth.ts:83` (`createSession`), `api/admin/impersonate/route.ts:11` | 32-byte hex token; server side `session:{token}` holds the email | httpOnly, sameSite lax, secure in production, path `/` | 30 days (cookie and Redis TTL) |
| `nashr_admin` | `api/admin/login/route.ts:18` | The raw `WAITLIST_ADMIN_KEY` value | httpOnly, lax, secure in production | 30 days |
| `nashr_return` | `api/admin/users/[email]/route.ts:87` | The founder's own session token, saved while impersonating | httpOnly, lax, secure in production | 2 hours |
| `nashr_impersonate` | `api/admin/users/[email]/route.ts:88` | Email of the impersonated user (display and audit only) | httpOnly, lax, secure in production | 2 hours |
| `nashr_lang` | `src/components/LangToggle.tsx:8` (client JS) | `ar` or `en` | not httpOnly, lax | 1 year |

`currentUser()` (`auth.ts:93`): cookie, `session:{token}`, `user:{email}`; returns `null` when the user is missing or `suspended`; otherwise sets runtime-only `brandId` and `scope`. Sessions are not rotated, not bound to IP or user agent, and are not deleted on password change, password reset, suspension (suspension is enforced at read time) or account wipe (the user record disappears, so `currentUser` returns `null`).

## 6. First-run onboarding inside the chat

Files: `start/page.tsx`, `src/components/app/StartWizard.tsx`, `src/app/api/onboard/confirm/route.ts`, `src/lib/onboard-confirm.ts`, `chat/page.tsx:28-41`, `src/components/app/ChatPanel.tsx:112`, `src/app/api/onboard/route.ts`, `src/lib/crawl.ts`, `src/lib/onboard.ts`, `src/app/api/onboard/plan/route.ts`, `src/components/app/OnboardCards.tsx`.

1. A user without `brand:{scope}` is redirected from the inbox, chat and reports pages to `/{lang}/app/start`. The wizard collects a site URL; a manual alternative links to `/{lang}/app/onboarding` (brand form, `PUT /api/brand`). A URL carried in from a link (signup `?url=`, start `?url=`, chat `?onboard=`) only pre-fills the field and shows a review note ("Check this link before Noor starts"); nothing is read until the owner presses Go.
2. Go posts `{url}` to `POST /api/onboard/confirm`: session required, URL trimmed and clipped to 300 characters (`onboardUrl`), length >= 4 else 400 `bad_url`, 409 `already_onboarded` when the workspace has a brand. It writes `onboardok:{scope}` = the URL (1 day) and nothing else: no crawl, no model call. The session cookie is SameSite=Lax, so another site cannot submit it for a signed-in owner. The wizard then routes to `/{lang}/app/chat?onboard={url}` (also on 409, where the chat opens as usual).
3. The chat page without a brand reads `onboardok:{scope}` and hands that URL to `ChatPanel`. The `?onboard=` value itself is never used to build: without a confirmation the page redirects to `/{lang}/app/start?url={value}` so the owner reviews it.
4. `ChatPanel` posts `{url}` to `POST /api/onboard`. Server requires a session and a URL of length >= 4, then, in this order: 409 `already_onboarded` when `brand:{scope}` exists; 403 `unconfirmed` unless the URL equals `onboardok:{scope}` (checked in code, before the paused check, the daily allowance, the lock and the crawl, so an unconfirmed URL costs nothing); 503 `paused`; 429 after three runs a day per account; lock `onboardlock:{scope}` (240 s), a second concurrent run gets 409 `busy`.
5. SSE stream (10 s ping). Steps: intro message, `crawl(url)` of the confirmed URL (server-side fetch of the user URL, 9 s timeout, follows redirects, `crawl.ts:44`), then `buildFromSite`: three parallel `claude-opus-5` calls from the same snapshot (core: brand, brand.md, plan, goal, summary; identity: guidelines, opportunities; market: research, strategy), one retry per part; the status line advances as each part lands.
6. Writes: `saveBrand(scope)`, each returned file via `writeFile(scope, ...)`, `preferences.md` if absent, `onboardplan:{scope}`, and deletes `onboardok:{scope}`: one confirmation, one build. Every assistant message is persisted to `chat:{scope}` via `push`. A failed or paused run keeps the confirmation, so "refresh to try again" works for a day.
7. Onboarding charges no credits (`onboard/route.ts:25`) and runs once per workspace (409 once `brand:{scope}` exists) and at most three times a day per account.
8. `GET /api/onboard/plan` returns the stored plan; `POST {index, added}` flips the `added` flag. Phone is requested in-thread and saved through `PUT /api/profile` (`OnboardCards.tsx:75`).
9. While the stream runs, `OnboardProgress` (`ChatPanel.tsx`) shows each `status` event as a completed step with a bar that never reaches 100% before `done`. After it, the launch journey (section 19) celebrates its first milestone.

## 7. Chat turn with `generate_content` and `draft_items`

Files: `src/app/api/chat/route.ts`, `src/lib/chat.ts`, `src/lib/noor.ts`, `src/lib/credits.ts`, `src/lib/judge.ts`, `src/lib/governance.ts`.

1. `POST /api/chat {text, conv?, agent?, stream?}`; session required; text clipped to 4000; `agent` falls back to `noor`; reply language from header `x-lang` else `u.lang`. `conv` is not validated against `convs:{scope}`; any string yields the key `chat:{scope}:{conv}`.
2. `chat()` pushes the user message, builds context (brand, 30 preferences, five memory files up to 6000 chars each, file names, connected providers, last 16 messages), and loops up to 5 model turns (`chat.ts:183`).
3. Tools available to every agent (`chat.ts:37-92`): `generate_content`, `draft_items`, `update_brand`, `read_file`, `write_file`, `import_catalog`, `generate_image`, `publish_item`, `list_inbox`.
4. `generate_content` (`chat.ts:222`): needs a brand; expired trial returns a message and sets `limit:trial`; cost `TASK_COST[type]` (`brand.ts:38`); `charge`; `generate(type, ...)`; tasks saved with `source:"chat"`; `judgeLater`.
5. `draft_items` (`chat.ts:251`): types `social|whatsapp|ads|gbp`; count clamped to 1..3; cost `max(1, ceil(TASK_COST/TASK_COUNT * count))`; otherwise identical.
6. Status for new tasks: `approved` when `gov.autoApprove[type]` is true, else `pending`.
7. Final assistant message stored with `items` (max 10 cards) and returned. `limit` is `credits` or `trial` when a tool hit that wall.
8. `POST /api/chat/feedback {agent, value: 1|-1, reason?, at?}` records the thumb in `fblog:{scope}`, keyed by the ACTIVE BRAND's scope (chat history is per brand, so its feedback is too). The old `fb:{email}:{agent}:up|down` lifetime counters are no longer written (2026-09-21).
9. Without `ANTHROPIC_API_KEY` the chat returns a `[DEV MOCK]` message before any tool runs (`chat.ts:165`), and `generate` returns mock items (`noor.ts:139`). Callers that reach `generate` directly (`/api/generate`, MCP `generate_content`, `runWeekly`) still charge credits for the mock items.
10. Cart-recovery drafts (`cart_recovery`, Noor, 5 items for 3 credits; `src/lib/cart-recovery.ts`): `/api/generate`, chat `generate_content` and `draft_items`, and MCP `generate_content` call `missingData` before `charge`; without a `storesales:{scope}` snapshot that names products left in carts they return `no_cart_data` (409 on the route) and charge nothing. `statsFor` hands the model a `CART DATA` block built from the snapshot (store, sync date, open carts, products most often left, best sellers) as escaped JSON inside `<cart_data>`, with no shopper data. After the reviewer, `generate` runs `capDiscounts`: any percentage (Latin or Arabic digits) that is not in the brand file's `offers` becomes `[رقم]%`. The drafts are a 3-message WhatsApp sequence (1 h, 24 h, 72 h, with `{{1}}` name and `{{2}}` cart-link placeholders) and 2 posts; Nashr never sends them, the owner pastes them into the store's own abandoned-cart automation. The Reports store card has a "Draft cart-recovery messages" button once a sync found products left in carts. `draft_items` now also passes `statsFor`, so small asks of Dana's types get the workspace data too.
11. Claude is paused in code (`CLAUDE_PAUSED` in `src/lib/model.ts`, since 2026-09-28). `modelState()` is `mock` without a key (step 9, unchanged for dev and CI), `paused` with a key while the switch is on, and `on` otherwise. While paused no surface calls the model or keeps a credit, and none shows the step-9 placeholders: `/api/generate` answers 503 `model_paused` before `charge`; MCP `generate_content` returns an error text before `charge`; chat (web and MCP `ask_noor`) replies with `PAUSED_REPLY` in the owner's language and runs no tool; `/api/onboard` answers 503 `paused` before its daily allowance, its lock and the crawl, so no mock brand file is saved; `/api/tools/[tool]` answers 503 `paused` before the rate limit; `runWeekly` returns `retry:paused` before `charge`, which leaves the week open in the cron markers for the Monday and Tuesday catch-ups; the judge returns no scores; image prompts use the fixed fallback (fal.ai still draws the image); the golden set refuses (`model_paused` on the admin route, `locked_or_no_model_key` on the cron). As a backstop `generate` and `buildFromSite` throw `ModelPaused`, and every caller that charged first refunds. To resume, set `CLAUDE_PAUSED` to `false` and deploy.

## 8. Credits: charge and refund

Files: `src/lib/credits.ts`, callers in `api/generate/route.ts:25`, `chat.ts:228,258,331`, `api/mcp/route.ts:71`, `api/tasks/[id]/image/route.ts:16`, `schedule.ts:45`.

1. `withUserLock(email)`: spin on `lock:user:{email}` (SET NX, 10 s TTL), 60 tries at 50 ms (3 s) then throws `user_lock_timeout`. Re-reads the user inside the lock.
2. `charge(email, cost)`: fails without change when `credits < cost`; else subtracts and saves.
3. `refund(email, n)` = `adjust(email, +n)`; balance is floored at 0 and deltas are truncated to integers.
4. Pattern: charge before the model call, refund in `catch`. Credits belong to the account, not the brand: every scope of one account draws from `user:{email}.credits`.
5. The lock guards only the read-modify-write of the user record and expires after 10 s. `unlock` is an unconditional `DEL` (`db.ts:56`), so a holder whose lock already expired would delete the next holder's lock.
6. Other balance writers: `renewIfDue` (monthly reset to plan allowance for non-trial plans, `credits.ts:58`), `POST /api/admin/plan` (under lock), `applyReferral` (+50 both sides), `POST /api/referral/share` (+20 per platform).
7. Writers that save the whole user record outside the lock: `PUT /api/profile` (`profile/route.ts:39`), `PATCH /api/account` (`account/route.ts:15`), `POST /api/auth/reset` (`reset/route.ts:22`). These persist the `credits` value read at request start.
8. Trial expiry is checked in `/api/generate`, chat tools `generate_content` and `draft_items`, and `runWeekly`. It is not checked in MCP `generate_content`, `generate_image` (chat tool and route), onboarding, catalog import, or free tools.

## 9. Approval and rejection of a task

Files: `src/app/api/tasks/[id]/route.ts`, `src/components/app/Inbox.tsx:57`, `ChatPanel.tsx:28`.

1. `PATCH /api/tasks/{id} {status?, editedBody?, note?, scheduledFor?}`; session required; task loaded with `getTask(sc(u), id)`, so only tasks under the caller's active scope resolve (404 otherwise).
2. `scheduledFor`: `null` clears, `YYYY-MM-DD` sets.
3. `editedBody` different from `body`: stored (max 20000 chars). When `gov.learning` is on, a preference note is pushed to `prefs:{scope}` and appended to `preferences.md`.
4. `status` in `approved|rejected|pending`: sets `decidedAt` on change, tracks `approve`/`reject`, and on reject with a note records a preference.
5. Any status may be moved to any other status, including after publishing. There is no separate approver role: the account owner is the only actor.
6. Brand gate (`src/lib/brand-rules.ts`): when the resulting status is `approved` and the item is customer-facing (`CUSTOMER_FACING`: social, article, whatsapp, ads, gbp, followup_seq, cart_recovery), the final text (`title` plus `editedBody ?? body`) is checked against the brand file's banned words. A hit returns 409 `{error: "brand_violation", violations}` and nothing is saved. Saving an edit as `pending` is allowed. Matching folds Arabic diacritics, tatweel and letter variants, accepts the Arabic prefixes و ف ب ل ك ال and suffixes for Arabic terms of three letters or more, and requires whole words for Latin and shorter terms. The inbox runs the same function in the browser to label cards and to check the editor as the owner types.
7. Auto-approval goes through `initialStatus(autoApprove, brand, item)` at every creation site (`api/generate`, `api/mcp` `generate_content`, chat `generate_content` and `draft_items`, the weekly schedule): an item that breaks a rule is created `pending` even when its type is auto-approved, and the chat tool reports how many were held.

## 10. Publishing to a connector

Files: `src/app/api/publish/[id]/route.ts`, `src/lib/connectors/publish.ts`, provider modules, chat tool `publish_item` (`chat.ts:301`).

1. `POST /api/publish/{id} {provider}`; session; task from `sc(u)`.
2. `publishTask(scope, task, provider)`: loads and decrypts `conn:{scope}:{provider}`; throws `not_connected` when absent. WordPress and Shopify create drafts; Telegram and X publish live (`publish.ts:24-40`). Body is `editedBody ?? body`; X clips to 280 chars, Telegram to 4000.
3. Before publishing, the route and the chat tool apply the brand gate from section 9 to the item's current text, including items approved before the word was banned: 409 `brand_violation` from the route, a refusal naming the word from the tool. On success the route appends to `task.published`, forces `status = "approved"` and saves. Both the HTTP route and the chat tool refuse a provider `targetsFor` does not list (`wrong_target`); the route refuses a rejected item (the owner's click is the approval), and the chat tool publishes only items already approved.
4. Provider error messages (up to 200 chars of the remote response) are returned to the caller in `error` (`publish/[id]/route.ts:25`).
5. Nothing publishes on a schedule. `scheduledFor` only drives calendar display and "due" notifications (`notifications.ts:57`).
6. Targets (`connectors/targets.ts`, no runtime imports, shared by the route, the chat tool and the inbox buttons): `connectedTargets` turns the stored connections into provider ids and adds `facebook` when the Meta connection has a chosen Page (`meta.pageId`) and `instagram` when that Page has an Instagram professional account (`meta.igId`). `targetsFor` offers `facebook` for `social` and `cart_recovery` items on the `instagram` or `facebook` channel, and `instagram` only for those items on the `instagram` channel that carry a generated image (`imageProvider === "fal"`; a placeholder card is not offered). Both publish through the `meta` connection (`CONNECTION_OF`).
7. Facebook (`connectors/meta.ts` `postToFacebook`): `POST /{page}/feed` with `message`, or `POST /{page}/photos` with `url` and `caption` when the item has a generated image, with the Page token as a Bearer header. Instagram (`postToInstagram`): `POST /{ig}/media` with `image_url` and `caption` (2,200 characters at most), `GET /{container}?fields=status_code` until `FINISHED` (8 tries, 1.5 s apart), `POST /{ig}/media_publish`, then the `permalink`. Markdown headings and bold are stripped from the text. Graph error code 190 is reported as 401 and codes 10 and 200 as 403, so `refusedToken` marks the Meta connection for reconnecting.

## 11. Connector OAuth: connect and callback

Files: `src/components/app/IntegrationsPanel.tsx:64,160`, `src/app/api/connect/[provider]/start/route.ts`, `.../callback/route.ts`, `src/lib/connectors/{registry,oauth,store}.ts`.

1. Browser navigates to `GET /api/connect/{provider}/start?lang=&shop=`. Session required. Provider must be `kind:"oauth"` and have both client env vars set (503 otherwise).
2. `shop` (Shopify only in practice): lowercased, scheme and path stripped, `.myshopify.com` appended when missing; anything that is then not `SHOP_HOST` (a single-label `*.myshopify.com`) is refused with 400 `bad_shop` before any redirect.
3. State: 16 random bytes hex. `oauthstate:{state}` = `{email: sc(u), provider, lang, shop, verifier}` for 10 min. PKCE pair only when `oauth.pkce` (X). The same state goes into the `nashr_oauth` cookie (httpOnly, SameSite=Lax, Secure as the session cookie, path `/api/connect`, 10 min).
4. Redirect to the provider authorize URL with `redirect_uri = ${APP_ORIGIN}/api/connect/{provider}/callback`.
5. `GET .../callback?state=&code=`: the `nashr_oauth` cookie is read and cleared, and `takeState` reads and deletes the state (single use). Missing state or code: `error=`. A state issued for another provider: `error=invalid_state`. The cookie must equal the state (`sameSecret`) and the signed-in account must own the state's scope, else `error=session_mismatch` and no code exchange. Shopify also needs a valid `hmac` over the query (`validShopifyHmac`, else `bad_hmac`) and a query `shop` equal to the state's (`bad_shop`).
6. `exchangeCode` posts to the provider token URL (Basic auth for X, body credentials otherwise; Shopify URL built from `shop`). All scalar fields of the token response are kept as `data`.
7. `saveConnection(st.email, ...)` writes `conn:{scope}:{provider}` (encrypted) and adds to `conns:{scope}`; the scope comes from the state record, not from the current cookie. `track(scope.split("#")[0], "connect")`.
8. Every use of a stored connection (publishing, product import) goes through `getFreshConnection` (`src/lib/connectors/fresh.ts`): an OAuth token that expires within 5 minutes is refreshed first (`grant_type=refresh_token`) under the lock `connlock:{scope}:{provider}`, and a rotated refresh token is saved. A refused refresh, a missing refresh token, or a 401/403 from the platform sets `needsReconnect` and the call fails with `reconnect_required`; the Integrations page then shows the connection with a Reconnect button.
9. A new connection saved by the callback replaces the record, which clears `needsReconnect`.
10. `DELETE /api/connect/{provider}` writes `null` to the connection key (the id remains in `conns:{scope}`; `listConnections` skips nulls). `POST /api/connect/{provider} {action:"import_products"}` imports products for shopify, woocommerce, odoo, prestashop, salla, zid into `products.md`. The Zid callback reads the manager profile (`GET /managers/account/profile`) and keeps the store id in `meta.storeId`, the store name in `meta.account` and its address in `meta.site`; every Zid call sends the `authorization` token as the bearer, `access_token` as `X-Manager-Token`, and `Store-Id`. A 403 on the Zid product import answers `zid_access_denied` without marking the connection for reconnecting (the Integrations card shows a permissions message); a 401 marks it.
10. Meta (`connectors/meta.ts` `connectMeta`, run by the callback after the code exchange): the short-lived user token is traded for a long-lived one (`grant_type=fb_exchange_token`, app credentials in the POST body), `GET /me/accounts` lists the Pages with their Page tokens and linked Instagram accounts, and the first Page with Instagram (else the first Page) is chosen. `data` (encrypted) holds the user token, every Page token and the chosen `page_token`; `meta` holds only `pageId`, `igId`, `account` and, with more than one Page, `pages` (ids, names, Instagram usernames). No expiry is stored: Page tokens from a long-lived user token do not expire. An account with no Page returns `error=meta_no_page` and saves nothing. `POST /api/connect/meta {action:"select_page", pageId}` switches the Page only to one Meta returned (400 `unknown_page` otherwise). With `META_CONFIG_ID` set, the authorize URL sends `config_id` (Facebook Login for Business) instead of `scope`. The scopes are the six publishing permissions only; Meta Ads and WhatsApp are not requested and their catalog cards no longer borrow the Meta connection's status.
11. `POST /api/connect/salla {action:"sync_sales"}` (`store-sales.ts`, `connectors/salla.ts` `sallaSales`): reads `GET /orders` for the last 30 days (up to 10 pages) and `GET /carts/abandoned` (60 a page, up to 3 pages) with a fresh token, reduces them to totals (order count, revenue by currency without canceled or refunded orders, open carts and their value, top 10 products each), and stores them in `storesales:{scope}` and in the file `store-sales.md`. No customer name, phone, email or checkout link is kept. Records whose amount cannot be read are counted as `unread`. `memoryBlock` includes `store-sales.md`, so every generation sees the totals; the Reports page shows them with a Sync button when Salla is connected.
12. `POST /api/connect/shopify {action:"sync_sales"}` (`store-sales.ts`, `connectors/shopify.ts` `shopifySales`, shared totals in `connectors/sales.ts`): the same snapshot from Shopify's Admin GraphQL API on the connected `*.myshopify.com` host only (see step 13). `orders` (last 30 days, 100 a page, up to 5 pages, 5 line items each) asks for no customer, email, phone or address field; `ordersCount` gives the full count. `abandonedCheckouts` (`created_at` in the last 30 days `AND status:open`, up to 3 pages) is read for totals and line titles only, with `abandonedCheckoutsCount` for the full count; `carts.capped` is set only when the count is missing and more pages remain. Revenue uses `currentTotalPriceSet` (after partial refunds and edits) and leaves out canceled, `REFUNDED` and `VOIDED` orders. HTTP 403 or an `ACCESS_DENIED` error means the app lacks protected customer data access to orders and returns `orders_access_denied` without marking the connection for reconnecting; HTTP 401 does mark it. One store per workspace: the card shows the store last synced while it stays connected, else the first connected of Salla and Shopify.
13. Every Shopify call (`shopifyGql`) is a POST to `https://{shop}/admin/api/2026-07/graphql.json` with the stored token: products (`importShopify`, 50 active products), the blog article (`publishShopifyArticle`: `blogs(first: 1)` and `shop.name`, then `articleCreate` with `isPublished: false` and the shop as author), and the sales queries. The shop must match `SHOP_HOST` before any request. A `THROTTLED` answer is retried twice, 2 s apart. The queries were validated against the Admin schema Shopify ships in `@shopify/dev-mcp` (2025-10, the oldest supported version) and use no deprecated field. Shopify requires GraphQL for new public App Store apps; the REST Admin calls are gone.
14. `POST /api/connect/zid {action:"sync_sales"}` (`store-sales.ts`, `connectors/zid.ts` `zidSales`): the same snapshot from Zid's Merchant API on `api.zid.sa` only, with both Zid tokens and `Store-Id` (a connection without a store id asks the profile once). Shapes come from Zid's official Python SDK and its fixtures; what they do not establish is handled in code. Orders: `GET /managers/store/orders?payload_type=default&sort_by=desc` (the only list payload with products), 100 a page, up to 5 pages, with a `date_from` a day early and no `date_to` (a UTC `date_to` can be a day behind Riyadh and drop the current day's orders) — Zid does not document what the date filter applies to, nor whether `total_order_count` honours it, so every row is checked against the 30 days on `created_at` (read as Riyadh time; the zone is undocumented), paging stops at the first page that reaches past the window, at a short page, or at `total_order_count`, and the count is always the orders read, never `total_order_count`. When the page cap stops it with orders left, `orders.capped` is set and the count reads "or more". Orders are de-duplicated by id. Revenue parses the decimal-string `order_total` under the order's own currency (never a default) and leaves out orders whose status is canceled, reversed or being reversed, or whose payment was refunded or voided; `partially_reversed` still counts. A list answer without an `orders` array fails the sync. Carts: `GET /managers/store/abandoned-carts` (100 a page, up to 3 pages, `capped` past that; the pagination block is not documented, so a short page ends it) counts the carts open now (not limited to the 30 days, like Salla's), leaving out phase `completed` and counting a cart seen on two pages once, and sums `cart_total`; product names come from the detail view of the newest 20 carts (four at a time; a failed detail is skipped). Errors: 401 marks the connection for reconnecting; 403 on orders answers `zid_access_denied` without marking it (the app lacks the permission, which a new connection does not fix); 403 on any cart page keeps the orders, drops whatever carts were read and sets `carts.unavailable` (any other cart error fails the sync), which `store-sales.md`, the Reports card and Dana's STORE DATA show as unknown rather than zero. About 28 requests at most, under Zid's 60 a minute. No customer name, phone, email, cart link or WhatsApp text is read into the snapshot.
15. Dana's report tasks (`weekly_report`, `board_deck`, `dashboard_spec`) get `statsFor`: the workspace KPIs and, when `storesales:{scope}` holds a snapshot, a STORE DATA block from `salesDataBlock` in `store-sales.ts` — the snapshot as escaped JSON with its sync date and age, the rule that there is no previous period to compare with, a note when the totals cover only the latest orders, a stale-sync line past 7 days, and currency codes limited to three letters. The workspace block's "sales are NOT in this data" line is replaced by a pointer to STORE DATA only when a snapshot exists.

## 12. API-key connectors

Files: `src/app/api/connect/[provider]/key/route.ts`, `src/lib/connectors/{wordpress,woocommerce,keyed}.ts`.

1. `POST /api/connect/{provider}/key` with the provider's `keyFields` (`registry.ts:28-81`). Session required; provider must be `kind:"key"`.
2. Every declared field is required. `type:"url"` fields get `https://` prefixed when they do not start with `http`.
3. Verification is a live call to the user-supplied host: WordPress `/wp-json/wp/v2/users/me`, WooCommerce `/wp-json/wc/v3/products`, Odoo `/jsonrpc`, PrestaShop `/api/products`, Telegram `getChat`, Brevo `/v3/account`, Klaviyo `/api/accounts/`. Failure: 400 `verify_failed` with a `detail` string derived from the remote response or fetch error.
4. On success the credentials are stored encrypted under `conn:{sc(u)}:{provider}`; `meta` (site, account name) is stored in clear.

## 13. MCP server and OAuth 2.1 authorization

Files: `src/app/api/mcp/route.ts`, `src/app/api/mcp/token/route.ts`, `src/lib/mcp.ts`, `src/lib/oauth.ts`, `src/app/api/oauth/*`, `src/app/oauth/authorize/page.tsx`, `next.config.ts`.

### Personal token
`GET /api/mcp/token` returns the first 12 chars and `exists`; `POST` revokes then creates `nashr_` + 24 random bytes base64url, stores `mcptoken:{token}` and `mcptoken-of:{email}` with no TTL, and returns the token once; `DELETE` revokes the personal token only.

### OAuth 2.1
1. Discovery: `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` (rewrites). Issuer and endpoints derive from `APP_ORIGIN`.
2. Client registration: `POST /api/oauth/register` is open to anyone. Keeps up to 10 `http(s)` redirect URIs, issues `client_id`, and a `client_secret` only when `token_endpoint_auth_method = client_secret_post`. No rate limit, no expiry.
3. Authorize: `/oauth/authorize?client_id&redirect_uri&response_type=code&code_challenge&code_challenge_method&state&scope`. Anonymous users are redirected to `/ar/app/login?next=...`. The page checks client, exact `redirect_uri` membership, `response_type=code`, presence of `code_challenge`; shows Allow/Deny with the client name supplied at registration.
4. Approve: `POST /api/oauth/approve` (form post, session required) re-validates client and redirect URI, requires `code_challenge_method=S256`, issues a 10 min single-use code bound to client, redirect URI, challenge, email and `scope` (free text from the request, default `noor`). Deny redirects with `error=access_denied`.
5. Token: `POST /api/oauth/token` (JSON or form; client auth via Basic, body secret, or none for public clients). `authorization_code`: code is deleted on first read, then client id, redirect URI and PKCE S256 are verified. Issues access token `nashr_...` stored in `mcptoken:{access}` for 30 days and refresh token `nashr_r_...` in `oauthrefresh:` for 90 days.
6. Refresh: `grant_type=refresh_token` rotates: the old refresh token is deleted and a new pair is issued; client id must match. The previous access token stays valid until its own TTL.
7. There is no revocation endpoint and no listing of granted clients. `revokeMcpToken` only removes the personal token.

### MCP calls
`POST /api/mcp` JSON-RPC. `initialize`, `ping`, `notifications/initialized`, `tools/list` answer without authentication (`mcp/route.ts:49-51`). Everything else needs `Authorization: Bearer nashr_...` resolved by `userFromBearer` (`mcp.ts:20`), which returns the raw user record: it does not check `suspended` and does not set `scope`, so MCP always acts on the default brand. Tools: `ask_noor` (full chat loop with all nine chat tools, including `publish_item`), `generate_content` (charges credits, no trial-expiry check), `list_inbox`, `read_file`, `list_files`, `get_brand_rules` (the active brand's tone, dialect, audience, products, offers, preferred words, channels and the enforced banned words as JSON; free), `check_brand` (`{text, type?}`, up to 20,000 characters, checked with the same `gateTask` as the approve button; returns `pass`, `violations` and a summary; internal types are not held; free, no model call). 401 responses carry `WWW-Authenticate` pointing at the resource metadata. CORS is `*`.

## 14. Founder console

Files: `admin/page.tsx`, `src/components/app/{AdminConsole,AdminLogin,GoldenPanel}.tsx`, `src/app/api/admin/*`, `src/lib/auth.ts:107-136`, `src/lib/admin-stats.ts`.

1. Page access: `isAdminCookie()`; otherwise 404, or the key form when `?login=1` (`admin/page.tsx:15-18`).
2. Key login: `POST /api/admin/login {key}`; 5 attempts per 15 min per IP; constant-time compare; sets `nashr_admin` to the key value. `DELETE` clears the cookie (no auth needed).
3. Data: `GET /api/admin/overview`, `/plan` (all users with usage), `/users/{email}` (user without `passHash`, default-scope brand, tasks of all brands, usage, connections metadata), `/log` (last 50), `/evals`, `/golden`, `/export` (CSV of all users).
4. Actions via `POST /api/admin/plan {email, plan?, addCredits?, reason?}` and `POST /api/admin/users/{email} {action}`: `suspend`, `unsuspend`, `extendTrial` (1..90 days), `resetPassword` (returns a temporary password once), `setLang`, `impersonate`, `delete` (`wipeAccount`). All write to `admin:log` except `setLang`. The log `actor` is always the literal `"founder"`.
5. Impersonation: saves the caller's current `nashr_session` into `nashr_return` (2 h), sets `nashr_impersonate`, then `createSession(targetEmail)` overwrites `nashr_session` with a normal 30-day session for the target. Logged with `expiresInMin:120`, but the impersonated session itself lasts 30 days and is a regular session.
6. Return: `POST /api/admin/impersonate` (form post from the banner, `app/layout.tsx:47`). No admin check. If `nashr_return` names a live session it becomes `nashr_session`; else `nashr_session` is deleted. Both helper cookies are cleared, `impersonate:stop` is logged when `nashr_impersonate` was present. The impersonated session record in Redis is not deleted.
7. `POST /api/admin/golden {agent?, resume?}` runs the golden set (up to 300 s).

## 15. Referrals

Files: `src/lib/referral.ts`, `src/app/api/referral/route.ts`, `src/app/api/referral/share/route.ts`, `refer/page.tsx`, signup route.

1. Code = first 8 alphanumerics of base64url SHA-256 of `"nashr-ref:" + email`, uppercased; stored at `ref:{CODE}`.
2. At signup with a valid `ref`: both accounts get +50 credits, `referrals:{referrer}` gets an entry, `referredBy:{new}` is set. Self-referral is blocked by email equality only.
3. `GET /api/referral` returns code, count, earned and the list of referred emails with timestamps.
4. `POST /api/referral/share {platform}` (x, linkedin, whatsapp, instagram): +20 credits once per platform; the check (`db.get`) and the write (`db.set`) are separate operations (`share/route.ts:16-18`). No proof of sharing is required.

## 16. Scheduled jobs

See `architecture.md` 2.6 and 4(d). Details:

- Daily (`src/app/api/cron/daily/route.ts`): per (user, active brand): `renewIfDue`; if no brand and account older than 10 min and email configured, a one-time nudge email (`notified:{email}:nudge1`); else `runLifecycle` (day 1, 2, 3, 10 emails, once each), `runDaily` (brief stored at `brief:{scope}`, no model call), `followUps` (notifications with fingerprints), and an email according to `profile:{email}.emails` (`all|important|none`). Links in the nudge and brief emails use a hard-coded production origin (`:29`, `:46`).
- Weekly (`src/app/api/cron/weekly/route.ts`, `schedule.ts:32`): skips when no brand, `weeklyPlan` off, trial over, weekly cap reached (`gov.weeklyCap`, counts `source:"scheduled"` tasks in 7 days) or insufficient credits. Response body maps account email to result string.
- Golden (`cron/golden/route.ts`, `golden.ts`): fixed fictional brands, meters usage under `golden@nashr.internal`, notifies founder accounts on regressions.
- Users can trigger their own runs: `POST /api/schedule {run:"weekly"|"daily"}`.

## 17. Support and contact tickets

`POST /api/support {email, message, type?, page?, lang?}` (`src/app/api/support/route.ts`): anonymous allowed; attaches the signed-in account email when a session exists; pushes to `support-tickets`; emails `WAITLIST_TO` when set. No rate limit. `GET` (admin) returns the latest 500. Tickets have `status:"open"` and no update path.

`POST /api/affiliates` stores applications the same way (`affiliate-applications`), `GET` is admin only.

## 18. Waitlist

`src/app/api/waitlist/route.ts`. `POST {email, company?, industry?, lang?}`: anonymous; dedupes on `waitlist:emails`; without Redis it only logs to the console and returns `stored:false`. `GET ?key=...[&format=csv]`: accepts only the query-string key compared with `!==` to `WAITLIST_ADMIN_KEY`; founder sessions and the admin cookie are not accepted here. No UI in `src/` posts to this route at present.

## 19. Launch journey (milestones, levels, streak)

Files: `src/lib/journey.ts` (pure: `computeJourney`, `levelFor`, `decisionStreak`; the browser imports it), `src/lib/journey-load.ts` (server: one parallel round), `src/components/app/JourneyCard.tsx`; shown on the inbox (`app/page.tsx`) and at the top of the chat thread until complete (`chat/page.tsx`).

1. Seven milestones, each read from the workspace, never from a counter the interface keeps: `brand` (brand file exists), `guard` (at least one banned word), `approve` (an item approved by the owner, i.e. with `decidedAt`; auto-approved items do not count), `schedule` (any `scheduledFor`), `connect` (any connection), `publish` (any item with a live publish), `ai` (a personal MCP token or an OAuth grant).
2. Levels by milestones done: seed 0, sapling 2, palm 4, oasis 7. Points per milestone sum to 150. Points and levels are cosmetic, are not credits and buy nothing; the card says so.
3. Streak: consecutive UTC days, ending today or yesterday, with at least one owner decision (`decidedAt`).
4. Celebration: the card compares the done set and level with `localStorage` key `nashr:journey:v1` and plays confetti and a toast once per new milestone (level change louder). First visit in a browser celebrates only `brand`. Storage failures are ignored. The inbox dispatches `nashr:milestone` after a successful approve, date or publish so the card updates before the next server render. Motion is disabled under `prefers-reduced-motion`.
5. The owner can hide the card; the choice is kept in the same storage key.

## 20. Campaign results import (CSV)

Files: `src/lib/perf-import.ts`, `src/lib/perf-store.ts`, `src/app/api/performance/route.ts`, `src/components/app/PerformanceImport.tsx` (on the reports page).

1. The owner exports an ad-level report (Meta, Snapchat, TikTok, Google Ads, or an email tool) and drops the CSV on the reports page. The browser reads the text (2 MB at most) and posts `{csv, file, metric?}` to `POST /api/performance`.
2. `readRows`: RFC 4180 parse with the delimiter detected from the header; the header is the first of the first twelve rows naming two known columns (English or Arabic synonyms, most specific first: "link clicks" before "clicks"); totals lines are skipped; at most 5,000 rows. Names and text are stripped to one plain line (`clean`). Missing name column or metrics: 422 with a reason code.
3. `analyze`: the metric defaults to what the file supports (ROAS, then cost per result, CTR, open rate, conversion rate) and can be switched. A row is ranked only above the metric's sample minimum (500 impressions for CTR, 30 clicks for cost per result, 50 spend for ROAS, 30 clicks for conversion rate, 100 sends for open rate). Findings: top and bottom three, best against the median, wording patterns (offer, number, question, Arabic, short) compared by pooled metric when both groups have three or more ads and differ by 20% or more, best and weakest placement, and spend with no result when it is 10% or more of spend. Confidence is "medium" at ten times the sample minimum with five or more ads, otherwise "low"; never "high".
4. `savePerf` stores the snapshot in `perfimport:{scope}` and writes `performance-learnings.md`, which `memoryBlock` includes, so every later generation, the weekly plan included, reads it. The file states that quoted names are data, not instructions, and that findings are comparisons, not promises. The reports card links to chat with prompts to write variants of the winners or plan next week.
5. No model call and no credits. `DELETE` removes the snapshot and the file.

## 21. Ad results from Meta and Snapchat (read only)

Files: `src/lib/connectors/ads.ts`, `src/lib/perf-store.ts` (`syncAds`, `syncAdsIfDue`), `api/connect/[provider]` (`sync_ads`, `select_ad_account`), `api/connect/[provider]/callback` (`connectAds`), `api/cron/daily`, `PerformanceImport.tsx`, `IntegrationsPanel.tsx`.

1. Connect: `meta_ads` is a separate OAuth connection from `meta` (Pages) with the scope `ads_read` only, so a pending App Review of `ads_read` never breaks Page publishing; it uses the same `META_APP_ID` and `META_APP_SECRET`. `snapchat` uses `snapchat-marketing-api`. After the code exchange, `connectAds` trades Meta's token for a long-lived one (about 60 days; no refresh token, so `fresh.ts` asks for a reconnect when it lapses) and lists ad accounts (`GET /me/adaccounts`, active only; Snap `GET /me/organizations?with_ad_accounts=true`, ACTIVE only). The first is chosen; `meta.adAccounts` lists the rest by id, name and currency. No active account: the callback returns `error=no_ad_account` and nothing is saved.
2. Read: `POST /api/connect/{meta_ads|snapchat} {action:"sync_ads"}`. Window: the last 30 whole UTC days ending yesterday. Meta: `GET /{act}/insights?level=ad&fields=ad_id,ad_name,impressions,inline_link_clicks,spend,actions,action_values&time_range=…`, following `paging.next` only on the Graph host (10 pages, 2,000 rows at most); purchases and purchase value from `omni_purchase`, else `purchase`, else the pixel purchase, never summed; ad copy from `GET /?ids=…&fields=creative{body,title}` for up to 50 ads, best effort. Snapchat: ad names from `GET /adaccounts/{id}/ads`, then `GET /adaccounts/{id}/stats?granularity=TOTAL&breakdown=ad&fields=impressions,swipes,spend,conversion_purchases,conversion_purchases_value`; spend and value are micro-currency and divided by 1,000,000; swipes are the clicks.
3. The rows go through `analyze` (section 20) and `savePerf` with `source` set to the provider, so the latest results, from an upload or an account, are what `performance-learnings.md` holds. `adsync:{scope}:{provider}` records the read time. No model call and no credits.
4. Daily: `dailyFor` calls `syncAdsIfDue`, which reads the connected ad account whose last read is oldest, once it is more than 20 hours old, one platform a day. A failure is recorded in the outcome (`ads_failed:…`) and does not stop the rest of the workspace's day; a 401 or 403 marks the connection for reconnecting.
5. Switch account: `{action:"select_ad_account", accountId}` accepts only an id in `meta.adAccounts`.
6. Nothing creates, edits, pauses or funds an ad. The readers send no request other than GET, apart from Meta's token exchange.

## 22. Ad codes: measuring Nashr's own ads

Files: `src/lib/ad-codes.ts`, `saveTask` in `src/lib/brand.ts`, `analyze` in `src/lib/perf-import.ts`, `Inbox.tsx`, `PerformanceImport.tsx`.

1. `saveTask` gives every new `ads` and `social` item an `adCode` (`NSR-` plus five characters from an alphabet without 0, O, 1, I and L) and writes `adcodes:{scope}` code → task id in the same round of commands. A later save keeps the code.
2. The inbox card shows the code with a copy button and the hint to put it in the ad's name in the ads manager. Nothing writes names on the platforms: the connectors are read only.
3. When results come in (CSV upload, section 20, or an ad account, section 21), `analyze` receives the workspace's code index. A row whose name or copy contains one of those codes is a Nashr ad; any other code is ignored. `snapshot.nashr` lists them with their metric and sample, and compares the pooled metric of the ranked Nashr ads with the other ranked ads when there are at least 2 and 3, with a confidence of low or medium by the same rule as the other findings. Codes are removed from the text before the wording patterns run.
4. `performance-learnings.md` gains a "Nashr's own ads" section with the comparison, telling Noor to build on what worked and to say plainly when Nashr's ads did worse. The results card shows the section, or how to add codes when none are found.

## Revocation (2026-09-18)

- Password change (`PATCH /api/account`): new hash and `sessionsAfter = now` saved inside the user lock, the caller's session is destroyed and a new one issued. Every other session of the account fails at its next request.
- Password reset (`POST /api/auth/reset`) and founder `resetPassword`: the same, plus `revokeAllMcp` (personal MCP token and every OAuth grant).
- Connected apps: `GET /api/mcp/grants` lists OAuth grants of the signed-in account; `DELETE /api/mcp/grants?id=` revokes one, `?all=1` all. A grant id of another account is a 404. Refreshing a token keeps the grant and deletes the previous access token.
