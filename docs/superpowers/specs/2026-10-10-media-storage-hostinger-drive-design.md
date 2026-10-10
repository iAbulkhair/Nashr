# Media storage on Hostinger disk, with Google Drive as the client's archive — design

Status: design only, no code. Written 2026-10-10 on branch `claude/media-storage-spec-41fe7e` from main `3bf67673`, revised the same day with the founder's answers (section D). The founder approves before any plan or code. Rules **991-1015** are reserved for this work. They come after PR #319's 987-990, and they do not collide with #316 (930-959) or #317 (960-969, 974-977). Check `git ls-tree origin/main docs/system/tests/` and the titles of open PRs again before the first code PR.

Founder decision (2026-10-10): our own copies live on Hostinger's disk and are served from thakeen.com. Google Drive is the **client's** optional permanent archive. Meta never publishes from Drive.

Convention: this spec PR adds no `docs/system/tests/NNNN-*.md`. That file comes with the first code PR, as with 0870 (admin shell spec #303 and code #304).

## D. Decisions (founder, 2026-10-10)

| # | Question | Decision | Where |
|---|---|---|---|
| 1 | Retention | **30 days for every file**, published posts included. Owners are warned before deletion, in the app and by email, at day 23 and day 29, but only when Drive auto-archive is not connected or failed for that file. The warning lists the files with download links. A file named by a pending, approved or scheduled post is not deleted until that post is published or cancelled; after that the 30 days still count from creation, with at least 7 days' notice | 4.2-4.4 |
| 2 | fal images | **Not copied** to our disk. The client saves the full-size file from the provider link; we keep only a medium-size thumbnail for preview and history. The link is checked when the post is scheduled and again when it is published, and a dead link is refused with a clear message | 5.4 |
| 3 | Staging | **`/m/` passes the staging lock.** Staging must test the real fetch path; names are 128 random bits; the route is read-only and rate-limited; staging has no customers. Staging has its own media folder | 2.5 |
| 4 | Drive | **Auto-save every generated file** to the client's Drive when Drive is connected. The manual button stays as the retry for a failed save. An archive failure never blocks publishing | 6.1, 6.4 |
| 5 | Drive auth | **Both, in this order:** Composio Google Drive first (it works now through Composio's verified app), then direct Google OAuth with `drive.file` once Google verifies our consent screen. One archive interface, two connectors behind it; the client uses whichever is connected | 6.2 |
| 6 | hPanel facts | **Postponed** by the founder. They stay "founder to confirm" and are listed in the pre-build checklist | 1.1, 9 |

## 0. Why we keep our own copy, and what exists today

- kie.ai and Higgsfield delete results after 1 to 14 days. Instagram and Facebook fetch a post's image by URL when it is published, which can be days later. So a post must point at a file we keep (media providers spec 4.6). Cost is not the issue: about 6 GB for 100 clients (estimate in 1.3).
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
- **Live has no Blob.** `BLOB_READ_WRITE_TOKEN` is not among the 11 Hostinger variables (`docs/PRD-Thakeen.md:210`), so live has no Blob copies and kie/Higgsfield are off. fal images on live are hot-linked. Whether the token is absent on staging too is in the checklist (section 9).
- Publishing video today goes only to YouTube, staged through Composio (`via-composio.ts:154`). Direct Meta publishes images only (`meta.ts:101` `url`, `:111` `image_url`). Reels and Facebook video (`video_url` / `file_url`) do not exist yet, but this store is built so they can use it.
- Building blocks reused below: `sendOnce(email, key, …)` in `src/lib/notify.ts` (one email per key, idempotent, `mailReady()`), rule 755 (scheduled work waits for a verified owner), and `composioStageFile` plus the pinned toolkit table in `src/lib/connectors/composio-catalog.ts`.

## 1. Disk facts (Hostinger Business, account `u472843410`)

Read through the Hostinger API connector on 2026-10-10 (read-only calls only):
- Order 1009870060, plan `hostinger_business_v5`, active. Three sites share it: `maslakiyat.com` (main, WordPress), `thakeen.com` (addon, Node.js) and `staging.thakeen.com` (addon, detected type "other").
- The 9 account crons are all still configured and every one reads `-H @/home/u472843410/domains/thakeen.com/.thakeen-cron`.
- `thakeen.com` has 25 Node builds, all from `production`. The last 5 completed between 2026-10-09 10:55 and 2026-10-10 16:59 UTC, all after the header file was created (2026-10-08 13:58 UTC).
- The API cannot show disk or inode usage, backups, or anything outside `public_html` for this plan. The disk metrics endpoints exist only for Agency plans and answer 404 here; the file listing is rooted at `public_html` (it holds only `.htaccess`) and refuses `..`.

So the quota, usage and backup numbers below are still **published** or **founder to confirm** in hPanel. The founder postponed these checks (D6); they are the pre-build checklist in section 9.

### 1.1 Facts

| Fact | Value | Source |
|---|---|---|
| Disk quota | 50 GB on the current "Web Business" table. An older version of the same page listed 200 GB | [Hostinger plan limits](https://www.hostinger.com/support/6976044-parameters-and-limits-for-hosting-plans), **founder to confirm** in hPanel > Resources Usage |
| Inode limit | 600,000. At the limit no file can be created, whatever disk space is free | same page and [inode limit article](https://www.hostinger.com/support/1583210-what-is-the-inode-limit-and-what-happens-when-it-is-reached/) |
| Current usage | Unknown. The quota and inodes are shared by thakeen.com (live), staging.thakeen.com and the WordPress site maslakiyat.com. Each Next.js app's `node_modules` and `.next` hold tens of thousands of files | **founder to confirm** (disk GB and inodes used) |
| Bandwidth | Not checked | **founder to confirm** |
| Node process limits (workers, entry processes, memory) | Not checked | **founder to confirm** |
| Where a Next.js build goes | `/home/{user}/domains/{domain}/nodejs`. `public_html` holds only the generated `.htaccess`, which every redeploy regenerates | [Hostinger deploy guide](https://www.hostinger.com/support/how-to-deploy-apps-built-with-codex-on-hostinger/), [redeploy](https://www.hostinger.com/support/how-to-redeploy-a-node-js-application/) |
| Do files survive a build? | Hostinger documents no folder that survives a redeploy. Evidence that siblings of `nodejs/` and `public_html/` survive: the cron header file `/home/u472843410/domains/thakeen.com/.thakeen-cron` was created 2026-10-08, and the crons kept answering 200 after the #309 and #312 release builds | The API confirms the 9 crons still point at that file after 25 builds, but it shows no cron run results. **Founder to confirm** that the crons still answer 200; the console sentinel in 1.2 then proves it on every build |
| Daily backup includes the store? | Not checked | **founder to confirm**: hPanel > Files > Backups, a file backup lists `domains/thakeen.com/media` |

### 1.2 Store location (rule 991)

- **Live:** `/home/u472843410/domains/thakeen.com/media`
- **Staging:** `/home/u472843410/domains/staging.thakeen.com/media` (its own folder, D3)

Each is set as `MEDIA_DIR` on its own Hostinger app. The folder is outside `public_html` and outside `nodejs`, so no build writes there and the web server never serves it directly. Only the route in section 2 serves it.

- The app creates `MEDIA_DIR` (mode 0700) on first use and refuses a path that is not absolute or that lies inside `process.cwd()`. Writing into the build would be wiped by the next deploy.
- **Sentinel:** the console probe (rule 1013) writes `MEDIA_DIR/.sentinel` with the build commit the first time it runs. Each later probe reports "the store survived N builds" or "the store was wiped". This replaces Hostinger's missing documentation with evidence.
- Whether the Node process may write there is proven by the same probe (write, serve over https, delete), not assumed.

### 1.3 Size estimate

Per client per month: about 4 clips at 5-15 MB plus the kie and Higgsfield images at ~0.4 MB each. fal images are no longer copied (D2), only ~40 KB thumbnails. So ~50-60 MB a client a month, and with 30-day retention the store holds one month: **~6 GB at 100 clients**, about 10,000 files, a negligible share of 600,000 inodes. Files held for unpublished posts (4.2) add little. Defaults: `MEDIA_MAX_BYTES` 20 GiB, `MEDIA_MAX_FILES` 100,000.

## 2. Serving route `GET|HEAD /m/{name}` (rules 992, 995-998, 1000)

`src/app/m/[name]/route.ts`. The static segment `m` wins over `[lang]`. The route is public and unauthenticated, because Meta, kie, Higgsfield and Composio fetch it with no credentials. It never reads cookies or the session.

### 2.1 Names and paths

- **Name (rule 992):** `{32 lowercase hex}.jpg` or `.mp4`. That is 128 random bits from `randomBytes(16)`, with no tenant id, task id or date in it. Thumbnails (5.4) are ordinary `.jpg` names.
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
| `Cache-Control` | `public, max-age=2592000, immutable` (30 days, the retention period). A name never changes content, and a cache never outlives the file by more than that |
| `ETag` | `"{hex}"` |
| `Last-Modified` | mtime |
| `Content-Disposition` | `inline` by default; `attachment; filename="thakeen-{first 8 hex}.{ext}"` with `?download=1`, so the inbox save link and the warning's download links work (`Inbox.tsx:89`, 4.3) |
| Defence in depth | `X-Content-Type-Options: nosniff` (global), plus `Content-Security-Policy: sandbox; default-src 'none'` and `Cross-Origin-Resource-Policy: cross-origin` on this route. A provider could return a polyglot MP4, and it must never run as a page on thakeen.com |

`If-None-Match` is answered with 304.

### 2.4 Range requests (rule 997)

- One range, `bytes=a-b`, `bytes=a-` or `bytes=-n`, gets a 206 with `Content-Range`.
- A range that cannot be satisfied gets a 416 with `Content-Range: bytes */size`.
- Several ranges get a 200 with the full body (RFC 9110 allows ignoring Range).
- The body is `fs.createReadStream(path, { start, end })` through `Readable.toWeb`. It is never read whole into memory.

### 2.5 Limits and staging (rules 998, 1000)

- **Rate limit:** `allow(\`mfile:${clientIp(req)}\`, 1200, WINDOW.hour)` from `src/lib/rate.ts`. Past it, `retryLater` answers 429 with `Retry-After`. 1,200 per hour leaves room for a video player's range requests and for Meta's fetchers, which share IPs.
- **Stream cap:** at most 6 full-body streams over 10 MB at once per Node process (an in-memory counter, released on close or abort). Past it the route answers 503 with `Retry-After: 5`. Range requests and images are not counted. A 100 MB clip read slowly holds a socket and a small buffer, not the event loop, but on shared hosting the process count is the scarce resource (1.1).
- **Staging (rule 1000, decided D3):** the staging lock (`src/proxy.ts:22`) answers 404 to every path without the access cookie, and providers, Meta and Composio carry no cookie. So the lock lets `/m/` through: a prefix test for `/m/` beside `STAGING_OPEN_PATHS`, with `X-Robots-Tag: noindex` kept. Only `/m/` opens; every other staging path stays locked. Why this is safe:
  - staging must test the real fetch path that live uses;
  - names are 128 random bits, so a file cannot be found by guessing;
  - the route is read-only and rate-limited;
  - staging has no customers, and it reads its own `MEDIA_DIR` (1.2).

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

Only `put` and `del` are replaced. `StoreErrorCode` loses `no_blob` and gains `no_store` and `full`. Unknown codes in old job records read as `store_failed`, as today. A second entry point, `thumbToStore(sourceUrl, deadline)`, runs the same download and sniff and writes a ~480 px wide JPEG (5.4).

### 3.1 Write order (rule 993)

Index first, file second, so a crash leaves a ghost index entry (which the sweep removes) and never an untracked file on disk.

1. `name = randomBytes(16).hex + ext`.
2. Index (4.1): `hset mfiles:{scope} name entry` and `zadd mfiles:due` (member `${scope}|${name}`, score = first warning time, 4.2), sent together in one `Promise.all`. The scope is the job's own `job.scope` (from `sc(u)` when the job was created). It is never taken from a request.
3. Write `MEDIA_DIR/.tmp/{name}.part` with flag `wx` (fails if the file exists), then `fsync`.
4. `fs.link(tmp, final)`, which fails with `EEXIST` and so can never overwrite, then `unlink(tmp)`. Both are on the same filesystem, so the final name appears whole or not at all.
5. `incrby mfiles:bytes`, `incr mfiles:count`.
6. Return `{ url: ${APP_ORIGIN}/m/{name}, bytes, contentType }`. `isOurMediaUrl(url)` must hold, otherwise it is `no_store`. This is the same check as today's post-`put` host check.
7. If the scope has a Drive connection, enqueue the auto-save (6.4). The enqueue never waits on Drive.

### 3.2 Quota guard (rule 994)

`storeReady()` replaces `blobConfigured()`. It holds when all of these are true:
- `MEDIA_DIR` is set and valid (1.2);
- `APP_ORIGIN` is `https://thakeen.com` or `https://staging.thakeen.com` (the host list in rule 999);
- `mfiles:bytes` is below 95 % of `MEDIA_MAX_BYTES`;
- `mfiles:count` is below 95 % of `MEDIA_MAX_FILES`.

`modelAvailable` and `startMedia` read it, so a full store refuses new kie and Higgsfield renders with 409 `model_unavailable` **before** the owner is charged or a provider is paid. Inside `copyToStore`:
- a second check refuses with `full` when `bytes + SOURCE_CAP_BYTES[kind]` would pass the cap, or when `fs.statfs(MEDIA_DIR)` reports less than 2 GiB free;
- `full` fails the job at once, with no `STORE_TRIES` retries, and the existing refund runs.

A fal render does not depend on `storeReady()`: its result stays on fal's link (5.4). If the thumbnail cannot be written, the item simply has no thumbnail.

At 80 % and at 95 % the cron writes one admin log entry a day (founder console) with no tenant data in it. `statfs` on shared hosting can show the whole server disk rather than our quota, so the Redis counters are the main guard and `statfs` is the backstop.

## 4. Retention, warnings and the index (rules 1001-1005)

### 4.1 Keys (all new)

| Key | Contents | Who writes it |
|---|---|---|
| `mfiles:{scope}` | hash: `name` to JSON `{ taskId, kind: "image"\|"video"\|"thumb", bytes, at, del?, w1?, w2?, drive? }`. `at` = created; `del` = deletion time once known; `w1`/`w2` = when each warning was issued; `drive` = `"queued"`, `"ok"` or `"failed"`. The per-tenant index, scope from `sc(u)` or `job.scope` | store, release, sweep, archive |
| `mfiles:due` | zset of `${scope}\|${name}`, score = the time of the entry's next action (a warning, a deletion or a hold re-check). Split on the last `\|` (scope may contain `\|`, names never do; same idea as `parseOpenMember`) | store, release, sweep |
| `mfiles:bytes`, `mfiles:count` | integers | store, deletes |
| `drive:q` | zset of `${scope}\|${name}`, score = next try time (6.4) | store, archive, sweep |

The hash replaces the plan's earlier per-tenant zset: the warnings and the archive state need a record per file. Every key is new, so no stored shape changes.

### 4.2 Retention rule (rule 1001, D1)

Every file, published or not, is deleted **30 days after creation** (`del = at + 30 d`), with two exceptions.

- **Held:** a file is held while its task exists, still names the file (`imageUrl`, `videoUrl` or `imageThumbUrl`), and is pending, approved, or scheduled and not yet published to every chosen target. A held file has no `del`, gets no warning and is never deleted. Its `mfiles:due` score is set 7 days ahead, so the sweep re-reads it weekly as a safety net.
- **Released:** when a held post is published to its targets, rejected, cancelled (schedule removed and not approved) or deleted, the code that changed the task calls `releaseMedia(scope, task)`. It sets `del = max(at + 30 d, now + 7 d)`, so the 30 days still count from creation but the owner always gets at least 7 days' notice. The sweep's weekly re-check calls the same function if a release was missed.

A file that is no longer named by its task (replaced by a re-render, or the task is gone) is not held. It follows the 30-day rule.

Warning times follow from `del`: `w1` is due at `del − 7 d` (day 23 normally) and `w2` at `del − 1 d` (day 29). After a late release they can be due at once.

### 4.3 Warnings (rule 1002, D1)

Who and what:
- A file needs a warning only if it is ours in full size (`kind` image or video) and `drive` is not `"ok"`: Drive is not connected, or the auto-save failed. A file already saved to the client's Drive is deleted on day 30 with no warning.
- Thumbnails of fal images (`kind` thumb) are not warned about. The client was told when the image was made to save the full size from the provider (5.4). Q2 below asks whether thumbnails should live longer.

How:
- **In the app:** a banner on the inbox while any file of the scope has a warning issued and is not yet deleted. It opens a list page computed from `mfiles:{scope}` (one `hgetall`) showing each file's thumbnail, the post title, the channel, the deletion date, and a download link `/m/{name}?download=1`. No new notice store is added.
- **By email:** one message per owner per day, through `sendOnce(email, \`mexp:${scope}:${yyyy-mm-dd}\`, …)`, listing the files due that day. At most 20 rows, then "and N more" with a link to the in-app list. Only to a verified owner (rule 755) and only when `mailReady()`. Each row links to `/m/{name}?download=1`. The email carries no other tenant's data and no file contents.
- `w1`/`w2` are written when the warning is issued, whether or not the email could be sent (the in-app banner always shows it).

The guarantee: the sweep never deletes a file that needs a warning unless its `w1` was issued at least 7 days earlier. If the first warning was late (a cron outage), `del` moves to `w1 + 7 d`.

### 4.4 Sweep (rule 1003)

The sweep is a second step of the existing daily `GET /api/cron/media` (`vercel.json`, renamed `crons.json` by #319, `20 5 * * *`, `sameSecret` bearer), after `sweepMedia`, within the same `deadlineFor(300)`:

1. `zrange mfiles:due -inf (now) BYSCORE LIMIT 0 500`: one call.
2. Group by scope. Read the index entries with one `hmget` per scope and the tasks with `pmap(entries, e => getTask(scope, e.taskId), 8)` from `src/lib/parallel.ts`. There is no `await db.*` inside a loop.
3. Decide for each entry: hold (reschedule +7 d), release (set `del`), warn (`w1` or `w2`), or delete. Group the warnings by scope and send them (4.3). For deletes:
   - unlink the files with `pmap` (`ENOENT` counts as done);
   - remove the entries in one `hdel` per scope and one `zrem` on `mfiles:due` and `drive:q`, with `Promise.all` across keys;
   - one `decrby` for the bytes and one for the count.
4. Retry the Drive queue (6.4).
5. Remove `.tmp/*.part` files older than 1 hour (one `readdir`).
6. Report `{ due, held, warned, deleted, bytesFreed, archived }` in the cron answer. The report carries no scope or name.

### 4.5 Deletions that cannot wait (rule 1004)

The media providers spec left this open (spec section 9): deleting an account or a brand, or a task, now deletes its files.
- **Account or brand deletion:** reads `mfiles:{scope}` (one `hgetall`), unlinks the files with `pmap`, then deletes the hash and its `mfiles:due` and `drive:q` members.
- **Task deletion:** removes that task's files the same way. Nothing is deleted from the client's Drive: the archive is theirs.

The account-deletion help answer (`src/lib/help.ts`) is corrected at the same time.

### 4.6 Expired file at publish time (rule 1005)

Before posting, every publish path checks `fs.stat` on our own URLs. If the file is gone it refuses with `media_expired` and calls neither Meta nor Composio. The inbox shows a "file expired" placeholder on a 404 instead of a broken image. With holds (4.2) this should only happen to a post re-used after its files were released.

## 5. Migration from Vercel Blob, fal, privacy (rules 1006-1008, 1014; rule 679 expand then contract)

### 5.1 Expand release (first code PR, rule 1008)

- `isOurBlobUrl` becomes **`isOurMediaUrl`** in `media-catalog.ts`, which stays import-free (rule 999). A URL passes if it is https, carries no credentials or query, and is either:
  - **new:** host exactly `thakeen.com` or `staging.thakeen.com` and path exactly `/m/{32 hex}.(jpg|mp4)`; or
  - **old:** host ending in `.public.blob.vercel-storage.com`.

  All 7 call sites switch to it.
- Writes go only to disk, in the new shape. `@vercel/blob` leaves `package.json`. Regenerate the lockfile as CLAUDE.md says. `BLOB_READ_WRITE_TOKEN` leaves the code and `variables.md`.
- The stored shape of `task.imageUrl` and `videoUrl` is unchanged: full https URL strings. The only new task field is the optional `imageThumbUrl` (5.4).
- **Rollback is safe.** Old code reading a new thakeen.com URL rejects it in `isOurBlobUrl`, so:
  - YouTube refuses with `youtube_needs_video`;
  - no reference image is sent to a provider;
  - the save link has no `?download=1`.

  Instagram and Facebook still publish it, because they use `hasArtwork`, not the Blob test. Old code ignores `imageThumbUrl`. Nothing breaks open.

### 5.2 Data

- A read-only script `scripts/media-blob-scan.ts` counts task URLs on the Blob host for each store it is pointed at. It scans keys with `SCAN` and reads tasks in batches with `pmap`. It writes nothing and prints counts only, never scopes.
- The founder runs it on live and on staging after the expand release is live.
- **Expected: 0 on live** (no token was ever set).
- Only if a count is above 0: `scripts/media-blob-copy.ts` runs. It is idempotent: for each such URL it calls `copyToStore` with `safeFetch`, then `updateTask` in that task's own stored scope, only if the URL is still the Blob one. A second run finds nothing to do. It runs after the release, never at build time.

### 5.3 Contract release (later PR)

Once the scan shows 0 on both stores, `isOurMediaUrl` drops the Blob host, and the tests that use Blob URLs move to thakeen.com URLs. The PR names the step "contract".

### 5.4 fal images: link plus thumbnail (rules 1006, 1007, D2)

**What changes (rule 1006).** fal results are not copied. `task.imageUrl` stays fal's own URL, as today (A25), and it stays the publish source. In addition, when the job finishes, `thumbToStore` writes a ~480 px wide JPEG (~40 KB) to our store and sets the new optional field `task.imageThumbUrl`. The inbox, history and warnings show the thumbnail. The item says, in Arabic and English, that the full-size image stays on the provider's link for a limited time and offers "Save full size" (opens fal's URL). fal images are not reference images: `isOurMediaUrl` refuses fal's hosts and the thumbnail is too small, the same as today. Stored shape (rule 679): `imageThumbUrl` is new and optional; old code ignores it, new code treats it as absent when missing. No conversion script is needed.

**The risk.** fal does not publish how long its result links live (unverified; the first plan task measures it). If the link dies before a scheduled post is published, that post cannot be published: Meta fetches nothing.

**Safe behaviour (rule 1007).**
- **At schedule time:** setting `scheduledFor` (`PATCH /api/tasks/{id}`) or approving a scheduled post checks the link with `safeFetch` (`httpsOnly`, a `GET` with `Range: bytes=0-0` and a 10 s timeout; 200 or 206 and an `image/*` `Content-Type` = alive).
- **At publish time:** every publish path checks it again before calling Meta or Composio.
- **Dead link:** refused with `media_link_expired` and one clear message: "The provider's link to this image has expired, so it cannot be published. Generate the image again or upload your own." Nothing is sent to Meta and no credit moves. The check reads only the task's stored `imageUrl` with `imageProvider` `"fal"`, never a URL from the request.
- If the client's Drive holds the archived copy, the message says so, but Drive is still never a publish source (rule 1012).

Q1 below asks whether kie and Higgsfield should also move to links plus thumbnails.

### 5.5 Privacy text (rule 1014)

`src/lib/legal.ts` and `src/lib/help.ts` still name "Vercel / Vercel Blob". In the expand PR they name Hostinger (our storage, 30 days), the image provider's link for fal images, and the client's own Google Drive (optional archive, through Composio or Google), with the dates bumped. PR #319 deliberately left these sentences for this change.

## 6. Google Drive archive (rules 1009-1012)

### 6.1 What the client gets (D4)

- **Auto-save:** when Drive is connected, every generated file is saved to a folder `Thakeen` in the client's own Drive, named `{yyyy-mm-dd} {channel} {short title}.{ext}`. For kie and Higgsfield the file is our copy; for fal it is the full-size image read from fal's link while it is still alive.
- **Retry button:** "Save to my Drive" on an item whose save failed (`drive: "failed"`), or that was made before Drive was connected. It runs the same save once.
- **Never blocks publishing:** the publish path never reads, waits for or retries Drive.

### 6.2 One archive interface, two connectors (D5)

`src/lib/archive/index.ts` exposes one function, `saveToArchive(scope, file)`, and picks the connector:

1. direct `gdrive`, if connected and healthy;
2. else Composio `googledrive`, if connected and healthy;
3. else none: nothing is queued and the warnings (4.3) apply.

Each connector implements the same `ArchiveConnector { ensureFolder(scope), upload(scope, file) }` and maps its errors to the fixed codes in 6.5. The client sees one "Google Drive" card; which connector backs it is a detail of how they connected.

**Composio Google Drive first (rule 1010).**
- A new toolkit `googledrive` in `src/lib/connectors/composio-catalog.ts`: `authEnv: "COMPOSIO_AUTH_GOOGLEDRIVE"`, a pinned toolkit version, `read: {}`, and `write` limited to the folder-create and file-upload tools (expected `GOOGLEDRIVE_CREATE_FOLDER` and `GOOGLEDRIVE_UPLOAD_FILE`; unverified at a pin until the first plan task checks them, as in the social-results work). No list, search, download, share or delete tool is allowed.
- The file reaches Composio through `composioStageFile`. Today it accepts only `isOurBlobUrl`. It changes to accept `isOurMediaUrl`, and, **for the `googledrive` upload tool only**, the task's own stored fal `imageUrl` (`imageProvider === "fal"`, read from the task under `sc(u)` or `job.scope`, never from a request).
- Composio's managed auth uses Composio's verified Google app. Its consent screen asks the client for broader Drive access than `drive.file` (to be read off the Composio auth config). Our code still calls only the two allowed tools. Each call counts against the Composio usage as every Composio call does (`count(scope)`).
- This is a write into the client's own Drive, by the client's setting. The founder's rule that Composio is read-only applies to ads and site data (composio connectors 2026-10-05), not to this archive.

**Direct Google OAuth second (rule 1011).**
- A new connector `gdrive` in `src/lib/connectors/registry.ts`, built the way `gcal` is (Reem B3): the same `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, its own redirect `/api/connect/gdrive/callback`, its own consent, and scope **`https://www.googleapis.com/auth/drive.file` only**, so the app sees only files it created. Tokens are stored and refreshed like every other connection (`src/lib/connectors/oauth.ts`), under `sc(u)`.
- `drive.file` is a non-sensitive scope: Google needs brand verification of the consent screen, not a security assessment. The connector stays hidden until the founder confirms the verification and `GOOGLE_*` is set on live (Reem B2b/B3 note).
- The upload streams the file to `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable`. That is a fixed host, so plain `fetch`; our file is read from disk, and fal's link is read through `safeFetch`.
- When both connectors are connected, direct wins. A client who started on Composio may switch by connecting direct; the folder id is kept per connector.

### 6.3 Folder

The `Thakeen` folder is created once per connector and its id is kept on that connection. If the client deletes or moves it, the next upload gets "not found", creates a new folder once and retries that one upload.

### 6.4 Auto-save queue (rule 1009)

- **Enqueue:** right after `copyToStore` (kie, Higgsfield) or `thumbToStore` (fal) succeeds, if the scope has a Drive connection: `zadd drive:q` (member `${scope}|${name}`, score now) and `drive: "queued"` on the index entry. For fal the entry is the thumbnail's, and the upload reads the full-size image from the task's `imageUrl`.
- **Drain:** first through `after()` at the end of the request or callback that finished the job, then in the daily media cron (4.4 step 4). Each drain takes a bounded batch with `pmap` (concurrency 3).
- **Tries:** at most 3. Success sets `drive: "ok"` and removes the member. After the third failure: `drive: "failed"`, the member is removed, the retry button shows, and the warnings apply (4.3). `drive_reconnect` stops the tries at once (a retry cannot fix a revoked token).
- **Credits:** none are spent and no model is called.
- An archive failure is a note on the item, never a publish error.

### 6.5 Manual retry route and failure codes

- `POST /api/tasks/{id}/archive` with `{ kind: "image" | "video" }`.
- It authenticates first with `currentUser()`, then loads the task with `getTask(sc(u), id)`. Any role may use it.
- Rate limit: `allow(\`drive:${sc(u)}\`, 60, WINDOW.hour)`.
- The file must be one of ours (`isOurMediaUrl`, and the name is in `mfiles:{sc(u)}`) or the task's own fal `imageUrl`, so one tenant cannot archive another's file even by knowing its name.

| State | Result |
|---|---|
| Not connected | Button opens the connect flow. Nothing else happens |
| Token revoked or expired, refresh fails | `drive_reconnect`. The connection is marked broken, as for other connectors |
| Drive full (403 `storageQuotaExceeded`) | `drive_full` |
| Google or Composio rate limit, or 5xx | `drive_busy`. The owner may try again |
| Our file already deleted | `media_expired` |
| fal's link already dead | `media_link_expired` |

Each code has one message in Arabic and English.

### 6.6 Drive is never a publish source (rule 1012)

`isOurMediaUrl` refuses every Google host, so a Drive link can never become `imageUrl`, `videoUrl`, `imageThumbUrl`, a reference image or a Composio staged file. The reasons:
- A share link (`drive.google.com/uc?export=download&id=…`) answers with an HTML page: a sign-in page, or the "can't scan for viruses" warning for larger files. Meta needs the media bytes with an image or video `Content-Type`. The publish fails or, worse, posts nothing useful.
- Google Workspace admins can forbid "anyone with the link" sharing. A client's Drive may simply be unable to make a file public.
- The client can move, unshare or delete the file between scheduling and publishing, and we would learn only when Meta fails.
- Popular files hit Google's download quota ("too many users have viewed or downloaded").
- Making a client's file public to the internet, so that Meta could fetch it, would be a privacy step we take on their behalf. The archive creates files; it does not run a public file host.

## 7. Variables, permissions, flows, tests

### 7.1 Variables (`docs/system/variables.md`)

| Name | What | Secret | Default / when unset |
|---|---|---|---|
| `MEDIA_DIR` | Absolute folder for our copies (1.2), one per Hostinger app | No | Unset: store off. kie and Higgsfield models are not offered; fal still works with its own link and no thumbnail |
| `MEDIA_MAX_BYTES` | Store cap in bytes | No | 21474836480 (20 GiB) |
| `MEDIA_MAX_FILES` | Store cap in files (inodes) | No | 100000 |
| `COMPOSIO_AUTH_GOOGLEDRIVE` | Composio auth config id for the Google Drive toolkit | No | Unset: the Composio Drive connector is not offered |
| `BLOB_READ_WRITE_TOKEN` | **Removed** in the expand release | — | — |

`APP_ORIGIN`, `CRON_SECRET`, `COMPOSIO_API_KEY`, `COMPOSIO_PROVIDERS`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are reused. The distinct-name count goes up by 3 net (4 new, 1 removed).

### 7.2 Permission rows (`docs/system/permissions.md`)

| Section | Method | Path | Actor | Check |
|---|---|---|---|---|
| new 1.11 Public media | GET, HEAD | `/m/{name}` | Public (P) | name regex before fs; same 404 for bad and missing; `allow` per IP 1200/h; stream cap 503; never reads cookies. On staging it is the only path that passes the lock without the cookie, still `noindex` |
| 1.3 | POST | `/api/tasks/{id}/archive` | O, any role | `currentUser`; task under `sc(u)`; file in `mfiles:{sc(u)}` or the task's own fal link; `allow` per scope 60/h |
| 1.3 (changed) | PATCH | `/api/tasks/{id}` | O | adds the fal link check when `scheduledFor` is set or a scheduled post is approved; calls `releaseMedia` on reject or cancel |
| 1.3 | GET | inbox media list (warnings) | O, any role | reads `mfiles:{sc(u)}` only |
| 1.4 | GET | `/api/connect/composio/googledrive` (the existing Composio start and callback rows) | O | as the other Composio toolkits: state bound to the login; only the folder-create and upload tools are callable |
| 1.4 | GET | `/api/connect/gdrive`, `/api/connect/gdrive/callback` | O | as the `gcal` rows: state bound to the login, scope `drive.file` only; hidden until the consent screen is verified |
| 1.7 (changed) | GET | `/api/admin/media` | F | `probeStore` replaces `probeBlob`: write, fetch our own `APP_ORIGIN/m/…` over https, delete; sentinel and usage figures. No tenant data |
| 1.8 (changed) | GET | `/api/cron/media` | C | adds the retention sweep, warnings and Drive queue (4.4) after `sweepMedia` |
| 3.2 | — | — | — | `/m/{name}` accepts a locator from the request: the name. It is not a tenant locator, carries no scope, and serves only files we wrote |

### 7.3 Flows (`docs/system/flows.md`, next free section at merge, today 62)

"Media storage on Hostinger disk and the Drive archive". It covers six flows:
- **render, copy and serve:** provider result, `copyToStore`, `/m/{name}`, then Meta, a provider or Composio fetches it;
- **fal link and thumbnail:** `thumbToStore`, link checks at schedule and publish, `media_link_expired`;
- **retention, holds and warnings:** 4.2-4.4, including `releaseMedia`;
- **deletion with an account, brand or task:** 4.5;
- **auto-save to Drive:** connector choice, queue, retries, manual retry, failure codes;
- **connect Drive:** Composio first, direct later.

`architecture.md` rows change in the same commit: `media/blob.ts` becomes `media/store.ts`, a new `archive/` module appears, and the "Vercel Blob" external service becomes "Hostinger disk (`MEDIA_DIR`)" plus "Google Drive (client's, optional, through Composio or Google)". The trust boundaries add the Drive upload and the fal link check.

### 7.4 Rules and tests (coverage file `docs/system/tests/0991-media-storage.md` comes with the first code PR)

| Rule | What | Test |
|---|---|---|
| 991 | Store at `MEDIA_DIR`: absolute, outside `cwd`, created 0700; unset or bad leaves the store off | `tests/media-store.test.ts` |
| 992 | Name = 32 hex + `.jpg`/`.mp4`, sharded, no tenant id; URL = `APP_ORIGIN/m/{name}` | `media-store.test.ts` |
| 993 | Index before file; `.part` with `wx` and `fsync`; `link` never overwrites; crash leaves only a ghost index entry | `media-store.test.ts` (fault injection with a temp dir) |
| 994 | Quota guard: `storeReady` at 95 % refuses before charge; `full` fails at once and refunds; `statfs` backstop; alerts at 80/95 % | `media-store.test.ts`, `media-jobs.test.ts` |
| 995 | `/m/{name}` regex before fs; traversal and encoded names 404; same 404 for missing; GET/HEAD only | `tests/media-file-route.test.ts` |
| 996 | Headers: type from extension, length, 30-day immutable cache, ETag/304, `download=1` attachment, CSP sandbox, CORP | `media-file-route.test.ts` |
| 997 | Range: single 206, unsatisfiable 416, multi 200 full; streamed, never buffered | `media-file-route.test.ts` |
| 998 | Rate limit per IP 1200/h with `Retry-After`; at most 6 big full streams per process, else 503 | `media-file-route.test.ts` |
| 999 | `isOurMediaUrl`: exact hosts and path, https, no credentials or query; the old Blob host during expand; all 7 call sites | `tests/media-catalog.test.ts` (look-alike hosts, `thakeen.com.evil`, `/m/../x`, uppercase hex, query) |
| 1000 | Staging lock lets `/m/` pass and nothing else, still `noindex` | `tests/staging-access.test.ts` |
| 1001 | Retention 30 days from creation; held while pending, approved or scheduled; `releaseMedia` sets `del = max(at + 30 d, release + 7 d)`; weekly hold re-check | `tests/media-retention.test.ts` (clock injected) |
| 1002 | Warnings at `del − 7 d` and `del − 1 d`, in the app and by email, only for full-size files not saved to Drive; one email per owner per day (`sendOnce`), 20 rows max, verified owner only; never delete without a first warning ≥7 days earlier | `media-retention.test.ts`, `tests/media-warnings.test.ts` |
| 1003 | Sweep: one `zrange`, `hmget` and `pmap` reads, batched `hdel`/`zrem`/`decrby`, deadline-bound, `.tmp` cleanup, report without ids | `media-retention.test.ts` (counts db calls) |
| 1004 | Account, brand and task deletion remove their files, index and queue entries; never the client's Drive | `media-retention.test.ts`, existing deletion tests |
| 1005 | Publish refuses `media_expired` before calling Meta or Composio | `tests/meta-publish.test.ts`, `composio-drafts.test.ts` |
| 1006 | fal: no copy; `imageThumbUrl` written, optional, ignored when missing; fal URL stays the publish source; fal images are not reference images | `media-jobs.test.ts`, `media-catalog.test.ts` |
| 1007 | fal link checked through `safeFetch` at schedule and at publish, from the stored task only; dead = `media_link_expired`, nothing sent, no credit moved | `tests/media-fal-link.test.ts`, `meta-publish.test.ts` |
| 1008 | Expand: `@vercel/blob` gone, no `BLOB_READ_WRITE_TOKEN`; scan read-only; copy script idempotent | `tests/media-migration.test.ts`, `tests/retire-vercel.test.ts` |
| 1009 | One archive interface; auto-save queue drained by `after()` and the cron, 3 tries, then `failed` and the retry button; `drive_reconnect` stops tries; publish never touches Drive | `tests/drive-archive.test.ts` |
| 1010 | Composio `googledrive`: only the folder-create and upload tools; `COMPOSIO_AUTH_GOOGLEDRIVE`; `composioStageFile` takes the task's own fal link for that tool only | `drive-archive.test.ts`, `tests/composio-catalog.test.ts` |
| 1011 | Direct `gdrive`: `drive.file` only, own redirect, tokens under `sc(u)`, hidden until enabled; direct wins over Composio | `drive-archive.test.ts` |
| 1012 | No Google host passes `isOurMediaUrl` | `media-catalog.test.ts` |
| 1013 | `probeStore`: write, serve, delete, sentinel, usage; never throws, no tenant data | `tests/media-admin.test.ts` |
| 1014 | Privacy policy and help name Hostinger (30 days), the provider link for fal images and the client's Drive, not Vercel Blob | `tests/legal.test.ts` (or the existing pin) |
| 1015 | Spare, for a gap found while planning | — |

`tests/media-blob.test.ts` becomes `media-store.test.ts`, keeping every download, cap, sniff, JPEG and deadline case. The Blob URLs in about 15 test files move to `https://thakeen.com/m/{hex}`, plus one kept Blob case per call site until the contract release.

### 7.5 Delivery

| PR | Contents | Rules |
|---|---|---|
| 1 (expand release) | Disk store, route, quota, staging `/m/`, retention with holds and warnings, deletions, fal thumbnail and link checks, probe, Blob removal, privacy text | 991-1008, 1013, 1014 |
| 2 | Archive interface, Composio Google Drive, auto-save queue, retry route | 1009, 1010, 1012 |
| 3 | Direct `gdrive` connector, after Google verifies the consent screen | 1011 |
| 4 (contract release) | Drop the Blob host | none new, amends 999 and 1008 |

Each is a draft PR and goes live only through a founder-merged release PR. Media on live stays off until the founder sets `MEDIA_DIR`, the provider keys and `MEDIA_MODELS_ON`, and the console probe passes. The Drive card stays hidden until `COMPOSIO_AUTH_GOOGLEDRIVE` (PR 2) or `GOOGLE_*` and the verified consent screen (PR 3) are in place.

## 8. Open questions for the founder

1. **kie.ai and Higgsfield:** should they also move to "link plus thumbnail" like fal? Recommended: **no, keep our 30-day copy for them.** Their links die in 1-14 days, often before a post scheduled a week ahead is published, and video reference images and YouTube staging need our own file. fal is the exception only because its links last longer and its images are cheap to remake.
2. **Thumbnail retention:** fal thumbnails follow the 30-day rule like every other file (recommended for v1: one rule, no warnings for thumbnails), or live longer (for example 12 months, ~0.5 GB at 100 clients) so history keeps a picture after the post is gone?

## 9. Pre-build checklist (founder, in hPanel, before PR 1 goes live)

Postponed by the founder (D6). Each item stays "founder to confirm" until checked. The Hostinger API connector cannot read these for a Business plan (section 1), so they are hPanel checks.

- [ ] Disk quota and inode limit, and current usage of each, across thakeen.com, staging.thakeen.com and maslakiyat.com (hPanel > Resources Usage).
- [ ] The daily file backup lists `domains/thakeen.com/media` once the folder exists (hPanel > Files > Backups).
- [ ] Bandwidth and Node process limits (entry processes, workers, memory).
- [ ] The crons still answer 200, which shows `domains/thakeen.com/.thakeen-cron` survived the #309 and #312 builds.
- [ ] `BLOB_READ_WRITE_TOKEN` is absent on live and on staging.
- [ ] After PR 1 is on staging: set `MEDIA_DIR` on staging, run the console probe, redeploy staging once, and check the probe reports "the store survived 1 build".
- [ ] For PR 2: create the Composio managed auth config for Google Drive, note which Drive scopes its consent asks for, and set `COMPOSIO_AUTH_GOOGLEDRIVE` (name only in chat; the value goes in hPanel).
