# Meta (Facebook Page and Instagram) through Composio: customers connect and publish without Thakeen's own Meta app

Status: draft for the founder's review, 2026-10-05. This is the **first build** that `2026-10-05-composio-evaluation-design.md` (the evaluation spec) names ("Instagram first, Facebook follows"). It inherits that spec's rules (its section 4) and does not repeat them; where this spec adds or narrows one, it says so. Nothing here reaches a real customer until section 8's gate is met.

## 1. Goal and what the founder decided

Today a customer's "Connect Meta" needs `META_APP_ID` and `META_APP_SECRET` (a Meta app of Thakeen's own, passed through Meta's app review for `pages_manage_posts` and `instagram_content_publish`). Neither variable is set, so no customer can connect. Composio publishes a managed Meta OAuth app; the goal is that a customer connects a Facebook Page and an Instagram professional account, and Thakeen publishes to them, without Thakeen passing Meta's review.

Decided by the founder on 2026-10-05, in chat:

- Option "customers connect Meta through Composio" (not "stay on our own Meta app", not "Composio only for my own Claude sessions").
- Design A: Composio holds the tokens and runs the publish calls; Thakeen stores only the pointer to the connected account and the display names. A **small, generic seam** (`src/lib/connectors/composio.ts`, section 3) is built, and applied to Meta only.

Correction to what the founder was told in chat, made here so nothing is hidden: the chat said the direct Meta code would not be kept as a fallback. The evaluation spec already decides otherwise (a flag routes new connects; the direct code is not deleted), and this spec follows it (section 3, "Routing").

Not in this spec: **Meta Ads** (`meta_ads`, read-only results, stays on the direct code; ad writes need their own spec, evaluation spec C-R1), Instagram comments, messages and insights, Reels and carousels (a post is one image, as today), scheduled posts, any other platform, X, Google, store connectors, any billing change, moving existing direct Meta connections to Composio.

## 2. What was verified and what was not

Read on 2026-10-05 from Composio's pages and from the installed SDK (`@composio/core` 0.22.0, `dist/*.d.mts`). The pages list behaviour; they do not prove it, which is section 7's job.

Verified in the SDK types (the exact calls the evaluation spec's Task 0 asks for):
- `composio.connectedAccounts.link(userId, authConfigId, { callbackUrl })` returns a request with `id` and `redirectUrl`.
- `composio.connectedAccounts.waitForConnection(id, timeoutMs)`, `.get(id)`, `.list({ userIds, ... })`, `.revoke(id)` (status becomes `REVOKED`), `.delete(id)`.
- `composio.tools.execute(slug, { userId, connectedAccountId, arguments }, { signal })` returns `{ data, error, successful }`. `signal` allows a timeout.
- A connected account's status is one of `INITIALIZING`, `INITIATED`, `ACTIVE`, `FAILED`, `EXPIRED`, `INACTIVE`, `REVOKED`. The `get` response carries no owner id, so ownership is checked through `list({ userIds })` (section 4, step 4).

Stated by Composio's toolkit pages: Facebook and Instagram both have "Composio-managed OAuth available"; Facebook's managed app grants `pages_manage_posts`, `pages_show_list` and `pages_read_engagement` and supports Pages only; Instagram supports Business and Creator accounts only; Instagram images must be JPEG, aspect 4:5 to 1.91:1, width 320 to 1440 px, at most 8 MB; the Instagram managed app is **not** approved for comment management.

**Not verified, and each can stop this build** (they become Task 0 questions, section 7): whether the managed Instagram app holds `instagram_content_publish` in production; whether the managed Facebook app is live for external users (app mode, business verification); what the Meta consent screen shows the customer; which parameters Composio appends to `callbackUrl`; how toolkit versions are pinned for `tools.execute`; whether `INSTAGRAM_GET_USER_INFO` accepts `"me"` as the account id (the tool's page lists the argument, not that value); whether a media URL with a path like our Blob URLs is accepted by `INSTAGRAM_POST_IG_USER_MEDIA` (the tool's own notes say URLs with query strings are error-prone).

## 3. Architecture

Off by default. With `COMPOSIO_PROVIDERS` empty or `COMPOSIO_API_KEY` unset, the app behaves exactly as today.

**Adapter.** `src/lib/connectors/composio.ts`, the only file that imports `@composio/core` (evaluation spec section 3). It exposes the three calls that spec names, widened by one argument where Meta's two toolkits need it:

- `composioConnect(scope, toolkit, state)`: calls `link` for the toolkit's auth config, with `callbackUrl` set to `{APP_ORIGIN}/api/connect/meta/callback?state={state}`; returns `{ accountId, redirectUrl }`.
- `composioExecute(scope, toolkit, slug, args, { accountId })`: checks the slug against the allowlist, calls `tools.execute` with `userId = composioUserId(scope)`, a 20 s `AbortSignal`, and returns `data` only when `successful`; any other outcome becomes an error carrying a short code (rule 7 of the evaluation spec).
- `composioRevoke(scope, accountId)`: `revoke`, then `delete`.

**Identity.** `composioUserId(scope) = base64url(HMAC-SHA256(CONNECT_SECRET, "composio:user:v1:" + scope)).slice(0, 32)`. Recomputed from `sc(u)` on every call; never read from a request, a callback or a stored value. No email, brand name or scope string leaves the product.

**Allowlist.** One map in the adapter, exact slugs, checked before any request:

| Toolkit | read | write |
|---|---|---|
| `facebook` | `FACEBOOK_LIST_MANAGED_PAGES` | `FACEBOOK_CREATE_POST`, `FACEBOOK_CREATE_PHOTO_POST` |
| `instagram` | `INSTAGRAM_GET_USER_INFO`, `INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT` | `INSTAGRAM_POST_IG_USER_MEDIA`, `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH` |

A `write` slug is callable only from `publishWith` (`src/lib/connectors/publish.ts`); `read` slugs also from the connect callback and the page selection. A slug outside the map throws before any request. The arguments are built in code from the stored connection and the item (`page_id` and `ig_user_id` come from `meta.pageId` and `meta.igId`, never from a request, a model or the item's text); `published` is `true`, and `targeting` and `scheduled_publish_time` are never sent.

**Registry and connection record.** `registry.ts` gains an optional `via: "composio"` on the `meta` provider and the toolkit list `["facebook", "instagram"]`. `isAvailable(meta)` for a Composio-routed provider is true only when `COMPOSIO_API_KEY`, `COMPOSIO_AUTH_FACEBOOK` and `COMPOSIO_AUTH_INSTAGRAM` (the two auth config ids, not secrets) are set, instead of the `META_APP_ID` check. The stored record keeps the shape `connectedTargets` reads, so `targets.ts` does not change:

- `provider: "meta"`, `data: { fbAccountId?, igAccountId? }` (Composio account ids; encrypted like every `data`), `meta: { via: "composio", pageId?, account, igId?, ig?, pages? }`.
- `meta.pages` is the JSON list of `{ id, name, ig }` as today but with no token (Composio holds the tokens; the direct code stores page tokens in `data`).
- There is one `meta` record per workspace. A workspace with an existing direct record (`meta.via` absent) keeps working until it is disconnected; a new connect while the flag routes `meta` to Composio creates a Composio record. Nothing is migrated.

**Routing.** `COMPOSIO_PROVIDERS` (comma list, evaluation spec section 3) containing `meta` sends the connect flow of section 4 to Composio. `publishWith` already switches on `provider`; `case "facebook"` and `case "instagram"` branch on `c.meta?.via === "composio"`: Composio path, else the existing Graph path. The gates above `publishWith` are not touched.

**Publish, per target (all inside `publishWith`, after the existing checks):**

- Facebook, text: `FACEBOOK_CREATE_POST { page_id, message }`; with artwork: `FACEBOOK_CREATE_PHOTO_POST { page_id, ... }` using the item's `imageUrl`. The returned composite id gives `https://www.facebook.com/{id}`, as today.
- Instagram: `hasArtwork` and `instagram_needs_image` stay (they are the existing checks). Then `INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT`; a spent limit is a clear owner message, no container is made. Then `INSTAGRAM_POST_IG_USER_MEDIA { ig_user_id, image_url, caption }` (caption cut to 2,200 characters, markup removed, exactly as `meta.ts` does) and `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH { ig_user_id, creation_id, max_wait_seconds: 20 }`. The result url is `https://www.instagram.com/{meta.ig}/` (username stored at connect); a permalink read is deferred, not specified here.
- **No retries inside Thakeen for a write.** A timeout or an error after the container call, or any error from the publish call, leaves the existing `pubtry` marker (the "result unknown, check the platform" path) and the adapter never calls a write twice (evaluation spec ruling C-R2). Creating the container is not retried either, because a second container is a second post waiting to be published.

## 4. Connect flow (the only new public-facing surface)

Same routes as today, new behaviour only when the provider is Composio-routed. `GET /api/connect/meta/start?toolkit=instagram|facebook&lang=` and `GET /api/connect/meta/callback?state=`, both behind `currentUser()` and `forbid(u, "connectors")` (admin and owner), as every connect route is. The two toolkits are two separate logins (Instagram Business Login is not Facebook Login), so the Integrations card shows two buttons for Meta; Instagram first.

1. **Start.** Generate `state` (random, 128 bits), save `oauthstate:{state}` = `{ scope: sc(u), toolkit, accountId }` with the existing 10-minute TTL (`saveState`), set the existing `OAUTH_COOKIE` to `state` in this browser, call `composioConnect`, and redirect to `redirectUrl` **only if its host is `composio.dev` or a subdomain** (otherwise `502`, no redirect).
2. **Callback.** Require the cookie to equal `state` and consume the state once (`takeState`); a missing or reused state is `invalid_state`. `scope` for everything below comes from the saved state **and must equal `sc(u)` of the current session**, else `invalid_state`. Nothing in the query string other than `state` is read.
3. **Active check.** `waitForConnection(accountId, 10_000)`; anything but `ACTIVE` is `connect_failed` and the pending account is deleted.
4. **Ownership check.** `connectedAccounts.list({ userIds: [composioUserId(scope)], toolkitSlugs: [toolkit], statuses: ["ACTIVE"] })` must contain `accountId`; otherwise `connect_failed` and no record is written. (The `get` response has no owner id, so the list filter is the check; this also stops a crafted `state` from binding someone else's account.)
5. **Identity read.** Instagram: `INSTAGRAM_GET_USER_INFO` gives `igId` and `username`. Facebook: `FACEBOOK_LIST_MANAGED_PAGES` gives the Pages; the first Page is chosen, as `connectMeta` does today, and `meta.pages` holds the list. No Page or Instagram account found is `meta_no_page` or `meta_no_instagram` (existing messages), and the new Composio account is deleted.
6. **Save.** `saveConnection(sc(u), ...)` merging into the workspace's `meta` record (an Instagram connect after a Facebook one keeps `fbAccountId` and `pageId`), then redirect to the Integrations page with the existing success marker.

**Choosing the Page** (`POST /api/connect/meta {action:"select_page", pageId}`, role `connectors`): `pageId` must be one of `meta.pages`, never a free value, exactly as `selectPage` enforces today; for a Composio record it changes `pageId` and `account` only, and does not touch `igId` (Instagram has its own login here, so its link does not follow the Page).

**Disconnect** (`DELETE /api/connect/meta`): `composioRevoke` for each account id on the record **first**, then `deleteConnection`. A failed revoke keeps the record, sets `needsReconnect`, and tells the owner "not disconnected"; never "disconnected" while Composio still holds the grant (evaluation spec rule 9). `wipeAccount` calls the same revoke for every Composio account it can name before it deletes.

A Composio account that Meta or the customer revokes shows up as a tool error; `refusedToken` already turns 401 and 403 messages into `needsReconnect`. The adapter maps Composio's `EXPIRED`, `REVOKED`, `INACTIVE` and `FAILED` states to a `401`-coded error so the same path asks the owner to reconnect.

## 5. Rules this spec adds or narrows

1. **One path per record.** `publishWith` chooses Composio or direct from `meta.via` of the stored record, never from the flag at publish time, so turning the flag off cannot silently move a connected customer to the direct path or drop one.
2. **Callback binding.** A connected account is saved only when all of section 4 steps 2 to 4 hold; a pending account that fails any step is deleted from Composio.
3. **Redirect host.** The connect start redirects only to `composio.dev` hosts.
4. **Tool arguments from code only.** Every `arguments` object is built from the stored connection and the item; a test asserts the adapter rejects an argument key not listed for its slug.
5. **Toolkit versions are pinned in the adapter** (the value set in Task 0), and `dangerouslySkipVersionCheck` is never passed, so a Composio-side tool change cannot alter what a publish does unseen.
6. **Privacy line.** Thakeen sends Composio only the opaque user id, the caption and the image URL of an item the owner approved, and the Page or Instagram ids. It sends no customer email, brand text beyond the caption, or other item data.
7. **Environment gating.** Until section 8's gate, `COMPOSIO_PROVIDERS` contains `meta` only in the Vercel Preview environment (the founder's test accounts), never in Production.

## 6. Files, docs and tests

New: `src/lib/connectors/composio.ts`. Changed: `registry.ts` (`via`, toolkits), `meta.ts` (nothing removed; the Composio publish and connect helpers live in `composio.ts` or a `meta-composio.ts` that `meta.ts` does not import), `publish.ts` (the two `case`s branch on `via`), `api/connect/[provider]/start`, `callback` and `route.ts` (Composio branch, revoke on delete), `IntegrationsPanel.tsx` (two buttons for a Composio-routed Meta, no customer-facing text naming Composio), `wipeAccount`. `targets.ts`, `working.ts` and the inbox are unchanged (a test pins that `connectedTargets` returns the same list for a Composio record).

Docs in the same commit (project rule): `variables.md` (`COMPOSIO_API_KEY` secret; `COMPOSIO_PROVIDERS`; `COMPOSIO_AUTH_FACEBOOK` and `COMPOSIO_AUTH_INSTAGRAM`, ids not secrets), `flows.md` (connect, publish, revoke), `permissions.md` (the start and callback behaviour for `meta`; no new route), `architecture.md` (the adapter), `tests.md`. Rule numbers for the tests are set in the plan after checking `tests.md` for numbers already taken.

Tests, one per rule, no network (the adapter takes an injected client): allowlist refuses an unlisted slug and a write slug outside `publishWith`; argument keys; identity is the HMAC and stable per scope and never contains the scope; callback rejects a missing cookie, a reused state, a `state` whose scope differs from the session, a non-`ACTIVE` account, and an account absent from the owner's list; start refuses a non-`composio.dev` redirect host; publish branches on `meta.via`; Instagram refuses without artwork and when the limit is spent, and creates no container; a timeout after the container call leaves the `pubtry` marker and makes no second write call; disconnect revokes before it deletes and keeps the record when revoke fails; `connectedTargets` unchanged; no file other than `composio.ts` imports `@composio/core` and neither `chat.ts` nor `mcp.ts` imports the adapter.

## 7. Task 0 for this build, and the measured run

Task 0 of the evaluation spec stands (plan, data processing and PDPL, tokens, X). This build adds, in writing, before any customer: (a) does the managed Instagram app hold `instagram_content_publish` in production; (b) is the managed Facebook app live for external users and what does it need (app mode, business verification); (c) what does the Meta consent screen show a customer, and can the name be changed without bringing our own Meta app; (d) which query parameters Composio appends to `callbackUrl`; (e) how a toolkit version is pinned in `tools.execute`; (f) does `INSTAGRAM_POST_IG_USER_MEDIA` accept our image URLs, tested with the real Vercel Blob URLs; (g) what `INSTAGRAM_GET_USER_INFO` needs as its account argument.

Measured run (founder's own Page and Instagram professional account, Preview only): 50 Instagram and 50 Facebook publishes, the revoked-token case (revoke in Meta, publish once, expect `needsReconnect`), the forced-timeout probe (a write that times out must show "result unknown" and never post twice), the publishing-limit refusal, and an image outside Instagram's size or ratio limits (expect a clear owner message, not a raw Meta error). Results go to the evaluation spec's results file. A call count per publish is recorded: Instagram is three calls to Composio plus the publish call's own wait (limit read, container, publish), Facebook one.

## 8. Gate before customers

All of: the evaluation spec's Task 0 answers and this section 7 list (a) to (g) are in writing and allow the use; the measured run meets the evaluation spec's pass rule for Instagram, then for Facebook; the founder says so for Production. If (a) or (b) fails, or Task 0 rules out the commercial or data use, Meta stays direct and this build is shelved with the flag off.

## 9. Open questions for the founder

1. **The Meta consent screen.** Customers may see Composio's app name, not Thakeen's. Acceptable for Starter customers, or does it block the launch? (White-labelling needs Thakeen's own Meta app, which is what this build avoids.)
2. **Privacy policy.** A sub-processor must be disclosed. The evaluation spec's rule 12 says no product text names Composio; the policy is the one place that has to. Name it in the policy only, once the gate is met?
3. **Pilot accounts.** Which Facebook Page and Instagram professional account of yours are used for the measured run?
4. **Instagram before Facebook** in the first release (as the evaluation spec says), or both together if both pass?

## 10. Rulings made while writing this spec

- M-R1: the direct Meta code is kept; routing is by flag and by the stored record's `via` (contradicts the chat answer "no fallback", which was wrong against the evaluation spec).
- M-R2: Facebook and Instagram are two Composio logins under one `meta` record, so `connectedTargets` and `targets.ts` are unchanged.
- M-R3: ownership of a returned connected account is checked by listing under the HMAC user id, because the SDK's `get` response has no owner field.
- M-R4: the Instagram result url is the account's profile url until a permalink read is specified; a wrong link is worse than a general one.
- M-R5: environment gating (Preview only) replaces a per-tenant pilot list, to add no variable and no code path for a short phase.
- M-R6: tool names, argument names and SDK calls are as read on 2026-10-05 (SDK 0.22.0); the claims about managed-app approval are Composio's and are verified only by section 7.
