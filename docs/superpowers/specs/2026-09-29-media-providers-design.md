# Media providers (kie.ai, Higgsfield) and video: design

Date: 2026-09-29. Status: decided, revised the same day after a 47-point critique (every point and its verdict is in
the "Critique log" at the end of the plan). Build plan: `docs/superpowers/plans/2026-09-29-media-providers.md`. Provider
facts come from the verified research file (`image-providers-research.json`, sections `kie`, `higgsfield`, `code`). Code
references are to HEAD `99d9801`.

Revised a second time the same day, after a verified review of the built code, so that this design matches it: every
write to an existing task goes through `updateTask` under `tasklock:{scope}:{id}` (sections 4.2, 4.3, 4.4, R10); the
refund marker is a claim that becomes `"done"` or `"none"` only after the ledger answered (4.2, 4.3, section 6); a
finalize writes the task before the job and records the job in `task.mediaApplied` (4.2, 4.3); rate windows are set with
EXPIRE NX on every hit (4.8); the chat tool works to the chat request's own deadline (R12); provider downloads are https
on every redirect hop (4.6); the placeholder card never replaces artwork (A1, sequence G). `docs/system/tests.md` rules
112-118 pin these.

## 1. Goal

Today one image path exists: `POST /api/tasks/{id}/image` and the chat tool `generate_image` call
`generateImage` (`src/lib/images.ts:30-50`), which calls fal.ai FLUX schnell synchronously, hot-links the fal URL on the
task and charges 1 credit. This change:

1. adds kie.ai and Higgsfield as media providers next to fal.ai;
2. lets the owner pick an image model per task in the inbox, with its credit price shown;
3. adds video generation (generate, preview, download in the inbox; no video publishing);
4. copies every provider result to our own Vercel Blob store, images re-encoded to JPEG so Instagram accepts them;
5. keeps the credit rules (charge before the render, refund exactly once on failure), tenant isolation and the Claude
   pause intact, and makes provider spend, failures and disabled models visible in the founder console.

## 2. Decisions

### 2.1 Founder decisions (final)

| # | Decision |
|---|---|
| F1 | kie.ai and Higgsfield join fal.ai. Images and video ship in this round. |
| F2 | The owner picks the model in the app, per task, and sees its credit price. |
| F3 | Catalog and prices as in section 3. Target: our cost at most about $0.05 per credit. Video uses the PRD's reserved 12 and 24 credits (`docs/PRD.md:93`). |
| F4 | Storage is Vercel Blob (`@vercel/blob`, `BLOB_READ_WRITE_TOKEN`). Every provider result is copied there. Images are re-encoded to JPEG with `sharp`; video is stored as MP4. |
| F5 | Video in this round is generate, preview and download in the inbox. Publishing video (Reels, TikTok) is out of scope. |
| F6 | The founder adds `KIE_API_KEY`, `KIE_WEBHOOK_HMAC_KEY` (optional), `HIGGSFIELD_API_KEY_ID`, `HIGGSFIELD_API_KEY_SECRET` and `BLOB_READ_WRITE_TOKEN` himself. A kie or Higgsfield model is offered only when its key(s) and the Blob token exist. fal works without Blob exactly as today (hot-link); with Blob, fal results are copied too. |

### 2.2 Decisions the architect made (not specified by the founder)

| # | Decision | Why |
|---|---|---|
| A1 | The placeholder card (no fal key, default model) is no longer charged and then refunded: it is not charged at all. The response shape and the restored-balance number are unchanged. It never replaces artwork: it is written through `updateTask` only while the task as stored has no generated image, and an item that has one keeps it (409 `model_unavailable`, nothing written). | Same outcome for the owner and the existing tests, one ledger write fewer, no refund path to get wrong. A placeholder drawn over an image the owner paid for would hide that image and keep it from Instagram. |
| A2 | The chat tool `generate_image` keeps the default model only (`img-fast`, 1 credit) and gains no `model` argument. | The model never chooses how much of the owner's money to spend; the price in the tool description stays true. The chat path is off while Claude is paused anyway (`src/lib/chat.ts:187-194`). |
| A3 | Stale jobs are collected two ways. (1) A cron route `GET /api/cron/media` at `20 5 * * *`, which every Vercel plan allows. (2) An opportunistic sweep: the start routes and the poll route run `maybeSweep` in `after()` behind a 5-minute `SET NX` lock (`msweep`), limited to 6 jobs and to the route's own deadline (A23). If the founder's Vercel plan allows sub-daily crons, the schedule becomes `*/15 * * * *` (open question Q2). | A daily-only backstop let orphaned jobs hold Higgsfield slots and let kie results (24 h expiry in one kie doc) expire before the copy. The sweep is not a step of `/api/cron/daily`: each advance can take up to ~90 s and would eat that route's per-workspace budget (`src/app/api/cron/daily/route.ts:71`). |
| A4 | Provider callbacks (webhooks) are requested only when `APP_ORIGIN` is set to an `https://` origin that is not localhost. Otherwise jobs finish through polling and the sweeps. | A preview or local deployment must not point providers at production, and the hard-coded production fallback used elsewhere (`src/app/api/cron/daily/route.ts:18`) would do exactly that. The console shows `webhooks: off` in red. |
| A5 | "Clip with sound 8s" (Veo 3.1 Fast) goes through kie's legacy `POST /api/v1/veo/generate` with `model: "veo3_fast"`, polled at `GET /api/v1/veo/record-info`, unless the implementer finds a documented tier selector on the unified `veo-3-1` schema when re-reading the docs (plan, package 2). | The unified schema documents no Fast/Quality/Lite selector, and the tiers differ about 4x in price ($0.30 vs $1.25). |
| A6 | The job engine (`src/lib/media/jobs.ts`) receives providers and storage as an injected `MediaDeps` object, the way `postToInstagram` receives `wait` (`src/lib/connectors/meta.ts:107`). The real object is built in `src/lib/media/registry.ts`. | Tests drive every state transition with scripted fakes and no network; the engine, the adapters and the store can be built in parallel. |
| A7 | `src/lib/images.ts` is deleted. The prompt builders move to `src/lib/media/prompts.ts`; the fal call moves to `src/lib/media/fal.ts`. | One media path for every provider. |
| A8 | Type gates move into code: images only for `IMAGE_TYPES` (`src/lib/tasks.ts:39`), video only for a new `VIDEO_TYPES = ["social", "ads"]`. | `IMAGE_TYPES` is enforced only in the inbox today (`src/components/app/Inbox.tsx:255`). |
| A9 | A reference image or first frame is sent to a provider only when it is our own Blob copy of a real generated image (`hasArtwork` and `https://*.public.blob.vercel-storage.com`). | Providers fetch reference URLs server-side. Only URLs Nashr controls leave the building. |
| A10 | Higgsfield admission (all tenants share one account): count only live open jobs (not terminal, younger than their max age, no result waiting to be copied). When the open set is at the cap, the start request first force-advances the open jobs older than 2 minutes (bounded, behind a 60 s `SET NX` lock, status calls only) and drops members that are gone or terminal. Then: at most 1 live Higgsfield job per account (`one_open`), at most `HF_MAX_OPEN = 2` in total, of which at most `HF_MAX_OPEN - 1` may be videos (`busy`). kie creates: 18 per 10 s (account-wide). | Higgsfield's documented floor for a new account is 2 concurrent requests; kie allows 20 creates per 10 s per account. Counting raw set members let two orphaned jobs block every Higgsfield model for every tenant for up to a day. The check is not atomic; Higgsfield's own refusal ("Maximum number of concurrent requests") maps to `busy` with an immediate refund. |
| A11 | Model labels are functional ("Fast", "Premium ad image", "Clip with sound 8s"); vendor and model names never appear in the UI. Hints describe what a model does and what it does not do; no quality claims ("sharper", "more detail"). | Matches the rule of not naming models on the site and the no-invented-claims rule. |
| A12 | The Sonnet prompt call gets `{timeout: min(20 s, time left), maxRetries: 0}`; when it fails (model on), the render uses the fixed template. | The Anthropic SDK retries timeouts twice by default (`maxRetries ?? 2`, `node_modules/@anthropic-ai/sdk/client.js:112`), so a bare 20 s timeout can take ~62 s. The credit buys the render, not the prompt. |
| A13 | Seedance ("Cinematic 5s") is sent with `generate_audio: false`. | "Clip with sound" is the audio product. The implementer confirms the price with `/estimate` (plan, package 3). |
| A14 | `mediaCredits` is recorded on the task and, as an optional field, on its light row. Readers use `t.mediaCredits ?? (t.image ? IMAGE_COST : 0)`; finalize starts from `t.mediaCredits ?? (hasArtwork(t) ? IMAGE_COST : 0)`. | A video costs 12 or 24 credits (`src/lib/stats.ts:107`, `src/lib/admin-stats.ts:71`). Rows written before this change lack the field, and a legacy fal image's credit must not be dropped on a re-render. |
| A15 | A founder-only `GET /api/admin/media` reports configuration, the Blob probe (write, check, delete a tiny file), the kie balance, Higgsfield's `/estimate` per model, the disabled models, per-model spend and the last 50 jobs. | `/estimate` validates the endpoint id and body without generating; the Blob probe catches a private store or a bad token before owners pay for renders that cannot be stored. |
| A16 | `package.json` and `package-lock.json` belong to package 0. `npm ls --depth=0` is recorded before and after the lockfile regeneration; any moved direct dependency other than `@vercel/blob` and `sharp` is pinned back or named in the commit. | The Blob package needs the dependencies in wave 1; a silent SDK upgrade could change the retry behaviour A12 relies on. |
| A17 | No new analytics event for video. Images still `track(email, "image")` (now only for real images). Render spend goes to new counters. | Adding an event touches `track.ts` and `AdminConsole.tsx:179-180` for little value. |
| A18 | Video prompts are metered as kind `image_prompt`. | A new kind would also need `src/lib/account.ts:19` to change; the cost is a few tenths of a cent. |
| A19 | Render counters are global only (`render:_all:*`), never per email. Job records (`mjob:{scope}:*`, 7 days) and throttle keys that carry an email (`rate:media:*`, `mflight:*`, `mtrialvid:*`) expire by TTL; account deletion does not delete them or Blob files (follow-up, section 9, and the help text says so). `src/lib/account.ts` does not change. | Per-email counters without TTL would outlive `wipeAccount` and break the wipe principle pinned by `tests/p1-fixes.test.ts:123-160`. |
| A20 | A provider status call needs two locks: the 4 s `mpoll:{jobId}` throttle (skipped only by the sweeps' `force`) and the job lock `mjoblock:{jobId}`, taken before the status call and held through finalize or fail. | Two tabs, webhooks and polls cannot multiply provider calls, and a job being copied gets no status calls at all. |
| A21 | Server-only allowlist `MEDIA_MODELS_ON` (comma-separated catalog ids). `img-fast` is always allowed; every other model is offered only when listed (and configured). Unset: `img-fast` only. | The founder turns a model on only after the console check passes, and off again without a deploy. A wrong endpoint id must never reach owners as a model that charges, fails and refunds. |
| A22 | Circuit breaker: 3 final `store_failed`, `timeout` or defect-class `submit_failed` (`rejected`, `bad_response`) of one model within an hour, or one kie render whose `creditsConsumed` exceeds 110 % of the expected credits, switch that model off for 6 hours; a `no_balance` answer switches all of that provider's models off for 1 hour. The state is one Redis key, `media:off`, read once per page or start. | A revoked Blob token, a silent tier or price change, or an empty provider balance would otherwise turn every click into "provider bills us, owner is refunded" until someone looks at the console. |
| A23 | Every render request has one deadline: `start + maxDuration × 1000 − 15 s`. Each step gets `min(its own maximum, time left)`: prompt 20 s, submit (fal 45 s, kie and Higgsfield 20 s), status 15 s, download (image 15 s, video 45 s), put (image 20 s, video 30 s). No step starts with less than its minimum; a finalize that does not fit is left for the next poll or sweep. Image, video, poll and webhook routes have `maxDuration = 120`; the cron has 300. | The old budgets did not fit the route ceilings (worst image case ~175 s against 120 s). A function killed after the charge left credits stuck until the daily sweep. |
| A24 | Start order: balance pre-check (402) → flight lock (409) → account limits (429) → trial rules → provider throttle (429) → charge → job saved `queued` together with `task.mediaJob[kind]` and the open-set member. Every refusal releases the flight lock (`try/finally`). A throw from `charge` answers 429 `busy` (nothing was charged). A throw after a successful charge but before the job is durable refunds at once under the `mrefund` marker and answers 502 `media_failed` with the balance; if that refund fails too, the job, its open-set member and the task pointer are written again, the flight lock stays held, the answer is 502 `media_pending`, and the next poll or sweep ends the job `submit_lost` with the refund. | A transient Redis error between the charge and the save lost the credit for good; a ledger lock timeout left the task blocked for 15-35 minutes; refused requests used up render slots and the shared kie throttle. |
| A25 | A provider result that could not be copied yet is kept on the job (`resultUrls`, provider output, only ever fetched through `safeFetch`). The copy is retried on later polls or sweeps (3 tries, at least 30 s apart, within the job's max age) without another status call. For fal, a failed copy falls back to today's hot-link. | Results live 1-14 days; a transient Blob error should not throw away a render we paid for. |
| A26 | A video first frame comes only from a portrait post image (TikTok, Snapchat). A square image (Instagram, Meta ads) is not sent to the video models, which then render text-to-video at 9:16; the exception is "Photo to motion", which needs the image, and the inbox says before the charge that the clip keeps the photo's square shape. | Kling 2.5 image-to-video and Hailuo have no aspect field and Seedance's aspect applies to text-to-video only (research), so a square first frame gives a square clip, while the owner downloads clips to post as Reels, TikToks or Snaps. |
| A27 | "English headline image" (`img-text`) puts an English headline only until the founder records a passing Arabic test. With Sonnet on: "headline in English, at most 6 words". While paused: the brand name is quoted only when it is plain Latin text (`/^[\x20-\x7E]+$/`); otherwise the prompt is the design template with no text. The task title never reaches the prompt. | No provider documents Arabic lettering, and while paused every Arabic title would have been drawn as Arabic text. |
| A28 | When a job ends without the owner watching (webhook or sweep), the owner gets an in-app notification (`pushNotif`, kind `info`, in the language stored on the job). A failure also leaves `task.mediaLast[kind] = {error, credits, refunded, at}` on the card until the next render of that kind. | The inbox tells the owner they can leave the page; a silent refund or a silent success is invisible otherwise. |
| A29 | Trial accounts (no card): images as usual; at most one video per trial (kept, not counting refunded attempts), only from the 12-credit models "Quick clip", "Clip with sound" and "Photo to motion". Default pending the founder's confirmation (Q1); one constant each. | Images cost ~$0.003 before; one free signup (plus 50 referral credits) could now spend $2-4 of real money on video. |
| A30 | The webhook has no global rate bucket. Per-IP 240 per minute; a hint for a known job calls `advance` without `force`, so it shares the job's 4 s poll throttle; unknown ids cost two Redis reads and no provider call. | A global bucket consumed before validation let anyone starve legitimate callbacks, and Higgsfield treats any 4xx as permanent. |
| A31 | Spend counters are integers: `usd_micro = Math.round(usd × 1e6)`, kie credits as `kie_centicredits = Math.round(credits × 100)`. | Upstash `INCRBY` rejects non-integers (35 × 0.005 × 1e6 = 175000.00000000003); the memory store accepts them, so tests would pass while production lost spend. `src/lib/usage.ts` already rounds. |
| A32 | A refund goes only to the account that was charged: the job stores the account's `createdAt` (`accountSince`); when the account is gone or was re-created, the job ends `failed` with `refunded: false`, and no notification is sent. | `refund()` throws `user_not_found` after `wipeAccount` (`src/lib/credits.ts:21`), which left the job open for 7 days; a re-registered address would have received the old account's refund. |

## 3. Catalog

Credits and our cost per render. "kie cr" is kie's own credit unit (1 kie credit = $0.005). Costs are list prices from
the research, 2026-09-29; the founder console records the real spend (section 4.9). **No model accepts a photo of the
owner's own product in this round**: the only reference image is the post's own generated image (A9).

### 3.1 Images

| Catalog id | Label (en / ar) | Provider | Endpoint | Exact request | Credits | Our cost | $ per credit |
|---|---|---|---|---|---|---|---|
| `img-fast` (default) | Fast / سريعة | fal | `POST https://fal.run/fal-ai/flux/schnell` (sync) | `{prompt, image_size: "square_hd" \| "portrait_16_9", num_images: 1, enable_safety_checker: true, output_format: "jpeg"}`; a response with `has_nsfw_concepts[0] === true` is a content refusal | 1 | ~$0.003 | 0.003 |
| `img-balanced` | Balanced / متوازنة | kie | `POST https://api.kie.ai/api/v1/jobs/createTask` | `{model: "nano-banana-2", callBackUrl?, input: {prompt, image_input?: [blobUrl], aspect_ratio: "1:1" \| "9:16", resolution: "1K", output_format: "jpg"}}` | 1 | $0.04 (8 kie cr) | 0.040 |
| `img-premium` | Premium ad image / صورة إعلانية فاخرة | kie | same | `{model: "nano-banana-pro", callBackUrl?, input: {prompt, image_input?: [blobUrl], aspect_ratio, resolution: "2K", output_format: "jpg"}}` | 2 | $0.09 (18 kie cr) | 0.045 |
| `img-text` | English headline image / صورة بعنوان إنجليزي | kie | same | `{model: "gpt-image-2-text-to-image", callBackUrl?, input: {prompt, aspect_ratio: "1:1" \| "9:16", resolution: "1K"}}` (no output_format: re-encoded) | 1 | $0.03 (6 kie cr) | 0.030 |
| `img-lifestyle` | Lifestyle photo / صورة حياتية | higgsfield | `POST https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard` | `{prompt, aspect_ratio: "1:1" \| "9:16", resolution: "1080p", batch_size: 1, enhance_prompt: false, style_id: "3db34ab5-3439-4317-9e03-08dc30852e69", seed: <int 1..1000000>}` | 1 | $0.0057 | 0.006 |
| `img-design` | Graphic design / تصميم جرافيك | higgsfield | `POST https://api.higgsfield.ai/recraft/v4.1/text-to-image` | `{prompt, resolution: "1k", aspect_ratio: "1:1" \| "9:16", output_format: "jpg"}` | 1 | $0.035 | 0.035 |

`aspect_ratio` is `9:16` when the task channel is `tiktok` or `snapchat`, else `1:1` (today's rule,
`src/lib/images.ts:43`). `image_input` is sent only when the task already has a real generated image on our Blob (A9).
The design template asks for no lettering, so the label says "graphic design", not "poster". The exact hint strings
(what each model does and does not do) are fixed in the plan, package 0.

### 3.2 Video (9:16 requested; a first frame only from a portrait image, A26)

| Catalog id | Label (en / ar) | Provider | Endpoint | Exact request | Credits | Our cost | $ per credit |
|---|---|---|---|---|---|---|---|
| `vid-quick` | Quick clip · 5s / مقطع سريع · 5 ث | kie | `POST /api/v1/jobs/createTask` | text: `{model: "kling/v2-5-turbo-text-to-video-pro", input: {prompt, duration: "5", aspect_ratio: "9:16", negative_prompt: "text, watermark, logo", cfg_scale: 0.5}}`; from a portrait image: `{model: "kling/v2-5-turbo-image-to-video-pro", input: {prompt, image_url, duration: "5", negative_prompt, cfg_scale: 0.5}}` | 12 | $0.21 (42 kie cr) | 0.018 |
| `vid-sound` | Clip with sound · 8s / مقطع بصوت · 8 ث | kie | `POST /api/v1/veo/generate` (A5), status `GET /api/v1/veo/record-info` | `{prompt, model: "veo3_fast", aspect_ratio: "9:16", generationType: "TEXT_2_VIDEO" \| "FIRST_AND_LAST_FRAMES_2_VIDEO", imageUrls?: [blobUrl], enableTranslation: true, duration: 8, resolution: "720p", callBackUrl?}` (translation on: a prompt can carry the Arabic brand name, and Veo refuses non-English prompts with code 400) | 12 | $0.30 (60 kie cr) | 0.025 |
| `vid-premium` | Premium · 10s with audio / فيديو مميز · 10 ث بصوت | kie | `POST /api/v1/jobs/createTask` | `{model: "kling-3.0/video", input: {prompt, image_urls?: [blobUrl], sound: true, duration: "10", aspect_ratio: "9:16", mode: "std", multi_shots: false, multi_prompt: [{prompt ≤ 500 chars, duration: 10}]}}` (kie lists `multi_prompt` as required; one shot repeating the prompt) | 24 | $1.00 (200 kie cr) | 0.042 |
| `vid-cinematic` | Cinematic · 5s / سينمائي · 5 ث | higgsfield | `POST /bytedance/seedance-2.0/text-to-video` or `/image-to-video` | text: `{prompt, duration: 5, resolution: "720p", aspect_ratio: "9:16", generate_audio: false}`; from a portrait image: `{prompt, image_url, duration: 5, resolution: "720p", generate_audio: false}` | 12 | ~$0.70 (list $0.1407/s) | 0.058 |
| `vid-motion` | Photo to motion · 6s / تحريك الصورة · 6 ث | higgsfield | `POST /minimax/hailuo-2.3/standard/image-to-video` | `{prompt, image_url, duration: 6, prompt_optimizer: false}` (needs our image; the clip keeps the photo's shape, square for square posts) | 12 | $0.28 | 0.023 |

Every video prompt forbids speech, dialogue and voice-over ("sound" means ambient sound and music): no provider documents
the language of generated speech. `vid-cinematic` is above the ~$0.05 per credit target at list price (open risk R3).
Revenue per credit is $0.1065 on the agency plan (`docs/system/costs.md:75`), so every row still has a margin.
Since pricing phase 1 (2026-09-30) the cheapest credit is Business's $0.1776 and the 60% floor allows at most $0.0710 of
cost per credit; `tests/pricing-floor.test.ts` (rule 241) checks every row, prompt included, against it, and
`vid-cinematic` is the highest at $0.0588 (`docs/system/costs.md` sections 3.1 and 4).

### 3.3 Where each doubtful field is confirmed

Every model's request body is built in exactly one function (`KIE_MODELS[id].body` in `src/lib/media/kie.ts`,
`HF_MODELS[id].body` in `src/lib/media/higgsfield.ts`, the single body in `src/lib/media/fal.ts`), so a wrong field is a
one-line fix. Before merging, the implementer re-reads:

| Model | Doubt | Page to re-read | How to settle it |
|---|---|---|---|
| `img-fast` | `output_format` and `has_nsfw_concepts` on FLUX schnell | https://fal.ai/models/fal-ai/flux/schnell/api | `output_format` listed as `"jpeg" \| "png"`; `has_nsfw_concepts` in the output schema. |
| `img-balanced`, `img-premium` | model enum spelling; whether `nsfw_checker` exists | https://docs.kie.ai/market/google/nanobanana2.md, https://docs.kie.ai/market/google/pro-image-to-image.md | Copy the enum from the OpenAPI block. Add `nsfw_checker: true` if and only if the schema lists it. |
| `img-text` | 9:16 at 1K accepted; `nsfw_checker` | https://docs.kie.ai/market/gpt/gpt-image-2-text-to-image.md | Restrictions table on the page. |
| `vid-quick` | enum shows `kling/v2-1-master-*` while examples use `kling/v2-5-turbo-*-pro`; `duration` string or number; `aspect_ratio` on text-to-video | https://docs.kie.ai/market/kling/v25-turbo-image-to-video-pro.md and the text-to-video sibling | Use the example ids. After the first real render, `creditsConsumed` on the job must be 42 (the breaker, A22, switches the model off above 46). |
| `vid-sound` | tier selector (A5), field names on the legacy endpoint, record-info shape (`successFlag`, `response.resultUrls`), and whether record-info reports `creditsConsumed` at all (the research documents it only for the market `recordInfo` and callbacks) | https://docs.kie.ai/veo3-api/generate-veo-3-video.md, https://docs.kie.ai/old-model/veo3-api/generate-veo-3-video.md and its record-info page | If the unified schema documents a Fast selector, switch to the market family. The adapter reads a numeric `data.creditsConsumed` when present. Proof of the tier either way: the founder renders one `vid-sound` alone and compares the kie balance in the console before and after (60 credits for Fast, about 250 for Quality) before adding `vid-sound` to `MEDIA_MODELS_ON`. |
| `vid-premium` | `mode` values (`std` = 720p), `duration` as string | https://docs.kie.ai/market/kling/kling-3-0.md | `creditsConsumed` must be 200. |
| Higgsfield, all four | exact endpoint ids; strict schemas reject unknown fields | https://docs.higgsfield.ai/docs/llms.txt, each model page under `/docs/models/`, and the console playground `https://open.higgsfield.ai/models/{endpoint_id}/playground` | `GET /api/admin/media` (A15) calls `POST https://api.higgsfield.ai/estimate/{endpoint_id}` with each model's real body: HTTP 200 plus a `usd` value proves the id and the body; 404/422 names the one line to fix. A model is added to `MEDIA_MODELS_ON` only after its line is green. |
| `vid-cinematic` | price at 720p with and without audio | `/estimate` via `GET /api/admin/media` | If the estimate exceeds $0.70, set `resolution: "480p"` or ask the founder to reprice. |

## 4. Architecture

### 4.1 Modules

| Module | Side | Imports | Role |
|---|---|---|---|
| `src/lib/media-catalog.ts` | client-safe | **nothing** (pinned by `tests/client-bundle.test.ts`) | Catalog, ids, labels, hints, credits, max ages, trial models, `aspectFor`, `hasArtwork`, `isOurBlobUrl`, `mediaImageFor`. |
| `src/lib/tasks.ts` | client-safe | nothing | Gains `VIDEO_TYPES`. |
| `src/lib/media/types.ts` | server (types + two error classes) | type-only | Adapter interface, job record, deps, results. |
| `src/lib/media/keys.ts` | server | nothing | Redis key builders, TTLs, id formats, `deadlineFor`. |
| `src/lib/media/config.ts` | server | catalog, db | Configured providers, `MEDIA_MODELS_ON`, disabled models (`offModels`), `availableModels`, cost and expected-credit tables, callback URL. |
| `src/lib/media/fal.ts`, `kie.ts`, `higgsfield.ts` | server | types, keys, config | One adapter per provider. Plain `fetch`, fixed hosts, no SDK. |
| `src/lib/media/blob.ts` | server | `@vercel/blob`, `sharp`, `safe-fetch` | Download a provider result, cap, sniff, JPEG, put; `probeBlob` for the console. |
| `src/lib/media/prompts.ts` | server | Anthropic SDK, `model.ts`, `usage.ts` | Image and video prompts; fixed templates while paused. |
| `src/lib/media/jobs.ts` | server | db, credits, auth (`getUser`), brand, rate, parallel, track, notifications, keys, config | The engine: start, admission, advance, finalize, fail, breaker, spend, notifications, sweeps. No provider import (A6). |
| `src/lib/media/registry.ts` | server | adapters, blob, config | `mediaDeps()`: the real `MediaDeps`. |
| `src/lib/media/start.ts` | server | auth, brand, tasks, catalog, config, prompts, jobs, registry | `renderImage` / `renderVideo` / `mediaResponse`: validation shared by the routes and the chat tool. |

Routes: `POST /api/tasks/{id}/image` (changed), `POST /api/tasks/{id}/video`, `GET /api/media/{jobId}`,
`POST /api/media/hook/{provider}`, `GET /api/cron/media`, `GET /api/admin/media`. Route handlers follow Next 16:
`ctx: { params: Promise<{...}> }` awaited (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`),
`export const maxDuration` per route (`.../02-route-segment-config/maxDuration.md`), and `after()` from `next/server` for
work that must not delay the response; `after` runs within the route's `maxDuration`
(`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`), so work scheduled with it gets the same
deadline as the request (A23).

### 4.2 Data model

**Task** (`src/lib/brand.ts:36-63`), new and widened fields:

```ts
imageProvider?: MediaProviderId | "placeholder";   // was "fal" | "placeholder" (brand.ts:55)
imageModel?: ImageModelId;                          // absent on images made before 2026-09-29 (fal FLUX schnell)
videoUrl?: string;                                  // our Blob URL, video/mp4
videoPrompt?: string;
videoProvider?: "kie" | "higgsfield";
videoModel?: VideoModelId;
mediaCredits?: number;                              // credits kept for renders on this task, after refunds
mediaJob?: { image?: string; video?: string };      // set when the job is saved "queued", for every provider
mediaApplied?: string[];                            // the last 8 finished jobs whose result or credits the task took
mediaLast?: { image?: MediaLast; video?: MediaLast }; // last failure of that kind, until the next render of that kind
// MediaLast = { error: MediaFailure; credits: number; refunded: boolean; at: string }
```

`mediaApplied` (`src/lib/brand.ts:80`, kept to 8 by `APPLIED_KEEP` in `jobs.ts`) is written in the same task write as
the result and the credits, so a finalize retried after a write that half failed finds its job there and changes nothing:
no render is counted twice.

`TaskLite` (`brand.ts:119-129`) gains `video: boolean` and `mediaCredits?: number` (optional: rows written earlier lack
it; readers fall back as in A14), and its `image` is false for a placeholder card (`liteOf`, `src/lib/brand.ts:175`), so
the readers' `image ? IMAGE_COST : 0` fallback never counts a credit or an image for a card that cost nothing.

Every change to an existing task goes through `updateTask(scope, id, mutate)` (`src/lib/brand.ts:274`): under
`tasklock:{scope}:{id}` (SET NX, 10 s; 60 tries 50 ms apart, then `task_lock_timeout`) it re-reads the task, applies the
writer's own fields to a copy, and saves; `mutate` may return null to save nothing, and a task deleted meanwhile is not
recreated. `saveTask` replaces the whole task, so a writer that saved a copy read before slow work erased whatever landed
in between: a publish or an approval undid a render that finished meanwhile, and a finalize undid an approval. The media
engine, the placeholder, the approve and edit route, the publish route, the chat tool `publish_item` and the judge all
write this way.

**Media job** (full type in the plan, package 0): `{id, scope, email, lang, accountSince, taskId, kind, model, provider,
credits, prompt, imageUrl?, providerTaskId?, state, error?, createdAt, updatedAt, finishedAt?, resultUrls?, storeTries?,
url?, costUsd?, providerCredits?, refunded?, trialVideo?}`. `scope` is `sc(u)` at creation and is the only workspace the
job ever writes; `email` is the account that was charged (credits are per account, `docs/system/flows.md:101`);
`accountSince` is that account's `createdAt` (A32); `lang` is the owner's interface language, for notifications.

**Redis keys** (all built in `src/lib/media/keys.ts`):

| Key | Type | Holds | TTL |
|---|---|---|---|
| `mjob:{scope}:{jobId}` | json | `MediaJob` | 7 days, reset on every save |
| `mjobref:{provider}:{providerTaskId}` | json | `{scope, jobId}`: the reverse index a webhook uses | 7 days |
| `mjobs:open:{provider}` | set | `{scope}\|{jobId}` for every job not yet done or failed | none; members removed at the end, gone or terminal members removed by admission and the sweeps |
| `mjobs:recent` | list | last 50 terminal jobs `{id, model, state, error, providerCredits, costUsd, at}`, no email, no scope | capped |
| `mflight:{scope}:{taskId}:{kind}` | lock | one render per task and kind at a time | image 900 s, video 2100 s |
| `mjoblock:{jobId}` | lock | serialises status, finalize and fail of one job | 120 s |
| `mrefund:{jobId}` | lock, then string | exactly-once refund marker: a claim (`db.lock`) taken before the ledger call, then `"done"` once `refund` returned or `"none"` when the account that paid is gone or was re-created (`refundOnce`) | claim 60 s, then 7 days |
| `mpoll:{jobId}` | lock | at most one provider status call per 4 s (30 s after a failed copy) | 4 s / 30 s |
| `msweep` | lock | at most one opportunistic sweep per 5 minutes | 300 s |
| `mhfclean` | lock | at most one Higgsfield admission clean-up per minute | 60 s |
| `mtrialvid:{email}` | lock | the one trial video (released when that video is refunded) | 14 days |
| `media:off` | json | `{[modelId]: {until, reason}}`: models switched off by the breaker | none (entries expire by `until`) |
| `media:offlock` | lock | serialises writes to `media:off` | 5 s |
| `rate:media:{kind}:h:{email}`, `rate:media:{kind}:d:{email}` | int | per-account render limits | 3600 s, 86400 s |
| `rate:kie:create` | int | account-wide kie create throttle | 10 s |
| `rate:mfail:{modelId}` | int | breaker window | 3600 s |
| `rate:mpoll:u:{email}` | int | polls per account | 60 s |
| `rate:mhook:{provider}:{ip}` | int | webhook throttle per IP | 60 s |
| `render:_all:{YYYY-MM}:m:{modelId}:{jobs\|failed\|credits\|usd_micro}`, `render:_all:{YYYY-MM}:kie_centicredits` | int | render spend (integers, A31); provider and month totals are sums of the model counters | none (like `usage:_all`) |
| `tasklock:{scope}:{id}` | lock | one read-change-save of a task at a time (`updateTask`; built in `src/lib/brand.ts`, not in `keys.ts`) | 10 s |

`jobId` is 16 random bytes in hex, generated by the server. A provider task id is used in a key only after it matches a
strict format (`PROVIDER_TASK_ID` in `keys.ts`), and only to find the stored `{scope, jobId}` pointer; the workspace is
always the stored `scope`, never anything from the request. This is the same shape as `oauthstate:{state}`
(`docs/system/permissions.md` section 3.2) and is documented there.

### 4.3 Job state machine

```
            startMedia                           advance (poll / webhook / sweep)
 (none) ──charge──▶ queued ──submit ok (async)──▶ running ──status done──▶ finalize ──▶ done
                      │  └─submit ok (fal sync)────────────────────────────▶ finalize ──▶ done
                      │                               │          └─copy failed (tries left)─▶ running + resultUrls
                      ├─submit error / refusal ───────┼────────────────────────────────▶ failed (+refund once)
                      └─older than 3 min (lost) ──────┘  status failed / nsfw / past max age / copy failed 3 times
```

- `queued`: charged, job saved with `task.mediaJob[kind]` pointing at it, not yet accepted by the provider. The start
  request holds the job lock while it works; a queued job older than 3 minutes (longer than any route deadline) whose
  lock is free is `submit_lost`.
- `running`: the provider has a task id, or the result is known and waiting to be copied (`resultUrls`). Max age: image
  10 minutes, video 30 minutes (`MEDIA_MAX_AGE_MS`); past it the job is cancelled (Higgsfield, best effort) and failed
  with `timeout`, or, when the copy kept failing, `store_failed`.
- `done` and `failed` are terminal. A terminal job never changes again: every transition runs under `mjoblock:{jobId}`,
  re-reads the job and returns if it is already terminal.
- Refund happens only in `fail`, and at the start when the job never became durable (A24), both through `refundOnce`
  (`src/lib/media/jobs.ts:484`), so duplicate webhooks, two tabs and the sweeps cannot refund twice. `mrefund:{jobId}`
  records how far a refund got. `"done"`: made, the job is `refunded: true`. `"none"`: not owed, `refunded: false`.
  Neither: `refundOnce` takes a claim (`db.lock`, 60 s), and a claim another pass holds makes it throw `refund_pending`,
  so the job stays open. Holding the claim, it checks that the charged account still exists with the same `createdAt`
  (A32) and only then calls `refund()`; afterwards the claim becomes `"done"`, or `"none"` for a gone or re-created
  account (no refund, no notification), for 7 days. If `refund()` throws anything else, the claim is released and the job
  stays open, so the next poll or sweep retries. A job is therefore recorded `refunded` only after a refund that
  happened, and a pass that died holding the claim delays the refund until the claim expires instead of losing it.
- `fail` writes the task (`mediaJob[kind]` cleared, `mediaLast[kind]` set, only while the task still points at this job)
  and only then saves the job `failed`; a task write that throws leaves the job open, and the next pass finds the refund
  already recorded in the marker.
- `finalize` checks the refund marker first: any value means a `fail` is under way or done, so it finishes that `fail`
  (or throws `refund_pending` while the claim stands) and the render is never delivered.
- `finalize` writes the task first and saves the job `done` only after that write succeeded; a task write that throws
  leaves the job `running` with its `resultUrls`, and the next poll or sweep copies and delivers it. In that one task
  write the job's credits are added to `mediaCredits` and its id to `mediaApplied`; a job already in `mediaApplied` changes
  nothing, so a retry never counts a render twice. The media fields are written only when `task.mediaJob[kind]` still
  points at this job; a late, older job ends `done` with its `url` but does not overwrite a newer render. `mediaCredits`
  is added either way (the credit was kept).
- The engine changes a task only through `updateTask` (4.2), never by saving a copy it read earlier.
- On every terminal transition: the job leaves `mjobs:open:{provider}`, `task.mediaJob[kind]` is cleared if it still
  points at this job, `mflight` is released only while the job is younger than the flight TTL (the lock `DEL` is
  unconditional, `docs/system/flows.md:102`), the outcome is counted (4.9), and, when the transition came from a
  webhook or a sweep, the owner is notified (A28).

### 4.4 Sequences

Every sequence below runs against one deadline (A23): `deadline = t0 + maxDuration × 1000 − 15 000`.

**A. Start (every model)**

1. `POST /api/tasks/{id}/image {model?}` or `POST /api/tasks/{id}/video {model}`: `currentUser` (401),
   `getTask(sc(u), id)` and `getBrand(sc(u))` (404).
2. `renderImage` / `renderVideo` (`start.ts`): trial ended (402 `trial_over`); model id from the catalog (400
   `bad_model`); `IMAGE_TYPES` / `VIDEO_TYPES` (400 `wrong_type`); trial account and a video model outside
   `TRIAL_VIDEO_MODELS` (402 `plan_required`); availability = keys, Blob, `MEDIA_MODELS_ON`, not in `media:off`
   (default image model unavailable: placeholder, sequence G, or 409 `model_unavailable` when the item already has
   artwork; other models: 409 `model_unavailable`); "Photo to motion" without our image (409 `needs_image`). The reference image is `mediaImageFor(model, task)` (A9, A26).
3. `startMedia` (A24): `u.credits < credits` → 402 `no_credits {need, have}` before any counter moves; flight lock
   (409 `in_progress` with the running job when there is one); then, inside `try/finally` that releases the flight lock
   on every refusal: account limits (429 `too_many`); trial video marker `mtrialvid:{email}` (402 `trial_video_used`);
   provider throttle: kie `allow("kie:create", 18, 10)`, Higgsfield admission (A10) (429 `busy` or `one_open`);
   `charge` (throws → 429 `busy`, nothing charged; refused → 402 `no_credits`).
4. Job saved `queued` in one `Promise.allSettled` round with the open-set member and `task.mediaJob[kind] = jobId` (and
   `task.mediaLast[kind]` cleared), the task part through `updateTask`, so a render of the other kind or an approval
   landing meanwhile keeps its fields. All three settle before anything is decided. If one failed, the credit is refunded
   at once through `refundOnce` (4.3), the member and the pointer are removed (the cleared `mediaLast` is put back), and
   the answer is 502 `media_failed` with the restored balance. If that refund fails too, the job, its member and the
   pointer are written again, the flight lock stays held and the answer is 502 `media_pending`; the next poll or sweep
   ends the job `submit_lost` with the refund. The start request takes the job lock and holds it to the end.
5. Prompt: Sonnet with `{timeout: min(20 s, left), maxRetries: 0}`, or the fixed template while paused (4.5).
6. Submit with a budget of `min(fal 45 s | kie 20 s | Higgsfield 20 s, left − (fal: 25 s reserved for the copy))`; less
   than 5 s left → not sent, `submit_failed`, refunded. Provider refusal (kie 429, Higgsfield concurrency 400) → 429
   `busy`; other errors → 502 `media_failed`; fal `has_nsfw_concepts` → 422 `nsfw`. All three refund once.
7. fal answers `done`: finalize inline (download ≤ 15 s, JPEG, put ≤ 20 s, both bounded by the deadline; a failed copy
   keeps the fal URL, A25). Task gets `imageUrl`, `imagePrompt`, `imageProvider: "fal"`, `imageModel`, `mediaCredits`,
   `mediaApplied` (through `updateTask`, before the job is saved); job `done`; spend counted; `track(email, "image")` when
   the account that paid still exists as that account (A32). 200 `{ok, task, credits, provider: "fal", job}`.
8. kie or Higgsfield answer with a task id: it must match `PROVIDER_TASK_ID`; job `running`, `providerTaskId` and
   `mjobref:{provider}:{id}` saved in one round. 202 `{ok, job, task, credits}`; the inbox polls (sequence E).
9. After the response: `after(() => maybeSweep(deps, deadline))`.

Worst case, image route: prompt 20 + fal 45 + download 15 + put 20 + sharp ~2 = ~102 s, inside the 105 s deadline of
`maxDuration = 120`. Video route: prompt 20 + submit 20 = 40 s.

**B. kie details.** `POST https://api.kie.ai/api/v1/jobs/createTask` (or `/api/v1/veo/generate`) with `Authorization:
Bearer ${KIE_API_KEY}` and, when A4 allows, `callBackUrl: ${APP_ORIGIN}/api/media/hook/kie`. Response `{code: 200,
data: {taskId}}`.

**C. Higgsfield details.** `Authorization: Key ${HIGGSFIELD_API_KEY_ID}:${HIGGSFIELD_API_KEY_SECRET}`, submit to
`https://api.higgsfield.ai/{endpoint_id}` with `?hf_webhook=<url-encoded hook URL>` when A4 allows, response
`{status: "queued", request_id}`. The submit is never retried: Higgsfield has no idempotency key, so a retry after an
ambiguous timeout could render and bill twice (research: SDK gotcha).

**D. Webhook (hint only, A30)**

1. `POST /api/media/hook/{provider}`, public, `maxDuration = 120`. Unknown provider or provider not configured: 404.
2. `allow("mhook:{provider}:{ip}", 240, 60)`: 429.
3. Body at most 64 KB (413), JSON (400). The only field read is the provider task id: kie `taskId` / `data.taskId` /
   `data.task_id`; Higgsfield `request_id`. It must match `PROVIDER_TASK_ID[provider]` (400).
4. kie with `KIE_WEBHOOK_HMAC_KEY` set: `X-Webhook-Timestamp` within ±300 s and `X-Webhook-Signature` equal to
   `base64(HMAC-SHA256(taskId + "." + timestamp, key))`, compared with `sameSecret` (401). Higgsfield webhooks are
   unsigned (research) and are accepted as hints.
5. `jobForHook(provider, id)`: read `mjobref:{provider}:{id}`; load `mjob:{ref.scope}:{ref.jobId}`; require
   `job.provider === provider && job.providerTaskId === id`. No job: 200 (no oracle), no provider call.
6. `after(() => advance(job, deps, {deadline, via: "hook"}))` without `force`: the hint shares the job's 4 s poll
   throttle and job lock, so any number of hints cost at most one provider status call per job per 4 s. Then 200
   `{ok: true}` at once (kie wants a 200 within 15 s, Higgsfield within 10 s). `advance` re-fetches the status with our
   key; result URLs in the body are never read.

**E. Poll**

1. `GET /api/media/{jobId}`, `maxDuration = 120`: `currentUser` (401); `jobId` must match `^[a-f0-9]{32}$` (404);
   `getJob(sc(u), jobId)` (404: another account's job id reads as not found and causes no provider call).
2. `allow("mpoll:u:{email}", 120, 60)` else 429 `slow_down` (the inbox backs off).
3. `advance(job, deps, {deadline, via: "poll"})`: terminal jobs return as they are; `queued` → `submit_lost` after 3
   minutes; otherwise the `mpoll` lock (4 s) and the job lock decide whether this poll may make the one status call
   (≤ 15 s); a job with `resultUrls` is copied without a status call; `pending` past max age → cancel + fail `timeout`;
   `done` → finalize when the deadline leaves room (image 25 s, video 60 s), else left for the next poll; `failed` → fail
   with `nsfw` or `provider_failed`.
4. 200 `{ok, job}` plus `task` when done, plus the account's `credits` when failed. After the response:
   `after(() => maybeSweep(deps, deadline))`.

**F. Sweeps (A3)**

`sweepMedia(deps, {deadline, limit?})` reads the three open sets together (`Promise.all`), loads every job with `pmap`,
removes members whose record is gone or terminal, and runs `advance(job, deps, {force: true, deadline, via: "sweep"})`
on jobs older than 2 minutes or holding `resultUrls`, oldest first, `pmap(..., 4)`, starting none with less than 20 s
left. It never awaits Redis inside a loop. `GET /api/cron/media` (`Authorization: Bearer ${CRON_SECRET}`, `sameSecret`,
401 otherwise; `maxDuration = 300`) runs it with the full budget; `maybeSweep` runs it with `limit: 6` only when it wins
`msweep` (300 s) and at least 30 s are left.

**G. Placeholder (no fal key, or `img-fast` switched off, default model)**

Nothing is charged. Through `updateTask`, on the task as stored, the task gets the placehold.co card, the fixed prompt,
`imageProvider: "placeholder"` and `mediaCredits: 0` when it had none (`imageModel` removed), and the response is 200
`{ok, task, credits, provider: "placeholder"}` exactly as before (`tests/regressions.test.ts:276-295, 368-386`). When
the task as stored already has artwork (`hasArtwork`), including an image of another style that finished while the
placeholder waited for the task lock, nothing is written and the answer is 409 `model_unavailable`
(`src/lib/media/start.ts:31-53`); the chat tool then says the item keeps its current image and no credit was used. An image of another style that finishes after the card was written replaces it, because the card leaves `task.mediaJob` as it was.

### 4.5 Prompts and the pause

`CLAUDE_PAUSED` stays (`src/lib/model.ts:12`, `true` today). The pause stops Claude, never the renderer. While paused,
the inbox says so above the media buttons (plan, package 7), because every render then comes from a fixed brand template
rather than from the post.

- `imagePrompt(brand, task, model, aspect, email, timeoutMs)`: when `modelState() !== "on"`, a fixed template by style.
  Photo (`img-fast`, `img-balanced`, `img-premium`) keeps today's text (`src/lib/images.ts:13`) with the aspect fixed:
  `Premium {industry} product photo for {name}, Gulf aesthetic, warm light, clean background, no text, {1:1 | 9:16}`.
  Lifestyle (`img-lifestyle`): `Natural lifestyle photo for {name}, a {industry} business: its product or service in use
  in a modern Gulf setting, modest styling, no close-up faces, no text, {ratio}`. Text (`img-text`, A27): the brand name
  as a short English headline when it is plain Latin text, else the design template. Design (`img-design`): a flat
  graphic with bold shapes and a Gulf palette, no lettering. When on: `claude-sonnet-5`, `max_tokens` 400, effort low,
  `{timeout: min(20 s, timeoutMs), maxRetries: 0}`, the same Gulf-fit system rule as today (`images.ts:22`) with a
  per-style variant (text: "one short headline in English, at most 6 words, taken from the post"); metered as
  `image_prompt`; failure or empty output → the fixed template (A12).
- `videoPrompt(brand, task, model, fromImage, email, timeoutMs)`: paused → `{seconds}-second vertical social video for
  {name}: a scene that represents a {industry} business, slow camera push-in, warm Gulf light, modest styling, no text
  on screen, no close-up faces, no speech, no dialogue, no voice-over` (with `fromImage`: `Animate this photo: slow
  camera push-in, gentle light movement, ...` with the same rules). When on: Sonnet writes one English prompt of at most
  70 words describing one continuous shot, camera movement, subject and light under the same cultural rules and "no
  speech, no dialogue, no voice-over". Metered as `image_prompt` (A18). The prompt is shown under the video in the inbox
  as the image prompt is under the image.

### 4.6 Storage and JPEG

`copyToBlob(sourceUrl, kind, deadline)`:

1. `https:` only (`not_https`). Fetched with `safeFetch(url, init, {httpsOnly: true})` (the URL is provider output, so
   untrusted; `src/lib/media/blob.ts:62`): every hop, the first and each redirect, must be https, so a redirect to plain
   http is refused before it is requested (`unsafe_url:not_https`, reported as `fetch_failed`). Budget
   `min(image 15 s | video 45 s, left − 10 s)`; less than 3 s → `no_time`.
2. `Content-Length` above the cap (image 25 MB, video 100 MB) is refused before reading; the body is read with a running
   total and aborted past the cap (`too_large`).
3. Magic bytes decide, not the header: images must be JPEG, PNG, WebP or GIF; video must carry `ftyp` at offset 4
   (`not_media`).
4. Images: `sharp(buf, {limitInputPixels: 40_000_000}).rotate().flatten({background: "#ffffff"}).resize({width: 1440,
   height: 1920, fit: "inside", withoutEnlargement: true}).jpeg({quality: 88, mozjpeg: true})`. `failOn` stays at
   sharp's default `"warning"`, which sharp 0.35.4 recommends for untrusted input
   (`node_modules/sharp/dist/index.d.mts:989-991`). Transparent PNGs become white, not black. Video bytes are stored
   unchanged.
5. `put("media/{32 hex}.jpg|.mp4", body, {access: "public", contentType, addRandomSuffix: false, allowOverwrite: false,
   cacheControlMaxAge: 31536000, token: BLOB_READ_WRITE_TOKEN, abortSignal: timeout(min(image 20 s | video 30 s,
   left))})`. The path carries no email, scope or task id. The returned URL must pass `isOurBlobUrl`.

`probeBlob(signal)` (console only): `put("media/check-{16 hex}.txt", "ok", {access: "public", ...})`, `isOurBlobUrl`
on the result, then `del(url, {token})`; returns `ok` or a fixed error code.

The store must be created with public access: Instagram and Facebook fetch the image by URL
(`src/lib/connectors/meta.ts:101,111`). The URL is unguessable (128 random bits).

### 4.7 Publishing

One helper, `hasArtwork(t) = !!t.imageUrl && ["fal", "kie", "higgsfield"].includes(t.imageProvider)`, in the
import-free catalog, replaces the three `imageProvider === "fal"` checks: `src/lib/connectors/targets.ts:30`,
`src/lib/connectors/publish.ts:45`, `:50`, and the inbox hint at `src/components/app/Inbox.tsx:258`. Legacy fal tasks keep
working; tasks with no `imageProvider` and placeholders stay non-artwork (as today). `chat.ts:90` and
`app-i18n.ts:76,181` contain only wording ("generated image"), which stays true, so they do not change. Video is never a
publish target in this round; the inbox says so under every video.

### 4.8 Throttles and limits

| Limit | Value | Where |
|---|---|---|
| Per account, images | 30 per hour, 150 per day | `allow("media:image:h|d:{email}")` in `startMedia`, after the flight lock |
| Per account, videos | 6 per hour, 20 per day | `allow("media:video:h|d:{email}")` |
| Trial accounts, video | 1 kept per trial; 12-credit models only | `mtrialvid:{email}` lock, `TRIAL_VIDEO_MODELS` (A29) |
| kie creates, all tenants | 18 per 10 s | `allow("kie:create", 18, 10)` |
| Higgsfield, all tenants | 2 live jobs (`HF_MAX_OPEN`), 1 per account, videos at most 1 | admission (A10) |
| Provider status calls | 1 per job per 4 s, never while the job is being copied | `mpoll:{jobId}` + `mjoblock:{jobId}` |
| Polls per account | 120 per minute | `allow("mpoll:u:{email}", 120, 60)` |
| Webhooks | 240 per minute per IP | `allow("mhook:{provider}:{ip}", 240, 60)` |
| Breaker | 3 failures per model per hour → off 6 h; overbill → off 6 h; no balance → provider off 1 h | `media:off` (A22) |

Every `allow()` window above is set with EXPIRE NX on every hit (`src/lib/rate.ts:13`, `db.expireNx`), not by a SET
on the first hit: the window starts at the first hit, later hits never move it, concurrent hits are all counted, and a
counter whose expiry call failed gets one at the next hit, so `rate:kie:create` can never refuse every tenant for good. A
store that refuses the NX form falls back to the first hit's SET (`:18`).

A provider's own rate or concurrency refusal at submit (kie 429, Higgsfield 400 "Maximum number of concurrent
requests") maps to `busy`: the credit is refunded at once and the owner sees "busy, no credits were used, try again in a
minute".

### 4.9 Founder console

At every terminal transition the engine increments, for the job's model and month, `render:_all:{month}:m:{model}:jobs`
(done) or `:failed`, `:credits` (credits kept, done only) and `:usd_micro` (done and `store_failed`: the provider billed
us; `timeout` is not counted because we cannot know), plus `render:_all:{month}:kie_centicredits` when kie reported
`creditsConsumed`, and pushes the job's summary to `mjobs:recent`. All values are integers (A31). `renderSpend()` reads
the counters with one `Promise.all` and derives the provider and month totals. `overview()` (`src/lib/admin-stats.ts:24`)
reports `renderCostUsd` and the breakdown, and the gross margin subtracts model cost plus render cost. The billing tab
shows a "Render cost this month $" tile, a per-model table (jobs, failed, credits kept, USD, $ per credit), the recent
jobs, the disabled models, and a "Check media providers" button backed by `GET /api/admin/media` (A15), where `webhooks:
off` and a red Blob probe are shown in red.

## 5. Security model, rule by rule (CLAUDE.md)

| CLAUDE.md rule | How this design holds it |
|---|---|
| Tenant isolation through `sc(u)`; never a key from a request id/email/scope | Jobs are stored at `mjob:{sc(u)}:{id}` and read only with the caller's `sc(u)`. The engine writes tasks only under `job.scope`, which the server set at creation, always through `updateTask` (whose `tasklock` key is built from that scope), and notifies only `job.email`. The webhook finds a job only through the server-written `mjobref` pointer (format-checked id, scope taken from the stored value, provider and task id cross-checked). Admission reads other tenants' open jobs only to count them; nothing of theirs is returned. Test: another account's job id is 404 and triggers no provider call; a webhook naming another tenant's task id cannot write anywhere but that job's own scope. |
| Every route authenticates first; new public routes need a rate limit | Image, video and poll: `currentUser()`. Cron: `CRON_SECRET` via `sameSecret`. Admin: `isAdmin(req)`. The webhook is the one public route: per-IP `allow()`, a body cap, kie HMAC when configured, and a hint costs at most one throttled status call. |
| User-supplied URLs only through `safeFetch` | Provider result URLs are untrusted output and are downloaded only through `safeFetch` in `blob.ts`, with `httpsOnly` so every redirect hop is https too, also when retried from `resultUrls`. URLs inside webhook bodies are never read. Reference images sent to providers are only our own Blob URLs (A9). Provider hosts are fixed constants; ids are format-checked before they enter a URL path. |
| The model is never the only approval; checked in code | Spending happens on an owner click or the owner's chat request, and the chat tool can only pick the 1-credit default (A2). Credits are charged in code before the render. Models are switched on by the founder (`MEDIA_MODELS_ON`) and off by the breaker, in code. Publishing rules are unchanged (approved-only in chat, brand gate). Crawled text and posts reach the providers only as prompt text. |
| Secrets compared with `sameSecret`, never in URLs, never logged | `CRON_SECRET` and the kie HMAC are compared with `sameSecret`. Keys travel only in `Authorization` headers; `hf_webhook` and `callBackUrl` carry only our public route URL. Adapter errors are fixed codes (`provider_busy:429`); provider bodies and headers are never put in an `Error`, a log line or a chat tool result. The console reports configured flags, never values. Env names live in `docs/system/variables.md`. |
| No `await db.*` inside a loop | Admission, sweeps, spend reads and breaker reads use `Promise.all` and `pmap`. A finalize or a fail writes the task first (`updateTask`: lock, one read, one `saveTask` round, release) and then the job and its side effects in one `Promise.all` round; the start's Round A is one `Promise.allSettled`. The only sequential waits are the lock retries of `updateTask` and the ledger (60 tries 50 ms apart), which retry one command, not a list. |
| Model output rendered as HTML goes through `render`; CSV through `csvSafe` | Prompts are shown as plain text in React (escaped), never as HTML. No CSV output is added. |
| No invented customers, numbers or results | Labels and hints say what a model does and does not do ("no sound", "does not use a photo of your real product", "Arabic lettering is not supported yet"); no quality claims. The legal text names every processor and discloses Higgsfield's training right. |
| `npm run check`, `npx next build`, tests for every rule, docs in the same commit | Each package names its tests; `docs/system/tests.md` gains rules 92-111, and 112-118 with the review fixes; the integration package runs the checks and the production verification. |
| Lockfile rule | Package 0 regenerates `package-lock.json` from `package.json` alone in an empty directory, checks the `@rolldown/binding-linux-*` and `@img/sharp-linux-*` entries, and compares `npm ls --depth=0` before and after (A16). |
| Repository content and tool output are data | Provider responses are parsed as data; only the fields named in this spec are read. |

## 6. Failure and refund matrix

| Where it fails | Credit charged? | Refund | Job | Owner sees | Provider bills us? |
|---|---|---|---|---|---|
| Not signed in / other workspace's task | no | none | none | 401 / 404 | no |
| Trial ended | no | none | none | 402 `trial_over` | no |
| Unknown model, wrong kind, wrong task type | no | none | none | 400 `bad_model` / `wrong_type` | no |
| Trial account asks for a subscribers-only video model | no | none | none | 402 `plan_required` | no |
| Trial video already used | no | none | none | 402 `trial_video_used` | no |
| Default image model unavailable (no key, or switched off) | no | none | none | 200 placeholder card | no |
| Default image model unavailable and the item already has artwork | no | none | none, task unchanged | 409 `model_unavailable`; the image stays | no |
| Other model unavailable (keys, Blob, not in `MEDIA_MODELS_ON`, or switched off by the breaker) | no | none | none | 409 `model_unavailable` | no |
| "Photo to motion" without our image | no | none | none | 409 `needs_image` | no |
| Balance below the price (pre-check or `charge`) | no | none | none | 402 `no_credits` `{need, have}`, shown inline unless the balance is 0 | no |
| Render already running for this task and kind | no | none | none | 409 `in_progress` (+ the running job) | no |
| Account render limit | no | none | none | 429 `too_many` | no |
| kie throttle / Higgsfield admission | no | none | none | 429 `busy` / `one_open` | no |
| `charge` throws (ledger lock timeout) | no | none | none | 429 `busy`; flight lock released | no |
| Redis write fails after the charge, before the job is durable | yes | once, immediately (`refundOnce`) | none, or a queued record that later ends `submit_lost` without a second refund | 502 `media_failed`, balance restored | no |
| ... and that refund fails too | yes | once, by the next poll or sweep, 3 min after the start | the queued record, its member and the task pointer written again; ends `submit_lost` | 502 `media_pending` ("any credits used come back"), then failed on the next poll | no |
| Sonnet prompt fails or times out | yes | none (fixed prompt used) | continues | nothing | no |
| Less than 5 s left before the submit | yes | once, immediately | failed `submit_failed` | 502 `media_failed`, balance restored | no |
| Submit refused (429, 400 concurrency) | yes | once, immediately | failed `submit_failed` | 429 `busy`, balance restored | no |
| Submit error, network error or timeout | yes | once, immediately | failed `submit_failed` (defect-class errors count toward the breaker) | 502 `media_failed`, balance restored | usually no; an ambiguous timeout may still render |
| Provider balance empty | yes | once, immediately | failed `submit_failed`; the provider's models switched off 1 h | 502 `media_failed`, balance restored | no |
| fal flags the image (`has_nsfw_concepts`) | yes | once, immediately | failed `nsfw` | 422 `nsfw`, balance restored | yes (fraction of a cent) |
| Function killed after the job was saved (deadline miss, platform) | yes | once, by the next poll (the inbox finds the job through `task.mediaJob`) or a sweep, 3 min after the start | failed `submit_lost` | failed on the next poll | possibly |
| Provider reports failure | yes | once | failed `provider_failed` | failed, credits returned | no (kie FAQ, Higgsfield docs) |
| Provider content refusal | yes | once | failed `nsfw` | failed, content message | no |
| Still pending at max age | yes | once (+ Higgsfield cancel) | failed `timeout` (counts toward the breaker) | failed | possibly |
| Copy to Blob fails (kie, Higgsfield) | yes | none yet | stays `running` with `resultUrls`; retried up to 3 times, 30 s apart | still rendering | yes |
| Copy still failing after 3 tries or past max age | yes | once | failed `store_failed` (counts toward the breaker; cost recorded) | failed, credits returned | yes (we absorb it; the breaker bounds it) |
| Copy to Blob fails (fal) | yes | none | done, hot-linked fal URL (today's behaviour) | the image | yes |
| Task deleted before the result arrives | yes | none | done, no task write | nothing | yes |
| Account deleted (or deleted and re-registered) before the refund | yes | none | failed, `refunded: false`, member removed, marker set to `"none"` (7 days), no notification | — | depends |
| `fail` refunded but could not save, then the provider reports done | yes | the one refund already made | failed, task not written | failed | yes |
| A pass dies holding the refund claim (after or before the ledger call) | yes | at most once: the next pass throws `refund_pending` until the 60 s claim expires, then refunds, unless the marker already says `"done"` | stays open meanwhile | still rendering, then failed | — |
| The task write fails at finalize | yes | none | stays `running` with `resultUrls`; the next pass delivers it without another status call and counts its credits once (`mediaApplied`) | still rendering, then the result | yes |
| Duplicate webhooks, two tabs, sweeps racing a poll | — | never twice (`mjoblock` + `mrefund`) | — | — | — |
| `refund()` throws a transient error | — | retried by the next poll or sweep (the claim is released) | stays open | — | — |
| Owner left the page | — | as above | as above | an in-app notification (success or failure) and `mediaLast` on the card | — |

## 7. Environment variables

| Name | Enables | Read in | Without it | Secret |
|---|---|---|---|---|
| `FAL_KEY` (existing) | `img-fast` | `src/lib/media/config.ts`, `src/lib/media/fal.ts` | Default image model returns the placeholder card, not charged | Yes |
| `KIE_API_KEY` | `img-balanced`, `img-premium`, `img-text`, `vid-quick`, `vid-sound`, `vid-premium` | `config.ts`, `kie.ts` | Those models are not offered and refused with 409 | Yes |
| `KIE_WEBHOOK_HMAC_KEY` | Signature check on kie callbacks | `src/app/api/media/hook/[provider]/route.ts` | kie callbacks are accepted as unsigned hints (safe: they only trigger a throttled status re-fetch with our key) | Yes |
| `HIGGSFIELD_API_KEY_ID` | `img-lifestyle`, `img-design`, `vid-cinematic`, `vid-motion` (with the secret) | `config.ts`, `higgsfield.ts` | Those models are not offered | Yes |
| `HIGGSFIELD_API_KEY_SECRET` | same | same | same | Yes |
| `BLOB_READ_WRITE_TOKEN` | Copying results to Vercel Blob | `config.ts`, `blob.ts` | No kie or Higgsfield model is offered; fal hot-links as today | Yes |
| `MEDIA_MODELS_ON` | Which catalog models (besides `img-fast`) owners may use, comma-separated ids, e.g. `img-balanced,img-lifestyle,vid-quick` | `config.ts` | Only `img-fast` is offered | No |
| `APP_ORIGIN` (existing) | Callback URLs for provider webhooks | `config.ts` `callbackUrl` | No webhooks: jobs finish by polling and the sweeps; the console shows `webhooks: off` | No |

Totals after this change: 43 names (25 in sections 1 to 4 of `variables.md`, 18 connector credentials), 22 secrets.

## 8. Owner setup steps (the founder, never in chat)

These steps also go into `docs/Owner_Tasks_AR.md` (plan, package 9b).

1. Vercel → Storage → Create → Blob, **public** access, connect it to the Nashr project for Production (and Preview if
   wanted). Vercel adds `BLOB_READ_WRITE_TOKEN` itself.
2. kie.ai: top up, create a key at https://kie.ai/api-key, set its hourly, daily and total credit caps (the spend
   backstop; the IP whitelist does not suit Vercel), add `KIE_API_KEY` to the Vercel Production environment. Optional:
   generate the webhook HMAC key at https://kie.ai/settings and add `KIE_WEBHOOK_HMAC_KEY`. Email support@kie.ai to confirm
   output rights, resale inside a SaaS and how tenant prompts and images are used (research: terms are silent).
3. Higgsfield: at https://open.higgsfield.ai create an API key (the secret is shown once), top up (minimum $5), turn auto
   top-up off or cap it, note the concurrency the console shows, add `HIGGSFIELD_API_KEY_ID` and
   `HIGGSFIELD_API_KEY_SECRET`. If the key ever leaks, Higgsfield must be told within 24 hours (ToS 11.4).
4. Make sure `APP_ORIGIN` is the https production origin, leave `MEDIA_MODELS_ON` unset, then redeploy. Owners still see
   only "Fast".
5. Open the founder console → Billing → "Check media providers": Blob probe green, every configured provider green, the
   kie balance shown, each Higgsfield model with an estimate, `webhooks: on`. Fix any red line first.
6. Turn models on one at a time: add the ids whose lines are green to `MEDIA_MODELS_ON` (for example
   `img-balanced,img-lifestyle`), redeploy, render one item with each on a test brand, and read the per-model row in the
   console. For `vid-sound`: note the kie balance, render one clip with nothing else running, check the balance again
   (60 credits = Fast, about 250 = Quality: stop and report). Keep `img-text` off, or tell owners it is English-only,
   until an Arabic headline test has passed and been recorded; then report what you saw. To turn a model off, remove its
   id and redeploy; the breaker's switches clear themselves after 6 hours (or delete the `media:off` key in Upstash).
7. Accept or sign the providers' data-processing terms and record each date in `docs/Owner_Tasks_AR.md`. The privacy
   policy says "under data-processing agreements" only for providers whose acceptance is recorded (plan, package 9a).
8. If the Vercel plan allows sub-daily crons, ask for the media cron to run every 15 minutes (Q2).

## 9. Out of scope

- Publishing video to Instagram Reels, TikTok, Snapchat or Facebook (the inbox says so under every video).
- Product-photo uploads or brand assets as reference images; brand colour palettes for the design model.
- Arabic lettering inside images, and text overlay rendered by us over a text-free image (the reliable route to Arabic
  headlines).
- Deleting Blob files and media job records when an account or a task is deleted (follow-up; the help text says so).
- Letting the chat agent choose a model (A2); an MCP media tool.
- Automatic fallback to another provider when one fails (the owner picks again).
- Moderation of our own beyond the providers' checks and the prompt rules.
- Repricing existing task types.

## 10. Open risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Veo tier: the wrong selector would bill Quality ($1.25) for a 12-credit clip, and the legacy record-info may not report `creditsConsumed`. | A5; `vid-sound` stays out of `MEDIA_MODELS_ON` until the founder's balance-difference check (step 6); when `creditsConsumed` is reported, the breaker switches the model off above 66. |
| R2 | Higgsfield endpoint ids and strict schemas may differ from the docs per account. | `/estimate` through `GET /api/admin/media`; a model is turned on only when its line is green (A21); each body is one function. |
| R3 | `vid-cinematic` costs about $0.058 per credit at list price, above the $0.05 target; Higgsfield prices change and promotions expire 2026-10-01. | Per-model spend in the console; 480p fallback; founder reprices if needed. |
| R4 | Arabic text rendering is undocumented for every model. | A27: English-only headline, the label says so, the hint says Arabic lettering is not supported; the founder's Arabic test decides any change. |
| R5 | kie result URLs may expire in 24 hours (docs conflict). | Webhooks, inbox polling and the opportunistic sweep finish most jobs in minutes (A3); a failed copy is retried from `resultUrls` (A25). |
| R6 | kie commercial and resale terms are unclear; Higgsfield may train on inputs and outputs (ToS 4.4); no DPA is recorded yet. | Owner steps 2 and 7; the privacy policy names both processors and Higgsfield's training right, and claims a DPA only where one is recorded; no sensitive tenant data is sent beyond the prompt and our own image. |
| R7 | Content safety: none of the chosen kie models documents `nsfw_checker`; Gulf-fit rules live in the prompt, which is a fixed template while paused. | Providers' own filters, `enable_safety_checker` on fal with `has_nsfw_concepts` honoured, `nsfw` failures refunded; the owner approves every item before publishing. |
| R8 | Vercel Blob storage and transfer cost grows with every render and is not metered per tenant. | Visible on the Vercel bill; deletion on wipe is a follow-up (section 9). |
| R9 | A submit that times out ambiguously can render on the provider after we refunded. | Rare; bounded by per-account limits, the breaker and the kie key's credit caps. |
| R10 | Read-modify-write on the task: `saveTask` replaces the whole task, so a writer that saved a copy read before slow work (a publish, an approval, the judge, a finalize) erased whatever landed meanwhile, a paid render included. | Closed: every write to an existing task goes through `updateTask` under `tasklock:{scope}:{id}` (4.2) and applies only its own fields to the task as stored; `tests/task-writes.test.ts`. |
| R11 | Unsigned webhooks (Higgsfield, and kie without the HMAC key) can be spammed. | Per-IP limit; a hint only triggers a status call under the job's 4 s throttle and job lock (A30). |
| R12 | A `generate_image` call late in a long chat turn could be cut off by the chat route's 300 s ceiling. | Closed: `chat()` takes the request's deadline when it starts (`deadlineFor(CHAT_MAX_DURATION_S)`, 300 s, the `maxDuration` of `/api/chat` and `/api/mcp`, kept equal by `tests/chat-deadline.test.ts`), the tool renders against it, and with less than `CHAT_RENDER_MIN_MS` (60 s) left it starts nothing and charges nothing. A render cut off anyway is refunded as `submit_lost` by the next poll or sweep, because the job is saved with `task.mediaJob` before the submit; the chat path is off while Claude is paused. |
| R13 | Higgsfield admission is check-then-submit, not atomic; two simultaneous starts can both pass. | Higgsfield refuses the extra request with its concurrency error, which is `busy` with an immediate refund. |

## 11. Open questions only the founder can answer

| # | Question | Default until answered |
|---|---|---|
| Q1 | Trial accounts and video: one 12-credit clip per trial, no Premium or Cinematic (A29)? Or no video on trial at all, or the full catalog? | One 12-credit clip per trial. |
| Q2 | Which Vercel plan is the project on? If it allows sub-daily crons, the media sweep runs every 15 minutes. | Daily cron plus the opportunistic sweep. |
| Q3 | Which data-processing agreements have actually been accepted (Anthropic, Vercel, Upstash, Resend, fal.ai, kie.ai, Higgsfield), and on what dates? | The privacy policy claims none for kie.ai and Higgsfield and keeps today's wording for the others only if their acceptance is recorded; otherwise the phrase is dropped. |
| Q4 | Is `vid-cinematic` kept at 12 credits if `/estimate` confirms ~$0.70 (above the $0.05 per credit target), or repriced, or moved to 480p? | 12 credits, 720p, reviewed after the first week of spend. |
| Q5 | After the Arabic headline test: keep `img-text` English-only, change it, or remove it? | English-only. |
