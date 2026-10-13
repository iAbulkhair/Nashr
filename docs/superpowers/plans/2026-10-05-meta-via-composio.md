# Meta (Facebook Page and Instagram) through Composio Implementation Plan

> **Status update (2026-10-12, from `git log origin/main` and the files named; the status line below is the state when the document was written):** built and merged as #272 (in `production`). The `- [ ]` boxes below were never ticked as steps ran: they are the task list, not open work; the spec's status update and `docs/system/tests/` say what shipped.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer connects a Facebook Page and an Instagram professional account through Composio's managed Meta OAuth and Thakeen publishes to them, with the direct Meta code untouched and everything off unless `COMPOSIO_PROVIDERS` contains `meta`.

**Architecture:** `src/lib/connectors/composio.ts` is the only file that imports `@composio/core` (lazily, behind an injectable client). `src/lib/connectors/meta-composio.ts` holds the Meta-specific calls built on it. The existing `meta` connection record keeps its shape (`meta.via = "composio"` marks the new kind), so `targets.ts`, `publishOnce`, `refusedToken` and the inbox are reused unchanged. The connect routes get a Composio branch; `publishWith` branches on the stored record.

**Tech Stack:** Next.js 16 route handlers, Upstash through `src/lib/db.ts`, `@composio/core` 0.22.0 (already in `package.json`), vitest with the existing helpers in `tests/helpers/`.

**Spec:** `docs/superpowers/specs/2026-10-05-meta-via-composio-design.md` (inherits `2026-10-05-composio-evaluation-design.md` section 4). Read both before starting. Read `node_modules/next/dist/docs/` before touching a route handler (AGENTS.md).

## Global Constraints

- Tenant scope is `sc(u)` only; never build a key from a request value. The Composio user id is `HMAC-SHA256(CONNECT_SECRET, "composio:user:v1:" + scope)`, base64url, first 32 characters, recomputed on every call.
- No `await db.*` inside a loop; use `Promise.all` or `pmap` from `src/lib/parallel.ts`.
- A write tool is never called twice and never retried; a timeout or any non-refusal error after a write was sent counts as "may have posted" through the existing `mayHavePosted` in `src/lib/publish-once.ts`.
- Errors thrown for a Composio call have the shape `meta {slug-in-lowercase} {status}: {at most 120 characters}` so `LEADING_STATUS` in `publish-once.ts` classifies them; the status is 401 for a dead account, 429 for a rate answer, else 502. Never put a token, an account id or a response body in a message or a log.
- No customer-facing text names Composio. `dangerouslySkipVersionCheck` is never passed.
- `chat.ts` and `mcp.ts` never import `composio.ts` or `meta-composio.ts` directly.
- Until the spec's section 8 gate: `COMPOSIO_PROVIDERS` contains `meta` only in the Vercel Preview environment, never Production. No commit goes to `main`, no push and no production step without the founder's explicit yes (memory: no production without explicit approval).
- Before every commit: `npm run check`; before the last one also `npx next build` (blocked locally per `docs/system/tests.md` notes; CI is the proof). If vitest fails to load its config after an `npm install`, reinstall `@rolldown/binding-darwin-arm64@1.2.12 --no-save --ignore-scripts --no-package-lock`.
- Rule numbers for new tests: the next free numbers after 628 in `docs/system/tests.md`, written below as R1 to R8 and expected to be 629 to 636. Re-check with `grep -n "^| 6[0-9][0-9]" docs/system/tests.md` before the docs commit; other branches may have taken them.

## Review Focus

Failure modes the spec implies that no single rule line covers; each has a test in the task named in brackets.

1. Instagram connected again while Facebook is already connected must keep the Facebook account id and Page [Task 5].
2. A `successful: false` answer whose message contains a number (for example "5xx" or a Page id) must not be read as that status; only the adapter's own mapping counts [Task 1].
3. A Page with no Instagram account selected must offer no Instagram target [Task 5].
4. A stored Composio record while `COMPOSIO_API_KEY` is unset must refuse before any send, as a refusal (not "may have posted") [Task 4].
5. Instagram rejecting the image (format or ratio) must read as a refusal, not "may have posted", and must not leave a second container [Task 4].

---

### Task 1: Adapter core (identity, allowlist, enablement, execute)

**Files:**
- Create: `src/lib/connectors/composio.ts`
- Test: `tests/composio-adapter.test.ts`

**Interfaces:**
- Produces:
  - `type Toolkit = "facebook" | "instagram"`
  - `type ComposioClient = { connectedAccounts: { link(userId: string, authConfigId: string, o: { callbackUrl: string }): Promise<{ id: string; redirectUrl?: string | null }>; waitForConnection(id: string, timeoutMs?: number): Promise<{ id: string; status?: string }>; list(q: { userIds: string[]; toolkitSlugs?: string[]; statuses?: string[] }): Promise<{ items: { id: string }[] }>; revoke(id: string): Promise<unknown>; delete(id: string): Promise<unknown> }; tools: { execute(slug: string, body: { userId: string; connectedAccountId: string; arguments: Record<string, unknown>; version?: string }, o?: { signal?: AbortSignal }): Promise<{ data?: unknown; error?: string | null; successful: boolean }> } }`
  - `setComposioClientForTests(c: ComposioClient | null): void`
  - `composioUserId(scope: string): string`
  - `bucketFor(scope: string): string`
  - `composioEnabled(provider: string): boolean` (true only when `COMPOSIO_API_KEY` is set and `COMPOSIO_PROVIDERS`, a comma list trimmed per item, contains the provider)
  - `composioReady(provider: string): boolean` (enabled, plus `COMPOSIO_AUTH_FACEBOOK` and `COMPOSIO_AUTH_INSTAGRAM` set)
  - `ALLOWLIST: Record<Toolkit, { read: readonly string[]; write: readonly string[] }>` exactly the spec's section 3 table
  - `ARG_KEYS: Record<string, readonly string[]>`, the allowed argument names per slug: `FACEBOOK_CREATE_POST` `page_id,message,published`; `FACEBOOK_CREATE_PHOTO_POST` `page_id,url,message,published`; `FACEBOOK_LIST_MANAGED_PAGES` none; `INSTAGRAM_GET_USER_INFO` `ig_user_id`; `INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT` `ig_user_id`; `INSTAGRAM_POST_IG_USER_MEDIA` `ig_user_id,image_url,caption`; `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH` `ig_user_id,creation_id,max_wait_seconds`. Composio's exact argument names are confirmed in Task 8; change `ARG_KEYS` there if one differs.
  - `composioRead(scope: string, toolkit: Toolkit, slug: string, args: Record<string, unknown>, accountId: string): Promise<unknown>` (read slugs only)
  - `composioWrite(scope: string, toolkit: Toolkit, slug: string, args: Record<string, unknown>, accountId: string): Promise<unknown>` (write slugs only)
  - `TOOLKIT_VERSION: Partial<Record<Toolkit, string>>` (empty until Task 8; when a value exists it is passed as `version`)

- [ ] **Step 1: Write the failing tests** in `tests/composio-adapter.test.ts` (rule R1), with a fake client that records calls:
  - `it("derives a stable opaque user id from the scope")`: `composioUserId("a@x.sa")` equals itself, differs from `composioUserId("b@x.sa")`, matches `/^[A-Za-z0-9_-]{32}$/`, and does not contain `"a@x.sa"`.
  - `it("is enabled only with the key and the provider in the list")`: key unset, list empty, `" meta , x "` with key set (true), `"x"` (false).
  - `it("refuses a slug outside the allowlist before any request")`: `composioRead(s, "instagram", "INSTAGRAM_DELETE_MEDIA", {}, "ca_1")` rejects; fake `execute` calls = 0.
  - `it("refuses a write slug through composioRead and a read slug through composioWrite")`.
  - `it("refuses an argument key not listed for the slug")`: `composioWrite(..., "FACEBOOK_CREATE_POST", { page_id: "1", message: "m", targeting: {} }, ...)` rejects with `/argument/`.
  - `it("calls execute with the derived user id, the stored account id and an abort signal, never skipping the version check")`: body has `userId === composioUserId(scope)`, `connectedAccountId`, the second argument carries an `AbortSignal`, and `dangerouslySkipVersionCheck` is absent.
  - `it("returns data on success and throws the shaped error otherwise")`: `successful:false, error:"page 5xx not found"` rejects with a message matching `/^meta create_post 502: /` (Review Focus 2); an error text containing `expired`, `revoked` or `invalid_grant` (case-insensitive) maps to 401, containing `rate` to 429; a thrown `TimeoutError` propagates with `name === "TimeoutError"`.
  - `it("counts calls against the per-account hourly bucket and a monthly global counter")`: after one call `db.get("rate:" + bucketFor(scope))` is 1 and `db.get("composio:calls:" + yyyymm)` is 1; with the bucket set to 600 through `db.set`, the next call rejects `composio_rate_limited` and `execute` is not called.

- [ ] **Step 2: Run** `npx vitest run tests/composio-adapter.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `composio.ts`.** The real client is built lazily with `new (await import("@composio/core")).Composio({ apiKey: process.env.COMPOSIO_API_KEY })`, cached in a module variable and replaced by `setComposioClientForTests`. `execute` uses `AbortSignal.timeout(20_000)`. Per-account limit: `allow(bucketFor(scope), 600, 3600)`, where `bucketFor(scope)` is `"composio:"` plus the first 16 characters of the HMAC computed with the tag `"composio:bucket:v1:"`. Monthly counter: `db.incrby("composio:calls:" + yyyymm, 1)` with a 40-day expiry set through `db.expireNx` as `rate.ts` does. Error shape and status mapping per Global Constraints; the slug in the message is lowercased with the toolkit prefix removed (`create_post`). Log nothing but the slug and the status.

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `git add src/lib/connectors/composio.ts tests/composio-adapter.test.ts && git commit -m "feat: Composio adapter core with identity, allowlist and limits"` with the trailer from the session's attribution reminder.

### Task 2: Adapter connect, verify and revoke

**Files:**
- Modify: `src/lib/connectors/composio.ts`
- Test: `tests/composio-adapter.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `composioConnect(scope: string, toolkit: Toolkit, state: string): Promise<{ accountId: string; redirectUrl: string }>`: auth config id from `COMPOSIO_AUTH_FACEBOOK` or `COMPOSIO_AUTH_INSTAGRAM`; `callbackUrl = appOrigin() + "/api/connect/meta/callback?state=" + state` (`appOrigin` from `src/lib/origin.ts`); throws `composio_bad_redirect` unless the redirect URL is `https:` and its host is `composio.dev` or ends with `.composio.dev`, and in that case deletes the pending account.
  - `composioVerify(scope: string, toolkit: Toolkit, accountId: string): Promise<void>`: `waitForConnection(accountId, 10_000)` must report `ACTIVE`, then `list({ userIds: [composioUserId(scope)], toolkitSlugs: [toolkit], statuses: ["ACTIVE"] })` must contain `accountId`; any failure deletes the pending account (its own errors swallowed) and throws `connect_failed`.
  - `composioRevoke(scope: string, accountId: string): Promise<void>`: `revoke` then `delete`; a failure of either rejects so the caller keeps the local record.

- [ ] **Step 1: Write the failing tests** (R2 for verify, R3 for the redirect host):
  - `it("builds the callback URL from appOrigin with only the state")`.
  - `it("refuses a redirect off composio.dev and deletes the pending account")`: `https://evil.test/x`, `http://app.composio.dev/x` and `https://composio.dev.evil.test/x` reject; `https://backend.composio.dev/x` resolves.
  - `it("verifies ACTIVE and ownership")`: not `ACTIVE` rejects `connect_failed` and calls `delete`; a `list` result lacking the id rejects `connect_failed` and calls `delete`; both fine resolves with no `delete`.
  - `it("revoke deletes after revoking and rejects if revoke fails")`: call order `revoke` then `delete`; a rejecting `revoke` rejects and `delete` is not called.
- [ ] **Step 2: Run** `npx vitest run tests/composio-adapter.test.ts`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement** the three functions as specified.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: Composio connect, verify and revoke`.

### Task 3: Registry and provider list

**Files:**
- Modify: `src/lib/connectors/registry.ts`, `src/app/api/connect/route.ts`
- Test: `tests/composio-adapter.test.ts`

**Interfaces:**
- Consumes: `composioEnabled`, `composioReady` (Task 1).
- Produces: `routedViaComposio(p: Provider): boolean` exported from `registry.ts` (true when `p.id === "meta"` and `composioEnabled("meta")`); `isAvailable(meta)` returns `composioReady("meta")` when routed, otherwise the existing env check. `GET /api/connect` adds `toolkits: ["instagram", "facebook"]` (Instagram first) to the `meta` entry only when routed.

- [ ] **Step 1: Failing tests** (R4): `it("keeps Meta on META_APP_ID when Composio is off")`; `it("makes Meta available through Composio only with the key, the flag and both auth config ids")`; `it("lists the toolkits only when routed")` through the route's `GET`.
- [ ] **Step 2: Run** the file; expect FAIL.
- [ ] **Step 3: Implement.** `registry.ts` imports from `composio.ts`; the SDK is imported lazily there, so the import is cheap and safe in any bundle.
- [ ] **Step 4: Run**; expect PASS.
- [ ] **Step 5: Commit** `feat: route Meta availability through Composio behind the flag`.

### Task 4: Publish through Composio

**Files:**
- Create: `src/lib/connectors/meta-composio.ts`
- Modify: `src/lib/connectors/publish.ts` (cases `facebook`, `instagram`), `src/lib/connectors/meta.ts` (export `plain`), `src/lib/publish-once.ts` (add `composio_unavailable` and `instagram_limit_reached` to the `REFUSED` pattern)
- Test: `tests/meta-composio-publish.test.ts`

**Interfaces:**
- Consumes: `composioRead`, `composioWrite`, `composioEnabled` (Tasks 1-2); `Connection` from `store.ts`.
- Produces:
  - `isComposioMeta(c: Connection): boolean` (`c.meta?.via === "composio"`)
  - `postToFacebookVia(scope: string, c: Connection, text: string, imageUrl?: string): Promise<{ url: string; id: string }>`
  - `postToInstagramVia(scope: string, c: Connection, text: string, imageUrl: string): Promise<{ url: string; id: string }>`
- `publishWith` passes its `email` argument (the scope string it already uses for `getFreshConnection`) as `scope`.

- [ ] **Step 1: Write the failing tests** (R5 branch, R6 unknown outcome) with the fake client:
  - `it("takes the Composio path from the stored record, not from the flag")`: a record with `meta.via="composio"` publishes through the fake with `COMPOSIO_PROVIDERS` unset but `COMPOSIO_API_KEY` set; a record without `via` goes through the Graph mock exactly as in `tests/meta-publish.test.ts`.
  - `it("refuses a Composio record when the key is unset, as a refusal")` (Review Focus 4): rejects `composio_unavailable`, `mayHavePosted(err)` is false, the fake saw no call.
  - `it("Facebook text and photo posts use the right slug and build the url from the returned id")`: `FACEBOOK_CREATE_POST` with `{ page_id, message, published: true }`; with an image `FACEBOOK_CREATE_PHOTO_POST`; a returned `{ post_id: "1_2" }` gives `https://www.facebook.com/1_2`.
  - `it("Instagram checks the limit, makes one container, then publishes")`: call order `INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT`, `INSTAGRAM_POST_IG_USER_MEDIA`, `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH`; caption at most 2200 characters with markup stripped by the exported `plain`; `max_wait_seconds` is 20; url is `https://www.instagram.com/{meta.ig}/`.
  - `it("Instagram stops before the container when the publishing limit is spent")`: limit read answers `{ quota_usage: 50, config: { quota_total: 50 } }` (shape confirmed in Task 8); rejects `instagram_limit_reached`; no container call.
  - `it("an image rejection is a refusal and leaves no second container")` (Review Focus 5): the container call fails with `successful:false, error:"image format not supported"`; `meta-composio.ts` rethrows `meta media 400: image_rejected` for a container error whose text contains `image`, `aspect`, `format` or `invalid`; `mayHavePosted` is false and there is exactly one container call.
  - `it("a timeout after the container call keeps the unknown outcome and calls no write twice")`: the publish call throws `TimeoutError`; `mayHavePosted` is true; write calls total 2; running it through `publishOnce` leaves the `pubtry:` marker (find the existing pattern with `grep -rn attemptKey tests`).
  - `it("Instagram still requires artwork")`: no artwork rejects `instagram_needs_image` before any call.
- [ ] **Step 2: Run** `npx vitest run tests/meta-composio-publish.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.** Instagram follows the spec's section 3 order. In `publish.ts` both cases call the Via function when `isComposioMeta(c)`, otherwise the existing line.
- [ ] **Step 4: Run** the file plus `npx vitest run tests/meta-publish.test.ts` and the existing publish-once tests (`ls tests | grep -i publish`); expect PASS, direct path unchanged.
- [ ] **Step 5: Commit** `feat: publish Facebook and Instagram through Composio`.

### Task 5: Connect flow and Page selection

**Files:**
- Modify: `src/app/api/connect/[provider]/start/route.ts`, `src/app/api/connect/[provider]/callback/route.ts`, `src/app/api/connect/[provider]/route.ts` (`select_page`), `src/components/app/IntegrationsPanel.tsx`, `src/lib/connectors/meta-composio.ts`
- Test: `tests/meta-composio-connect.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4; `saveState`, `takeState`, `OAUTH_COOKIE`, `saveConnection`, `getConnection`.
- Produces in `meta-composio.ts`:
  - `connectViaComposio(scope: string, toolkit: Toolkit, accountId: string, existing: Connection | null): Promise<Connection>`: reads identity through `composioRead` (Instagram `INSTAGRAM_GET_USER_INFO`, Facebook `FACEBOOK_LIST_MANAGED_PAGES`); merges into `existing` when `existing?.meta?.via === "composio"`, so the other toolkit's account id and Page survive; otherwise starts `{ provider: "meta", data: {}, meta: { via: "composio" }, connectedAt: new Date().toISOString() }` (an existing direct record is simply replaced, as a reconnect would). Sets `data.fbAccountId` or `data.igAccountId`; Facebook sets `meta.pageId`, `meta.account` and `meta.pages` (JSON `{ id, name, ig }[]`, no token); Instagram sets `meta.igId` and `meta.ig`. Throws `meta_no_page` or `meta_no_instagram` when the answer holds none. `parsePages(data: unknown)` is tolerant: an array under `data.pages`, `data.data` or the value itself, items need a string `id`; real shapes are confirmed in Task 8.
  - `selectPageVia(c: Connection, pageId: string): Connection | null`: accepts only an id listed in `meta.pages`; changes `pageId` and `account` only, never `igId`.

Start route, when `provider === "meta"` and `composioEnabled("meta")`: query `toolkit` must be `instagram` or `facebook` (else 400 `bad_toolkit`); `composioReady` false gives 503 `provider_not_configured`; `state = randomBytes(16).toString("hex")`; call `composioConnect`; `saveState(state, { email: sc(u), provider: "meta", lang, shop: "", verifier: "", actor: u.actor?.email ?? u.email, via: "composio", toolkit, accountId })`; set the cookie exactly as the existing code does; `NextResponse.redirect(redirectUrl)`. The existing role check (`forbid(u, "connectors")`) stays first.

Callback route: every existing check (state, provider match, cookie via `sameSecret`, same user, same actor, `can(u, "connectors")`) runs unchanged and first. The `!code` refusal is skipped only when `st.via === "composio"` (Composio's redirect parameters are Task 0 item (d)). Then, with `scope = st.email` and the toolkit and account id from the saved state only: `composioVerify`, `connectViaComposio(scope, toolkit, accountId, await getConnection(scope, "meta"))`, `saveConnection(scope, conn)`, `track(..., "connect")`, redirect `connected=meta`. A throw after the account became ACTIVE deletes that pending account (through `composioRevoke`) and redirects with an `error=` code from the existing set.

- [ ] **Step 1: Write the failing tests** (R7 callback binding), reusing the helpers in `tests/meta-publish.test.ts` (`jar`, `signIn`, `saveState`, cookie) and the fake client:
  - `it("start redirects to the Composio URL, saves the state and sets the cookie")`; `it("start refuses an unknown toolkit")`; `it("start is 503 when the auth configs are missing")`; `it("start is refused for a member without the connectors role")`.
  - `it("callback saves the record with account ids and no token")`: afterwards `getConnection(u.email, "meta")` has `meta.via === "composio"`, `data.igAccountId`, `meta.igId`, `meta.ig`, and `JSON.stringify(conn)` contains neither `access_token` nor `page_token`.
  - `it("callback rejects a missing cookie, a reused state, a state of another user and a non-ACTIVE account")`: each redirects with an `error=` and saves nothing; the non-ACTIVE case deletes the pending account.
  - `it("callback never reads an account id from the query string")`: append `&connected_account_id=ca_evil`; the saved id is the one from the state.
  - `it("connecting Instagram after Facebook keeps the Facebook account and Page")` (Review Focus 1).
  - `it("a Page with no Instagram account leaves no Instagram target")` (Review Focus 3): `connectedTargets` over the saved record contains `facebook` and not `instagram`.
  - `it("select_page accepts only a listed Page and leaves igId alone")` and `it("select_page refuses an unlisted id")`.
- [ ] **Step 2: Run** `npx vitest run tests/meta-composio-connect.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** as specified. In `IntegrationsPanel.tsx`, for a provider that has `toolkits`, render one button per toolkit (labels `Instagram` and `Facebook`; Arabic `إنستغرام` and `فيسبوك`) that goes through `startOAuth` with `&toolkit=` appended; other providers are unchanged and no text names Composio.
- [ ] **Step 4: Run** the file plus `npx vitest run tests/meta-publish.test.ts tests/oauth-connect.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat: connect Facebook and Instagram through Composio`.

### Task 6: Disconnect and account deletion

**Files:**
- Modify: `src/app/api/connect/[provider]/route.ts` (`DELETE`), `src/lib/account.ts` (`wipeAccount`), `src/lib/connectors/meta-composio.ts`
- Test: `tests/meta-composio-disconnect.test.ts`

**Interfaces:**
- Consumes: `composioRevoke`, `getConnection`, `saveConnection`, `deleteConnection`.
- Produces: `composioAccountIds(c: Connection): string[]` in `meta-composio.ts` (the values of `data.fbAccountId` and `data.igAccountId` that exist).

Behaviour: `DELETE /api/connect/meta` for a Composio record runs `Promise.all(ids.map((id) => composioRevoke(scope, id)))` first. If any rejects, save the record with `needsReconnect = "revoke_failed"`, keep it, and answer `502 { ok: false, error: "revoke_failed" }`; otherwise `deleteConnection`. A direct record and every other provider delete exactly as today. In `wipeAccount`, before keys are deleted, read each scope's `meta` connection inside the existing per-scope `pmap`, revoke its Composio accounts, and let a revoke failure stop the wipe the way `revokeFeeds` does (the existing comment says a retry runs it again).

- [ ] **Step 1: Failing tests** (R8): `it("revokes at Composio before deleting the local record")` (call order through the fake, `getConnection` null at the end); `it("keeps the record and flags it when revoke fails")` (status 502, record present with `needsReconnect`); `it("leaves a direct Meta record and other providers on the old path")`; `it("wipeAccount revokes the Composio accounts and stops when revoke fails")`.
- [ ] **Step 2: Run**; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file plus the existing account-deletion tests (`ls tests | grep -i -E "account|wipe"`); expect PASS.
- [ ] **Step 5: Commit** `feat: revoke Composio accounts on disconnect and account deletion`.

### Task 7: Isolation rule, docs and pinned rules

**Files:**
- Test: `tests/composio-isolation.test.ts`
- Modify: `docs/system/variables.md`, `flows.md`, `permissions.md`, `architecture.md`, `tests.md`

- [ ] **Step 1: Write the test** (part of R1): read every file under `src` as text; `@composio/core` appears only in `src/lib/connectors/composio.ts`; the import paths `composio` and `meta-composio` do not appear in `src/lib/chat.ts`, `src/lib/mcp.ts` or any file under `src/app/api/mcp`; `composioWrite` appears only in `src/lib/connectors/composio.ts` and `src/lib/connectors/meta-composio.ts`.
- [ ] **Step 2: Run** `npx vitest run tests/composio-isolation.test.ts`. Expected: PASS if Tasks 1 to 6 respected it; otherwise fix the offending import.
- [ ] **Step 3: Docs.** `variables.md`: rows for `COMPOSIO_API_KEY` (secret, server only, never in a URL or log), `COMPOSIO_PROVIDERS` (comma list; empty means none; Preview only until the gate), `COMPOSIO_AUTH_FACEBOOK` and `COMPOSIO_AUTH_INSTAGRAM` (auth config ids, not secrets). `flows.md`: the connect, publish and revoke flows with the callback checks. `permissions.md`: `meta` start and callback behaviour (role `connectors`, no new route). `architecture.md`: the adapter and the one-path-per-record rule. `tests.md`: rows R1 to R8 in the table's existing format, each naming its test file, plus a note that no Composio test touches the network.
- [ ] **Step 4: Run** `npm run check`; expect PASS. Then `npx next build`, recording if it is blocked locally.
- [ ] **Step 5: Commit** `docs: Meta through Composio flows, variables and pinned rules`.

### Task 8: Task 0 answers and the measured run (founder-held steps)

This task changes no product code except filling `TOOLKIT_VERSION` and correcting `ARG_KEYS`, the response parsers and the quota parsing from what the real calls show. It needs the founder's Composio dashboard, a Vercel Preview deployment and the founder's own Page and Instagram professional account; credentials are entered by the founder, never in chat.

- [ ] **Step 1: Founder gets written answers** to the evaluation spec's Task 0 questions and the spec's section 7 items (a) to (g), and saves them in `docs/superpowers/specs/2026-10-05-composio-evaluation-results.md`. If (a) or (b) fails, stop: the flag stays off and the branch is shelved.
- [ ] **Step 2: Create the two auth configs** (managed OAuth, toolkits `facebook` and `instagram`) in the Composio dashboard, or with a one-off local script calling `composio.authConfigs.create(toolkit, { type: "use_composio_managed_auth", name })`. The founder puts the returned `ac_…` ids in the Vercel Preview environment as `COMPOSIO_AUTH_FACEBOOK` and `COMPOSIO_AUTH_INSTAGRAM`, with `COMPOSIO_API_KEY` and `COMPOSIO_PROVIDERS=meta`, Preview only.
- [ ] **Step 3: Connect** the founder's Instagram account on the Preview deployment; read what the callback receives and what `INSTAGRAM_GET_USER_INFO`, the limit read and the container call really return; update `ARG_KEYS`, `parsePages`, the quota parsing and `TOOLKIT_VERSION`, with one test per correction using the real shape (ids and secrets redacted).
- [ ] **Step 4: Run the measured protocol** from the spec's section 7 (50 Instagram, 50 Facebook, revoked-token case, forced-timeout probe, limit refusal, out-of-ratio image) and record counts and calls per publish in the results file.
- [ ] **Step 5: Commit** the results file and the corrections. The founder decides on Production; nothing else is switched on.

## Self-review notes

- Spec coverage: section 3 adapter, identity, allowlist, routing, publish (Tasks 1, 2, 4); section 4 connect, Page choice, disconnect, wipe (Tasks 5, 6); section 5 rules 1 to 7 (1 Task 4, 2 Task 5, 3 Task 2, 4 Task 1, 5 Tasks 1 and 8, 6 Tasks 1 and 4, 7 Task 8 and Global Constraints); section 6 docs and tests (Task 7); sections 7 and 8 (Task 8).
- One spec point is adapted to existing code: the callback's binding to the session uses the existing `st.email`, cookie, same-user and same-actor checks instead of a new `scope` field; the spec's intent (state saved server side, bound to the browser and the session) holds.
- Names used across tasks are each defined once: `Toolkit`, `ComposioClient`, `composioRead`, `composioWrite`, `composioConnect`, `composioVerify`, `composioRevoke`, `composioEnabled`, `composioReady`, `bucketFor`, `isComposioMeta`, `postToFacebookVia`, `postToInstagramVia`, `connectViaComposio`, `selectPageVia`, `composioAccountIds`.
