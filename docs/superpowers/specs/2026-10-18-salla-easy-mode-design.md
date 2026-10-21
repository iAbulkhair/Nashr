# Salla Easy Mode: tokens by webhook, claimed by a code shown inside Salla — design

> **Status update (2026-10-21):** the base this spec was cut from reached main in #393 (rules 2160-2179 and 2200-2209). Rule 2192 (the owned lock in `fresh.ts`) is built and goes to main in PR #424, together with Zid's early refresh: the registry's `oauth.refreshLeadDays` and `refreshDue` (rules 2210-2211). So section 8.1's rule 2193 should set Salla's 3-day window through `refreshLeadDays` rather than add a second test, and its cron pass should build on rule 2179's keep-alive (and 2212) instead of adding a second pass. Rules 2180-2191 and 2193-2199 are still unused on main. The design still waits on the founder's approval before any plan or code.

Status: design only, no code. Written 2026-10-18 on branch `claude/salla-easy-mode-spec`, cut from the local branch
`claude/api-platform-integrations-ce2972` (`2cb2b779`, rules 2160-2176, not pushed). That base is needed because the
design builds on `tokenExpiry` (rule 2176). The founder approves the design before any plan or code.

Rules **2180-2199** are reserved for this work. Checked 2026-10-18:
- `origin/main` `docs/system/tests/` ends at `2140-help-urls.md`, and 2150-2159 belong to help-urls.
- The only open PR is #387, rules 1980-1999.
- The multi-workspace spec holds 2110-2139.
- The integration branch holds 2160-2176.
- No other local branch names a rule above 2149.

2177-2179 stay free for fix-ups on the integration branch. Check `git ls-tree origin/main docs/system/tests/` and the
open PR titles again before the first code PR. As with 0870 and 0991, this spec adds no `docs/system/tests/NNNN-*.md`;
that file comes with the first code PR (`2180-salla-easy-mode.md`).

## 1. Why

Salla's Authorization page (docs.salla.dev/421118m0, read 2026-10-18) says that Easy Mode is the only mode allowed for
published App Store apps. Custom Mode is for testing only. Thakeen implements only Custom Mode today:
- `GET /api/connect/salla/start` sends the browser to `accounts.salla.sa/oauth2/auth`.
- `GET /api/connect/[provider]/callback` exchanges the code (`exchangeCode` in `src/lib/connectors/oauth.ts`).
- The callback saves the connection under `wsKey.conn(sc, "salla")` (`saveConnection` in `connectors/store.ts`).

So the Salla app has to stay unpublished, and only test stores or merchants added by hand can use it. That is the
current note in founder checklist job `platform-apps`.

In Easy Mode, Salla does the code exchange itself and POSTs the tokens to the app's webhook URL as the
`app.store.authorize` event. No browser comes back to Thakeen and no OAuth `state` exists. The delivery names a Salla
merchant id but no Thakeen user or workspace. The core problem is linking that delivery to the right workspace without
trusting anything in it to pick a Redis key.

## 2. What Salla does (sources read 2026-10-18; gaps are listed in section 13)

Sources:
- Authorization: docs.salla.dev/421118m0
- Webhooks: docs.salla.dev/421119m0
- App Events: docs.salla.dev/421413m0
- Embedded SDK: docs.salla.dev/embedded-sdk/create-app and docs.salla.dev/embedded-sdk/authentication

**Easy Mode token delivery.** Salla sends `app.store.authorize` when a merchant installs the app and approves its scopes.
- The body has top-level `event`, `merchant` (the example is an integer, 1234509876) and `created_at` (the example is
  `"2022-12-31 12:31:25"`, with no timezone stated).
- It also has `data`, holding `access_token`, `refresh_token`, `expires` (the example is `1634819484`, a Unix time in
  seconds), `scope` and `token_type`.
- When the merchant updates the app, Salla sends `app.updated` and then a new authorize event with a new access token
  and refresh token. The docs say: "you are required to update the access token and refresh token in your database."

**Lifetimes.** The access token lasts 14 days. The refresh token lasts one month, is issued only with `offline_access`,
and is **single use**: each refresh returns a new one and invalidates the old one. Reusing a refresh token invalidates
it and revokes every access token obtained with it. The merchant then has to reinstall the app from the App Store. One
paragraph describes reuse more mildly, but we design for the severe reading. Salla recommends a mutex around refresh.

**Other app events.** These exist: `app.installed`, `app.updated`, `app.uninstalled` (its body has installation and
uninstallation dates and a `refunded` flag), `app.settings.updated`, `app.trial.*` and `app.subscription.*`.

**Webhook security.** The default strategy for Partner apps, and the one used when none is set, is `Signature`.
- Salla adds `X-Salla-Security-Strategy: Signature` and `X-Salla-Signature`.
- The signature is a 64-character lowercase hex HMAC-SHA256 of the request body under the app's webhook secret.
- Salla's own examples compare with `===` and, in Node, hash `JSON.stringify(req.body)`. We hash the **raw bytes** and
  compare with `sameSecret`, as the Shopify route does.
- The `Token` strategy is documented inconsistently (header names and lengths disagree with each other). We refuse it.
- No timestamp header and no IP list are documented, so a replay cannot be detected by time.
- Salla waits about 30 seconds and retries a failed delivery three times, about five minutes apart.

**Embedded app.** Salla can show an app page inside the merchant dashboard in an iframe.
- Salla appends `token` (a "short-lived" token) and the layout parameters `theme` and `lang` to the iframe URL.
- The app server verifies the token with `POST https://api.salla.dev/exchange-authority/v1/introspect`. The request
  carries the header `S-Source: <app id>` and the body `{"token": "..."}`.
- The answer is `{ success: true, data: { merchant_id, user_id, exp } }`.
- Salla says: "Do not perform business logic based on an unverified frontend token."

## 3. Decisions in one list

1. **One webhook URL**, `POST /api/salla/webhook`.
   - Public, limited per IP, body capped at 64 KB.
   - Exempt from the cross-site check by exact path.
   - Strategy `Signature` only. Hex HMAC-SHA256 of the raw body under `SALLA_WEBHOOK_SECRET`, compared with
     `sameSecret` before the body is parsed. 401 otherwise, and 401 while the secret is unset.
2. **The webhook never touches a workspace key.** Tokens are parked, encrypted, in the fixed hash `salla:parked`, with
   the merchant id as the field. This is the same pattern as `shopify:redact`: request data picks a hash field, never a
   key.
3. **The claim method is a one-time code shown in the Thakeen page inside the Salla dashboard.** The merchant id comes
   from Salla's introspection answer, never from the browser. The signed-in owner types the code on Thakeen's
   Integrations page. Section 6 explains the choice and the alternatives that were rejected.
4. **The workspaces pull; nothing pushes into them.** A workspace's own Salla connection records `meta.merchant`, from
   its own record and never from a request.
   - It reads `salla:owner[merchant]` and `salla:parked[merchant]` when it uses the connection and in the stores cron.
   - It adopts newer parked tokens (`app.updated`).
   - It drops the connection when it no longer owns that merchant (uninstall, or another workspace claimed the store).
5. **`salla:owner` is the single source of truth.** Its value is a tag: `sha256("salla-owner:" + scope)`, 32 hex
   characters, never the scope itself. `app.uninstalled` deletes the store's owner field and parked field, and each
   workspace cleans itself up on its next read or cron pass.
6. **Refresh is owned and never unlocked by someone else.** The fallthrough in `fresh.ts` that refreshes without the
   lock after 5 seconds is removed (section 8.2). This matters for X too.
7. **Salla refreshes early.** It refreshes three days before the access token lapses, not five minutes. The stores cron
   touches every roster workspace's Salla connection, idle ones included, so a refresh token never reaches its month.
8. **Custom Mode stays for test stores** until Easy Mode is switched on. Setting `SALLA_APP_STORE_URL` turns the Easy
   Mode card on and makes the Custom start route refuse with `salla_easy_mode`.

## 4. Flow

```
Merchant (Salla dashboard)          Salla                       Thakeen
 install app from App Store ──────► exchange code itself
                                    POST /api/salla/webhook ──► verify signature, park tokens:
                                    app.store.authorize          salla:parked[merchant] = enc(tokens)
 open app page (iframe) ──────────► iframe /salla/app?token=…
                                                               ◄─ page POSTs token to /api/salla/embedded/code
                                    introspect(token) ◄──────── S-Source: SALLA_APP_ID
                                    {merchant_id, user_id, exp} ─► merchant from Salla's answer only
 sees code  K7QF-29XM  ◄────────────────────────────────────────── sallaclaim:{sha256(code)} = {merchant}, 10 min
Owner (thakeen.com, signed in)
 Integrations ▸ Salla ▸ paste code ───────────────────────────► POST /api/connect/salla/claim (user, role connectors)
                                                                 take code (single use), owner tag = tag(sc(u)),
                                                                 conn under wsKey.conn(sc(u), "salla"),
                                                                 delete parked only if unchanged
Later: app.updated + authorize ───► webhook parks new tokens ─► owner's next read or cron adopts them (connlock)
Later: app.uninstalled ───────────► webhook drops owner+parked ► owner's next read or cron deletes the connection
```

## 5. The webhook (`src/app/api/salla/webhook/route.ts`, `src/lib/connectors/salla-easy.ts`)

The route is hand-written like `/api/shopify/compliance`, because the signature is over raw bytes and the `handler`
wrapper parses JSON. Steps:

1. `allow("sallahook:ip:" + clientIp(req), 120, 60)`, else 429 `slow_down`. The limit is per IP only: a global bucket
   spent before the signature check would let anyone starve real deliveries (the reasoning of the Paymob and Shopify
   routes).
2. `readCapped(req, 64 KB)`, else 413 `too_large`. The largest documented body, a subscription event, is about 2 KB.
3. Check the signature. The request is refused with 401 and an empty body when any of these fail:
   - `X-Salla-Security-Strategy`, lowercased, must equal `signature`.
   - `X-Salla-Signature` must match `^[0-9a-f]{64}$` after lowercasing.
   - `sameSecret(header, hmacSha256Hex(raw, SALLA_WEBHOOK_SECRET))` must hold. An unset secret is a 401 too.
   Nothing is logged but the fixed word `bad_signature`.
4. `JSON.parse`, else 400 `bad_json`. `merchant` must be a number or a string matching `^[1-9][0-9]{0,11}$`, else 400
   `bad_merchant`. The merchant is kept as that string.
5. Dispatch on `event`. Unknown or ignored events answer 200 `{ok:true, ignored:true}` so Salla stops retrying.

| Event | Action |
|---|---|
| `app.store.authorize` (also accept `app.store.authorized`, the spelling in the Authorization page) | Validate `data`: `access_token` and `refresh_token` are non-empty strings of at most 4096 characters, and `expires` is numeric. Otherwise 400 `bad_tokens`. Flatten `data` to `Record<string,string>` the way `tokenRequest` does. Park it (5.1). |
| `app.updated` | Receipt only. The authorize that follows carries the tokens. |
| `app.uninstalled` | `hdel salla:owner merchant`, `hdel salla:parked merchant`, receipt (section 9). |
| `app.installed`, `app.settings.updated`, `app.trial.*`, `app.subscription.*` | Receipt only. The app is free on Salla's store and billing stays in Thakeen (founder action F6). |

6. A store write that throws answers 500 `retry`, so Salla tries again within its three retries. The log holds
   `errorTag(e)` only.

Receipts go to the fixed list `salla:events`: `{event, merchant, at}`, the 500 newest, never a token. This is the
Shopify `shopify:compliance` pattern, and the Integrations page reads it (rule 2196).

### 5.1 Parking

`salla:parked` is a fixed hash. Field: the merchant id string. Value:
`{ enc, kid, at, created }`, where:
- `enc` is `encrypt(JSON.stringify(tokens))`, the AES-256-GCM of `connectors/store.ts` under `CONNECT_SECRET`, with
  `kid = currentKid()` so key rotation (rule 1351) covers parked tokens too.
- `at` is Thakeen's receive time in ms.
- `created` is Salla's `created_at` string.

An authorize whose `created` sorts before the parked entry's `created` is acknowledged and not written. Salla's retries
can reorder deliveries. Both are the same `YYYY-MM-DD HH:MM:SS` shape in Salla's own clock, so string order is time
order whatever the zone.

A parked entry is consumed by a claim (section 6) or an adoption (section 7) through `hdelIf` (section 11). The stores
cron removes entries older than 30 days, because by then the refresh token has expired and the tokens are useless.

## 6. Linking a store to a workspace: the claim

### 6.1 Method chosen: a code shown by Thakeen's page inside the Salla dashboard

**Salla side.** The merchant installs the app and opens it in their dashboard. Salla loads
`https://thakeen.com/salla/app?token=…&lang=ar&theme=light` in an iframe.
- The page reads `token`, removes it from the address bar (`history.replaceState`), and POSTs it to
  `/api/salla/embedded/code`.
- That route asks Salla's introspection endpoint who it is. The merchant id comes from **Salla's answer**, over a fixed
  host. Nothing from the browser is believed.
- If tokens are parked for that merchant, the route issues an 8-character code (Crockford base32, 40 bits, shown as
  `K7QF-29XM`) and stores `sallaclaim:{sha256(code)}` = `{merchant, at}` for 10 minutes.

**Thakeen side.** The owner signs in, opens Integrations → Salla, and types the code. `POST /api/connect/salla/claim`
then takes the code (single use), checks the role, and links the store to `sc(u)`.

Why this proves the right thing:
- Seeing the code needs a live session in that store's Salla dashboard. That proves control of the store, checked by
  Salla, not by us.
- Using the code needs a signed-in Thakeen session with the `connectors` permission in the workspace that receives it.
  That proves control of the workspace.
- The code joins the two sessions without either side trusting the other's request.

Why it fits the rules:
- No Redis key is built from an id, email or scope in a request. The code's key is a SHA-256 of a random token with a
  TTL, the same pattern as `oauthState(state)`. The merchant id only ever names a field of a fixed hash, and it comes
  from a signed webhook or from Salla's introspection answer.
- The workspace always comes from `sc(u)`.

### 6.2 Alternatives rejected

- **A `state` carried through the App URL or install link.** Easy Mode installs start in Salla's App Store, not from
  Thakeen, so no Thakeen state exists to carry. Salla documents no parameter passed through the install or the App
  URL. Even if one were echoed back, it would arrive in the browser, not in the signed webhook, so nothing would tie
  the tokens to it.
- **Matching the Salla user's email to the Thakeen account email.** We cannot know that Salla verified that email. An
  attacker could open a Salla store with a victim's email and push their own store's catalogue and sales into the
  victim's workspace. Crawled and connector data is untrusted, but it should not arrive uninvited.
- **A Thakeen code typed into a Salla app setting (`app.settings.updated`).** This was workable, but it depends on a
  settings form whose builder and payload Salla documents only in passing. It also leaves the code stored in Salla
  after use. It would be the fallback if the embedded page is refused in review (section 13).
- **Emailing a claim link to the store's email.** This has the same verification gap as email matching, it needs mail
  delivery, and a link is a secret in a URL.

### 6.3 Residual risk, accepted

A phisher could hand a victim a code from the phisher's own store. The victim would then link a store they don't own
into their workspace. The victim must take that step themselves. The success message names the store
(`meta.account`, `meta.site`), and Disconnect removes it. The data is store data treated as untrusted input already.
The code lives 10 minutes and is used once.

### 6.4 Code route (`POST /api/salla/embedded/code`)

- Auth is `public`, through the `handler` wrapper. It reads no session or cookie.
- Rate limit `sallacode` 20 per 10 minutes per IP. `maxBytes` 2048. Input `z.object({ token: z.string().min(8).max(4096) })`.
- Introspect: `fetch("https://api.salla.dev/exchange-authority/v1/introspect", { method: "POST", headers: { "S-Source": SALLA_APP_ID, "Content-Type": "application/json" }, body, signal: providerTimeout() })`.
  The host is fixed, not a user URL, so this is the `fetch` the other Salla calls use, not `safeFetch`.
- Accept only `success === true`, a merchant id of the same shape as in step 4, and `exp` in the future. Otherwise
  401 `salla_token`.
- Answer one of these states. None names a workspace, scope, email or store:
  - `ready` (a parked entry exists): with `{code, expiresIn: 600}`.
  - `waiting` (no parked entry and no owner): "Salla has not sent your store's access yet. Wait a minute and reopen
    this page." The page offers a retry button and does not poll.
  - `linked` (an owner exists and nothing is parked): "This store is already linked to a Thakeen workspace. To link
    another one, remove the app from your store and install it again."
- Not cross-site exempt. The iframe document is on thakeen.com, so its `fetch` is same-origin and passes
  `crossSiteRefusal`.

### 6.5 The embedded page (`src/app/salla/app/page.tsx`)

- It is outside `[lang]`. The language comes from Salla's `lang` (`ar` by default, else `en`) and the theme from
  `theme`. It reads no Thakeen session: third-party cookies are blocked in an iframe anyway, and it needs none.
- Headers apply to this path only. `Content-Security-Policy: frame-ancestors <Salla dashboard origins>` replaces the
  global `frame-ancestors 'none'`, and `X-Frame-Options` is left out. `next.config.ts` excludes `/salla/app` from the
  global header source.
  - The origins are a fixed list in code, to be confirmed in the Partners Portal (section 13, item Q3).
  - Also set: `Referrer-Policy: no-referrer`, so the token never leaks through a link, and `Cache-Control: no-store`.
- Content: the code in large type with a copy button, three numbered steps, and a link to
  `https://thakeen.com/{lang}/app/integrations#salla` with `target="_blank" rel="noopener"`. The code is never put in
  a URL.
- If Salla requires `embedded.ready()` to clear its loading screen (Q4), the page loads Salla's Embedded SDK from npm,
  pinned, under the lockfile rule (a release older than 7 days). No third-party script is loaded from a CDN.
- Hostinger's access log can record the `token` query string, which is Salla's design and cannot be avoided. The token
  is short-lived and only proves who opened the page; it grants no API access. Our own code never logs it.

### 6.6 Claim route (`POST /api/connect/salla/claim`)

Settings:
- `handler({ auth: "user", role: "connectors", rate: { bucket: "sallaclaim", max: 5, window: 600, per: "account" }, maxBytes: 1024, input })`,
  plus `allow("sallaclaim:ip:" + ip, 20, 600)`.
- The input is `code`. It is normalised (uppercased, `-` and spaces removed, `O→0`, `I/L→1`) and must match
  `^[0-9A-HJKMNP-TV-Z]{8}$`, else 400 `bad_code`.
- Cross-site checked as usual: it is a cookie route.

Steps:
1. GET then DEL `sallaclaim:{sha256(code)}`, the `takeState` pattern. A missing or expired code is 400 `bad_code`.
   With 5 tries per 10 minutes per account against 40 bits, a brute force has no chance.
2. `Promise.all([hget salla:parked m, hget salla:owner m])`. With nothing parked, answer 409 `salla_not_ready`.
3. Lock `connlock:{sc(u)}:salla` (owned, section 8.2).
4. If this workspace already holds a Salla connection for another merchant and owns that merchant, `hdel` that owner
   field. One Salla store per workspace (provider id `salla`), as today.
5. Write in this order. A failure part-way leaves either a stale owner field, which is harmless (no connection uses it),
   or an extra parked copy, which is pruned:
   1. `hset salla:owner m {tag: tag(sc(u)), at}`.
   2. `saveConnection(sc(u), { provider: "salla", data, meta: { merchant: m, mode: "easy", adoptedAt: String(parked.at) }, connectedAt, expiresAt: tokenExpiry(data) })`.
   3. `hdelIf salla:parked m <raw parked value>`.
   A store claimed before by another workspace moves. The merchant proved control again in Salla's dashboard, and the
   old workspace drops it on its next read (section 7).
6. `sallaStore(conn)` fills `meta.account` and `meta.site` and `meta.merchant` is checked against
   `data.merchant.id`. A mismatch deletes what step 5 wrote and answers 409 `salla_mismatch`. This should never happen,
   but it would catch a parked entry crossed with a code.
7. `track(owner, "connect")`. The answer is `{ok:true, account}`.

## 7. Using the connection: adoption and ownership (`getFreshConnection`, stores cron)

For a Salla connection with `meta.merchant`, `getFreshConnection(scope, "salla")` adds one parallel step before the
due check. `scope` here is the caller's `sc(u)` or a roster entry, never a request value. The step runs
`Promise.all([hget salla:owner m, hget salla:parked m])`. That is two HTTP commands, and Salla is read rarely: product
import, the sales sync, the cron.

- **Not the owner** (field missing, or the tag differs from `tag(scope)`): the store was uninstalled or claimed by
  another workspace.
  - Delete the connection.
  - When the store-sales snapshot is Salla's, also delete `storesales:`, `storesyncfail:` and `store-sales.md`. This
    reuses the helper behind `applyShopRedactions`, generalised.
  - Return `null`. The owner's `products.md` stays, because it is their file.
  - Log `salla unlinked` with no merchant id.
- **Newer parked tokens** (`parked.at > meta.adoptedAt`): under the connection lock, re-read both, then adopt.
  - Set `data` to the parked tokens, `expiresAt` to `tokenExpiry(data)`, `meta.adoptedAt` to `parked.at`, and clear
    `needsReconnect`.
  - `saveConnection`, then `hdelIf` the parked field. A newer authorize that lands between the two survives, because
    `hdelIf` compares the stored value.
  - The old refresh token is never used again.
- Otherwise the existing refresh path runs (section 8).

A connection marked `needsReconnect` does not throw at once for Salla when a newer parked entry exists. Adoption runs
first, so an `app.updated` reinstall repairs a lost connection without a code.

**Stores cron** (step 14c): before the syncs, `sallaPass(roster)` runs. The roster is the active and idle workspaces of
`dailyRoster()`, the same set as `applyShopRedactions`.
- It takes the workspaces that hold a Salla connection (`listConnections`, `pmap`, no `await` in a loop) and calls
  `getFreshConnection` on each. That one call drops, adopts or refreshes as needed.
- It then prunes parked entries older than 30 days with one `hgetall` and `hdel`s.
- Its answer adds `salla: {dropped, adopted, refreshed, pruned}`. A failure counts as -1 and does not stop the syncs.

Legacy Custom Mode connections, made before this release, have no `meta.merchant`. They skip both checks and behave as
today. Section 10 covers how they gain it.

## 8. Expiry and rotation

### 8.1 Lifetimes and early refresh

- `tokenExpiry` (rule 2176) already reads `expires` as a Unix time when it is above 1e9. The authorize payload's
  `expires` is such a time, so parking and adoption use `tokenExpiry` unchanged. Tests feed the documented example
  `1634819484` and a lifetime value.
- Refresh tokens last a month and are spent on each refresh. A connection must therefore refresh at least once a month
  or it is lost. Today's window refreshes 5 minutes before the access token lapses, which happens only when something
  reads Salla, and an idle workspace may read nothing for a month.
  - Rule 2193 adds a per-provider early window: Salla refreshes once its access token has less than **3 days** left.
  - The stores cron pass (section 7) reads every roster workspace's Salla connection twice a day.
  - So a Salla token is refreshed around day 11, and its refresh token is never older than about 11 days when used.
  - The only cost is one token call per store every 11 days.
- A refresh answer without `refresh_token` is a failure for Salla, which always rotates. Today's code keeps the old one
  instead, and spending it again would trigger the reuse revocation. Salla's refresh is therefore marked `rotates: true`
  in the registry, and a missing token marks the connection `needsReconnect`.
- Persist before use. `saveConnection` of the refreshed tokens happens before the new access token is returned, as
  today. If the save throws, retry it once, then log. The tokens are lost and the merchant must reinstall, an accepted
  edge with Upstash's availability.

### 8.2 The lock in `fresh.ts`: a gap to close first

`getFreshConnection` tries `db.lock("connlock:{scope}:{provider}", 30)` 20 times, 250 ms apart. If it never gets the
lock, **the loop ends and the code refreshes anyway**. Its `finally` then calls plain `db.unlock`, which deletes a lock
another request still holds. For a single-use refresh token this is exactly the double spend that Salla punishes by
revoking everything (and X by refusing). Rule 2192 fixes it, for every provider:
- Use `lockOwned` and `unlockOwned` (the compare-and-delete in `db.ts`). A request whose lock expired never frees the
  next holder's lock.
- If the lock is not won after the waits, re-read. If the connection is no longer due, use it. If it is still due,
  throw `RefreshBusy`, which routes answer as a retryable 503 `busy`. Never refresh without the lock.
- `LOCK_S` stays 30 seconds, which is longer than `providerTimeout()`.

Adoption (section 7) and claim (section 6.6) take the same lock, so a refresh, an adoption and a claim on one
workspace's Salla connection never interleave. Two different workspaces never hold the same tokens: a parked entry is
taken by exactly one claim or adoption (`hdelIf`), and the ownership check stops the old holder.

## 9. `app.uninstalled`

The webhook runs `hdel salla:owner m` and `hdel salla:parked m` and writes a receipt. Salla revokes the tokens on its
side. Nothing in the delivery picks a workspace.

The owning workspace drops the connection and the Salla sales snapshot on its next Salla read or at the next stores
cron, within 12 hours (section 7). This follows the Shopify `shop/redact` model, but needs no pending list: the missing
owner field is the signal.

A reinstall sends a new authorize. With no owner field, it can only be linked by a new claim (a code). A store that
changed hands is never re-linked silently to the old workspace.

The privacy page's deletion section (rule 2167's anchors) gains one sentence on this (rule 2199). When a merchant removes
Thakeen from their Salla store, Thakeen deletes the store connection and its sales figures within 12 hours. The
`refunded` flag is ignored, because the app is free on Salla.

## 10. Custom Mode until the switch, and after it

- **While `SALLA_APP_STORE_URL` is unset** (today), the Integrations card and `/api/connect/salla/start` work as now
  (Custom Mode, test stores). The callback also stores `meta.merchant` from `sallaStore`
  (`data.merchant.id`, accepted only with the step 4 shape) and writes `salla:owner[merchant] = tag(sc(u))`.
  - Test connections therefore get uninstall handling and ownership too.
  - A Custom connection is proven the OAuth way, by a signed-in user with a state bound to the browser.
- **Once it is set**, the card shows the Easy Mode steps and the code box, and the start route answers 400
  `salla_easy_mode` for Salla.
- Connections made in Custom Mode keep working if Salla still honours their refresh tokens after the app switches mode.
  This is unknown (Q5). If not, their first refresh fails, they are marked `needsReconnect`, and the card tells the
  owner to install from the App Store.
- **Legacy connections without `meta.merchant`** (expand step): the next successful `sallaStore` read, at product import
  or sales sync, fills `meta.merchant`. It writes the owner field only when the field is empty, never over another
  workspace's tag. The `meta` record is `Record<string,string>`, so older code ignores the new fields and no stored shape
  changes. **One release, no expand/contract pair** (rule 679 does not apply). The contract-like clean-up, treating a
  Salla connection without `meta.merchant` as `needsReconnect`, waits for a later release once production shows none
  left. It is not part of this work.

## 11. Keys, environment variables, code

| Key (all `globalKey`, all in the key registry `src/lib/keys.ts`) | Kind | Written by | Read by |
|---|---|---|---|
| `salla:parked` | hash, field = merchant id, value `{enc, kid, at, created}` | webhook | claim, adoption, cron prune, code route |
| `salla:owner` | hash, field = merchant id, value `{tag, at}` | claim, Custom callback, legacy fill; `hdel` by webhook and claim | adoption/ownership check, code route |
| `salla:events` | list, 500 newest `{event, merchant, at}` | webhook | Integrations page receipts |
| `sallaclaim:{sha256(code)}` | string, TTL 600 s, `{merchant, at}` | code route | claim (GET+DEL) |
| `rate:sallahook:ip:*`, `rate:sallacode:ip:*`, `rate:sallaclaim:*` | counters through `allow` | | |

`src/lib/db.ts` gains two methods, in both the Upstash and in-memory adapters, with tests:
- `hget(key, field)`. Today only `hgetall` exists, and reading one store's field must not fetch the whole hash.
- `hdelIf(key, field, expected)`, a Lua compare-and-delete like `REPLACE_IF`.

| Variable | Secret | Purpose |
|---|---|---|
| `SALLA_WEBHOOK_SECRET` | yes | The webhook secret from the Salla app's Webhooks settings. Without it the webhook answers 401. |
| `SALLA_APP_ID` | no | The `S-Source` header of introspection. Without it the code route answers 503 `salla_off`. |
| `SALLA_APP_STORE_URL` | no | The App Store listing. Setting it switches the card to Easy Mode and turns off the Custom start. |

`SALLA_CLIENT_ID` and `SALLA_CLIENT_SECRET` stay, because refresh still calls `accounts.salla.sa/oauth2/token` with
them.

New code:
- `src/lib/connectors/salla-easy.ts`: signature check, payload parse, park, receipts, code issue and take, owner tag,
  ownership and adoption step, cron pass. It is imported by the three routes, `fresh.ts` and the stores cron.
- Routes: `src/app/api/salla/webhook/route.ts`, `src/app/api/salla/embedded/code/route.ts` and
  `src/app/api/connect/salla/claim/route.ts`.
  - Check that the static `connect/salla/claim` route wins over `connect/[provider]` in Next 16 (it should: static
    segments win). Read `node_modules/next/dist/docs/` on routing first, as AGENTS.md says.
- The page `src/app/salla/app/page.tsx`.
- Changes to `IntegrationsPanel.tsx`, `fresh.ts`, `db.ts`, `keys.ts`, `csrf.ts`, `next.config.ts`, `registry.ts`
  (`rotates`, early window), the callback route (Custom: merchant and owner), `cron/stores/route.ts`, and the privacy
  page text.

## 12. Rules 2180-2199 and their tests

| Rule | What | Test (new file unless named) |
|---|---|---|
| 2180 | `POST /api/salla/webhook`: per-IP limit 120/60 (429), 64 KB cap (413), exact-path entry in `CROSS_SITE_EXEMPT` with its comment | `tests/salla-webhook.test.ts`; `tests/csrf.test.ts` list |
| 2181 | Signature: strategy `Signature` only; lowercase hex HMAC-SHA256 of the **raw** body under `SALLA_WEBHOOK_SECRET`; `sameSecret`; 401 before parsing, 401 while unset, 401 for `Token`; a re-serialised body with different whitespace fails | `salla-webhook.test.ts` |
| 2182 | Payload: merchant shape, event table, unknown or ignored events 200 `ignored`, `bad_json`, `bad_merchant`, `bad_tokens`; receipts with no token, 500 newest | `salla-webhook.test.ts` |
| 2183 | Authorize parks encrypted under `salla:parked[merchant]` with `kid`; an older `created` never overwrites; the webhook module imports no `wsKey` (source scan) | `salla-webhook.test.ts`, `tests/salla-easy-isolation.test.ts` |
| 2184 | `app.updated` keeps a receipt only; the next authorize replaces the parked tokens | `salla-webhook.test.ts` |
| 2185 | `app.uninstalled` deletes the owner and parked fields; a store write that throws answers 500 | `salla-webhook.test.ts` |
| 2186 | Ownership check: a connection whose owner tag is missing or someone else's is deleted on read and in the cron, with the Salla snapshot; `products.md` stays | `tests/salla-adoption.test.ts` |
| 2187 | Embedded page: path-scoped `frame-ancestors` (Salla origins), no `X-Frame-Options`, `no-referrer`, `no-store`; global headers unchanged elsewhere; token removed from the URL; no session read | `tests/salla-embedded-page.test.ts`, `tests/security-hardening.test.ts` (extend) |
| 2188 | Code route: public, 20/10 min per IP, 2 KB, introspection with `S-Source` against the fixed URL, merchant from Salla's answer only, `exp` checked, 40-bit code, only its SHA-256 stored, TTL 600; states `ready`, `waiting`, `linked` name no workspace; 503 without `SALLA_APP_ID` | `tests/salla-claim.test.ts` |
| 2189 | Claim route: user + `connectors`, 5/10 min per account and 20 per IP, code normalised, single use, scope from `sc(u)` only, order owner → connection → `hdelIf`; 409 `salla_not_ready`, `salla_mismatch` | `salla-claim.test.ts`; `tests/api-handler.test.ts` route list |
| 2190 | Owner tag is `sha256("salla-owner:" + scope)` sliced to 32 hex characters, and no scope or email is stored in any `salla:*` key (scan of written values) | `salla-easy-isolation.test.ts` |
| 2191 | Adoption: newer parked tokens adopted under the connection lock, `adoptedAt` advanced, `hdelIf` keeps a newer entry, `needsReconnect` cleared, an adopted refresh token never spent twice | `salla-adoption.test.ts` |
| 2192 | `fresh.ts`: owned lock, no refresh without the lock, `RefreshBusy` → 503 `busy`, never frees another holder's lock (all providers) | `tests/oauth-connect.test.ts` (extend) |
| 2193 | Salla early window 3 days; a rotating provider's answer without `refresh_token` → `needsReconnect`; the cron pass reads idle roster workspaces too | `oauth-connect.test.ts`, `salla-adoption.test.ts` |
| 2194 | Stores cron: `sallaPass` before the syncs, `pmap`, parked entries older than 30 days pruned, `salla` counts in the answer, failure -1 and the syncs still run | `salla-adoption.test.ts`; `tests/redis-loops.test.ts` (no `await db` in a loop) |
| 2195 | Custom Mode: the callback stores `meta.merchant` and the owner tag; legacy fill never overwrites another tag; start answers `salla_easy_mode` once `SALLA_APP_STORE_URL` is set | `tests/salla-custom-mode.test.ts` |
| 2196 | Integrations card in Easy Mode: steps, App Store link, code box, fixed error codes mapped to `ar` and `en` strings (no provider text), latest webhook receipt time | `tests/integrations-panel-drift.test.ts` (extend) |
| 2197 | `db.hget` and `db.hdelIf` in both adapters; four new key builders in the registry and the raw-key ratchet | `tests/db-hash.test.ts`, `tests/key-registry.test.ts` and `key-registry-ratchet.test.ts` (extend) |
| 2198 | Docs drift: the Registration_Packs Salla row names the webhook URL, embedded page URL, events and the three variables; `variables.md` names them | `tests/registration-packs-current.test.ts` (extend) |
| 2199 | Privacy page: the Salla uninstall deletion sentence in both languages under the deletion anchor | `tests/registration-packs-current.test.ts` (extend, where rule 2167 is pinned) |

Files marked "extend" exist on the base branch (checked 2026-10-18); the others are new.

## 13. Open questions to verify before or while building (the founder's Partners Portal and one demo store)

- **Q1.** The exact `app.store.authorize` body. Is `merchant` a number? Is `expires` a Unix time or a lifetime? Does
  Salla sign the exact bytes it sends? Capture one delivery from a demo store and keep it, with the tokens replaced, as
  the test fixture.
- **Q2.** Does `app.store.authorize` reach us before the merchant can open the app page? The `waiting` state covers the
  other order either way.
- **Q3.** Which origins frame the app page in the merchant dashboard (for example `https://s.salla.sa`)? Read the iframe
  URL setting in the Partners Portal and the frame's parent in a demo store.
- **Q4.** Does Salla's dashboard need `embedded.ready()` from its SDK to show the page? If yes, add the npm package,
  pinned.
- **Q5.** After the app switches to Easy Mode, do refresh tokens issued in Custom Mode still refresh? It only affects
  test stores.
- **Q6.** Does Salla's review accept an embedded page whose only job is to show a linking code? If not, fall back to the
  settings-field code (6.2, third alternative), which keeps everything else in this design.

## 14. Build order (one draft PR, after the founder approves)

1. `db.hget` and `hdelIf`, the key builders (2197).
2. The owned lock in `fresh.ts` (2192). This is independent and also protects X, and could go first on its own.
3. `salla-easy.ts` signature, parse and park, plus the webhook route and CSRF entry (2180-2185).
4. The code route and the embedded page with path headers (2187-2188).
5. The claim route and owner tag (2189-2190).
6. Adoption, the ownership check, the early window and the cron pass (2186, 2191, 2193-2194).
7. Custom Mode merchant and owner (2195), the Integrations card (2196), privacy text (2199), docs (2198).
8. `npm run check` and `npx next build`. Then a demo store end to end on staging: install, receipt, code, claim,
   import, `app.updated` adoption, uninstall drop.

## 15. `docs/system` updates in the code PR

- `architecture.md`: the `salla-easy.ts` row, three routes, one page, and the new `db` methods.
- `flows.md`: new step **14h** (Salla Easy Mode), with 14c amended for `sallaPass` and 14g for the Salla early window.
- `permissions.md`:
  - the webhook is public and signed;
  - the code route is public and proven by Salla's introspection;
  - the claim needs `connectors`;
  - the page is public and frameable by Salla only.
- `variables.md`: the three variables.
- `docs/Registration_Packs.md`: the Salla Easy Mode paragraph replaces the Custom-only note.
- `docs/system/tests/2180-salla-easy-mode.md`, following rule 788.
- `src/lib/csrf.ts`: the exemption comment.

## 16. Founder actions (for checklist job `platform-apps`)

Keep the app **unpublished in Custom Mode** until the code PR is merged and released to `production`. Then, in the
Salla Partners Portal:

- **F1. Webhooks.** Set the URL to `https://thakeen.com/api/salla/webhook` and the security strategy to **Signature**.
  Subscribe to `app.store.authorize`, `app.updated` and `app.uninstalled` (`app.installed` is optional). Put the webhook
  secret in Hostinger's environment as `SALLA_WEBHOOK_SECRET`, and never paste it in chat.
- **F2. App ID.** Put it in Hostinger's environment as `SALLA_APP_ID`. It is not secret.
- **F3. App page (embedded / iframe URL).** Set it to `https://thakeen.com/salla/app`. Note which dashboard origin
  frames it (Q3) and tell the session building it.
- **F4. Scopes.** Keep them to read products, read orders and offline access. That is what the code uses: the
  `/products` and `/orders` reads and refresh.
- **F5. App Keys.** Switch the authorization mode to **Easy Mode** only after F1-F3 are live and a demo store test
  passed (F7).
- **F6. Pricing on Salla.** Make the app free on the Salla App Store, because the subscription stays in Thakeen. This is
  a decision for the founder; the design assumes free.
- **F7. Demo store test**, before submitting for review: install, open the app page, claim the code in Thakeen, import
  products, update the app (the new tokens are adopted), then uninstall (the connection disappears within 12 hours).
- **F8. After the listing is approved,** set `SALLA_APP_STORE_URL` in production. This switches the Integrations card to
  Easy Mode.
