# Media storage on Hostinger disk, with Google Drive as the client's archive — design

Status: design only, no code. Written 2026-10-10 on branch `claude/media-storage-spec-41fe7e` from main `3bf67673`. The founder approves before any plan or code. Rules **991-1010** are reserved for this work. They come after PR #319's 987-990, and they do not collide with #316 (930-959) or #317 (960-969, 974-977). Check `git ls-tree origin/main docs/system/tests/` and the titles of open PRs again before the first code PR.

Founder decision (2026-10-10): our own copies live on Hostinger's disk and are served from thakeen.com. Google Drive is the **client's** optional permanent archive. Meta never publishes from Drive.

Convention: this spec PR adds no `docs/system/tests/NNNN-*.md`. That file comes with the first code PR, as with 0870 (admin shell spec #303 and code #304).

## 0. Why we keep our own copy, and what exists today

- kie.ai and Higgsfield delete results after 1 to 14 days. Instagram and Facebook fetch a post's image by URL when it is published, which can be days later. So a post must point at a file we keep (media providers spec 4.6). Cost is not the issue: about 10 GB for 100 clients (estimate in 1.3).
- `src/lib/media/blob.ts` `copyToBlob`: downloads the provider URL through `safeFetch` with `httpsOnly`, caps it while it streams (image 25 MB, video 100 MB), sniffs magic bytes, converts images to one JPEG (≤1440×1920) with `sharp`, then calls `put` to `media/{32 hex}.jpg|mp4` on Vercel Blob (public, `cacheControlMaxAge` 1 year). `probeBlob` writes, checks and deletes a file for the founder console.
- `src/lib/media/config.ts:15` `blobConfigured()` = `BLOB_READ_WRITE_TOKEN` is set. kie and Higgsfield models are offered only when it is true (`modelAvailable`, `startMedia` 409 `model_unavailable`). fal (`img-fast`) hot-links its own URL (spec A25).
- `src/lib/media-catalog.ts:79` `isOurBlobUrl` accepts only `https://*.public.blob.vercel-storage.com` with no credentials. It is the trust test at 7 call sites:
  - `mediaImageFor` (`media-catalog.ts:95`): the reference image sent to kie or Higgsfield.
  - `higgsfield.ts:100`: the same check inside the adapter.
  - `composioStageFile` (`connectors/composio.ts:177`): the only file Composio may fetch, for the YouTube upload.
  - `publish.ts:91`: YouTube needs our clip.
  - `targets.ts:47`: YouTube is offered as a target.
  - `Inbox.tsx:89`: the `?download=1` save link.
  - `blob.ts:124`: the post-`put` host check.
- **Live has no Blob.** `BLOB_READ_WRITE_TOKEN` is not among the 11 Hostinger variables (`docs/PRD-Thakeen.md:210`), so live has no Blob copies and kie/Higgsfield are off. fal images on live are hot-linked. The founder confirms that the token is absent from both the live and the staging app (Q6).
- Publishing video today goes only to YouTube, staged through Composio (`via-composio.ts:154`). Direct Meta publishes images only (`meta.ts:101` `url`, `:111` `image_url`). Reels and Facebook video (`video_url` / `file_url`) do not exist yet, but this store is built so they can use it.

## 1. Disk facts (Hostinger Business, account `u472843410`)

No Hostinger API MCP was connected in this session, so every number below is either **published** or **founder to confirm** in hPanel. Nothing here was measured on the server.

### 1.1 Facts

| Fact | Value | Source |
|---|---|---|
| Disk quota | 50 GB on the current "Web Business" table. An older version of the same page listed 200 GB | [Hostinger plan limits](https://www.hostinger.com/support/6976044-parameters-and-limits-for-hosting-plans), **founder to confirm** in hPanel > Resources Usage |
| Inode limit | 600,000. At the limit no file can be created, whatever disk space is free | same page and [inode limit article](https://www.hostinger.com/support/1583210-what-is-the-inode-limit-and-what-happens-when-it-is-reached/) |
| Current usage | Unknown. The quota and inodes are shared by thakeen.com (live), staging.thakeen.com and the WordPress site maslakiyat.com. Each Next.js app's `node_modules` and `.next` hold tens of thousands of files | **founder to confirm** (disk GB and inodes used) |
| Bandwidth | Not checked | **founder to confirm** |
| Node process limits (workers, entry processes, memory) | Not checked | **founder to confirm** |
| Where a Next.js build goes | `/home/{user}/domains/{domain}/nodejs`. `public_html` holds only the generated `.htaccess`, which every redeploy regenerates | [Hostinger deploy guide](https://www.hostinger.com/support/how-to-deploy-apps-built-with-codex-on-hostinger/), [redeploy](https://www.hostinger.com/support/how-to-redeploy-a-node-js-application/) |
| Do files survive a build? | Hostinger documents no folder that survives a redeploy. Evidence that siblings of `nodejs/` and `public_html/` survive: the cron header file `/home/u472843410/domains/thakeen.com/.thakeen-cron` was created 2026-10-08, and the crons kept answering 200 after the #309 and #312 release builds | **founder to confirm** that the crons still answer 200; the console sentinel in 1.2 then proves it on every build |
| Daily backup includes the store? | Not checked | **founder to confirm**: hPanel > Files > Backups, a file backup lists `domains/thakeen.com/media` |

### 1.2 Store location (rule 991)

- **Live:** `/home/u472843410/domains/thakeen.com/media`
- **Staging:** `/home/u472843410/domains/staging.thakeen.com/media`

Each is set as `MEDIA_DIR` on its own Hostinger app. The folder is outside `public_html` and outside `nodejs`, so no build writes there and the web server never serves it directly. Only the route in section 2 serves it.

- The app creates `MEDIA_DIR` (mode 0700) on first use and refuses a path that is not absolute or that lies inside `process.cwd()`. Writing into the build would be wiped by the next deploy.
- **Sentinel:** the console probe (rule 1009) writes `MEDIA_DIR/.sentinel` with the build commit the first time it runs. Each later probe reports "the store survived N builds" or "the store was wiped". This replaces Hostinger's missing documentation with evidence.
- Whether the Node process may write there is proven by the same probe (write, serve over https, delete), not assumed.

### 1.3 Size estimate

Per client per month: about 40 images at ~0.4 MB plus about 4 clips at 5-15 MB, so ~60 MB. For 100 clients that is ~6 GB a month, ~12 GB with 60-day retention. That is about 10,000 files, a negligible share of 600,000 inodes. Defaults: `MEDIA_MAX_BYTES` 20 GiB, `MEDIA_MAX_FILES` 100,000.

## 2. Serving route `GET|HEAD /m/{name}` (rules 992, 995-998, 1000)

`src/app/m/[name]/route.ts`. The static segment `m` wins over `[lang]`. The route is public and unauthenticated, because Meta, kie, Higgsfield and Composio fetch it with no credentials. It never reads cookies or the session.

### 2.1 Names and paths

- **Name (rule 992):** `{32 lowercase hex}.jpg` or `.mp4`. That is 128 random bits from `randomBytes(16)`, with no tenant id, task id or date in it.
- **On disk:** `MEDIA_DIR/{first 2 hex}/{name}`, 256 shard folders.
- **Public URL:** `${APP_ORIGIN}/m/{name}`. The shard folder never appears in a URL.

### 2.2 Path traversal is impossible (rule 995)

- `name` must match `^[a-f0-9]{32}\.(jpg|mp4)$` before any filesystem call. No `/`, `..`, `%`, NUL or uppercase can pass, so the joined path can only be a file inside `MEDIA_DIR`.
- A bad name and a missing file get the same bare 404, with no body difference.
- There is no listing: the route serves one named file and nothing else. `MEDIA_DIR` is not under the document root.
- Methods are GET and HEAD only. Next answers 405 to anything else.

### 2.3 Headers (rule 996)

| Header | Value |
|---|---|
| `Content-Type` | From the extension only: `image/jpeg` or `video/mp4`. The bytes were checked when they were written (section 3) |
| `Content-Length` | From `fs.stat`. Meta and Higgsfield read it |
| `Accept-Ranges` | `bytes` |
| `Cache-Control` | `public, max-age=31536000, immutable`. A name never changes content |
| `ETag` | `"{hex}"` |
| `Last-Modified` | mtime |
| `Content-Disposition` | `inline` by default; `attachment; filename="thakeen-{first 8 hex}.{ext}"` with `?download=1`, so the inbox save link keeps working (`Inbox.tsx:89`) |
| Defence in depth | `X-Content-Type-Options: nosniff` (global), plus `Content-Security-Policy: sandbox; default-src 'none'` and `Cross-Origin-Resource-Policy: cross-origin` on this route. A provider could return a polyglot MP4, and it must never run as a page on thakeen.com |

`If-None-Match` is answered with 304.

### 2.4 Range requests (rule 997)

- One range, `bytes=a-b`, `bytes=a-` or `bytes=-n`, gets a 206 with `Content-Range`.
- A range that cannot be satisfied gets a 416 with `Content-Range: bytes */size`.
- Several ranges get a 200 with the full body (RFC 9110 allows ignoring Range).
- The body is `fs.createReadStream(path, { start, end })` through `Readable.toWeb`. It is never read whole into memory.

### 2.5 Limits (rule 998)

- **Rate limit:** `allow(\`mfile:${clientIp(req)}\`, 1200, WINDOW.hour)` from `src/lib/rate.ts`. Past it, `retryLater` answers 429 with `Retry-After`. 1,200 per hour leaves room for a video player's range requests and for Meta's fetchers, which share IPs.
- **Stream cap:** at most 6 full-body streams over 10 MB at once per Node process (an in-memory counter, released on close or abort). Past it the route answers 503 with `Retry-After: 5`. Range requests and images are not counted. A 100 MB clip read slowly holds a socket and a small buffer, not the event loop, but on shared hosting the process count is the scarce resource (1.1).
- **Staging (rule 1000, Q3):** the staging lock (`src/proxy.ts:22`) answers 404 to every path without the access cookie. Providers fetch our image for image-to-video, and they carry no cookie. So staging media works only if the lock lets `/m/` through: a prefix test beside `STAGING_OPEN_PATHS`, still `noindex`. The 128-bit name is the guard, as on live. The recommendation is yes. Otherwise media stays off on staging.

### 2.6 Meta and provider requirements this route meets

- **Instagram:** `image_url` must be a public JPEG, 8 MB at most, 320-1440 px wide, aspect ratio 4:5 to 1.91:1. Meta fetches it with cURL ([content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing)). We serve only `toJpeg` output: JPEG, ≤1440 px wide, well under 8 MB.
- **Reels** (future): `video_url`, MP4 or MOV, 300 MB at most, 3 s to 15 min, moov atom at the front ([IG User Media](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media)). Our cap is 100 MB. We do not re-mux, so the moov position is whatever the provider wrote. Shared hosting has no ffmpeg. This risk is unchanged from Blob and is noted for the Reels work.
- **Facebook:** photo `url` today, video `file_url` later.
- **Kie, Higgsfield, Composio:** they need a public https URL with a correct `Content-Type` and `Content-Length`, which the route gives them.

## 3. Write path (rules 993, 994)

`src/lib/media/blob.ts` becomes `src/lib/media/store.ts` with `copyToStore`. Everything up to the bytes stays as it is:
- the `safeFetch` download with `httpsOnly`;
- `SOURCE_CAP_BYTES`, the running total and the `Content-Length` pre-check;
- `sniff`, `toJpeg`, `budget` and `deadline`;
- the `StoreError` fixed codes.

Only `put` and `del` are replaced. `StoreErrorCode` loses `no_blob` and gains `no_store` and `full`. Unknown codes in old job records read as `store_failed`, as today.

### 3.1 Write order (rule 993)

Index first, file second, so a crash leaves a ghost index entry (which the sweep removes) and never an untracked file on disk.

1. `name = randomBytes(16).hex + ext`.
2. Index: `zadd mfiles:{scope}` and `zadd mfiles:age`, member `${scope}|${taskId}|${name}`, score now, sent together in one `Promise.all`. The scope is the job's own `job.scope` (from `sc(u)` when the job was created). It is never taken from a request.
3. Write `MEDIA_DIR/.tmp/{name}.part` with flag `wx` (fails if the file exists), then `fsync`.
4. `fs.link(tmp, final)`, which fails with `EEXIST` and so can never overwrite, then `unlink(tmp)`. Both are on the same filesystem, so the final name appears whole or not at all.
5. `incrby mfiles:bytes`, `incr mfiles:count`.
6. Return `{ url: ${APP_ORIGIN}/m/{name}, bytes, contentType }`. `isOurMediaUrl(url)` must hold, otherwise it is `no_store`. This is the same check as today's post-`put` host check.

### 3.2 Quota guard (rule 994)

`storeReady()` replaces `blobConfigured()`. It holds when all of these are true:
- `MEDIA_DIR` is set and valid (1.2);
- `APP_ORIGIN` is `https://thakeen.com` or `https://staging.thakeen.com` (the host list in rule 999);
- `mfiles:bytes` is below 95 % of `MEDIA_MAX_BYTES`;
- `mfiles:count` is below 95 % of `MEDIA_MAX_FILES`.

`modelAvailable` and `startMedia` read it, so a full store refuses new kie and Higgsfield renders with 409 `model_unavailable` **before** the owner is charged or a provider is paid. Inside `copyToStore`:
- a second check refuses with `full` when `bytes + SOURCE_CAP_BYTES[kind]` would pass the cap, or when `fs.statfs(MEDIA_DIR)` reports less than 2 GiB free;
- `full` fails the job at once, with no `STORE_TRIES` retries, and the existing refund runs.

At 80 % and at 95 % the cron writes one admin log entry a day (founder console) with no tenant data in it. `statfs` on shared hosting can show the whole server disk rather than our quota, so the Redis counters are the main guard and `statfs` is the backstop.

## 4. Retention and the index (rules 1001-1003)

### 4.1 Keys (all new)

| Key | Contents | Who writes it |
|---|---|---|
| `mfiles:{scope}` | zset of `name`, score createdAt. The per-tenant index, scope from `sc(u)` or `job.scope` | store, deletes |
| `mfiles:age` | zset of `${scope}\|${taskId}\|${name}`, score = when the member is next due. Split on the last two `\|` (scope may contain `\|`, ids never do; same idea as `parseOpenMember`) | store, sweep |
| `mfiles:bytes`, `mfiles:count` | integers | store, deletes |

### 4.2 Retention rule (rule 1001)

A file is deleted once it is **60 days** old, unless its task still needs it. "Still needs it" means the task:
- exists;
- still names this file in `imageUrl` or `videoUrl`;
- and is not finished: a draft, pending approval, approved but not yet published to every chosen target, or scheduled for a future time.

A file that is still needed gets its `mfiles:age` score moved forward 7 days, so the sweep reads it again in a week and not every day. A file replaced by a re-render, or whose task was deleted, is gone at 60 days.

A published task's file is deleted 60 days after creation (Q1). Before posting, the publish code checks `fs.stat` on our own URLs. If the file is gone it refuses with `media_expired` and does not call Meta or Composio (rule 1004). The inbox shows a "file expired" placeholder on a 404 instead of a broken image. No task field is added, so no stored shape changes.

### 4.3 Sweep (rule 1003)

The sweep is a second step of the existing daily `GET /api/cron/media` (`vercel.json`, renamed `crons.json` by #319, `20 5 * * *`, `sameSecret` bearer), after `sweepMedia`, within the same `deadlineFor(300)`:

1. `zrange mfiles:age -inf (now) BYSCORE LIMIT 0 500`: one call.
2. Group by scope. Read the tasks with `pmap(members, m => getTask(scope, taskId), 8)` from `src/lib/parallel.ts`. There is no `await db.*` inside a loop.
3. Split the members into keep, reschedule and delete. For deletes:
   - unlink the files with `pmap` (`ENOENT` counts as done);
   - remove the members in one `zrem` per key, with `Promise.all` across keys;
   - one `decrby` for the bytes and one for the count.
4. Remove `.tmp/*.part` files older than 1 hour (one `readdir`).
5. Report `{ due, kept, deleted, bytesFreed }` in the cron answer. The report carries no scope or name.

### 4.4 Deletions that cannot wait (rule 1002)

The media providers spec left this open (spec section 9): deleting an account or a brand, or a task, now deletes its files.
- **Account or brand deletion:** reads `mfiles:{scope}` (one `zrange`), unlinks the files with `pmap`, then deletes the zset and its `mfiles:age` members.
- **Task deletion:** removes that task's names.

The account-deletion help answer (`src/lib/help.ts`) is corrected at the same time.

## 5. Migration from Vercel Blob (rule 1005, rule 679 expand then contract)

### 5.1 Expand release (first code PR)

- `isOurBlobUrl` becomes **`isOurMediaUrl`** in `media-catalog.ts`, which stays import-free (rule 999). A URL passes if it is https, carries no credentials or query, and is either:
  - **new:** host exactly `thakeen.com` or `staging.thakeen.com` and path exactly `/m/{32 hex}.(jpg|mp4)`; or
  - **old:** host ending in `.public.blob.vercel-storage.com`.

  All 7 call sites switch to it.
- Writes go only to disk, in the new shape. `@vercel/blob` leaves `package.json`. Regenerate the lockfile as CLAUDE.md says. `BLOB_READ_WRITE_TOKEN` leaves the code and `variables.md`.
- The stored shape is unchanged: `task.imageUrl` and `videoUrl` stay full https URL strings.
- **Rollback is safe.** Old code reading a new thakeen.com URL rejects it in `isOurBlobUrl`, so:
  - YouTube refuses with `youtube_needs_video`;
  - no reference image is sent to a provider;
  - the save link has no `?download=1`.

  Instagram and Facebook still publish it, because they use `hasArtwork`, not the Blob test. Nothing breaks open.

### 5.2 Data

- A read-only script `scripts/media-blob-scan.ts` counts task URLs on the Blob host for each store it is pointed at. It scans keys with `SCAN` and reads tasks in batches with `pmap`. It writes nothing and prints counts only, never scopes.
- The founder runs it on live and on staging after the expand release is live.
- **Expected: 0 on live** (no token was ever set).
- Only if a count is above 0: `scripts/media-blob-copy.ts` runs. It is idempotent: for each such URL it calls `copyToStore` with `safeFetch`, then `updateTask` in that task's own stored scope, only if the URL is still the Blob one. A second run finds nothing to do. It runs after the release, never at build time.

### 5.3 Contract release (later PR)

Once the scan shows 0 on both stores, `isOurMediaUrl` drops the Blob host, and the tests that use Blob URLs move to thakeen.com URLs. The PR names the step "contract".

### 5.4 fal (Q2)

Recommendation: once the store is ready, copy fal results too. That removes our dependency on fal's retention, and it lets fal images be reference images. If the copy fails, fal keeps its own URL as today (A25). This changes A25, so it waits for the founder's yes.

### 5.5 Privacy text

`src/lib/legal.ts` and `src/lib/help.ts` still name "Vercel / Vercel Blob". In the expand PR they name Hostinger (our storage) and the client's own Google Drive (optional archive), with the dates bumped. PR #319 deliberately left these sentences for this change.

## 6. Google Drive archive (rules 1006-1008)

### 6.1 What the client gets

- **"Save to my Drive"** on an item in the inbox, for images and clips. The file goes to a folder `Thakeen` in the client's own Drive, named `{yyyy-mm-dd} {channel} {short title}.{ext}`.
- **v1 is manual only.** Auto-save on publish is Q4.

### 6.2 Connection (rule 1006): direct Google OAuth, not Composio

- A new connector `gdrive` in `src/lib/connectors/registry.ts`, built the way `gcal` is (Reem B3):
  - the same `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`;
  - its own redirect `/api/connect/gdrive/callback`;
  - its own consent;
  - scope **`https://www.googleapis.com/auth/drive.file` only**: the app sees only files it created. It is a non-sensitive scope, so it needs no extra Google verification.
  - Tokens are stored and refreshed like every other connection (`src/lib/connectors/oauth.ts`), under `sc(u)`.
- **Why not Composio:**
  - The Composio Google Drive toolkit's managed auth asks for broader Drive scopes. Limiting it to `drive.file` would need our own OAuth app inside a Composio auth config anyway.
  - The upload is one REST call to a fixed Google host. Composio would add a hop and a per-call count for nothing.
  - The direct pattern already exists (`gcal`).
- `GOOGLE_*` is not set on live yet (Reem B2b/B3 note), so the archive stays dormant until it is. The founder also adds `drive.file` to the OAuth consent screen.

### 6.3 Upload

- `POST /api/tasks/{id}/archive` with `{ kind: "image" | "video" }`.
- It authenticates first with `currentUser()`, then loads the task with `getTask(sc(u), id)`. Any role may use it.
- Rate limit: `allow(\`drive:${sc(u)}\`, 60, WINDOW.hour)`.
- The file must be one of ours: `isOurMediaUrl`, and the name is in `mfiles:{sc(u)}`, so one tenant cannot archive another's file even by knowing its name.
- The server reads the file from disk and streams it to `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable`. That is a fixed host, not user-supplied, so plain `fetch`; `safeFetch` is for user-supplied URLs.
- The `Thakeen` folder is created once, and its id is kept on the connection.
- No credits are spent and no model is called.

### 6.4 Failures never touch publishing (rule 1007)

| State | Result |
|---|---|
| Not connected | Button opens the connect flow. Nothing else happens |
| Token revoked or expired, refresh fails | `drive_reconnect`. The connection is marked broken, as for other connectors |
| Drive full (403 `storageQuotaExceeded`) | `drive_full` |
| Google rate limit or 5xx | `drive_busy`. The owner may try again. No automatic retry loop |
| Our file already expired | `media_expired` |

Each code has one message in Arabic and English. The publish path never reads, waits for or retries Drive. An archive failure is a note on the item, never a publish error.

### 6.5 Drive is never a publish source (rule 1008)

`isOurMediaUrl` refuses every Google host, so a Drive link can never become `imageUrl`, `videoUrl`, a reference image or a Composio staged file. The reasons:
- A share link (`drive.google.com/uc?export=download&id=…`) answers with an HTML page: a sign-in page, or the "can't scan for viruses" warning for larger files. Meta needs the media bytes with an image or video `Content-Type`. The publish fails or, worse, posts nothing useful.
- Google Workspace admins can forbid "anyone with the link" sharing. A client's Drive may simply be unable to make a file public.
- The client can move, unshare or delete the file between scheduling and publishing, and we would learn only when Meta fails.
- Popular files hit Google's download quota ("too many users have viewed or downloaded").
- Making a client's file public to the internet, so that Meta could fetch it, would be a privacy step we take on their behalf. `drive.file` lets us create files, not run a public file host.

## 7. Variables, permissions, flows, tests

### 7.1 Variables (`docs/system/variables.md`)

| Name | What | Secret | Default / when unset |
|---|---|---|---|
| `MEDIA_DIR` | Absolute folder for our copies (1.2), one per Hostinger app | No | Unset: store off. kie and Higgsfield models are not offered; fal hot-links (today's live behaviour) |
| `MEDIA_MAX_BYTES` | Store cap in bytes | No | 21474836480 (20 GiB) |
| `MEDIA_MAX_FILES` | Store cap in files (inodes) | No | 100000 |
| `BLOB_READ_WRITE_TOKEN` | **Removed** in the expand release | — | — |

`APP_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `CRON_SECRET` are reused. The distinct-name count goes up by 2 net (3 new, 1 removed).

### 7.2 Permission rows (`docs/system/permissions.md`)

| Section | Method | Path | Actor | Check |
|---|---|---|---|---|
| new 1.11 Public media | GET, HEAD | `/m/{name}` | Public (P) | name regex before fs; same 404 for bad and missing; `allow` per IP 1200/h; stream cap 503; never reads cookies. On staging, passes the lock only if Q3 = yes |
| 1.3 | POST | `/api/tasks/{id}/archive` | O, any role | `currentUser`; task under `sc(u)`; file in `mfiles:{sc(u)}`; `allow` per scope 60/h; fixed Google host |
| 1.4 | GET | `/api/connect/gdrive`, `/api/connect/gdrive/callback` | O | as the `gcal` rows: state bound to the login, scope `drive.file` only |
| 1.7 (changed) | GET | `/api/admin/media` | F | `probeStore` replaces `probeBlob`: write, fetch our own `APP_ORIGIN/m/…` over https, delete; sentinel and usage figures. No tenant data |
| 1.8 (changed) | GET | `/api/cron/media` | C | adds the file sweep (4.3) after `sweepMedia` |
| 3.2 | — | — | — | `/m/{name}` accepts a locator from the request: the name. It is not a tenant locator, carries no scope, and serves only files we wrote |

### 7.3 Flows (`docs/system/flows.md`, next free section at merge, today 62)

"Media storage on Hostinger disk and the Drive archive". It covers four flows:
- **render, copy and serve:** provider result, `copyToStore`, `/m/{name}`, then Meta, a provider or Composio fetches it;
- **retention sweep:** 4.3;
- **deletion with an account, brand or task:** 4.4;
- **save to Drive:** connect, archive, and the failure codes.

`architecture.md` rows change in the same commit: `media/blob.ts` becomes `media/store.ts`, and the "Vercel Blob" external service becomes "Hostinger disk (`MEDIA_DIR`)" plus "Google Drive (client's, optional)". The trust boundaries add Google upload.

### 7.4 Rules and tests (coverage file `docs/system/tests/0991-media-storage.md` comes with the first code PR)

| Rule | What | Test |
|---|---|---|
| 991 | Store at `MEDIA_DIR`: absolute, outside `cwd`, created 0700; unset or bad leaves the store off | `tests/media-store.test.ts` |
| 992 | Name = 32 hex + `.jpg`/`.mp4`, sharded, no tenant id; URL = `APP_ORIGIN/m/{name}` | `media-store.test.ts` |
| 993 | Index before file; `.part` with `wx` and `fsync`; `link` never overwrites; crash leaves only a ghost index entry | `media-store.test.ts` (fault injection with a temp dir) |
| 994 | Quota guard: `storeReady` at 95 % refuses before charge; `full` fails at once and refunds; `statfs` backstop; alerts at 80/95 % | `media-store.test.ts`, `media-jobs.test.ts` |
| 995 | `/m/{name}` regex before fs; traversal and encoded names 404; same 404 for missing; GET/HEAD only | `tests/media-file-route.test.ts` |
| 996 | Headers: type from extension, length, immutable cache, ETag/304, `download=1` attachment, CSP sandbox, CORP | `media-file-route.test.ts` |
| 997 | Range: single 206, unsatisfiable 416, multi 200 full; streamed, never buffered | `media-file-route.test.ts` |
| 998 | Rate limit per IP 1200/h with `Retry-After`; at most 6 big full streams per process, else 503 | `media-file-route.test.ts` |
| 999 | `isOurMediaUrl`: exact hosts and path, https, no credentials or query; the old Blob host during expand; all 7 call sites | `tests/media-catalog.test.ts` (look-alike hosts, `thakeen.com.evil`, `/m/../x`, uppercase hex, query) |
| 1000 | Staging lock lets `/m/` pass, still `noindex` (if Q3 = yes) | `tests/staging-access.test.ts` |
| 1001 | Retention 60 days; kept while an unfinished or scheduled task names the file; 7-day re-check | `tests/media-retention.test.ts` |
| 1002 | Account, brand and task deletion remove their files and index | `media-retention.test.ts`, existing deletion tests |
| 1003 | Sweep: one `zrange`, `pmap` reads, batched `zrem`/`decrby`, deadline-bound, `.tmp` cleanup, report without ids | `media-retention.test.ts` (counts db calls) |
| 1004 | Publish refuses `media_expired` before calling Meta or Composio | `tests/meta-publish.test.ts`, `composio-drafts.test.ts` |
| 1005 | Expand: `@vercel/blob` gone, no `BLOB_READ_WRITE_TOKEN`; scan read-only; copy script idempotent | `tests/media-migration.test.ts`, `tests/retire-vercel.test.ts` |
| 1006 | `gdrive` connector: `drive.file` only, own redirect, tokens under `sc(u)` | `tests/drive-archive.test.ts` |
| 1007 | Archive route: auth first, file must be in `mfiles:{sc(u)}`, rate limit, fixed codes; publish never touches Drive | `drive-archive.test.ts` |
| 1008 | No Google host passes `isOurMediaUrl` | `media-catalog.test.ts` |
| 1009 | `probeStore`: write, serve, delete, sentinel, usage; never throws, no tenant data | `tests/media-admin.test.ts` |
| 1010 | Privacy policy and help name Hostinger and the client's Drive, not Vercel Blob | `tests/legal.test.ts` (or the existing pin) |

`tests/media-blob.test.ts` becomes `media-store.test.ts`, keeping every download, cap, sniff, JPEG and deadline case. The Blob URLs in about 15 test files move to `https://thakeen.com/m/{hex}`, plus one kept Blob case per call site until the contract release.

### 7.5 Delivery

| PR | Contents | Rules |
|---|---|---|
| 1 (expand release) | Disk store, route, quota, retention, deletion, probe, Blob removal, privacy text | 991-1005, 1009, 1010 |
| 2 | Drive archive | 1006-1008 |
| 3 (contract release) | Drop the Blob host | none new, amends 999 and 1005 |

Each is a draft PR and goes live only through a founder-merged release PR. Media on live stays off until the founder sets `MEDIA_DIR`, the provider keys and `MEDIA_MODELS_ON`, and the console probe passes.

## 8. Open questions for the founder

1. **Published media:** delete 60 days after creation (recommended; the client keeps a copy in Drive), or keep files of published posts forever (about +6 GB a month at 100 clients)?
2. **fal images:** copy them to our disk too (recommended), or keep hot-linking fal as today?
3. **Staging:** let `/m/` through the staging lock so providers and Meta can fetch staging media (recommended), or keep media off on staging?
4. **Drive:** v1 manual "save to my Drive" only (recommended), or also an automatic save on every publish?
5. **Drive auth:** direct Google OAuth with the existing Google client and `drive.file` (recommended), which needs `GOOGLE_*` set on live and `drive.file` added to the consent screen. Or Composio?
6. **Hostinger, please confirm in hPanel:**
   - disk quota and inodes, and current usage of each;
   - that the daily backup lists `domains/thakeen.com/media`;
   - bandwidth and Node process limits;
   - that the crons still answer 200 (the `.thakeen-cron` evidence);
   - that `BLOB_READ_WRITE_TOKEN` is absent on live and on staging.
