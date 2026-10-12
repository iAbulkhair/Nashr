# Media providers and video: implementation plan

> **Status update (2026-10-12, from `git log origin/main` and the files named; the status line below is the state when the document was written):** built (the media routes, adapters and `src/lib/media/` are on `main`; rules in `docs/system/tests.md`); PR numbers not looked up. The `- [ ]` boxes below were never ticked as steps ran: they are the task list, not open work; the spec's status update and `docs/system/tests/` say what shipped.

Design: `docs/superpowers/specs/2026-09-29-media-providers-design.md` (read it first; section and decision numbers below
refer to it). Revised on 2026-09-29 after a 47-point critique; the verdict on each point is in the "Critique log" at the
end. Code references are to HEAD `99d9801`. Next.js is 16.3.5: route handlers take `ctx: { params: Promise<{...}> }` and
await it, `export const maxDuration = N` sets the ceiling, and `after()` from `next/server` runs after the response
inside that ceiling (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`,
`.../02-route-segment-config/maxDuration.md`, `.../04-functions/after.md`). Never open `.env*` files.

## 0. How the work is split

Thirteen packages. Every file belongs to exactly one package; no two packages edit the same file. Packages in the same
wave run in parallel in the same working tree.

```
wave 0   P0 contracts (lead)
wave 1   P1 fal+prompts · P2 kie · P3 higgsfield · P4 blob · P5 publishing · P6 job engine · P7 inbox UI
wave 2   P8 routes+wiring · P9a legal, help, product text · P10 founder console + reports
wave 3   P9b system and owner docs (needs P8, P9a and P10 landed: it counts routes and names their functions)
wave 4   Z integration (lead)
```

Why this order: wave-1 packages import only P0 files and code that exists today, so each can run its own tests at once.
The job engine takes providers and storage as an injected `MediaDeps` object (spec A6), so it does not import the
adapters or the Blob store. P8 wires the real adapters (`registry.ts`); P10 calls the adapters' `check`, P4's
`probeBlob`, P6's counters and P7's `reports.videos` string. P9b documents what the other packages built, so it runs
alone after them.

While a wave is in progress, `npx tsc --noEmit` may report errors only in files that import a module another package of
the same wave has not landed yet. Each package runs its own test files with `npx vitest run tests/<file>` and `npx eslint
<its files>`; the full `npm run check` belongs to Z.

### File ownership

| Package | Owns (create, edit or delete) |
|---|---|
| P0 contracts | `package.json`, `package-lock.json`, `src/lib/media-catalog.ts` (new), `src/lib/media/types.ts` (new), `src/lib/media/keys.ts` (new), `src/lib/media/config.ts` (new), `src/lib/tasks.ts`, `src/lib/brand.ts`, `tests/helpers/media.ts` (new), `tests/client-bundle.test.ts`, `tests/media-catalog.test.ts` (new) |
| P1 fal + prompts | `src/lib/media/fal.ts` (new), `src/lib/media/prompts.ts` (new), `tests/media-fal.test.ts` (new), `tests/media-prompts.test.ts` (new) |
| P2 kie | `src/lib/media/kie.ts` (new), `tests/media-kie.test.ts` (new) |
| P3 Higgsfield | `src/lib/media/higgsfield.ts` (new), `tests/media-higgsfield.test.ts` (new) |
| P4 Blob store | `src/lib/media/blob.ts` (new), `tests/media-blob.test.ts` (new) |
| P5 publishing | `src/lib/connectors/targets.ts`, `src/lib/connectors/publish.ts`, `tests/meta-publish.test.ts` |
| P6 job engine | `src/lib/media/jobs.ts` (new), `tests/media-jobs.test.ts` (new) |
| P7 inbox UI | `src/components/app/Inbox.tsx`, `src/components/app/MediaControls.tsx` (new), `src/app/[lang]/app/page.tsx`, `src/lib/app-i18n.ts` |
| P8 routes + wiring | `src/lib/media/registry.ts` (new), `src/lib/media/start.ts` (new), `src/lib/images.ts` (delete), `src/lib/chat.ts`, `src/app/api/tasks/[id]/image/route.ts`, `src/app/api/tasks/[id]/video/route.ts` (new), `src/app/api/media/[jobId]/route.ts` (new), `src/app/api/media/hook/[provider]/route.ts` (new), `src/app/api/cron/media/route.ts` (new), `vercel.json`, `tests/media-routes.test.ts` (new), `tests/regressions.test.ts`, `tests/model-pause.test.ts`, `tests/p1-round2.test.ts`, `tests/routes-isolation.test.ts` |
| P9a legal, help, product text | `src/lib/legal.ts`, `src/lib/help.ts`, `PRODUCT.md`, `tests/content-claims.test.ts` |
| P9b system and owner docs | `docs/system/architecture.md`, `docs/system/flows.md`, `docs/system/permissions.md`, `docs/system/variables.md`, `docs/system/costs.md`, `docs/system/tests.md`, `docs/Owner_Tasks_AR.md`, `docs/Project_Summary_AR.md`, `docs/Requirements_and_Steps_AR.md` |
| P10 founder console and reports | `src/lib/admin-stats.ts`, `src/lib/stats.ts`, `src/components/app/AdminConsole.tsx`, `src/components/app/ReportsPanel.tsx`, `src/app/api/admin/media/route.ts` (new), `tests/media-admin.test.ts` (new) |
| Z integration | no source files; runs the checks and the production verification. A defect found here is fixed by the owning package. |

Files that must NOT change: `src/app/api/mcp/route.ts` (no media tool, spec section 9), `src/app/api/cron/daily/route.ts`
(spec A3), `src/lib/usage.ts`, `src/lib/account.ts` (spec A18, A19: no per-email render counter exists, so the wipe list
needs nothing new), `src/lib/track.ts` (A17), `src/lib/connectors/meta.ts`, `src/lib/db.ts`, `src/lib/credits.ts`,
`src/lib/notifications.ts`, `src/components/app/LimitModal.tsx`.

### Style rules for every package

- Match the neighbours: short top-of-file comment that says why the module exists, comments only where a reader would
  otherwise re-introduce a bug, one-line helpers, no classes except the two error classes in P0.
- No provider SDK (`@higgsfield/client` auto-retries POSTs: duplicate charges). Plain `fetch`, fixed hosts.
- An `Error` created by media code carries a fixed code only (`provider_busy:429`, `store_too_large`). Never a provider
  body, a header or a key: the chat puts tool errors in front of the model (`src/lib/chat.ts:231`) and routes log them.
- No `await db.*` inside a loop: `Promise.all` or `pmap` (`src/lib/parallel.ts`).
- Every timeout is `min(step maximum, deadline − now)` (spec A23), built with `abortAfter(ms)` from `keys.ts` (a
  `setTimeout` + `AbortController`, which vitest fake timers control; `AbortSignal.timeout` is not).
- Counters are integers (spec A31): `Math.round` before every `incrby`.
- New Arabic strings addressed to the owner use verbal nouns or the passive, never a gendered imperative. Button labels
  that ask Noor for something keep the existing feminine form ("ولّدي صورة").
- Tests never reach the network: `noNetwork()` from `tests/helpers/media.ts`; `mediaEnv({...})` stubs every media
  variable, never only `FAL_KEY`; `resetMediaCounters()` in `beforeEach` of every media test file that starts jobs.

---

## P0. Shared contracts (wave 0, owner: lead)

Land this first, in one commit, then start wave 1.

### P0.1 Dependencies (`package.json`, `package-lock.json`)

Add to `dependencies` (`package.json:13-22`): `"@vercel/blob": "^2.8.0"` and `"sharp": "^0.35.4"` (Next already pulls
sharp 0.35 as an optional dependency, lock line 5835, so the versions dedupe). Then, per CLAUDE.md:

```sh
npm ls --depth=0 > "$TMPDIR/deps-before.txt"
TMP=$(mktemp -d) && cp package.json "$TMP"/ \
  && (cd "$TMP" && npm install --package-lock-only --ignore-scripts --cache "$TMPDIR/npm-cache") \
  && cp "$TMP"/package-lock.json ./package-lock.json && npm ci --cache "$TMPDIR/npm-cache"
npm ls --depth=0 > "$TMPDIR/deps-after.txt"; diff "$TMPDIR/deps-before.txt" "$TMPDIR/deps-after.txt"
grep -c '"node_modules/@rolldown/binding-linux-' package-lock.json     # > 0
grep -c '"node_modules/@img/sharp-linux-x64"' package-lock.json         # 1
grep -c '"node_modules/@img/sharp-libvips-linux-x64"' package-lock.json # 1
grep -c '"node_modules/@vercel/blob"' package-lock.json                 # 1
```

The `diff` may show only `@vercel/blob` and `sharp` added. If any other direct dependency moved (for example
`@anthropic-ai/sdk ^0.126.0`, whose default `maxRetries` spec A12 relies on, `@upstash/redis`, `resend`, `vitest`), pin
it back to the old version in `package.json` and regenerate, or name the upgrade in the commit message.
(`--cache` avoids the root-owned `~/.npm` cache seen on this machine.)

### P0.2 `src/lib/media-catalog.ts` (new, imports nothing)

```ts
/**
 * The media catalogue: every image and video model the owner can pick in the inbox, and its price in credits.
 *
 * This module imports NOTHING, for the reason given at the top of ./tasks: the inbox is a client component, and one
 * value import from a server module drags the Redis client into the browser bundle (pinned by
 * tests/client-bundle.test.ts). Endpoints, request bodies and our own cost live on the server, in src/lib/media/.
 * Labels say what a model does; hints say what it does and does not do. No vendor or model names, no quality claims.
 */
export type MediaKind = "image" | "video";
export type MediaProviderId = "fal" | "kie" | "higgsfield";
export type ImageModelId = "img-fast" | "img-balanced" | "img-premium" | "img-text" | "img-lifestyle" | "img-design";
export type VideoModelId = "vid-quick" | "vid-sound" | "vid-premium" | "vid-cinematic" | "vid-motion";
export type MediaModelId = ImageModelId | VideoModelId;
export type Aspect = "square" | "portrait";
/** Why a render ended without a result. The inbox has one message per value (app-i18n `mediaErr`). */
export type MediaFailure = "submit_failed" | "submit_lost" | "provider_failed" | "nsfw" | "timeout" | "store_failed";

export type MediaModel = {
  id: MediaModelId;
  kind: MediaKind;
  provider: MediaProviderId;
  label: { ar: string; en: string };
  hint: { ar: string; en: string };
  /** Credits for one render, shown beside the label: the price the owner sees is the price charged. */
  credits: number;
  /** Clip length in seconds (video only). */
  seconds?: number;
  /** Builds on the task's own generated image when it is on our Blob store (see mediaImageFor). */
  usesImage?: boolean;
  /** Cannot run without that image. */
  needsImage?: boolean;
};

export const MEDIA_MODELS: readonly MediaModel[] = [
  { id: "img-fast", kind: "image", provider: "fal", credits: 1, label: { ar: "سريعة", en: "Fast" }, hint: { ar: "جاهزة خلال ثوانٍ، للمنشورات اليومية.", en: "Ready in seconds, for everyday posts." } },
  { id: "img-balanced", kind: "image", provider: "kie", credits: 1, usesImage: true, label: { ar: "متوازنة", en: "Balanced" }, hint: { ar: "تبني على صورة المنشور الحالية إن وُجدت.", en: "Builds on the post's current image if there is one." } },
  { id: "img-premium", kind: "image", provider: "kie", credits: 2, usesImage: true, label: { ar: "صورة إعلانية فاخرة", en: "Premium ad image" }, hint: { ar: "أعلى دقة بين الخيارات. لا تستخدم صورة منتجك الحقيقية.", en: "The highest resolution here. It does not use a photo of your real product." } },
  { id: "img-text", kind: "image", provider: "kie", credits: 1, label: { ar: "صورة بعنوان إنجليزي", en: "English headline image" }, hint: { ar: "عنوان قصير بالإنجليزية داخل الصورة. الكتابة العربية داخل الصورة غير مدعومة بعد.", en: "A short English headline inside the image. Arabic lettering is not supported yet." } },
  { id: "img-lifestyle", kind: "image", provider: "higgsfield", credits: 1, label: { ar: "صورة حياتية", en: "Lifestyle photo" }, hint: { ar: "لقطة طبيعية بأسلوب التصوير الواقعي.", en: "A natural, real-life photo style." } },
  { id: "img-design", kind: "image", provider: "higgsfield", credits: 1, label: { ar: "تصميم جرافيك", en: "Graphic design" }, hint: { ar: "رسومات مسطحة بلا كتابة، تُضاف عليها تفاصيل العرض لاحقاً.", en: "Flat graphics with no lettering; add the offer details afterwards." } },
  { id: "vid-quick", kind: "video", provider: "kie", credits: 12, seconds: 5, usesImage: true, label: { ar: "مقطع سريع · 5 ث", en: "Quick clip · 5s" }, hint: { ar: "حركة بسيطة بلا صوت.", en: "Simple motion, no sound." } },
  { id: "vid-sound", kind: "video", provider: "kie", credits: 12, seconds: 8, usesImage: true, label: { ar: "مقطع بصوت · 8 ث", en: "Clip with sound · 8s" }, hint: { ar: "صوت محيط وموسيقى، بلا تعليق صوتي.", en: "Ambient sound and music, no voice-over." } },
  { id: "vid-premium", kind: "video", provider: "kie", credits: 24, seconds: 10, usesImage: true, label: { ar: "فيديو مميز · 10 ث بصوت", en: "Premium · 10s with audio" }, hint: { ar: "10 ثوانٍ، مع صوت محيط وموسيقى، بلا تعليق صوتي.", en: "10 seconds, with ambient sound and music, no voice-over." } },
  { id: "vid-cinematic", kind: "video", provider: "higgsfield", credits: 12, seconds: 5, usesImage: true, label: { ar: "سينمائي · 5 ث", en: "Cinematic · 5s" }, hint: { ar: "حركة كاميرا سينمائية، بلا صوت.", en: "Cinematic camera movement, no sound." } },
  { id: "vid-motion", kind: "video", provider: "higgsfield", credits: 12, seconds: 6, usesImage: true, needsImage: true, label: { ar: "تحريك الصورة · 6 ث", en: "Photo to motion · 6s" }, hint: { ar: "يحرّك صورة هذا المنشور، ويحتاج صورة مولّدة أولاً.", en: "Animates this post's image; needs a generated image first." } },
];

/** What the inbox button did before models existed, what the route uses without a `model`, and all the chat tool may use. */
export const DEFAULT_IMAGE_MODEL: ImageModelId = "img-fast";
export const MEDIA_MODEL_IDS: readonly MediaModelId[] = MEDIA_MODELS.map((m) => m.id);
/** Membership test for a model id from a request body. Not `in`, which walks the prototype chain (see isTaskType). */
export const isMediaModelId = (v: unknown): v is MediaModelId => typeof v === "string" && (MEDIA_MODEL_IDS as readonly string[]).includes(v);
export const mediaModel = (id: MediaModelId): MediaModel => MEDIA_MODELS.find((m) => m.id === id)!;
/** How long a render may run before it is failed and refunded. The inbox stops polling a little after this. */
export const MEDIA_MAX_AGE_MS: Record<MediaKind, number> = { image: 10 * 60_000, video: 30 * 60_000 };
/** Spec A29 (founder question Q1): the video models a trial account may use, and how many videos a trial keeps. */
export const TRIAL_VIDEO_MODELS: readonly VideoModelId[] = ["vid-quick", "vid-sound", "vid-motion"];
export const TRIAL_VIDEOS = 1;
/** From this price up, and for every re-render, the inbox asks before charging. */
export const CONFIRM_FROM_CREDITS = 12;
/** Portrait for video and for the vertical channels, square otherwise: the rule src/lib/images.ts:43 applied to fal. */
export const aspectFor = (kind: MediaKind, channel: string): Aspect => (kind === "video" || channel === "tiktok" || channel === "snapchat" ? "portrait" : "square");

/** Providers whose images are real artwork. A placeholder card is not, and neither is an image with no recorded provider. */
export const ARTWORK_PROVIDERS: readonly string[] = ["fal", "kie", "higgsfield"];
/** The one test for "this item has a generated image": Instagram, the Facebook photo post and the inbox hint all use it. */
export const hasArtwork = (t: { imageUrl?: string; imageProvider?: string }): boolean => !!t.imageUrl && ARTWORK_PROVIDERS.includes(t.imageProvider ?? "");
/** Our own Vercel Blob store (public access). Only these URLs are ever handed to a provider as a reference image. */
export function isOurBlobUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && u.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
}
/**
 * The image a render of `m` sends to the provider, or undefined. Only our own copy of a real generated image (spec A9).
 * Video takes it as a first frame only when it is portrait: Kling 2.5 image-to-video and Hailuo have no aspect field and
 * Seedance's applies to text-to-video only, so a square first frame gives a square clip (spec A26). Photo to motion
 * needs the image whatever its shape, and the inbox says the clip keeps it.
 */
export function mediaImageFor(m: MediaModel, t: { imageUrl?: string; imageProvider?: string; channel: string }): string | undefined {
  const img = m.usesImage && hasArtwork(t) && isOurBlobUrl(t.imageUrl) ? t.imageUrl : undefined;
  if (!img || m.kind === "image" || m.needsImage) return img;
  return aspectFor("image", t.channel) === "portrait" ? img : undefined;
}
```

### P0.3 `src/lib/media/types.ts` (new, type-only imports plus two error classes)

```ts
import type { Aspect, MediaFailure, MediaKind, MediaModelId, MediaProviderId } from "../media-catalog";
import type { Task } from "../brand";

/** What the engine hands an adapter. `imageUrl` is set only when mediaImageFor allowed it. */
export type SubmitInput = { model: MediaModelId; prompt: string; aspect: Aspect; imageUrl?: string };
/** fal answers in the same request (or refuses the content); kie and Higgsfield hand back a task id to poll. */
export type SubmitResult = { state: "pending"; providerTaskId: string } | { state: "done"; urls: string[] } | { state: "failed"; reason: "nsfw" };
export type StatusResult =
  | { state: "pending" }
  | { state: "done"; urls: string[]; /** kie `creditsConsumed`, when reported */ providerCredits?: number }
  | { state: "failed"; reason: "nsfw" | "provider_failed" };
/** Founder console check: balances and estimates only, never a secret. */
export type ProviderCheck = Record<string, number | string>;

export interface MediaAdapter {
  readonly id: MediaProviderId;
  /** Never retried by the caller: no provider offers an idempotency key, so a retry could render and bill twice. */
  submit(input: SubmitInput, signal: AbortSignal): Promise<SubmitResult>;
  status(ref: { providerTaskId: string; model: MediaModelId }, signal: AbortSignal): Promise<StatusResult>;
  cancel?(ref: { providerTaskId: string; model: MediaModelId }): Promise<void>;
  check?(signal: AbortSignal): Promise<ProviderCheck>;
}

export type ProviderErrorCode = "busy" | "no_balance" | "rejected" | "unavailable" | "bad_response";
/** The only error an adapter throws. Its message is a fixed code: never a provider body, header or key. */
export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, readonly status = 0) {
    super(`provider_${code}${status ? `:${status}` : ""}`);
    this.name = "ProviderError";
  }
}

export type StoredMedia = { url: string; bytes: number; contentType: "image/jpeg" | "video/mp4" };
export type StoreErrorCode = "not_https" | "fetch_failed" | "too_large" | "not_media" | "convert_failed" | "put_failed" | "no_blob" | "no_time";
export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode) {
    super(`store_${code}`);
    this.name = "StoreError";
  }
}

export type MediaJobState = "queued" | "running" | "done" | "failed";
export type { MediaFailure };

export type MediaJob = {
  /** 16 random bytes, hex. Server-generated. */
  id: string;
  /** sc(u) when the job was created: the only workspace this job ever reads or writes. */
  scope: string;
  /** The account charged (credits are per account, not per brand). */
  email: string;
  /** That account's createdAt: a refund or a notification goes only to the same account (spec A32). */
  accountSince: string;
  /** The owner's interface language, for the notification (spec A28). */
  lang: "ar" | "en";
  taskId: string;
  kind: MediaKind;
  model: MediaModelId;
  provider: MediaProviderId;
  credits: number;
  prompt: string;
  /** Reference image sent to the provider (our Blob URL), if any. */
  imageUrl?: string;
  providerTaskId?: string;
  state: MediaJobState;
  error?: MediaFailure;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** Provider result URLs not yet copied (untrusted; fetched only through safeFetch). Spec A25. */
  resultUrls?: string[];
  storeTries?: number;
  /** Our Blob URL (or, for fal without a working Blob store, the fal URL) once done. */
  url?: string;
  /** What this render cost us: kie creditsConsumed × $0.005 when reported, else the catalog estimate. */
  costUsd?: number;
  providerCredits?: number;
  refunded?: boolean;
  /** Holds the account's one trial video (mtrialvid): released if this job is refunded. */
  trialVideo?: boolean;
};

/** What the browser sees of a job. */
export type PublicJob = { id: string; kind: MediaKind; model: MediaModelId; credits: number; createdAt: string; state: "running" | "done" | "failed"; error?: MediaFailure };

/** Providers and storage, injected so the engine runs in tests with scripted fakes and no network. */
export type MediaDeps = {
  adapter(p: MediaProviderId): MediaAdapter;
  /** Copy a provider result to our store; every timeout inside is bounded by `deadline` (epoch ms). */
  store(sourceUrl: string, kind: MediaKind, deadline: number): Promise<StoredMedia>;
  blobReady(): boolean;
  now?(): number;
};

/** Who is moving a job forward. Only "hook" and "sweep" transitions notify the owner (spec A28). */
export type AdvanceVia = "start" | "poll" | "hook" | "sweep";
export type AdvanceOpts = { deadline: number; via: AdvanceVia; /** Skip the 4 s poll throttle (sweeps only). */ force?: boolean };

export type StartInput = {
  scope: string;
  email: string;
  lang: "ar" | "en";
  accountSince: string;
  plan: string;
  /** The balance read with the session: a pre-check so a request that cannot pay moves no counter (spec A24). */
  balance: number;
  taskId: string;
  model: MediaModelId;
  aspect: Aspect;
  imageUrl?: string;
  deadline: number;
  /** Called after the charge. Must not throw: prompts fall back to a fixed template. */
  prompt(timeoutMs: number): Promise<string>;
};
export type StartError =
  | "trial_over" | "bad_model" | "wrong_type" | "plan_required" | "trial_video_used" | "model_unavailable" | "needs_image"
  | "in_progress" | "busy" | "one_open" | "too_many" | "no_credits" | "nsfw" | "media_failed";
export type StartResult =
  | { ok: true; job: MediaJob; task: Task | null; credits: number }
  | { ok: false; status: 400 | 402 | 409 | 422 | 429 | 502; error: StartError; credits?: number; need?: number; have?: number; job?: PublicJob };

export type SweepReport = { open: number; advanced: number; done: number; failed: number; dropped: number; skipped: number };
```

### P0.4 `src/lib/media/keys.ts` (new, imports nothing)

```ts
/** Every Redis key the media engine writes (docs/system/architecture.md section 3). Built here and nowhere else. */
export const JOB_TTL_S = 7 * 86400;
/** A job id: 16 random bytes in hex, generated by the server. */
export const JOB_ID = /^[a-f0-9]{32}$/;

export const mk = {
  job: (scope: string, id: string) => `mjob:${scope}:${id}`,
  /** Webhook reverse index. The id must have passed PROVIDER_TASK_ID first; the scope comes from the stored value. */
  ref: (provider: string, providerTaskId: string) => `mjobref:${provider}:${providerTaskId}`,
  open: (provider: string) => `mjobs:open:${provider}`,
  openMember: (scope: string, id: string) => `${scope}|${id}`,
  recent: () => "mjobs:recent",
  flight: (scope: string, taskId: string, kind: string) => `mflight:${scope}:${taskId}:${kind}`,
  jobLock: (id: string) => `mjoblock:${id}`,
  refundOnce: (id: string) => `mrefund:${id}`,
  poll: (id: string) => `mpoll:${id}`,
  sweepLock: () => "msweep",
  hfClean: () => "mhfclean",
  trialVideo: (email: string) => `mtrialvid:${email}`,
  off: () => "media:off",
  offLock: () => "media:offlock",
  /** Render spend, global only (spec A19). Suffixes: m:{modelId}:{jobs|failed|credits|usd_micro}, kie_centicredits. */
  spend: (month: string) => `render:_all:${month}`,
};

/** Scope may contain "|" (emails allow it) but a job id never does, so split on the LAST one. */
export function parseOpenMember(m: string): { scope: string; jobId: string } | null {
  const i = m.lastIndexOf("|");
  const scope = m.slice(0, i), jobId = m.slice(i + 1);
  return i > 0 && JOB_ID.test(jobId) ? { scope, jobId } : null;
}

/** Formats a provider task id must match before it is put in a URL path or a key. fal never has one. */
export const PROVIDER_TASK_ID: Record<"fal" | "kie" | "higgsfield", RegExp> = {
  fal: /^(?!)$/,
  kie: /^[A-Za-z0-9_-]{6,80}$/,
  higgsfield: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
};

/** The one deadline of a request (spec A23): 15 s of room under the route's maxDuration. */
export const deadlineFor = (maxDurationS: number, t0 = Date.now()) => t0 + maxDurationS * 1000 - 15_000;
/** min(step maximum, time left), never negative. */
export const budget = (maxMs: number, deadline: number, now = Date.now()) => Math.max(0, Math.min(maxMs, deadline - now));
/** An abort signal built on setTimeout, so vitest fake timers control it (AbortSignal.timeout is not). */
export function abortAfter(ms: number): AbortSignal {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  (t as { unref?: () => void }).unref?.();
  return c.signal;
}
```

### P0.5 `src/lib/media/config.ts` (new)

```ts
import { db } from "../db";
import { MEDIA_MODELS, isMediaModelId, mediaModel, type MediaKind, type MediaModelId, type MediaProviderId } from "../media-catalog";
import { mk } from "./keys";

/** Which providers this deployment can use. Read at call time, like every other variable (docs/system/variables.md). */
export function providerConfigured(p: MediaProviderId): boolean {
  if (p === "fal") return !!process.env.FAL_KEY;
  if (p === "kie") return !!process.env.KIE_API_KEY;
  return !!process.env.HIGGSFIELD_API_KEY_ID && !!process.env.HIGGSFIELD_API_KEY_SECRET;
}
export const blobConfigured = () => !!process.env.BLOB_READ_WRITE_TOKEN;

/**
 * Spec A21: the founder switches models on after the console check passes. img-fast (today's behaviour) is always on;
 * every other id must be listed in MEDIA_MODELS_ON. Unknown ids in the variable are ignored.
 */
export function modelsSwitchedOn(): Set<MediaModelId> {
  const listed = (process.env.MEDIA_MODELS_ON ?? "").split(",").map((s) => s.trim()).filter(isMediaModelId);
  return new Set<MediaModelId>(["img-fast", ...listed]);
}

export type OffMap = Partial<Record<MediaModelId, { until: number; reason: string }>>;
/** Models the breaker switched off (spec A22). One read for the whole catalogue; expired entries are ignored. */
export async function offModels(now = Date.now()): Promise<OffMap> {
  const all = (await db.get<OffMap>(mk.off())) ?? {};
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v && v.until > now)) as OffMap;
}

/**
 * kie and Higgsfield delete results after 1 to 14 days while posts are published later by URL, so their models exist only
 * with a Blob store to copy into. fal works without one exactly as before (hot-link).
 */
export function modelAvailable(id: MediaModelId, off: OffMap = {}): boolean {
  const p = mediaModel(id).provider;
  return providerConfigured(p) && (p === "fal" || blobConfigured()) && modelsSwitchedOn().has(id) && !off[id];
}
export const availableModels = (kind?: MediaKind, off: OffMap = {}): MediaModelId[] =>
  MEDIA_MODELS.filter((m) => (!kind || m.kind === kind) && modelAvailable(m.id, off)).map((m) => m.id);

/** Our list-price cost per render in USD, 2026-09-29 (docs/system/costs.md). Server-only: margins stay out of the browser. */
export const COST_USD: Record<MediaModelId, number> = {
  "img-fast": 0.003, "img-balanced": 0.04, "img-premium": 0.09, "img-text": 0.03, "img-lifestyle": 0.0057, "img-design": 0.035,
  "vid-quick": 0.21, "vid-sound": 0.3, "vid-premium": 1.0, "vid-cinematic": 0.7, "vid-motion": 0.28,
};
export const KIE_USD_PER_CREDIT = 0.005;
/** kie credits one render should consume (research, 2026-09-29). Above 110 % the breaker switches the model off (A22). */
export const EXPECTED_KIE_CREDITS: Partial<Record<MediaModelId, number>> = {
  "img-balanced": 8, "img-premium": 18, "img-text": 6, "vid-quick": 42, "vid-sound": 60, "vid-premium": 200,
};

/**
 * Where a provider may call us back, or undefined for "poll only". Only an explicit https APP_ORIGIN that is not local:
 * the hard-coded production fallback used elsewhere would point a preview's jobs at production.
 */
export function callbackUrl(p: "kie" | "higgsfield"): string | undefined {
  const o = (process.env.APP_ORIGIN ?? "").replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+$/.test(o) || /localhost|127\.0\.0\.1|\[::1\]/.test(o)) return undefined;
  return `${o}/api/media/hook/${p}`;
}
```

### P0.6 `src/lib/tasks.ts` and `src/lib/brand.ts`

- `tasks.ts:38-39`: after `IMAGE_TYPES`, add
  `/** Types that get a video button in the inbox, checked again on the server. */ export const VIDEO_TYPES: TaskType[] = ["social", "ads"];`
- `brand.ts:33`: re-export `VIDEO_TYPES` too.
- `brand.ts:34`: add `import type { ImageModelId, MediaFailure, MediaProviderId, VideoModelId } from "./media-catalog";`
  (type-only: `brand.ts` gains no value import).
- `brand.ts:50-55`: rewrite the `imageProvider` comment to name every provider; type becomes
  `imageProvider?: MediaProviderId | "placeholder";`. After it add the fields of spec section 4.2 (`imageModel`,
  `videoUrl`, `videoPrompt`, `videoProvider?: Exclude<MediaProviderId, "fal">`, `videoModel`, `mediaCredits`,
  `mediaJob?: { image?: string; video?: string }`, `mediaLast?: { image?: MediaLast; video?: MediaLast }` with
  `export type MediaLast = { error: MediaFailure; credits: number; refunded: boolean; at: string }`), each with a
  one-line comment.
- `brand.ts:119-129` `TaskLite`: add `video: boolean; mediaCredits?: number;` with the comment "optional: rows written
  before 2026-09-29 lack it; readers use `t.mediaCredits ?? (t.image ? IMAGE_COST : 0)`".
- `brand.ts:137` `liteOf`: add `video: !!t.videoUrl, mediaCredits: t.mediaCredits,`.

### P0.7 `tests/helpers/media.ts` (new)

```ts
import { vi } from "vitest";
import type { MediaKind, MediaProviderId } from "@/lib/media-catalog";
import { StoreError, type MediaAdapter, type MediaDeps, type StatusResult, type StoredMedia, type SubmitInput, type SubmitResult } from "@/lib/media/types";

/** Every variable that switches a media provider, the Blob store or a model on. Tests set ALL of them, never FAL_KEY alone. */
export const MEDIA_ENV = { fal: ["FAL_KEY"], kie: ["KIE_API_KEY"], hmac: ["KIE_WEBHOOK_HMAC_KEY"], higgsfield: ["HIGGSFIELD_API_KEY_ID", "HIGGSFIELD_API_KEY_SECRET"], blob: ["BLOB_READ_WRITE_TOKEN"] } as const;
/** `models: "all"` lists every catalogue id in MEDIA_MODELS_ON; a string is used as is; absent means unset (img-fast only). */
export function mediaEnv(on: Partial<Record<keyof typeof MEDIA_ENV, boolean>> & { models?: "all" | string } = {}) {
  for (const [group, names] of Object.entries(MEDIA_ENV)) for (const n of names) vi.stubEnv(n, on[group as keyof typeof MEDIA_ENV] ? `test-${n.toLowerCase()}` : "");
  vi.stubEnv("MEDIA_MODELS_ON", on.models === "all" ? "img-balanced,img-premium,img-text,img-lifestyle,img-design,vid-quick,vid-sound,vid-premium,vid-cinematic,vid-motion" : on.models ?? "");
}

/**
 * The memory store is shared by every test in a file (globalThis.__nashrMem, src/lib/db.ts:88-90) and allow() is a
 * fixed window (src/lib/rate.ts:5-11), so global counters leak between tests. Call in beforeEach of every media test file.
 */
export function resetMediaCounters() {
  const mem = (globalThis as unknown as { __nashrMem?: { kv: Map<string, unknown>; lists: Map<string, string[]>; sets: Map<string, Set<string>> } }).__nashrMem;
  if (!mem) return;
  const global = /^(rate:kie:create|rate:mhook:|rate:mfail:|media:off|msweep|mhfclean|mjobs:recent)/;
  for (const k of [...mem.kv.keys()]) if (global.test(k)) mem.kv.delete(k);
  for (const k of [...mem.lists.keys()]) if (global.test(k)) mem.lists.delete(k);
  for (const k of [...mem.sets.keys()]) if (k.startsWith("mjobs:open:")) mem.sets.delete(k);
}
/** A distinct client IP per webhook test, so clientIp() is never "unknown" for all of them (src/lib/rate.ts:14-16). */
export const ipHeaders = (n: number) => ({ "x-vercel-forwarded-for": `203.0.113.${n}` });

/** Any fetch fails loudly and is recorded. Returns the recorder and a restore function. */
export function noNetwork() {
  const real = globalThis.fetch;
  const hosts: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    hosts.push(u.host);
    throw new Error(`network in a test: ${u.host}`);
  }) as typeof fetch;
  return { hosts, restore: () => { globalThis.fetch = real; } };
}

export type FakeScript = { submit?: (i: SubmitInput, n: number, signal: AbortSignal) => SubmitResult | Promise<SubmitResult>; status?: (n: number) => StatusResult | Promise<StatusResult> };
/**
 * A scripted provider. Defaults: fal answers done at once; kie and Higgsfield answer pending with a well-formed task id.
 * The counters live on the returned object itself (not a copy), so a test reads them after the calls.
 */
export function fakeAdapter(id: MediaProviderId, script: FakeScript = {}) {
  const a = {
    id,
    submits: [] as SubmitInput[],
    signals: [] as AbortSignal[],
    statusCalls: 0,
    cancels: 0,
    async submit(i: SubmitInput, signal: AbortSignal): Promise<SubmitResult> {
      a.submits.push(i); a.signals.push(signal);
      const n = a.submits.length;
      if (script.submit) return script.submit(i, n, signal);
      if (id === "fal") return { state: "done", urls: ["https://v3.fal.media/files/test.jpg"] };
      return { state: "pending", providerTaskId: id === "kie" ? `kietask${n}abc` : `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` };
    },
    async status(): Promise<StatusResult> { a.statusCalls++; return script.status ? script.status(a.statusCalls) : { state: "pending" }; },
    async cancel(): Promise<void> { a.cancels++; },
  };
  return a satisfies MediaAdapter;
}

/** MediaDeps over fakes. `stored` records every copy the engine asked for; `storeFails` fails the first N copies (true = all). */
export function fakeDeps(adapters: Partial<Record<MediaProviderId, MediaAdapter>> = {}, opts: { blob?: boolean; storeFails?: boolean | number; now?: () => number } = {}) {
  const stored: { source: string; kind: MediaKind; url: string; deadline: number }[] = [];
  let failures = 0;
  const deps: MediaDeps & { stored: typeof stored } = {
    stored,
    adapter: (p) => { const a = adapters[p]; if (!a) throw new Error(`no fake adapter for ${p}`); return a; },
    async store(source, kind, deadline): Promise<StoredMedia> {
      if (opts.storeFails === true || (typeof opts.storeFails === "number" && failures < opts.storeFails)) { failures++; throw new StoreError("put_failed"); }
      const url = `https://test.public.blob.vercel-storage.com/media/${String(stored.length + 1).padStart(32, "0")}.${kind === "image" ? "jpg" : "mp4"}`;
      stored.push({ source, kind, url, deadline });
      return { url, bytes: 1, contentType: kind === "image" ? "image/jpeg" : "video/mp4" };
    },
    blobReady: () => opts.blob ?? true,
    now: opts.now,
  };
  return deps;
}
```

### P0.8 Tests

- `tests/client-bundle.test.ts:15` (`SERVER_ONLY`): add `"@/lib/media/config"`, `"@/lib/media/jobs"`,
  `"@/lib/media/registry"`, `"@/lib/media/start"`, `"@/lib/media/fal"`, `"@/lib/media/kie"`, `"@/lib/media/higgsfield"`,
  `"@/lib/media/blob"`, `"@/lib/media/prompts"`. (`media/types` and `media/keys` import nothing server-side and may be
  imported by type only; leave them out.)
  After the test "the task catalogue the client reads imports nothing at all" (`:41-45`) add "the media catalogue the
  inbox reads imports nothing at all" (same shape, file `src/lib/media-catalog.ts`). In "brand.ts still re-exports the
  catalogue, so server callers are unaffected" (`:47-54`) add `expect(brand.VIDEO_TYPES).toBe(tasks.VIDEO_TYPES)`.
- `tests/media-catalog.test.ts` (new):
  - ids unique; every entry's kind matches its id prefix; credits pinned exactly: images 1, 1, 2, 1, 1, 1; video 12, 12,
    24, 12, 12 (founder decision F3: a change here is a pricing change);
  - copy rules: no label or hint in either language matches `/sharper|more detail|best|أدق|أفضل|احترافي/i`; no hint
    mentions Arabic lettering (`/arabic|عرب/i`) except `img-text`, whose hint must contain "not supported" and
    «غير مدعومة»; the `img-premium` hint says it does not use the owner's product photo; every sound model's hint says
    "no voice-over" / «بلا تعليق صوتي»; no Arabic hint contains a gendered imperative as a whole word (`راجع`, `ولّد`, `اختر`; whole-word match,
    since «مولّدة» legitimately contains «ولّد»);
  - `isMediaModelId` refuses `"constructor"`, `"__proto__"`, `"toString"`, `""`, `"IMG-FAST"`, `1`, `null`;
  - `hasArtwork`: true for fal, kie, higgsfield with a URL; false for placeholder, for a URL with no provider (legacy), for
    a provider with no URL;
  - `isOurBlobUrl`: true for `https://abc.public.blob.vercel-storage.com/media/x.jpg`; false for `http:`, other hosts,
    `https://public.blob.vercel-storage.com.evil.example/x`, `https://evil.example/.public.blob.vercel-storage.com`, a
    URL with credentials, `undefined`, garbage;
  - `mediaImageFor`: an image model with our kie image → the URL; with a fal hot-link or a placeholder → undefined;
    `vid-quick` on a tiktok task with our image → the URL, on an instagram task → undefined; `vid-motion` on an instagram
    task → the URL;
  - `aspectFor`: video → portrait; tiktok/snapchat → portrait; instagram → square;
  - `availableModels` with `mediaEnv`: nothing set → `[]`; fal only → `["img-fast"]`; kie + Blob without `models` →
    no kie model; kie + Blob + `models: "all"` → the six kie models; `models: "img-balanced"` → only that kie model;
    Higgsfield needs BOTH id and secret; an `OffMap` with `img-balanced` until the future removes it, until the past
    does not;
  - `offModels`: reads `media:off` once (spy on `db.get`) and drops expired entries;
  - `callbackUrl`: unset, `http://`, localhost, a path → undefined; `https://nashr.example` → `https://nashr.example/api/media/hook/kie`;
  - `parseOpenMember`: splits `a|b@x.example#brand|<32 hex>` on the last `|`; refuses a bad job id;
  - `budget`: never negative, never above the maximum; `deadlineFor(120, 0)` is `105_000`.

**Acceptance P0**: `npx vitest run tests/media-catalog.test.ts tests/client-bundle.test.ts tests/task-index.test.ts
tests/eval-truth.test.ts` green; `npx tsc --noEmit` green; the lockfile greps pass and the `npm ls` diff shows only the
two new packages; `npm ci` succeeds.

**Docs lines affected (written by P9b)**: architecture.md section 2.5 module table, section 3 key table; variables.md
totals.

---

## P1. fal adapter and prompts (wave 1)

### `src/lib/media/fal.ts`

```ts
export const falAdapter: MediaAdapter
```

- `submit(input, signal)`: `process.env.FAL_KEY` missing → `throw new ProviderError("unavailable")`. `input.model !==
  "img-fast"` → `ProviderError("rejected")`. `POST https://fal.run/fal-ai/flux/schnell`, `signal` passed through,
  headers `Authorization: Key ${key}` and JSON, body exactly
  `{ prompt, image_size: aspect === "portrait" ? "portrait_16_9" : "square_hd", num_images: 1, enable_safety_checker: true, output_format: "jpeg" }`
  (moved from `src/lib/images.ts:39-44`, plus `output_format`, confirmed at https://fal.ai/models/fal-ai/flux/schnell/api).
- Status mapping for a non-2xx: 429 → `busy`; 401/403 → `unavailable`; 400/422 → `rejected`; other → `unavailable`, each
  with the status number. The body is never read into the error.
- Success: `has_nsfw_concepts?.[0] === true` → `{ state: "failed", reason: "nsfw" }` (the safety checker flagged or
  blanked the image; confirm the field in the output schema on the same page). Otherwise `images[0].url` must start with
  `https://`, else `ProviderError("bad_response")`. Returns `{ state: "done", urls: [url] }`.
- `status()` throws `ProviderError("bad_response")` (fal is synchronous; the engine never polls it).

### `src/lib/media/prompts.ts`

```ts
export type PromptStyle = "photo" | "lifestyle" | "text" | "design";
export const IMAGE_STYLE: Record<ImageModelId, PromptStyle>; // img-lifestyle → lifestyle, img-text → text, img-design → design, the rest photo
export const PROMPT_MAX_MS = 20_000;
export function fixedImagePrompt(brand: Brand, task: Task, model: ImageModelId, aspect: Aspect): string;
export function fixedVideoPrompt(brand: Brand, task: Task, model: VideoModelId, fromImage: boolean): string;
export async function imagePrompt(brand: Brand, task: Task, model: ImageModelId, aspect: Aspect, email?: string, timeoutMs?: number): Promise<string>;
export async function videoPrompt(brand: Brand, task: Task, model: VideoModelId, fromImage: boolean, email?: string, timeoutMs?: number): Promise<string>;
```

- Move `imagePrompt` from `src/lib/images.ts:12-28`; do not edit `images.ts` (P8 deletes it).
- Fixed templates (spec 4.5), `ratio = aspect === "portrait" ? "9:16" : "1:1"`:
  - photo (must keep today's prefix so `tests/model-pause.test.ts:121` still matches): `Premium ${brand.industry}
    product photo for ${brand.name}, Gulf aesthetic, warm light, clean background, no text, ${ratio}`;
  - lifestyle: `Natural lifestyle photo for ${brand.name}, a ${brand.industry} business: its product or service in use in
    a modern Gulf setting, modest styling, no close-up faces, no text, ${ratio}`;
  - text (spec A27): when `/^[\x20-\x7E]+$/.test(brand.name.trim())`: `Clean ${industry} promotional poster for ${name}
    with the short English headline "${name without quotes, max 40 chars}", Gulf aesthetic, warm light, ${ratio}`;
    otherwise exactly the design template. `task.title` and `task.body` are never used;
  - design: `Minimal flat graphic for ${name} (${industry}), bold shapes, Gulf palette, no text or lettering, ${ratio}`;
  - video: `${seconds}-second vertical social video for ${name}: a scene that represents a ${industry} business, slow
    camera push-in, warm Gulf light, modest styling, no text on screen, no close-up faces, no speech, no dialogue, no
    voice-over`; with `fromImage`: `Animate this photo: slow camera push-in, gentle light movement, warm Gulf light,
    modest styling, no text on screen, no speech, no dialogue, no voice-over`. `seconds` from `mediaModel(model).seconds`.
- `modelState() !== "on"`, or `timeoutMs < 3_000` → return the fixed template, and never construct `Anthropic`.
- On: `new Anthropic().messages.create({model: "claude-sonnet-5", max_tokens: 400, thinking: {type: "adaptive"},
  output_config: {effort: "low"}, system, messages}, { timeout: Math.min(PROMPT_MAX_MS, timeoutMs), maxRetries: 0 })`
  (spec A12: the SDK's default `maxRetries ?? 2` would turn a 20 s timeout into ~62 s). System per style: photo keeps
  `images.ts:22` verbatim; lifestyle: the same rules, "the product or service in use in a modern Gulf setting";
  text replaces "no text or logos in image" with "one short headline in English, at most 6 words, taken from the post;
  no Arabic lettering; no logos"; design: flat graphic design, no text or lettering; video: "one text-to-video prompt
  (English, ≤ 70 words) for a {seconds}-second vertical clip: one continuous shot, camera movement, subject, light; no
  speech, no dialogue, no voice-over" with the same cultural rules (and "describe only motion for the given photo" when
  `fromImage`). User content as `images.ts:23`. `await meter(email, res.model, "image_prompt", res.usage)` for both
  (spec A18).
- Any throw, or empty text → `console.error("media prompt failed", <message only>)` and the fixed template (spec A12).

### Tests

- `tests/media-fal.test.ts`: with `mediaEnv({fal: true})` and a recording `globalThis.fetch`:
  host is `fal.run`, path `/fal-ai/flux/schnell`; header `Authorization: Key test-fal_key`; body deep-equals the exact
  object for square and for portrait; the `signal` given is the one fetch received and is not aborted (the intent of
  `tests/p1-round2.test.ts:89-111`, which P8 removes); `has_nsfw_concepts: [true]` → `{state: "failed", reason:
  "nsfw"}`; `[false]` → done; non-https URL → `bad_response`; a 500 whose body contains `test-fal_key` and `leak` →
  error message is `provider_unavailable:500` and contains neither; missing key → `unavailable` and no fetch; a non-fal
  model → `rejected`.
- `tests/media-prompts.test.ts`: mock `@anthropic-ai/sdk` with a constructor counter (as `tests/model-pause.test.ts:9-10`).
  Paused (`vi.mock("@/lib/model", ...)` → `"paused"`): each image style and each video model returns its template, the
  photo template starts with `Premium قهوة product photo` and ends `1:1` / `9:16` by aspect, zero SDK constructions;
  `img-text` for a brand named `قهوة الورد` with an Arabic title returns exactly the design template (no `headline`,
  and the title string absent); for a brand named `Rose Coffee` it contains `"Rose Coffee"` and still not the title;
  every video template contains `no speech, no dialogue, no voice-over` and not `the product`; the lifestyle template
  differs from the photo one. On (`claudeOn()` from `tests/helpers/model.ts`, SDK mock returning text): `create`
  received `{timeout: 20000, maxRetries: 0}` as the second argument (and `{timeout: 5000, maxRetries: 0}` when
  `timeoutMs` is 5000), `max_tokens` 400, and the result is the model's text; the text-style and video system prompts
  contain "English" and "no speech" respectively; a mock that rejects with a timeout error is called exactly once and
  the fixed template comes back; empty text → the fixed template; `timeoutMs: 2000` → the template with zero SDK calls.

**Acceptance P1**: both test files green; `grep -n "images" src/lib/media/prompts.ts` shows no import of `../images`;
`grep -n "maxRetries: 0" src/lib/media/prompts.ts` matches.

**Docs lines affected (P9b)**: architecture.md :72 and :103 (`images.ts:16` → `media/prompts.ts`), :105; costs.md :17;
flows.md :92.

---

## P2. kie adapter (wave 1)

### `src/lib/media/kie.ts`

```ts
type KieModelId = "img-balanced" | "img-premium" | "img-text" | "vid-quick" | "vid-sound" | "vid-premium";
type KieSpec = { family: "market" | "veo"; body(i: SubmitInput): Record<string, unknown> };
/** One place per model: a wrong field is a one-line fix. */
export const KIE_MODELS: Record<KieModelId, KieSpec>;
export const kieAdapter: MediaAdapter;
/** base64(HMAC-SHA256(`${taskId}.${timestamp}`, key)), compared with sameSecret; timestamp within ±300 s. */
export function verifyKieSignature(taskId: string, timestamp: string | null, signature: string | null, key: string, nowS?: number): boolean;
/** The task id from a callback body: taskId, then data.taskId, then data.task_id; null unless it matches PROVIDER_TASK_ID.kie. */
export function kieTaskIdFrom(body: unknown): string | null;
```

- `HOST = "https://api.kie.ai"`. Headers: `Authorization: Bearer ${process.env.KIE_API_KEY}`,
  `Content-Type: application/json`. Missing key → `ProviderError("unavailable")` before any fetch.
- `KIE_MODELS` bodies exactly as spec 3.1/3.2. `ratio = aspect === "portrait" ? "9:16" : "1:1"` for images, always
  `"9:16"` for video. `image_input` / `image_urls` / `image_url` / `imageUrls` only when `i.imageUrl` is set (the engine
  sets it only as `mediaImageFor` allows). The `vid-quick` spec switches model id between
  `kling/v2-5-turbo-text-to-video-pro` and `kling/v2-5-turbo-image-to-video-pro`. `vid-sound` is `family: "veo"` with
  `model: "veo3_fast"` (spec A5).
  **Before merging, re-read every page in spec 3.3 for these six models**, copy each enum from its OpenAPI block, add
  `nsfw_checker: true` to a body if and only if its schema lists the field, and note the date read in a comment above
  `KIE_MODELS`.
- `submit`: `callBackUrl = callbackUrl("kie")` (P0 config) added at the top level when defined. Market →
  `POST /api/v1/jobs/createTask` with `{model, input, callBackUrl?}` (the body builder returns `{model, input}`); veo →
  `POST /api/v1/veo/generate` with the flat body plus `callBackUrl?`. Response: HTTP ok AND `body.code === 200` AND
  `data.taskId` matching `PROVIDER_TASK_ID.kie`, else mapped: HTTP or body code 429 → `busy`; 402, 433 → `no_balance`;
  401 → `unavailable`; 400, 422 → `rejected`; 455, 5xx → `unavailable`; malformed → `bad_response`.
- `status({providerTaskId, model})`: id re-checked against the regex. Market → `GET
  /api/v1/jobs/recordInfo?taskId=${encodeURIComponent(id)}`: `data.state` `waiting | queuing | generating` → pending;
  `success` → `JSON.parse(data.resultJson).resultUrls` filtered to `https://` (none → `bad_response`), `providerCredits:
  data.creditsConsumed` when it is a finite number (it may be fractional); `fail` → `nsfw` when `failCode` is 400 or
  `failMsg` matches `/policy|nsfw|sensitive|violat/i`, else `provider_failed`. Veo → `GET
  /api/v1/veo/record-info?taskId=...`: `successFlag` 0 → pending, 1 → done with `data.response.resultUrls` and
  `providerCredits: data.creditsConsumed` when it is a finite number (the research documents the field only for the
  market endpoints; if the record-info page does not list it, leave this line in, write "not documented on
  record-info as of <date>" above it, and rely on the founder's balance check, spec 3.3 and owner step 6), 2 or 3 →
  failed (`errorCode` 400 → `nsfw`). Confirm the Veo record-info field names on
  https://docs.kie.ai/old-model/veo3-api/generate-veo-3-video.md and its record-info page.
- No `cancel` (kie documents none).
- `check(signal)`: `GET /api/v1/chat/credit` → `{ balanceCredits: data }`; failure → `{ error: "http:<status>" }`.
- Logging: at most `console.error("kie", httpStatus, bodyCode)` (numbers). Never the body, never a header.
- `verifyKieSignature`: `false` when any input is empty, when `timestamp` is not an integer, or when
  `|nowS - timestamp| > 300`; else `sameSecret(signature, createHmac("sha256", key).update(`${taskId}.${timestamp}`).digest("base64"))`.

### Tests: `tests/media-kie.test.ts`

Recording `globalThis.fetch` returning scripted JSON; `mediaEnv({kie: true, blob: true, models: "all"})`.
- Every model's body deep-equals its expected object for square/portrait and with/without `imageUrl` (one table test);
  `vid-sound` goes to `/api/v1/veo/generate` with `model: "veo3_fast"`; market models go to `/api/v1/jobs/createTask`.
- Every request goes to host `api.kie.ai`; `Authorization: Bearer test-kie_api_key`; the key never appears in a URL.
- `callBackUrl` absent without `APP_ORIGIN`; present and equal to `https://nashr.example/api/media/hook/kie` with
  `vi.stubEnv("APP_ORIGIN", "https://nashr.example")`.
- Error mapping table (429, body code 429 on HTTP 200, 402, 433, 401, 422, 455, 503, malformed); every message matches
  `/^provider_[a-z_]+(:\d+)?$/` and contains neither the key nor the response body text.
- Status: waiting/queuing/generating → pending; success with a stringified `resultJson` → urls and `providerCredits`
  (including a fractional `8.2`); an `http:` result URL is dropped; fail with `failCode: 400` → nsfw; other fail →
  provider_failed; Veo `successFlag` 0/1/2; Veo `successFlag: 1` with `creditsConsumed: 60` → `providerCredits: 60`, and
  without the field → `providerCredits` undefined; a task id with `/` or `..` never reaches fetch.
- `verifyKieSignature`: valid; wrong key; tampered taskId; stale (301 s); future (301 s); missing header; non-integer
  timestamp. `kieTaskIdFrom`: the three body shapes; rejects `../x`, 200-char ids, numbers.
- `check`: balance parsed; 401 → `{error: "http:401"}`.

**Acceptance P2**: test file green; a comment above `KIE_MODELS` records which doc pages were re-read and on what date,
and says whether Veo record-info documents `creditsConsumed`.

**Docs lines affected (P9b)**: architecture.md 2.7 (new kie.ai row); flows.md new section 23; permissions.md webhook row.

---

## P3. Higgsfield adapter (wave 1)

### `src/lib/media/higgsfield.ts`

```ts
type HfModelId = "img-lifestyle" | "img-design" | "vid-cinematic" | "vid-motion";
type HfSpec = { endpoint(i: SubmitInput): string; body(i: SubmitInput): Record<string, unknown> };
/** One place per model. Higgsfield schemas are strict (additionalProperties: false), and docs and console defaults differ, so every parameter is sent. */
export const HF_MODELS: Record<HfModelId, HfSpec>;
export const higgsfieldAdapter: MediaAdapter;
/** request_id from a webhook body; null unless it matches PROVIDER_TASK_ID.higgsfield. */
export function hfRequestIdFrom(body: unknown): string | null;
```

- `HOST = "https://api.higgsfield.ai"`. Header `Authorization: Key ${HIGGSFIELD_API_KEY_ID}:${HIGGSFIELD_API_KEY_SECRET}`
  (not Bearer), `Content-Type: application/json`. Either variable missing → `ProviderError("unavailable")`.
- `HF_MODELS` endpoints and bodies exactly as spec 3.1/3.2: `higgsfield-ai/soul/v2/standard` (seed
  `1 + randomInt(1_000_000)` from `crypto`, `style_id` sent explicitly), `recraft/v4.1/text-to-image`,
  `bytedance/seedance-2.0/text-to-video` or `.../image-to-video` (by `imageUrl`), `minimax/hailuo-2.3/standard/image-to-video`
  (`imageUrl` missing → `ProviderError("rejected")`). **Before merging, re-read** https://docs.higgsfield.ai/docs/llms.txt
  and each model page (`/docs/models/soul-2/generate.md`, `/docs/models/recraft-v4-1/text-to-image.md`,
  `/docs/models/seedance-2/image-to-video.md` and its text-to-video sibling, `/docs/models/hailuo-2-3.md`); record the date
  in a comment above `HF_MODELS`.
- `submit`: `POST ${HOST}/${endpoint}` plus `?hf_webhook=${encodeURIComponent(callbackUrl("higgsfield"))}` when defined.
  Response `{status, request_id}`: `request_id` must match the regex, else `bad_response`. Errors: 400 whose `detail`
  mentions "concurrent" → `busy`; 403 (and 402) → `no_balance`; 401, 404, 423, 503 → `unavailable`; 400, 422 →
  `rejected`; 5xx → `unavailable`. Reading `detail` to classify is fine; it never goes into the error.
- `status`: `GET ${HOST}/requests/${id}/status` (the id re-checked; the response's own `status_url` is not used, so the
  host stays fixed): `queued | in_progress` → pending; `completed` → `images[0].url` or `video.url` (https only);
  `nsfw` → nsfw; `failed | canceled` → provider_failed.
- `cancel`: `POST ${HOST}/requests/${id}/cancel` with `abortAfter(5_000)`, errors swallowed (it only succeeds while
  queued).
- `check(signal)`: for each `HF_MODELS` entry, `POST ${HOST}/estimate/${endpoint}` with that model's real body built from
  `{prompt: "check", aspect: "portrait", imageUrl: "https://example.public.blob.vercel-storage.com/check.jpg"}` in
  parallel (`Promise.all`), returning `{ [modelId]: Number(usd) }` or `"error:<status>"`. This is what proves the
  endpoint ids and bodies in production without spending (spec A15, A21).
- Never retry a submit.

### Tests: `tests/media-higgsfield.test.ts`

Recording fetch; `mediaEnv({higgsfield: true, blob: true, models: "all"})`.
- Header is `Key test-higgsfield_api_key_id:test-higgsfield_api_key_secret`; host always `api.higgsfield.ai`; neither
  secret in any URL.
- Bodies deep-equal per model (seed checked as an integer 1..1000000, then compared with the rest); Seedance switches
  endpoint on `imageUrl`; Hailuo without `imageUrl` → `rejected`, no fetch.
- `hf_webhook` absent without `APP_ORIGIN`; present and URL-encoded with it.
- Errors: 400 "Maximum number of concurrent requests (4) has been reached" → `busy`; 403 → `no_balance`; 422; 423; 503;
  messages carry neither secret nor body.
- Status: queued, in_progress, completed image, completed video, nsfw, failed, canceled; a non-uuid id never reaches fetch.
- `submit` is called once even when fetch throws (no retry): fetch mock call count 1, error propagated.
- `check`: estimates parsed per model; one 404 → that model shows `error:404`, others still reported.
- `hfRequestIdFrom`: valid uuid; rejects other strings and shapes.

**Acceptance P3**: test file green; the doc-read comment is present.

**Docs lines affected (P9b)**: architecture.md 2.7 (new Higgsfield row); permissions.md section 5 (unsigned webhooks).

---

## P4. Blob store (wave 1)

### `src/lib/media/blob.ts`

```ts
export const SOURCE_CAP_BYTES: Record<MediaKind, number> = { image: 25 * 1024 * 1024, video: 100 * 1024 * 1024 };
export const DOWNLOAD_MAX_MS: Record<MediaKind, number> = { image: 15_000, video: 45_000 };
export const PUT_MAX_MS: Record<MediaKind, number> = { image: 20_000, video: 30_000 };
export function sniff(b: Uint8Array): "jpeg" | "png" | "webp" | "gif" | "mp4" | null;
export async function toJpeg(input: Buffer): Promise<Buffer>;
/** Download a provider result (untrusted URL) and keep our own copy. Throws StoreError with a fixed code. */
export async function copyToBlob(sourceUrl: string, kind: MediaKind, deadline: number): Promise<StoredMedia>;
/** Founder console only: write, check and delete a tiny public file. Never throws. */
export async function probeBlob(signal: AbortSignal): Promise<"ok" | "error:no_blob" | "error:put_failed" | "error:foreign_host" | "error:del_failed">;
```

Behaviour (spec 4.6):
1. `!blobConfigured()` → `StoreError("no_blob")`. Not `https:` → `not_https`.
2. `safeFetch(sourceUrl, { signal: abortAfter(dl) })` with `dl = min(DOWNLOAD_MAX_MS[kind], deadline − now − 10_000)`;
   `dl < 3_000` → `no_time` before any fetch; any throw or `!res.ok` → `fetch_failed`.
3. `Content-Length` above the cap → `too_large` before reading; then read `res.body` with a reader, summing chunk sizes,
   `reader.cancel()` and `too_large` past the cap.
4. `sniff`: JPEG `FF D8 FF`; PNG `89 50 4E 47`; WebP `RIFF....WEBP`; GIF `GIF8`; MP4 `ftyp` at offset 4. Image kind needs
   one of the four image formats; video needs `mp4` → else `not_media`.
5. Image → `toJpeg` = `sharp(input, { limitInputPixels: 40_000_000 }).rotate().flatten({ background: "#ffffff" })
   .resize({ width: 1440, height: 1920, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88, mozjpeg: true })
   .toBuffer()`. No `failOn` option: sharp's default `"warning"` is the one its typings recommend for untrusted input
   (`node_modules/sharp/dist/index.d.mts:989-991`). `.rotate()` without an argument auto-orients (alias `.autoOrient()`).
   Any throw → `convert_failed`. Video → bytes unchanged.
6. `put(\`media/${randomBytes(16).toString("hex")}.${ext}\`, body, { access: "public", contentType, addRandomSuffix:
   false, allowOverwrite: false, cacheControlMaxAge: 31536000, token: process.env.BLOB_READ_WRITE_TOKEN, abortSignal:
   abortAfter(min(PUT_MAX_MS[kind], deadline − now)) })` (`@vercel/blob` 2.x API checked with context7). Less than
   3 s left → `no_time`. Throw → `put_failed`. Returned `url` must pass `isOurBlobUrl`, else `put_failed`.
7. Returns `{ url, bytes, contentType }`. No tenant identifier in the path, ever.

`probeBlob(signal)`: no token → `error:no_blob`; `put(\`media/check-${randomBytes(8).toString("hex")}.txt\`, "ok",
{ access: "public", contentType: "text/plain", addRandomSuffix: false, token, abortSignal: signal })` throw →
`error:put_failed`; `!isOurBlobUrl(url)` → `error:foreign_host` (still try to delete); `del(url, { token, abortSignal:
signal })` throw → `error:del_failed`; else `ok`. `del` signature confirmed with context7 (`del(urlOrPathname,
{token, abortSignal})`).

### Tests: `tests/media-blob.test.ts`

`vi.mock("@/lib/safe-fetch", ...)` with a spy returning scripted `Response`s; `vi.mock("@vercel/blob", ...)` with `put`
and `del` spies, `put` returning `{ url: "https://s1.public.blob.vercel-storage.com/" + pathname }`;
`mediaEnv({blob: true})`; `const far = Date.now() + 100_000` as the deadline unless the test is about time.
- A real transparent PNG made with `sharp({create: {width: 64, height: 64, channels: 4, background: {r: 0, g: 0, b: 0,
  alpha: 0}}}).png().toBuffer()` → stored bytes sniff as JPEG, and a decoded pixel is white (`sharp(out).raw()`), not
  black.
- A 3000×3000 PNG → output no larger than 1440 wide.
- A truncated PNG (valid header, cut body) → `store_convert_failed` (the default `failOn: "warning"` refuses it).
- `put` called once with `access: "public"`, `contentType: "image/jpeg"`, `addRandomSuffix: false`, and a pathname matching
  `/^media\/[a-f0-9]{32}\.jpg$/`; the pathname contains no `@` and no `#`.
- The download went through `safeFetch` (spy called with the source URL), never bare `fetch` (`noNetwork()` active).
- `Content-Length` over the cap → `store_too_large` without reading; a streamed body over the cap → `store_too_large`.
- HTML bytes with `content-type: image/jpeg` → `store_not_media`. An MP4 (`....ftypisom`) for video → stored unchanged as
  `video/mp4` with `.mp4`. MP4 bytes for kind image → `not_media`.
- `http:` source → `store_not_https`; Blob token unset → `store_no_blob`; `put` returning a foreign host →
  `store_put_failed`; a deadline 5 s away → `store_no_time` and no `safeFetch` call; a deadline 40 s away for a video →
  the download signal was built from 30 s, not 45 s (spy on `abortAfter` via `vi.spyOn` of the keys module).
- `probeBlob`: `ok` with put then del called on the returned URL; put throws → `error:put_failed`; a foreign URL →
  `error:foreign_host` and `del` still called; del throws → `error:del_failed`; no token → `error:no_blob`, no put.

**Acceptance P4**: test file green; `grep -n "fetch(" src/lib/media/blob.ts` shows only `safeFetch(`;
`grep -n "failOn" src/lib/media/blob.ts` prints nothing.

**Docs lines affected (P9b)**: architecture.md 2.7 (Vercel Blob row), section 5 trust boundary; variables.md new row.

---

## P5. Publishing gate (wave 1)

- `src/lib/connectors/targets.ts:1`: add `import { hasArtwork } from "../media-catalog";`. Rewrite the header comment's
  "No runtime imports" to "Its only runtime import is ../media-catalog, which imports nothing". `:29-30`:
  `if (social && task.channel === "instagram" && connected.includes("instagram") && hasArtwork(task)) out.push("instagram");`
  and update the comment ("a generated image from any provider; a placeholder card is not artwork").
- `src/lib/connectors/publish.ts:45`: `postToFacebook(c, body, hasArtwork(task) ? task.imageUrl : undefined)`.
  `:49-51`: `if (!hasArtwork(task)) throw new Error("instagram_needs_image"); const r = await postToInstagram(c, body, task.imageUrl!);`.
  Import `hasArtwork` from `../media-catalog`.
- `tests/meta-publish.test.ts`:
  - "where a post can go" (`:123-133`): add a kie image
    (`imageUrl: "https://s1.public.blob.vercel-storage.com/media/<32hex>.jpg", imageProvider: "kie"`) and a Higgsfield
    image → `["instagram", "facebook"]`; a legacy image with a URL and no `imageProvider` → `["facebook"]`; a task with
    only a `videoUrl` on instagram → no `instagram` target (video is not publishable in this round).
  - New case in "publishing to Instagram and Facebook": a kie-image post publishes to Instagram with `image_url` equal to
    the Blob URL; a Higgsfield-image post posts to the Facebook Page as a photo with that URL.
  - `grep -rn 'imageProvider === "fal"\|imageProvider !== "fal"' src` must print nothing once P7 lands.

**Acceptance P5**: `npx vitest run tests/meta-publish.test.ts` green (the existing fal fixture at `:59` still passes).

**Docs lines affected (P9b)**: flows.md :128-129; tests.md rule 75.

---

## P6. Job engine (wave 1)

### `src/lib/media/jobs.ts`

Imports: `randomBytes` (crypto), `db`, `pushCapped` (../db), `charge`, `refund`, `monthKey` (../credits), `getUser`
(../auth), `getTask`, `saveTask`, `IMAGE_COST` (../brand), `allow` (../rate), `pmap` (../parallel), `track` (../track),
`pushNotif` (../notifications), `mediaModel`, `hasArtwork`, `MEDIA_MAX_AGE_MS`, types (../media-catalog), `mk`,
`JOB_ID`, `JOB_TTL_S`, `PROVIDER_TASK_ID`, `parseOpenMember`, `budget`, `abortAfter` (./keys), `COST_USD`,
`KIE_USD_PER_CREDIT`, `EXPECTED_KIE_CREDITS`, `offModels` (./config), types and `ProviderError`, `StoreError`
(./types). **It must not import `./fal`, `./kie`, `./higgsfield`, `./blob` or `./registry`** (spec A6).

```ts
export const FLIGHT_TTL_S: Record<MediaKind, number> = { image: 15 * 60, video: 35 * 60 };
/** Longer than any route deadline (105 s), so a start request still working is never declared lost. */
export const QUEUED_LOST_MS = 3 * 60_000;
/** Sweeps and Higgsfield admission force-advance open jobs older than this. */
export const STALE_MS = 2 * 60_000;
export const POLL_GAP_S = 4;
export const STORE_TRIES = 3, STORE_RETRY_S = 30;
export const KIE_CREATES = { max: 18, windowS: 10 };
export const HF_MAX_OPEN = 2; // Higgsfield's floor for a new account; raise to what the console shows
export const RENDER_LIMITS: Record<MediaKind, { hour: number; day: number }> = { image: { hour: 30, day: 150 }, video: { hour: 6, day: 20 } };
export const TRIAL_VIDEO_TTL_S = 14 * 86400;
export const BREAKER = { failures: 3, windowS: 3600, offMs: 6 * 3600_000, noBalanceOffMs: 3600_000, overbill: 1.1 };
const SUBMIT_MAX_MS: Record<MediaProviderId, number> = { fal: 45_000, kie: 20_000, higgsfield: 20_000 };
const SUBMIT_MIN_MS = 5_000;
const STATUS_MAX_MS = 15_000, STATUS_MIN_MS = 15_000;
/** Do not start a copy with less time than this left; the job keeps resultUrls for the next poll or sweep. */
export const FINALIZE_MIN_MS: Record<MediaKind, number> = { image: 25_000, video: 60_000 };
const JOB_LOCK_S = 120, SWEEP_LOCK_S = 300, HF_CLEAN_LOCK_S = 60;

export async function startMedia(input: StartInput, deps: MediaDeps): Promise<StartResult>;
export async function getJob(scope: string, jobId: string): Promise<MediaJob | null>;
export async function advance(job: MediaJob, deps: MediaDeps, opts: AdvanceOpts): Promise<MediaJob>;
export async function jobForHook(provider: MediaProviderId, providerTaskId: string): Promise<MediaJob | null>;
export async function sweepMedia(deps: MediaDeps, opts: { deadline: number; limit?: number }): Promise<SweepReport>;
/** The opportunistic sweep (spec A3): runs only when it wins `msweep` and at least 30 s are left. */
export async function maybeSweep(deps: MediaDeps, deadline: number): Promise<SweepReport | null>;
export async function setOff(model: MediaModelId, reason: string, ms: number): Promise<void>;
export const publicJob: (j: MediaJob) => PublicJob;
```

`now()` below is `deps.now?.() ?? Date.now()`; `age(j) = now() − Date.parse(j.createdAt)`.

**`startMedia`** (spec A24, 4.4 A). Nothing is charged before step 7; every refusal from step 4 on releases the flight
lock through `try/finally`:
1. `m = mediaModel(input.model)`. `m.provider !== "fal" && !deps.blobReady()` → 409 `model_unavailable` (belt and
   braces: `start.ts` already checks availability).
2. `input.balance < m.credits` → 402 `no_credits {need: m.credits, have: input.balance}`. No counter has moved.
3. `db.lock(mk.flight(scope, taskId, kind), FLIGHT_TTL_S[kind])` fails → read the task's `mediaJob[kind]` and that
   job; 409 `in_progress` with `job: publicJob(running)` when found (without `job` otherwise). No counter has moved.
4. `let keepFlight = false; try {`
5. Account limits: `Promise.all([allow(`media:${kind}:h:${email}`, hour, 3600), allow(`media:${kind}:d:${email}`, day,
   86400)])` → 429 `too_many`.
6. Trial video (spec A29): `plan === "trial" && kind === "video"` → `db.lock(mk.trialVideo(email), TRIAL_VIDEO_TTL_S)`
   fails → 402 `trial_video_used`; won → `trialVideo = true` (every refusal below deletes the marker again in the same
   `finally`).
7. Provider throttle: kie → `allow("kie:create", 18, 10)` false → 429 `busy`. Higgsfield → `hfAdmission(email, kind,
   deps, deadline)` (below) → 429 `one_open` or `busy`.
8. `paid = await charge(email, m.credits)` inside `try`: a throw (e.g. `user_lock_timeout`, `src/lib/credits.ts:18`) →
   `console.error("media charge failed", message)`; 429 `busy` (nothing was charged). `!paid.ok` → 402 `no_credits
   {need, have: paid.credits}`.
9. Job built (`id = randomBytes(16).toString("hex")`, `state: "queued"`, `lang`, `accountSince`, `trialVideo?`); task
   re-read. Round A: `Promise.all([saveJob(job), db.sadd(mk.open(provider), mk.openMember(scope, id)), task ?
   saveTask(scope, {...task, mediaJob: {...task.mediaJob, [kind]: id}, mediaLast: omit(task.mediaLast, kind)}) : null])`.
   A throw → `refundUnsaved(job)`: `db.lock(mk.refundOnce(id), JOB_TTL_S)` won → `refund(email, credits)` (errors logged;
   the trial marker deleted); answer 502 `media_failed` with the restored `credits`. (A queued record that did get
   written later ends `submit_lost` with no second refund: the marker exists.)
10. `keepFlight = true } finally { if (!keepFlight) await Promise.all([db.unlock(flight), trialVideo ? db.del(mk.trialVideo(email)) : null]) }`.
11. `db.lock(mk.jobLock(id), JOB_LOCK_S)` (a fresh id: always won). The start request holds it until it returns
    (`try/finally` unlock), so polls on this queued job skip it.
12. `job.prompt = await input.prompt(budget(20_000, deadline − SUBMIT_MIN_MS, now()))`.
13. `t = budget(SUBMIT_MAX_MS[provider], deadline − (provider === "fal" ? FINALIZE_MIN_MS.image : 0), now())`;
    `t < SUBMIT_MIN_MS` → `failLocked(job, "submit_failed")`, 502 `media_failed` with credits (nothing was sent).
    Else `submitted = await deps.adapter(provider).submit({model, prompt, aspect, imageUrl}, abortAfter(t))`. Throw →
    `console.error("media submit failed", provider, message)`; `failLocked(job, "submit_failed", {cause})`;
    `ProviderError` `busy` → 429 `busy`, else 502 `media_failed`; include the restored `credits`. `cause` is the
    `ProviderError` code, used by the breaker (below).
14. `failed` (fal `nsfw`) → `failLocked(job, "nsfw")`, 422 `nsfw` with credits.
15. `done` (fal) → `finalizeLocked(job, urls, undefined, deps, {deadline, via: "start"})`; job `done` → 200 path
    `{ok: true, job, task, credits: paid.credits}`; job still `running` (copy left for later) → 202 path; job `failed`
    → 502 `media_failed` with credits.
16. `pending` → `providerTaskId` must match `PROVIDER_TASK_ID[provider]` (else `failLocked(job, "submit_failed")`, 502);
    job `running` with the id; Round C: `Promise.all([saveJob(job), db.set(mk.ref(provider, id), {scope, jobId: id},
    JOB_TTL_S)])`; return `{ok: true, job, task, credits: paid.credits}`. If Round C throws, the job stays `queued` and
    ends `submit_lost` (refunded) 3 minutes later.

**`hfAdmission(email, kind, deps, deadline)`** (internal, spec A10):
- `members = await db.smembers(mk.open("higgsfield"))`; empty → ok.
- `refs = members.map(parseOpenMember)`; `jobs = await pmap(valid refs, (r) => getJob(r.scope, r.jobId), 4)`.
- One `Promise.all` of `srem` for unparseable members and members whose job is missing or terminal.
- `live(j) = !terminal && age(j) <= MEDIA_MAX_AGE_MS[j.kind] && !j.resultUrls`.
- When `live` count ≥ `HF_MAX_OPEN` and `db.lock(mk.hfClean(), HF_CLEAN_LOCK_S)` is won: `pmap(stale.slice(0, 4), (j) =>
  advance(j, deps, {force: true, deadline: Math.min(deadline, now() + 20_000), via: "sweep"}), 2)` for the non-live or
  older-than-`STALE_MS` open jobs, oldest first (status calls only: the 20 s deadline leaves no room for a copy, which is
  left in `resultUrls`), errors caught; then recount from the returned jobs.
- `live.some((j) => j.email === email)` → `one_open`; `live.length >= HF_MAX_OPEN` → `busy`; `kind === "video" &&
  live.filter(video).length >= HF_MAX_OPEN - 1` → `busy`. Not atomic (spec R13): Higgsfield's own concurrency refusal is
  the backstop.

**`advance(job, deps, {force, deadline, via})`** (spec 4.4 E):
1. Terminal → return it.
2. `queued`: `age <= QUEUED_LOST_MS` → return; else `withJobLock(id, () => failLocked(job, "submit_lost", ctx))` (not
   won → return: the start request is still working).
3. Not `force` and `!(await db.lock(mk.poll(id), POLL_GAP_S))` → return (someone polled in the last 4 s).
4. `!(await db.lock(mk.jobLock(id), JOB_LOCK_S))` → return without a status call (another worker is finalizing: spec
   A20). Everything below runs under the lock; `finally` unlocks.
5. Re-read the job; terminal → return it.
6. `job.resultUrls` → `finalizeLocked(job, job.resultUrls, job.providerCredits, ...)` (no status call; spec A25).
7. `budget(STATUS_MAX_MS, deadline) < STATUS_MIN_MS` → return. Status with `abortAfter(that budget)`; a throw → past
   `MEDIA_MAX_AGE_MS[kind]` fail `timeout`, else return unchanged.
8. `done` → `finalizeLocked`; `failed` → `failLocked(reason)`; `pending` past max age → `adapter.cancel?.()` (errors
   swallowed) then `failLocked("timeout")`; else return.

**`finalizeLocked(job, urls, providerCredits, deps, ctx)`** (internal; the caller holds the job lock):
1. Re-read the job; missing or terminal → return it.
2. `await db.get(mk.refundOnce(id))` truthy → a `fail` refunded this job but did not save: end it `failed` with
   `refunded: true` and the job's recorded error (or `provider_failed`), no task write (spec 4.3).
3. `url = urls.find((u) => u.startsWith("https://"))`; none → `failLocked(job, "provider_failed")`.
4. `budget(Infinity, deadline) < FINALIZE_MIN_MS[kind]` → save the job `running` with `resultUrls: urls` and
   `providerCredits`; return (the next poll or sweep copies it).
5. Copy: `deps.blobReady()` → `(await deps.store(url, kind, deadline)).url`; not ready and fal → `url` (hot-link).
   A `StoreError` (or not ready for kie/Higgsfield):
   - fal → keep the fal URL (spec A25, today's behaviour);
   - `storeTries + 1 < STORE_TRIES` and `age <= MEDIA_MAX_AGE_MS[kind]` → save the job `running` with `resultUrls`,
     `storeTries + 1`, `providerCredits`, and `db.set(mk.poll(id), 1, STORE_RETRY_S)` (the next status-free retry waits
     30 s); return;
   - else `failLocked(job, "store_failed", {providerCredits})`.
6. `costUsd = providerCredits != null ? providerCredits * KIE_USD_PER_CREDIT : COST_USD[model]`. `providerCredits >
   EXPECTED_KIE_CREDITS[model] * BREAKER.overbill` → `setOff(model, "overbilled", BREAKER.offMs)` (spec A22).
7. Re-read the task (it may be gone). If present: `mediaCredits = (t.mediaCredits ?? (hasArtwork(t) ? IMAGE_COST : 0)) +
   job.credits` always (the credit was kept, spec A14); media fields only when `t.mediaJob?.[kind] === job.id` (spec
   4.3): image → `imageUrl, imagePrompt, imageProvider, imageModel`; video → `videoUrl, videoPrompt, videoProvider,
   videoModel`; and `mediaJob[kind]` removed. A task whose `mediaJob[kind]` points at another job keeps its media fields.
8. Job `done` with `url`, `costUsd`, `providerCredits`, `finishedAt`, `resultUrls` removed. One `Promise.all`:
   `saveJob(done)`, `saveTask(scope, t)` if present, `db.srem(mk.open(provider), member)`, `releaseFlight(done)`,
   `recordOutcome(done)`, `track(email, "image")` for images, and `notifyOwner(done, t)` when `via` is `hook` or `sweep`.

**`failLocked(job, reason, ctx)`** (internal; the caller holds the job lock). `fail(job, reason, ctx)` is the same
wrapped in `withJobLock`:
1. Re-read; terminal → return it.
2. Refund decision (spec A32): `if (await db.lock(mk.refundOnce(id), JOB_TTL_S))`: `acct = await getUser(email)`;
   `!acct || acct.createdAt !== job.accountSince` → `refunded = false` (marker kept); else `try { credits = await
   refund(email, job.credits); refunded = true } catch (e) { if (message === "user_not_found") refunded = false; else {
   await db.unlock(mk.refundOnce(id)); throw e } }` (a transient error leaves the job open for the next poll or sweep).
   Marker already present → `refunded = job.refunded ?? true` (the earlier holder refunded, or skipped for a gone account
   and saved that).
3. Job `failed` with `error: reason`, `refunded`, `finishedAt`, `resultUrls` removed. One `Promise.all`: `saveJob`,
   `srem` open member, `releaseFlight`, `recordOutcome(failed, ctx)`, `job.trialVideo && refunded ?
   db.del(mk.trialVideo(email)) : null`, and, when the task exists and `mediaJob[kind]` is this job, `saveTask` without
   `mediaJob[kind]` and with `mediaLast[kind] = {error: reason, credits: job.credits, refunded, at}`; `notifyOwner` when
   `via` is `hook` or `sweep` and the account is valid. Returns `{job, credits}`.

**`releaseFlight(job)`**: `db.unlock(mk.flight(...))` only while `now − createdAt < FLIGHT_TTL_S[kind] * 1000` (the
unlock is an unconditional `DEL`, `docs/system/flows.md:102`).

**`recordOutcome(job, ctx)`** (spec 4.9, A22, A31); errors logged, never thrown. One `Promise.all` of, with `p =
${mk.spend(monthKey())}:m:${model}`:
- done: `incrby(p:jobs, 1)`, `incrby(p:credits, job.credits)`, `incrby(p:usd_micro, Math.round(costUsd * 1e6))`;
- failed: `incrby(p:failed, 1)`; `store_failed` also `incrby(p:usd_micro, Math.round((ctx.providerCredits != null ?
  ctx.providerCredits * KIE_USD_PER_CREDIT : COST_USD[model]) * 1e6))` (the provider billed us);
- `providerCredits != null`: `incrby(${mk.spend(month)}:kie_centicredits, Math.round(providerCredits * 100))`;
- `pushCapped(mk.recent(), JSON.stringify({id, model, state, error, providerCredits, costUsd, at}), 50)` (no email,
  no scope, no prompt);
- breaker: `store_failed`, `timeout`, or `submit_failed` whose `cause` is `rejected` or `bad_response` → `if (!(await
  allow(`mfail:${model}`, BREAKER.failures, BREAKER.windowS))) await setOff(model, reason, BREAKER.offMs)`; `cause ===
  "no_balance"` → `setOff` for every catalogue model of that provider for `BREAKER.noBalanceOffMs`.

**`setOff(model(s), reason, ms)`**: `db.lock(mk.offLock(), 5)` not won → return (the next failure retries); else
read `media:off`, set `{until: now + ms, reason}` for each model, drop expired entries, `db.set`, unlock.

**`notifyOwner(job, task)`** (spec A28): only when the task exists and `getUser(job.email)` has `createdAt ===
job.accountSince` (never after a wipe, so no `notifs:{email}` is recreated). `pushNotif(email, {kind: "info", title,
body, href: `/${job.lang}/app`})` with, in `job.lang`:
- done: ar «الفيديو جاهز: {title}» / «الصورة جاهزة: {title}», body «يظهر في صندوق الموافقة.»; en "Your video is ready:
  {title}" / "Your image is ready: {title}", body "It's in your inbox.";
- failed and refunded: ar «لم يكتمل الفيديو لـ«{title}»» / «لم تكتمل الصورة لـ«{title}»», body «أُعيدت {n} كريدت.»;
  en "The video for “{title}” did not finish" / "The image for “{title}” did not finish", body "{n} credits were
  returned.". `{title}` is `task.title` cut to 60 characters.

**`getJob`**: `JOB_ID.test(jobId) ? db.get<MediaJob>(mk.job(scope, jobId)) : null`. **`saveJob`**: `db.set(mk.job(scope,
id), {...job, updatedAt}, JOB_TTL_S)`.

**`jobForHook(provider, id)`**: `PROVIDER_TASK_ID[provider].test(id)` else null; `ref = db.get(mk.ref(provider, id))`;
`job = getJob(ref.scope, ref.jobId)`; null unless `job.provider === provider && job.providerTaskId === id`.

**`sweepMedia(deps, {deadline, limit})`**: `Promise.all` of `db.smembers(mk.open(p))` for the three providers;
`parseOpenMember` (unparseable members removed); `pmap(refs, r => getJob(...), 8)`; members whose job is gone or
terminal removed with one `Promise.all` of `srem`; candidates = jobs older than `STALE_MS` or holding `resultUrls`,
oldest first, cut to `limit`; `pmap(candidates, j => budget(Infinity, deadline) < 20_000 ? skip : advance(j, deps,
{force: true, deadline, via: "sweep"}), 4)`; per-job errors caught and counted. Returns `SweepReport`.

**`maybeSweep(deps, deadline)`**: `budget(Infinity, deadline) < 30_000` → null; `db.lock(mk.sweepLock(), SWEEP_LOCK_S)`
not won → null; else `sweepMedia(deps, {deadline, limit: 6})` with errors caught.

**`publicJob`**: `{id, kind, model, credits, createdAt, state: state === "queued" ? "running" : state, ...(error ? {error} : {})}`.

### Tests: `tests/media-jobs.test.ts`

Memory store; `newUser()` (50 credits) and a saved task per test; `fakeDeps` + `fakeAdapter`; `noNetwork()` for the
whole file; `beforeEach(resetMediaCounters)`; `mediaEnv({fal: true, kie: true, higgsfield: true, blob: true, models:
"all"})`; `now` injected where time matters; `deadline = Date.now() + 100_000` unless the test is about time.
1. fal sync: charged 1 once; task has `imageUrl` = stored Blob URL, `imageProvider: "fal"`, `imageModel: "img-fast"`,
   `mediaCredits: 1`; job done; open set empty; flight free (a second start succeeds); `render:_all:{month}:m:img-fast:jobs`
   is 1; `mediaJob` absent.
2. fal without Blob (`blob: false`) → the fal URL is kept, nothing stored; fal with Blob whose store throws
   (`storeFails: true`) → job done with the fal URL, no refund.
3. fal content refusal (`submit` → `{state: "failed", reason: "nsfw"}`) → 422 `nsfw`, balance 50, task not written.
4. kie async: 202 path returns `running`; `mjobref:kie:{id}` holds `{scope, jobId}`; `task.mediaJob.image` = job id
   already while queued (the submit script reads the task and records it); a `done` status on `advance` finalizes; a
   second `advance` is a no-op (status not called again).
5. Refund exactly once: status scripted `failed`; `Promise.all` of 6 `advance(job, deps, {force: true, deadline, via:
   "sweep"})` → balance back to 50 exactly, `mrefund:{id}` set, job `failed`.
6. Finalize/fail race: one advance sees `done`, a concurrent one sees `failed` → exactly one terminal state; credits
   refunded if and only if that state is `failed`.
7. Submit `ProviderError("busy")` → 429 `busy`, credits 50, job `failed` `submit_failed`; a plain throw → 502.
8. Double click: two concurrent `startMedia` for one task and kind → one ok, one 409 `in_progress` with the running
   job; charged once. Image and video on the same task may run together.
9. Order (spec A24): a 409 `in_progress` and a 402 from the balance pre-check leave `rate:media:image:h:{email}` and
   `rate:kie:create` unset (spy on `allow`: not called).
10. kie throttle: 18 starts on 18 tasks pass, the 19th → 429 `busy` with no charge and the flight lock free.
11. Higgsfield admission: two live jobs of two accounts → a third account 429 `busy`, no charge; one account with one
    live job → its second start 429 `one_open`; one live video → a second video from another account `busy`, an image
    from another account admitted; two members whose jobs are 31 minutes old (status scripted `pending`) do not block:
    they are force-advanced to `failed` `timeout` and refunded, and the new start is admitted; a member whose record is
    gone is removed.
12. Account limit: the 31st image in an hour → 429 `too_many`, no charge, flight free.
13. No credits (balance 0) → 402 `{need, have}`, flight free, no counter moved.
14. `charge` throws (`vi.spyOn(credits, "charge").mockRejectedValueOnce(new Error("user_lock_timeout"))`) → 429 `busy`,
    balance 50, flight free (a second start succeeds).
15. Redis write fails after the charge (`vi.spyOn(db, "set")` rejecting the first call whose key starts with `mjob:`) →
    502 `media_failed`, balance 50, flight free, `mrefund:{id}` set; if the record was written anyway, a later
    `advance` past 3 minutes ends it `submit_lost` with the balance still 50 (no second refund).
16. Deadline: `deadline = Date.now() + 4_000` → no submit call at all, `submit_failed`, refunded; a kie submit that never
    resolves but honours its signal, with `deadline = Date.now() + 5_500` (`it(..., 15_000)`), returns in under 6 s with
    `submit_failed` and the balance restored.
17. A queued job is reachable: while the submit runs, the task's `mediaJob.image` equals the job id, and `advance` on
    that job (another "tab") returns it unchanged without failing it (the job lock is held by the start).
18. Timeout: pending status with `now` past 10 minutes → `cancel` called once, `failed` `timeout`, refunded,
    `rate:mfail:{model}` incremented.
19. Lost submit: a `queued` job older than 3 minutes with a free job lock → `submit_lost`, refunded; younger →
    untouched; older but with the job lock held → untouched.
20. Poll throttle: two non-forced `advance` calls inside 4 s → one status call; five non-forced `advance` calls in a row
    (as five webhooks would) → one status call; `force` bypasses `mpoll`; a job whose `mjoblock` is held gets no status
    call even with `force`.
21. Copy retry: `storeFails: 1` → after the first `done` the job stays `running` with `resultUrls` and `storeTries: 1`;
    the next forced `advance` (after `mpoll` expires) finalizes it with no second status call. `storeFails: true` → after
    3 tries `failed` `store_failed`, refunded, and `render:_all:{month}:m:{model}:usd_micro` > 0.
22. Breaker: three `store_failed` jobs of `img-balanced` → `offModels()` contains `img-balanced`; `vid-sound` done with
    `providerCredits: 250` → `offModels()` contains `vid-sound`; a submit `ProviderError("no_balance")` on a kie model
    → all six kie models off for 1 hour; a `busy` submit error never trips it.
23. Refund throws once (spy on `refund` rejecting the first call with a transient error) → job stays open and the
    marker is deleted; the next `advance` refunds exactly once.
24. Account deleted (`wipeAccount`) before a failing `advance` → job `failed`, `refunded: false`, member removed,
    marker kept, no `notifs:{email}` key created; `newUser` with the same address afterwards, then another `advance` →
    nothing changes and the new account keeps its 50 credits.
25. Refund marker set (`db.lock(mrefund)`) and the job `running` → a `done` status leaves the job `failed`, the task
    untouched and the balance unchanged.
26. Task deleted before the result → job `done`, no task recreated, no refund.
27. A late, older job does not overwrite a newer one: `task.mediaJob.image` points at job B; job A finalizes → A `done`
    with its `url`, `task.imageUrl` unchanged, `task.mediaCredits` increased by A's credits.
28. `mediaCredits` of a legacy fal task (`imageUrl` + `imageProvider: "fal"`, no `mediaCredits`) after a 1-credit
    re-render is 2.
29. A job older than the flight TTL does not release the flight lock of a newer job on the same task.
30. The adapter received a signal that is defined and not aborted.
31. `jobForHook`: wrong provider, wrong id, malformed id → null; right pair → the job.
32. `sweepMedia`: orphan members removed; a stale pending job past max age failed and refunded; a done status
    finalized; `deadline` less than 20 s away advances nothing and reports `skipped`. `maybeSweep` twice in a row → the
    second returns null (lock).
33. Integer counters: with `vi.spyOn(db, "incrby")`, a kie job done with `providerCredits: 35` and another with `8.2` →
    every numeric argument passes `Number.isInteger`; `kie_centicredits` is 4320.
34. Notifications: a failure through `via: "sweep"` pushes one notification in the job's language whose body names the
    returned credits; the same failure through `via: "poll"` pushes none; a success through `via: "hook"` pushes "Your
    video is ready".
35. `mediaLast`: a failure sets `task.mediaLast.video = {error, credits, refunded: true}`; the next video start clears
    it; an image start leaves it.
36. Trial: a trial account's first video holds `mtrialvid:{email}`; a second video → 402 `trial_video_used`, no charge;
    when the first fails and is refunded, the marker is gone and a new video is allowed; a paid account never touches
    the marker.
37. `mjobs:recent`: every terminal transition pushes one entry with no `email`, `scope` or `prompt` field; the list is
    capped at 50.
38. A job id that is not 32 hex → `getJob` returns null without a Redis read (spy on `db.get`).

**Acceptance P6**: test file green; `grep -nE "from \"\\./(fal|kie|higgsfield|blob|registry)\"" src/lib/media/jobs.ts` prints
nothing; no `await db.` inside a `for`/`while` body (`grep -n "for (" src/lib/media/jobs.ts` reviewed); every
`incrby(` call's amount is an integer literal or wrapped in `Math.round`.

**Docs lines affected (P9b)**: flows.md section 8 and new section 23; architecture.md section 3 keys; tests.md rules 94,
95, 102, 103, 105-110.

---

## P7. Inbox UI (wave 1)

Build against the HTTP contract below (served by P8). No server module value imports (`tests/client-bundle.test.ts`).
`LimitModal.tsx` does not change: MediaControls raises it only for `trial_over` and for `no_credits` at a zero balance,
where its text ("You've used this month's credits") is true.

**HTTP contract**
- `POST /api/tasks/{id}/image {model?: MediaModelId}` and `POST /api/tasks/{id}/video {model: MediaModelId}`:
  - 200 `{ok: true, task, credits, provider, job?}` (image finished in the request, or placeholder);
  - 202 `{ok: true, job: PublicJob, task, credits}` (rendering; `job.credits` is what was charged);
  - 4xx/5xx `{ok: false, error: StartError, need?, have?, credits?, job?}` with status 400, 402, 409, 422, 429 or 502;
    `409 in_progress` carries the running `job`.
- `GET /api/media/{jobId}` → 200 `{ok: true, job, task?, credits?}`; 404; 429 `{error: "slow_down"}`.

**`src/components/app/MediaControls.tsx`** (new, `"use client"`):

```ts
export default function MediaControls(props: {
  task: Task; lang: Lang; t: AppDict; available: MediaModelId[];
  credits: number; plan: string; paused: boolean;
  /** Called after any 200 or 202 and when a poll ends done or failed: the parent drops its local copy and refreshes. */
  onChanged(): void;
}): JSX.Element
```

- Imports values only from `@/lib/media-catalog`, `@/lib/tasks`, `next/navigation` and `./LimitModal`
  (`limitFromError`); types with `import type`.
- When `paused`: one line above the buttons, `i.pausedNote`.
- One picker per kind (images when `IMAGE_TYPES.includes(task.type)`, video when `VIDEO_TYPES.includes(task.type)` and
  a video model is available): a `fieldset` with `legend` `i.imageModel` / `i.videoModel` and `role="radiogroup"` radio
  cards (not a native `<select>`: phones never show an option's `title`, and no browser shows it on a disabled option).
  Each card shows `label[lang]` and `${credits} ${i.credits}`. A card is disabled, with the reason as visible text on the
  card, when: `credits > props.credits` → `i.notEnough`; `plan === "trial"` and a video model not in
  `TRIAL_VIDEO_MODELS` → `i.afterSubscribe`; `needsImage` and `mediaImageFor(m, task)` is undefined →
  `i.needsImageNote`. The selected model's `hint[lang]` is shown as text under the group (`id` referenced by
  `aria-describedby`), followed by `i.buildsOnImage` when `mediaImageFor(m, task)` is defined, and by `i.squareClip`
  for `vid-motion` when `aspectFor("image", task.channel) === "square"`.
- Default selection per card, never shared between cards: images `DEFAULT_IMAGE_MODEL` when available, else the first
  enabled; video the first enabled (the cheapest). When no image model is available the image button still shows and
  posts without `model` (placeholder path, as today). Button text as today (`i.image`, `↻` prefix when the item already
  has that media) and `i.video`.
- Confirmation (inline, no `confirm()`): when the price is at least `CONFIRM_FROM_CREDITS`, or the item already has that
  media (`hasArtwork(task)` for images, `task.videoUrl` for video), the first click shows `i.confirmReplace` (when
  replacing) or `i.confirmCost` with `{n}` = credits, and two buttons `i.continue` / `i.cancel`; only Continue posts.
- Responses: 200 → `onChanged()`; 202 → `onChanged()` and poll `job`; 409 `in_progress` with `job` → poll it; 402
  `trial_over`, or `no_credits` with `have === 0` → `limitFromError(error)`; 402 `no_credits` with `have > 0` → inline
  `i.needCredits` (`{need}`, `{have}`) and a link to `/${lang}/app/billing` labelled `i.billingLink`; 402
  `plan_required` / `trial_video_used` → the inline `mediaErr` text and the same link; any other error → inline
  `i.mediaErr[error] ?? i.imageFail` (no `alert`).
- While rendering: the button disabled with `i.imaging` / `i.videoing`; under it `i.charged` with `{n}` = `job.credits`;
  for video also `i.videoSlow`.
- Polling: a `setTimeout` chain, 3 s (image) or 6 s (video) for the first 2 minutes, then 15 s; on 429 double the gap up
  to 30 s; stops on unmount, on `done` (→ `onChanged()`), on `failed` (→ the `mediaErr` text, then `onChanged()` so the
  balance and `mediaLast` refresh), and at `MEDIA_MAX_AGE_MS[kind] + 2 minutes` with `i.stillRendering`. The server
  fails and refunds the job at its max age on the next poll, so the owner normally sees the real outcome first.
- On mount, `task.mediaJob?.image` / `.video` resume polling (a reload does not lose a running render, and a job whose
  function was killed is failed and refunded by the next poll after 3 minutes). One polling loop per job id (kept in a ref), so a
  refresh that brings `task.mediaJob` back does not start a second loop.
- When not rendering and `task.mediaLast?.[kind]` exists: `i.mediaLastFailed` (`{n}` = its credits) plus
  `i.mediaErr[error]`.

**`src/components/app/Inbox.tsx`**
- `:32` props: add `media?: MediaModelId[]` (default `[]`), `credits?: number` (default 0), `plan?: string`,
  `paused?: boolean`.
- `:46` `imaging` state and `:72-79` `image()` are removed (moved into MediaControls).
- `:193-202`: keep the image block; below it, when `x.videoUrl`:
  `<video controls playsInline preload="metadata" poster={hasArtwork(x) ? x.imageUrl : undefined} src={`${x.videoUrl}#t=0.1`} className="h-48 rounded-lg bg-ink/5" />`
  (iOS Safari shows an empty box for `preload="metadata"` without a poster or a start offset); then a download link to
  `isOurBlobUrl(x.videoUrl) ? `${x.videoUrl}?download=1` : x.videoUrl` labelled `i.videoDownload`; a button
  `i.videoSave` shown when `navigator.canShare` exists, which fetches the MP4, wraps it in `new File([blob],
  "video.mp4", {type: "video/mp4"})`, and calls `navigator.share({files: [file]})` when `navigator.canShare({files:
  [file]})` is true (on iPhone this offers "Save Video" to Photos), else falls back to the download link (the
  implementer checks that the Blob URL answers the `fetch` with CORS; if it does not, the button is hidden and the link
  stays); the line `i.videoNoPublish`; and `x.videoPrompt` in `<p className="mt-1 line-clamp-4" dir="ltr">` exactly
  like `imagePrompt`. Update the comment at `:195-197`: URLs now come from our Blob store (and fal for older items) and
  placehold.co.
- `:255-257`: replace the image button with `<MediaControls task={x} lang={lang} t={t} available={media}
  credits={credits} plan={plan ?? "trial"} paused={!!paused} onChanged={() => { forgetLocal(x.id); r.refresh(); }} />`
  (the comment at `:67-68` explains why a leftover `local` entry must be dropped; `r.refresh()` also re-renders the
  sidebar balance, `src/components/app/Sidebar.tsx:140,167`).
- `:258`: `x.channel === "instagram" && connected.includes("instagram") && !hasArtwork(x)`.
- Imports: `hasArtwork`, `isOurBlobUrl` from `@/lib/media-catalog`; `IMAGE_TYPES` import at `:7` moves to MediaControls.

**`src/app/[lang]/app/page.tsx:23-24`**: add `offModels()` (from `@/lib/media/config`) to the existing `Promise.all`;
pass `media={availableModels(undefined, off)}`, `credits={u.credits}`, `plan={u.plan}`,
`paused={modelState() !== "on"}` (`modelState` from `@/lib/model`). The page is a server component, `force-dynamic`, so
the environment and the breaker are read per request.

**`src/lib/app-i18n.ts`** inbox blocks (`:74-76` ar, `:179-181` en), same keys in both (the dictionary type is `typeof
ar`, so `tsc` enforces parity). `{n}`, `{need}`, `{have}` are replaced in the component. Exact strings:

| Key | ar | en |
|---|---|---|
| `imageModel` | نوع الصورة | Image style |
| `videoModel` | نوع الفيديو | Video style |
| `video` | ولّدي فيديو | Generate video |
| `videoing` | نور تجهّز الفيديو… | Noor is rendering the video… |
| `videoSlow` | قد يستغرق بضع دقائق، ويمكن مغادرة الصفحة؛ يصل إشعار عند انتهائه. | This can take a few minutes. You can leave the page; a notification arrives when it finishes. |
| `stillRendering` | لم يكتمل بعد. إن لم يكتمل خلال دقائق تُعاد الكريدت تلقائياً ويظهر السبب هنا. | Not done yet. If it does not finish within minutes, the credits come back automatically and the reason shows here. |
| `credits` | كريدت | credits |
| `charged` | خُصمت {n} كريدت، وتعود تلقائياً إن لم يكتمل التوليد. | {n} credits used; they come back automatically if the render fails. |
| `confirmCost` | سيُخصم {n} كريدت. متابعة؟ | This uses {n} credits. Continue? |
| `confirmReplace` | سيُخصم {n} كريدت، ويحل الناتج الجديد محل الحالي. متابعة؟ | This uses {n} credits and replaces the current one. Continue? |
| `continue` | متابعة | Continue |
| `needCredits` | يحتاج {need} كريدت، ورصيدك {have}. | Needs {need} credits; you have {have}. |
| `billingLink` | الخطط والرصيد | Plans and credits |
| `notEnough` | الرصيد لا يكفي | Not enough credits |
| `afterSubscribe` | متاح بعد الاشتراك | Available after you subscribe |
| `buildsOnImage` | يبني على صورة هذا المنشور | Builds on this post's image |
| `needsImageNote` | يحتاج صورة مولّدة لهذا المنشور أولاً | Needs a generated image for this post first |
| `squareClip` | المقطع بشكل الصورة (مربع). | The clip keeps the photo's square shape. |
| `pausedNote` | إنشاء المحتوى متوقف مؤقتاً، لذا تُصنع الصور والفيديو من وصف ثابت لعلامتك لا من نص هذا المنشور. | Content generation is paused, so images and videos are made from a fixed description of your brand, not from this post. |
| `videoDownload` | تنزيل الفيديو | Download video |
| `videoSave` | حفظ أو مشاركة | Save or share |
| `videoNoPublish` | نشر الفيديو من نشر غير متاح بعد؛ يمكن تنزيله ونشره من الجوال. | Publishing video from Nashr isn't available yet; download it and post it from your phone. |
| `mediaLastFailed` | لم يكتمل آخر توليد، وأُعيدت {n} كريدت. | The last render did not finish; {n} credits were returned. |

`mediaErr` (one entry per code, both languages):

| Code | ar | en |
|---|---|---|
| `busy` | الخدمة مشغولة الآن. لم يُخصم أي كريدت، ويمكن المحاولة بعد دقيقة. | The service is busy right now. No credits were used; try again in a minute. |
| `one_open` | يوجد توليد جارٍ من هذا النوع في حسابك. يمكن البدء بعد انتهائه. لم يُخصم أي كريدت. | A render of this kind is already running in your account; start another when it finishes. No credits were used. |
| `too_many` | تم الوصول إلى حد التوليد (30 صورة في الساعة و150 في اليوم، 6 مقاطع في الساعة و20 في اليوم). لم يُخصم أي كريدت. | Render limit reached (30 images an hour and 150 a day; 6 clips an hour and 20 a day). No credits were used. |
| `in_progress` | التوليد جارٍ لهذا المنشور، وسيظهر هنا عند انتهائه. | A render is already running for this post; it will show here when it finishes. |
| `model_unavailable` | هذا النوع غير متاح الآن. لم يُخصم أي كريدت. | This style isn't available right now. No credits were used. |
| `needs_image` | يحتاج صورة مولّدة لهذا المنشور أولاً. لم يُخصم أي كريدت. | Needs a generated image for this post first. No credits were used. |
| `plan_required` | متاح بعد الاشتراك. لم يُخصم أي كريدت. | Available after you subscribe. No credits were used. |
| `trial_video_used` | التجربة المجانية تشمل مقطعاً واحداً، وقد استُخدم. لم يُخصم أي كريدت. | The free trial includes one clip, and it has been used. No credits were used. |
| `bad_model` | نوع غير معروف. لم يُخصم أي كريدت. | Unknown style. No credits were used. |
| `wrong_type` | هذا النوع من المحتوى لا يأخذ صورة أو فيديو. لم يُخصم أي كريدت. | This kind of item doesn't take an image or a video. No credits were used. |
| `nsfw` | رفض المولّد الطلب بسبب قواعد المحتوى لديه، وأُعيدت الكريدت. | The generator refused the request under its content rules; the credits were returned. |
| `timeout`, `provider_failed`, `store_failed`, `submit_failed`, `submit_lost`, `media_failed` | تعذّر التوليد هذه المرة، وأُعيدت الكريدت كاملة. | The render didn't work this time; all credits were returned. |

`media_failed` always means a refund happened: a `charge` that throws answers `busy` (spec A24). `igNeedsImage`
(`:76`, `:181`) stays as is. Reports block (`:101` ar, `:206` en): add `videos` («مقاطع مولّدة» / "Videos generated")
for P10's tile.

**Acceptance P7**: `npx tsc --noEmit` clean for these files once P0 has landed; `npx vitest run
tests/client-bundle.test.ts` green; `npx eslint` on the four files clean; after P8 lands, the manual check in Z (phone
width: radio cards, visible hint, confirm, running note, video poster, save/share, balance updates after a render and
after a refund).

**Docs lines affected (P9b)**: flows.md new section 23 (inbox steps).

---

## P8. Routes and wiring (wave 2)

### `src/lib/media/registry.ts` (new)

```ts
import { falAdapter } from "./fal"; import { kieAdapter } from "./kie"; import { higgsfieldAdapter } from "./higgsfield";
import { copyToBlob } from "./blob"; import { blobConfigured } from "./config";
/** The real providers and store. Tests replace this module with fakes (vi.mock), never the engine. */
export function mediaDeps(): MediaDeps { return { adapter: (p) => ADAPTERS[p], store: copyToBlob, blobReady: blobConfigured }; }
```

### `src/lib/media/start.ts` (new): validation shared by the routes and the chat tool

```ts
export type ImageOutcome = StartResult | { ok: true; placeholder: true; task: Task; credits: number };
export async function renderImage(u: User, t: Task, brand: Brand, requested: unknown, opts: { deadline: number; deps?: MediaDeps }): Promise<ImageOutcome>;
export async function renderVideo(u: User, t: Task, brand: Brand, requested: unknown, opts: { deadline: number; deps?: MediaDeps }): Promise<StartResult>;
export function mediaResponse(r: ImageOutcome): { status: number; body: Record<string, unknown> };
```

`renderImage`: `trialOver(u)` → 402 `trial_over`; `model = requested == null || requested === "" ? DEFAULT_IMAGE_MODEL
: requested`; not `isMediaModelId` or not an image model → 400 `bad_model`; `!IMAGE_TYPES.includes(t.type)` → 400
`wrong_type`; `off = await offModels()`; `!modelAvailable(model, off)`: the default model → placeholder (re-read the
task, set `imageUrl = https://placehold.co/1024x1024/0f3d3a/f2b33d.png?text=${encodeURIComponent(brand.name.slice(0,
24))}` (`src/lib/images.ts:34`), `imagePrompt = fixedImagePrompt(...)`, `imageProvider: "placeholder"`, delete
`imageModel`, `saveTask`, return `{ok: true, placeholder: true, task, credits: u.credits}`: nothing charged, spec A1); any
other → 409 `model_unavailable`. Otherwise `m = mediaModel(model)`, `aspect = aspectFor("image", t.channel)`,
`startMedia({scope: sc(u), email: u.email, lang: u.lang, accountSince: u.createdAt, plan: u.plan, balance: u.credits,
taskId: t.id, model, aspect, imageUrl: mediaImageFor(m, t), deadline, prompt: (ms) => imagePrompt(brand, t, model,
aspect, u.email, ms)}, deps ?? mediaDeps())`.

`renderVideo`: trial ended → 402 `trial_over`; model required and a video model (400 `bad_model`); `VIDEO_TYPES` (400
`wrong_type`); `u.plan === "trial" && !TRIAL_VIDEO_MODELS.includes(model)` → 402 `plan_required`; `modelAvailable(model,
await offModels())` (409 `model_unavailable`); `imageUrl = mediaImageFor(m, t)`; `m.needsImage && !imageUrl` → 409
`needs_image`; `startMedia` with `aspect: "portrait"`, that `imageUrl`, `prompt: (ms) => videoPrompt(brand, t, model,
!!imageUrl, u.email, ms)`.

`mediaResponse`: placeholder → 200 `{ok, task, credits, provider: "placeholder"}`; ok and job `done` → 200 `{ok, task,
credits, provider: job.provider, job: publicJob(job)}`; ok and not done → 202 `{ok, job: publicJob(job), task,
credits}`; error → its status and `{ok: false, error, ...need/have/credits/job}`.

### Routes

Each route computes `const deadline = deadlineFor(maxDuration)` on entry (spec A23).

- `src/app/api/tasks/[id]/image/route.ts` (rewrite `:1-37`, keep `maxDuration = 120`): `currentUser` (401) → task and
  brand under `sc(u)` (404) → `b = await req.json().catch(() => ({}))` → `renderImage(u, t, brand, b.model, {deadline})`
  → `after(() => maybeSweep(mediaDeps(), deadline))` → `mediaResponse`. Wrap in `try/catch` → 502 `{ok: false, error:
  "media_failed"}` with `console.error("image route", message only)` (`startMedia` throws only after the job is
  durable, so the job is recovered by the next poll or a sweep). Remove the old comments that name fal (`:16-17`,
  `:26-27`) and write one about the engine owning charge and refund.
- `src/app/api/tasks/[id]/video/route.ts` (new, `maxDuration = 120`, was 60 in the first draft: prompt 20 s + submit 20 s
  plus admission must fit): same shape with `renderVideo`.
- `src/app/api/media/[jobId]/route.ts` (new, `maxDuration = 120`): spec 4.4 E. `currentUser` → 401; `getJob(sc(u), jobId)`
  → 404 `not_found`; `allow(`mpoll:u:${u.email}`, 120, 60)` → 429 `{ok: false, error: "slow_down", job}`; `advance(job,
  mediaDeps(), {deadline, via: "poll"})` in `try/catch` (on throw, answer with the stored job); `task` when done
  (`getTask(sc(u), job.taskId)`), `credits` when failed (`getUser(u.email)`); `after(() => maybeSweep(mediaDeps(),
  deadline))`.
- `src/app/api/media/hook/[provider]/route.ts` (new, `maxDuration = 120`): spec 4.4 D, in that order: provider known and
  configured (404) → `allow(`mhook:${provider}:${clientIp(req)}`, 240, 60)` (429) → body ≤ 64 KB (413) → JSON (400) →
  `kieTaskIdFrom` / `hfRequestIdFrom` (400) → `verifyKieSignature` when `KIE_WEBHOOK_HMAC_KEY` is set (401) →
  `jobForHook` → when found, `after(() => advance(job, mediaDeps(), {deadline, via: "hook"}).then(() => undefined, (e) =>
  console.error("media hook", e instanceof Error ? e.message : "error")))` — **without `force`** (spec A30) → always
  `NextResponse.json({ok: true})` for a well-formed hint, job or not. No global bucket.
- `src/app/api/cron/media/route.ts` (new, `maxDuration = 300`): bearer from `authorization` as in
  `src/app/api/cron/daily/route.ts:67-68` (`sameSecret`, 401) → `NextResponse.json({ok: true, ...(await
  sweepMedia(mediaDeps(), {deadline: deadlineFor(300)}))})`.
- `vercel.json`: add `{ "path": "/api/cron/media", "schedule": "20 5 * * *" }` (every plan allows a daily cron; the
  founder's answer to spec Q2 may change it to `*/15 * * * *`).

### `src/lib/chat.ts`

- `:20` import → `import { renderImage } from "./media/start";`. `:24` keeps `IMAGE_COST, getTask`.
- `:83-87` tool description unchanged (1 credit, the default model, spec A2).
- `:366` `list_inbox`: add `${t.video ? " (has video)" : ""}` after the image marker.
- `:376-401` handler: task and brand lookups as today; `r = await renderImage(user, t, brand, undefined, {deadline:
  Date.now() + 100_000})` (spec R12: the chat route's start time is not available here);
  placeholder → `The image service is not configured, so "${t.title}" has a placeholder rather than artwork. No credit was
  used.`; `trial_over` → push `limit:trial`, `Trial ended. Owner must subscribe from the Subscription page.`
  (`tests/regressions.test.ts:190-191`); `no_credits` → push `limit:credits`, `Insufficient credits for an image.`;
  `wrong_type` → `Images are only for social, ads, gbp, whatsapp and cart_recovery items.`; `in_progress` → `An image for
  this item is already being drawn.`; `busy`, `one_open`, `too_many` → `The image service is busy; try again in a minute.
  No credit was used.`; `nsfw` → `The image service refused this request under its content rules; the credit was
  returned.`; any other error → `The image could not be generated; the credit was returned.`; ok → `user.credits =
  r.credits`, push `image:${t.id}`, then the existing success text (`:400`) with `r.job.provider`, or, when the job is
  still running, `The image for "${t.title}" is being drawn and will appear in the inbox shortly. Credits left: ...`.

### `src/lib/images.ts`

Delete the file (`git rm`). `grep -rn "generateImage\|@/lib/images\|\./images\"" src tests` must print nothing.

### Existing tests

- `tests/regressions.test.ts:285` and `:376`: replace `vi.stubEnv("FAL_KEY", "")` with `mediaEnv({})` and wrap with
  `const net = noNetwork()` / `net.restore()`; assertions unchanged. Update the describe comments at `:271-275` and
  `:364-367` (the placeholder is now not charged at all).
- `tests/model-pause.test.ts:24`: import `imagePrompt, videoPrompt` from `@/lib/media/prompts`; `:119-121`:
  `expect(await imagePrompt(brand, task, "img-fast", "square")).toMatch(/^Premium قهوة product photo/)` and
  `expect(await videoPrompt(brand, task, "vid-quick", false)).toMatch(/second vertical social video/)`; drop the
  `FAL_KEY` stub.
- `tests/p1-round2.test.ts:89-111` ("a stalled image provider still reaches the refund"): remove the describe (its rule
  moved to `tests/media-fal.test.ts` and `tests/media-jobs.test.ts` cases 16 and 30); remove imports it alone used.
- `tests/routes-isolation.test.ts`: import the video and media-job routes; in `beforeAll` write a job for A with
  `db.set(mk.job(A.email, <32 hex>), {...})`; add `videoRoute.POST` and `mediaRoute.GET` to the lists in "another
  account's task id is a 404 on every id-taking route, and the task is untouched" (`:35-50`) and "every workspace route
  answers 401 without a session" (`:83-100`).

### New test: `tests/media-routes.test.ts`

`vi.mock("@/lib/media/registry", () => ({ mediaDeps: () => g.deps }))` with a hoisted holder the tests fill from
`fakeDeps`; `noNetwork()` for the file; `beforeEach(resetMediaCounters)`; `mediaEnv({...})` per test; every webhook
request carries its own `ipHeaders(n)`.
1. Image route, no keys at all: 200 placeholder, balance 50 before and after, no adapter call.
2. `model: "constructor"`, a video id on the image route, an image id on the video route, a `weekly_plan` task → 400, no
   charge.
3. kie model with keys and Blob but `MEDIA_MODELS_ON` unset → 409 `model_unavailable`; with `models: "all"` but no Blob
   → 409; with both → 202; poll → running, then (scripted done) → 200 with `task.imageUrl` = the stored Blob URL and
   `imageProvider: "kie"`.
4. Two concurrent POSTs on one task → one 202, one 409 `in_progress`; charged once.
5. Poll isolation: B polls A's job → 404 and the adapter's `statusCalls` is 0; a malformed id → 404; signed out → 401.
6. Poll after a scripted failure → `credits` in the response equals the restored balance.
7. Video: `vid-motion` without a Blob image → 409 `needs_image`; a tiktok task with our kie image → `vid-quick`'s submit
   carried `imageUrl`; an instagram task with our kie image → `vid-quick`'s submit had no `imageUrl` and `vid-motion`'s
   had it; while paused (`vi.mock("@/lib/model")` → paused) the submitted prompt is the fixed video template, contains
   `no speech`, and the job still runs.
8. Webhook: unknown provider → 404; provider not configured → 404; unknown task id → 200 and no status call; A's kie task
   id → after `settle()` A's job is done under A's scope and nothing of B's changed; a body carrying `resultUrls:
   ["https://evil.example/x.jpg"]` → `deps.stored[0].source` is the adapter's URL, never the body's; 64 KB + 1 → 413; the
   241st hook from one IP in a minute → 429 while a hook from another IP → 200; five hooks for one job in a row → one
   status call after `settle()`.
9. HMAC (`mediaEnv({kie: true, blob: true, hmac: true, models: "all"})`): missing signature → 401; wrong key → 401;
   timestamp 301 s old → 401; valid → 200 and advanced. Without the key, an unsigned hint → 200.
10. Cron: no bearer, wrong bearer → 401; the right bearer → a stale pending job past max age is failed and refunded.
11. Chat tool: `runTool(user, "generate_image", {task_id})` with a fal fake → "Image generated"; with no keys → the
    placeholder text and balance unchanged.
12. Breaker: `media:off` holding `img-balanced` until the future → POST 409 `model_unavailable`, balance unchanged; the
    inbox list (`availableModels(undefined, await offModels())`) leaves it out.
13. Trial account: `vid-premium` → 402 `plan_required`, no charge; `vid-quick` → 202; a second `vid-quick` on another task
    → 402 `trial_video_used`.
14. Opportunistic sweep: B's poll schedules `maybeSweep`; after `settle()` A's stale pending job past max age is failed
    and refunded; a second poll within 5 minutes runs no sweep (another stale job's `statusCalls` unchanged).
15. Route ceilings: the image, video, poll and hook route modules export `maxDuration === 120`, the cron 300.

**Acceptance P8**: `npx vitest run tests/media-routes.test.ts tests/regressions.test.ts tests/model-pause.test.ts
tests/p1-round2.test.ts tests/routes-isolation.test.ts tests/meta-publish.test.ts` green; the `generateImage` grep empty;
`npx tsc --noEmit` clean.

**Docs lines affected (P9b)**: permissions.md rows 39, 91-95 and section 3.2; flows.md :84, :96, :105, section 16 and new
section 23; architecture.md 2.4, 2.6, section 4.

---

## P9a. Legal, help and product text (wave 2)

Write from the spec; no line numbers for new files.

- `src/lib/legal.ts:2` `updated` → `"2026-09-29"`. `:11` (ar) and `:35` (en), the third paragraph of "How we use it",
  becomes four sentences (spec R6, Q3). Arabic:
  1. «لا نبيع بياناتك، ولا يدرّب نشر نماذج على محتواك.»
  2. «نستخدم مزوّدي ذكاء اصطناعي (Anthropic للنصوص، وfal.ai وkie.ai وHiggsfield للصور والفيديو) وبنية تحتية (Vercel
     وتخزين الوسائط Vercel Blob، وUpstash، وResend للبريد) لمعالجة البيانات{DPA}.»
  3. «لتوليد الصور والفيديو نرسل وصف الصورة المبني من منشورك وعلامتك، وصورة المنشور الحالية، إلى fal.ai وkie.ai
     وHiggsfield. تسمح شروط Higgsfield لها باستخدام المدخلات والمخرجات لتحسين نماذجها، وتسمح شروط kie.ai لها باستخدام
     المحتوى لتشغيل خدمتها وتحسينها.»
  4. «الصور والفيديو التي يولّدها الفريق مصنوعة بالذكاء الاصطناعي.»
  English: "We do not sell your data, and Nashr does not train models on your content." / "We use AI providers
  (Anthropic for text; fal.ai, kie.ai and Higgsfield for images and video) and infrastructure (Vercel and its Vercel Blob
  media storage, Upstash, and Resend for email) to process data{DPA}." / "To generate images and video we send the
  image description built from your post and brand, and the post's current image, to fal.ai, kie.ai and Higgsfield.
  Higgsfield's terms allow it to use inputs and outputs to improve its models, and kie.ai's terms allow it to use
  content to operate and improve its service." / "Images and videos made by the team are AI-generated."
  `{DPA}`: « وفق اتفاقيات معالجة بيانات مع {list}» / ", under data-processing agreements with {list}", where `{list}` is
  only the providers whose acceptance date is recorded in `docs/Owner_Tasks_AR.md` when this package runs (founder
  question Q3); with none recorded, `{DPA}` is empty. Never kie.ai or Higgsfield until recorded.
- `src/lib/help.ts:13` (cost list): «صورة 1» / "image 1" → «صورة 1-2 · فيديو 12-24» / "image 1-2 · video 12-24".
- `src/lib/help.ts:32` ("Images?"), both languages: the «ولّدي صورة» button on social, ads and other posts, with a
  choice of style and its price (1 or 2 credits); some styles build on the post's current image; Arabic lettering inside
  images is not supported yet; if a render does not finish, the credits come back automatically. After it, a new entry
  «الفيديو؟» / "Video?": the «ولّدي فيديو» button on social and ad posts (12 or 24 credits by style); it takes a few
  minutes, the page can be left and a notification arrives; the clip can be watched and downloaded in the inbox;
  publishing video from Nashr is not available yet; if it does not finish, the credits come back automatically; trial
  accounts get one clip from the 12-credit styles. Arabic in verbal nouns and the passive (no gendered imperatives).
- `src/lib/help.ts:52` (account deletion), both languages: generated images and videos are stored on our media storage
  (Vercel Blob) at unguessable addresses, and older images on fal.ai; render records are kept up to 7 days; none of these
  is removed by account deletion; the owner can ask support to remove them. Grep `help.ts` for other image answers and
  keep them true.
- `PRODUCT.md:31`: "Images generate with `FAL_KEY` (placeholder otherwise); further image styles and video (generate,
  preview, download; no video publishing) from kie.ai and Higgsfield appear when their keys, the Blob store and
  `MEDIA_MODELS_ON` allow them." `:34` Undecided: replace "video generation" with "video publishing".
- `tests/content-claims.test.ts`: a new describe "media processors are disclosed honestly": in both languages the privacy
  text names kie.ai and Higgsfield, contains the Higgsfield training sentence and the AI-generated sentence, and no
  sentence that names kie.ai or Higgsfield also contains "data-processing agreement" / «اتفاقيات معالجة» unless that
  provider is in a `DPA_RECORDED` constant at the top of the test (empty today, updated with the legal text); the help
  cost answer mentions video; no help, legal or in-app string claims Arabic text inside images works
  (`/arabic (text|lettering|headline)/i` and «كتابة عربية» only next to "not supported" / «غير مدعومة»).

**Acceptance P9a**: `npx vitest run tests/content-claims.test.ts` green; `grep -n "fal.ai للصور\|fal.ai for images"
src/lib/legal.ts` prints nothing.

---

## P9b. System and owner docs (wave 3)

Write from the spec and the code landed in waves 1 and 2; cite new code by file and function name (no line numbers for
new files). Recount routes with `find src/app/api -name route.ts | wc -l` and handlers with
`grep -rhoE "export (async )?function (GET|POST|PUT|PATCH|DELETE|OPTIONS)" src/app/api | wc -l` (before this change: 59
files, 95 exports including 5 `OPTIONS`; the docs still say 57). Every file path and function named must exist (`grep`).

- `docs/system/architecture.md`: `:28` counts; `:34` add `tasks/[id]/video`; new "Media" row `media/[jobId]`,
  `media/hook/[provider]`; Cron row `cron/media`; Founder console row `admin/media`; `:72` replace the `images.ts` row with
  rows for `media-catalog.ts`, `media/{types,keys,config,fal,kie,higgsfield,blob,prompts,jobs,registry,start}.ts`; 2.6 add
  the `/api/cron/media` row, the opportunistic `maybeSweep`, and "All four require"; 2.7 `:103` image prompt call site →
  `media/prompts.ts`, `:105` fal row (FLUX schnell via `media/fal.ts`, `output_format: jpeg`, `has_nsfw_concepts`), add
  kie.ai, Higgsfield and Vercel Blob rows, `:106` placehold.co now from `media/start.ts`; section 3 add every key of spec
  4.2 with its TTL; section 4 add "(e) Media render" (spec 4.4 A+E+D in six lines, including the deadline); section 5
  `:220` split into "Vercel function to email (Resend)" and a new row "Vercel function to fal.ai, kie.ai, Higgsfield
  (prompts, our Blob image URLs) and from their result hosts (downloaded through safeFetch, capped, re-encoded)", plus an
  inbound row "Providers to `/api/media/hook/{provider}` (hint only, per-IP rate limit, kie HMAC)".
- `docs/system/flows.md`: `:92` pause paragraph (prompts fixed, the renderer is never paused, the inbox says so, video
  template); `:96` callers (`media/jobs.ts startMedia`, `chat.ts generate_image` via `media/start.ts`); `:105` step 8 is
  stale: trial expiry is now checked in the image and video routes, the chat tool and MCP `generate_content`
  (`src/app/api/mcp/route.ts:81`); add step 9 "Media credits" (start order, charge before submit, refund once,
  `mrefund`, same-account refunds, trial video); `:128-129` `hasArtwork`; section 16 add the media cron and
  `maybeSweep`; new section 23 "Media generation (images and video)" covering spec 4.4 A-G, the deadline, the breaker,
  `MEDIA_MODELS_ON`, notifications and the inbox polling.
- `docs/system/permissions.md`: `:18` counts; `:74` row 39 (`renderImage`, trial, type gate, charge inside
  `startMedia`); new rows: 91 `POST /api/tasks/{id}/video` (O; trial rules), 92 `GET /api/media/{jobId}` (O;
  `getJob(sc(u), id)`), 93 `POST /api/media/hook/{provider}` (A; per-IP rate limit, body cap, kie HMAC with `sameSecret`,
  scope from the stored reverse index, status re-fetched with our key under the job's throttle), 94 `GET /api/cron/media`
  (C), 95 `GET /api/admin/media` (F); section 3.2 rows for the job id (bound by `sc(u)`), the video route, and the
  webhook's provider task id (format-checked, only selects a server-written pointer; same shape as `oauthstate`); `:263`
  remove "trial expiry is not checked for image generation"; section 5 add "Higgsfield webhooks are unsigned; kie's are
  signed only when `KIE_WEBHOOK_HMAC_KEY` is set; both are hints".
- `docs/system/variables.md`: `:3` HEAD reference; section 3 heading "Email, media, support"; `:36` `FAL_KEY` row (read in
  `media/config.ts` and `media/fal.ts`; without it the default model gives the placeholder card, not charged); new rows
  for the six names of spec section 7 (`MEDIA_MODELS_ON` not secret) and an `APP_ORIGIN` note (webhook callbacks only for
  an explicit https origin); `:74-75` totals → 43 names (25 + 18), 22 secrets (13 platform, listed, plus the 9 connector
  secrets).
- `docs/system/costs.md`: `:17` `image_prompt` row covers image and video prompts, "charged with the render"; replace
  `:64` with a pointer to a new section "3.1 Media renders" holding spec 3.1-3.2's credits / our cost / $ per credit
  table, the expected kie credits per model and the note on `vid-cinematic`; section 5 add the media bounds (spec 4.8,
  trial video, breaker); section 6 add the `render:_all` counters, `mjobs:recent` and the console tiles.
- `docs/system/tests.md`: header counts (after Z's final run); update rules 40 (both image paths plus video, via
  `media/start.ts`), 44, 47 (placeholder not charged), 75 (`hasArtwork`, kie and Higgsfield), 76 (media prompts); add
  after rule 91 (`:80`):

| # | Rule | Verified by |
|---|---|---|
| 92 | Media model ids come from the catalog (prototype keys refused); the price shown is the price charged, pinned per model | `media-catalog.test.ts`, `media-routes.test.ts` |
| 93 | A kie or Higgsfield model is offered and accepted only with its keys, the Blob token and its id in `MEDIA_MODELS_ON`; fal works without Blob by hot-link | `media-catalog.test.ts`, `media-routes.test.ts`, `media-jobs.test.ts` |
| 94 | Media credits are charged once before submit and refunded exactly once on submit error, provider failure, content refusal, timeout, lost submit or storage failure, including under concurrent finalizers; a refunded job is never delivered | `media-jobs.test.ts` |
| 95 | One render per task and kind at a time: a double click is 409 and charges once | `media-jobs.test.ts`, `media-routes.test.ts` |
| 96 | A media job is read only under `sc(u)`: another account's job id is 404 and causes no provider call | `media-routes.test.ts`, `routes-isolation.test.ts` |
| 97 | The media webhook is a hint: per-IP rate-limited, body-capped, kie HMAC checked when configured, scope from the stored reverse index, status re-fetched with our key under the job's 4 s throttle, URLs in the body ignored | `media-routes.test.ts` |
| 98 | Provider results are downloaded through `safeFetch` with size caps and magic-byte checks, images re-encoded to JPEG (sharp's default `failOn`, transparency to white), stored under a random path with no tenant identifier | `media-blob.test.ts` |
| 99 | Instagram and the Facebook photo post take any real generated image (`hasArtwork`: fal, kie, Higgsfield), never a placeholder, an image with no provider, or a video | `meta-publish.test.ts`, `media-catalog.test.ts` |
| 100 | Provider calls use fixed hosts; keys travel only in headers; errors are fixed codes without bodies or keys; each model's request body is built in one place | `media-fal.test.ts`, `media-kie.test.ts`, `media-higgsfield.test.ts` |
| 101 | While Claude is paused, image and video prompts are fixed templates, the renderer still runs, and the inbox says so | `media-prompts.test.ts`, `model-pause.test.ts`, `media-routes.test.ts` |
| 102 | kie creates are throttled account-wide; Higgsfield admission counts live jobs only, one per account, videos below the cap; each account has hourly and daily render limits; a status call happens at most once per job per 4 s and never during a copy | `media-jobs.test.ts`, `media-routes.test.ts` |
| 103 | Stale jobs are finalized or refunded by the daily cron and the opportunistic sweep, with bounded parallel reads, a deadline and a 5-minute lock | `media-jobs.test.ts`, `media-routes.test.ts` |
| 104 | Render spend is recorded per model as integers and shown in the founder console with failures and the last 50 jobs; the media check route is founder-only, probes the Blob store and returns no secret | `media-admin.test.ts`, `media-jobs.test.ts` |
| 105 | Start order: a request that cannot pay or is refused moves no counter and keeps no lock; a failure after the charge and before the job is durable refunds at once | `media-jobs.test.ts` |
| 106 | Every render request runs against one deadline under its route's ceiling; the prompt call has no SDK retries; the job is findable from the task while queued | `media-prompts.test.ts`, `media-jobs.test.ts`, `media-routes.test.ts` |
| 107 | Repeated storage failures, timeouts, defect-class submit errors, an overbilled render or an empty provider balance switch the model (or provider) off for a while, with no charge on later clicks | `media-jobs.test.ts`, `media-routes.test.ts` |
| 108 | No label or hint claims quality or Arabic lettering; the English headline style never draws the post title or Arabic text | `media-catalog.test.ts`, `media-prompts.test.ts` |
| 109 | Trial accounts get at most one kept video, from the 12-credit models only | `media-jobs.test.ts`, `media-routes.test.ts` |
| 110 | Unattended outcomes notify the owner; refunds and notifications go only to the account that was charged, never to a deleted or re-registered one | `media-jobs.test.ts` |
| 111 | The privacy policy names every media processor and Higgsfield's training right, and claims a data-processing agreement only where one is recorded | `content-claims.test.ts` |

  and a footer line: "Rules 92-111 were added on 2026-09-29 with kie.ai, Higgsfield, Vercel Blob and video."
- `docs/Owner_Tasks_AR.md`: bump «آخر تحديث»; new section «الصور والفيديو (kie.ai وHiggsfield وVercel Blob)» with spec
  section 8 steps 1-8 as checkboxes, in Arabic, commands for the founder's own terminal only (`vercel env add ...`),
  never a value; `:55-56` and `:131-133` (spend limits and key setup) extended to kie.ai, Higgsfield and Blob; `:233`
  (DPAs) adds kie.ai and Higgsfield and asks for each acceptance date (spec Q3); the item «هل نبني توليد الفيديو الآن أم
  لاحقاً؟ (#190)» ticked as decided on 2026-09-29 (founder decision F1); the open founder questions Q1-Q5 of spec
  section 11 listed as items.
- `docs/Project_Summary_AR.md:9,73,114` and `docs/Requirements_and_Steps_AR.md:42,59`: image provider now fal.ai, kie.ai
  and Higgsfield with Vercel Blob storage; video generation (generate, preview, download; no publishing); key setup and
  spend limits per provider (research `code.docsToUpdate`).

**Acceptance P9b**: every file path and function named in the docs exists (`grep` each); route counts match the commands
above; `npx vitest run tests/content-claims.test.ts` green.

---

## P10. Founder console and reports (wave 2)

- `src/lib/admin-stats.ts`:
  - `export async function renderSpend(month = monthKey()): Promise<{ usd: number; kieCredits: number; byProvider:
    Record<MediaProviderId, { usd: number; jobs: number; failed: number }>; byModel: Record<MediaModelId, { jobs: number;
    failed: number; credits: number; usd: number }> }>` reading `render:_all:{month}:m:{model}:{jobs,failed,credits,
    usd_micro}` for every catalogue model and `:kie_centicredits` with one `Promise.all` (no loop awaits); provider and
    total figures are sums in code; `usd = usd_micro / 1e6`, `kieCredits = centicredits / 100`.
  - `Overview.revenue` (`:17`) gains `renderCostUsd: number; renderByProvider: ...; renderByModel: ...`.
  - `:71`: `(t.mediaCredits ?? (t.image ? IMAGE_COST : 0))` instead of `(t.image ? IMAGE_COST : 0)`.
  - `:73-75`: fetch `renderSpend()` next to `getUsage("_all")` (same `Promise.all`); gross margin subtracts
    `(total.usd + render.usd) * usdToSar`.
  - `:87`: include the new fields.
- `src/lib/stats.ts`: `Kpis` (`:20`) gains `videos: number`; `:107` credits use `t.mediaCredits ?? (t.image ?
  IMAGE_COST : 0)`; `:129` add `videos: cur.filter((t) => t.video).length`; `statsText` (`:148`): "images generated:
  N; videos generated: M".
- `src/components/app/ReportsPanel.tsx`: add `"videos"` to `METRICS` and `videos: { label: R.videos, value:
  String(k.videos) }` to the value map (`:49-58`); the default picked metrics are unchanged. `R.videos` comes from P7's
  `reports.videos`.
- `src/components/app/AdminConsole.tsx`: type `:21` as above; dictionaries `:34-35` add `render` ("Render cost this month
  $" / «تكلفة توليد الصور والفيديو هذا الشهر $»), `check` ("Check media providers" / «فحص مزوّدي الوسائط»), `models`
  ("Per model" / «حسب النوع»), `recent` ("Last renders" / «آخر عمليات التوليد»), `off` ("Switched off" / «متوقف
  مؤقتاً»); billing tiles `:192`: a fifth tile with `renderCostUsd.toFixed(2)`; a per-model table (model id, jobs,
  failed, credits kept, USD, $ per credit = USD / credits kept); a button that fetches `/api/admin/media` and shows, as
  plain text: configured flags (green/red, `webhooks: off` and a Blob probe that is not `ok` in red), `MEDIA_MODELS_ON`
  ids, the kie balance, each Higgsfield model's estimate or error, the switched-off models with their reason and end
  time, and the last 50 jobs.
- `src/app/api/admin/media/route.ts` (new): `export const dynamic = "force-dynamic"; export const maxDuration = 60;`
  `GET(req)`: `isAdmin(req)` else 401 (same as `src/app/api/admin/overview/route.ts:8-9`); one `Promise.all` of:
  `kieAdapter.check(abortAfter(10_000))` when kie is configured, `higgsfieldAdapter.check(...)` when Higgsfield is,
  `probeBlob(abortAfter(10_000))`, the three open-set sizes, `renderSpend()`, `offModels()` and
  `db.lrange(mk.recent(), 0, 49)`; each check wrapped with `.catch(() => ({ error: "unreachable" }))`. Response `{ok,
  configured: {fal, kie, higgsfield, blob, webhooks: !!callbackUrl("kie")}, modelsOn: [...modelsSwitchedOn()],
  available: availableModels(undefined, off), blob: probe, kie, higgsfield, open, spend, off, recent}`. No variable
  value, ever (`MEDIA_MODELS_ON` ids are not secret).
- `tests/media-admin.test.ts` (new): anonymous and a signed-in customer → 401 (pattern of
  `tests/routes-admin-cron.test.ts:40-56`); the founder (`ADMIN_EMAILS` stubbed) → 200 with configured flags; with
  `mediaEnv({kie: true, higgsfield: true, blob: true, models: "img-balanced"})`, fetch scripted and `@vercel/blob`
  mocked, the JSON contains the balance, the estimates, `blob: "ok"` and `modelsOn: ["img-fast", "img-balanced"]`, and,
  as a string, contains none of the stubbed variable values; a `put` that throws → `blob: "error:put_failed"`;
  `overview().revenue.renderCostUsd` equals the sum written on the per-model counters, `renderByModel["vid-quick"]`
  carries jobs, failed and credits, and the gross margin includes the render cost; `media:off` and `mjobs:recent`
  entries appear in the response; `kpis` credits count `mediaCredits` (a task with `mediaCredits: 24` adds 24) and
  `videos` counts tasks with a video; `statsText` mentions videos.

**Acceptance P10**: `npx vitest run tests/media-admin.test.ts tests/routes-admin-cron.test.ts tests/task-index.test.ts`
and any existing test that pins `Kpis` or `METRICS` green.

**Docs lines affected (P9b)**: costs.md section 6; permissions.md row 95; flows.md section 14.

---

## Z. Integration (wave 4, owner: lead)

1. Confirm every package's acceptance list. Any failure goes back to the owning package.
2. Guards:
   - `grep -rn 'imageProvider === "fal"\|imageProvider !== "fal"' src` → nothing.
   - `grep -rn "generateImage\|lib/images" src tests` → nothing.
   - `grep -rn "KIE_API_KEY\|HIGGSFIELD_API_KEY\|BLOB_READ_WRITE_TOKEN\|KIE_WEBHOOK_HMAC_KEY\|MEDIA_MODELS_ON" src` → only
     `media/config.ts`, `media/kie.ts`, `media/higgsfield.ts`, `media/blob.ts`, the hook route.
   - `grep -rnE "console\.(log|error)\([^)]*(headers|Authorization|body)" src/lib/media src/app/api/media` → nothing.
   - `grep -rn "@higgsfield/client\|@fal-ai" package.json` → nothing.
   - `grep -n "maxRetries: 0" src/lib/media/prompts.ts` → a match; `grep -rn "failOn" src/lib/media` → nothing;
     `grep -rn "force: true" src/app/api/media/hook` → nothing; `grep -rn "AbortSignal.timeout" src/lib/media` → nothing
     (`abortAfter` only).
3. Lockfile: the four greps of P0.1 still pass; the `npm ls --depth=0` diff against the pre-change list shows only
   `@vercel/blob` and `sharp`; `npm ci` from a clean `node_modules` succeeds.
4. `npm run check` (type-check, lint, all unit tests) and `npx next build` green.
5. `docs/system/tests.md` header: update the file and test counts from the final `npx vitest run` summary.
6. Commit (message ends with the attribution line of the session), push, wait for CI green.
7. Production verification (confirm the deploy is live first, as in the deploy-verification note: do not trust the edge
   cache):
   - `curl -s -o /dev/null -w "%{http_code}" -X POST https://<prod>/api/media/hook/unknown` → 404;
   - `curl ... https://<prod>/api/media/00000000000000000000000000000000` without a cookie → 401;
   - `curl ... https://<prod>/api/cron/media` without the bearer → 401;
   - the inbox offers only "Fast" while `MEDIA_MODELS_ON` is unset;
   - then the founder runs owner steps 5 and 6 of the spec (console check with the Blob probe, models switched on one
     at a time, one render per model, the `vid-sound` balance-difference check, the Arabic headline test) and reports the
     results.
8. If the provider check shows a red Higgsfield or kie line, the fix is one line in `HF_MODELS` / `KIE_MODELS` (owned by P3
   / P2), followed by steps 4-7 again; the model stays out of `MEDIA_MODELS_ON` until then.

---

## Critique log (2026-09-29)

Each point was checked against the code at `99d9801`, the installed packages and the research file. Result: **47
accepted, 0 rejected** (seven of the accepted points duplicate or overlap another and share its fix). The file-ownership
rule still holds after the edits: P10 took `src/components/app/ReportsPanel.tsx`, P9a took `PRODUCT.md` and
`tests/content-claims.test.ts`, P9b took the three Arabic owner docs; no file has two owners.

| # | Area | Verdict | Checked against | Where it is fixed, or why it differs from the proposal |
|---|---|---|---|---|
| 0 | Charge before a durable record; flight lock leaked on a `charge` throw | Accepted (option b) | `credits.ts:14-18` throws `user_lock_timeout`; plan steps 5-6 had no catch | Spec A24, 4.4 A step 3-4, section 6 rows; P6 `startMedia` steps 2-10 (balance pre-check, `try/finally` on the flight lock, `charge` throw → 429 `busy`, Round A failure → `refundUnsaved` under `mrefund` → 502); tests 14, 15. Option (a) (save first with `charged: false`) was not taken: it is no more robust against a thrown error and adds writes and a delete on every 402. |
| 1 | Time budgets over the route ceilings; SDK retries; queued job unreachable | Accepted | `@anthropic-ai/sdk/client.js:112` (`maxRetries ?? 2`), `:548-556`; `images.ts:36-38` | Spec A12, A23, 4.4 A; P0.4 `deadlineFor`/`budget`/`abortAfter`; P1 `{timeout, maxRetries: 0}`; P4 deadline-bound download and put (15/20 s image); P6 steps 11-16 and `FINALIZE_MIN_MS`; P8 video route to 120 s; `task.mediaJob` written in Round A for every provider; tests P1, P6 16-17, P8 15. |
| 2 | Higgsfield cap counts raw members; daily-only backstop | Accepted | `plan` step 3 used `smembers(...).length`; `vercel.json` crons are daily | Spec A3, A10, 4.4 F; P6 `hfAdmission` (live jobs only, bounded clean-up behind `mhfclean`, 1 per account `one_open`, videos ≤ cap − 1) and `maybeSweep` from the start and poll routes; console `webhooks: off` in red; tests P6 11, 32, P8 14. A 15-minute cron depends on the Vercel plan: founder question Q2. |
| 3 | Systematic "provider bills us, owner refunded" loss | Accepted | `blobConfigured()` only checks the variable | Spec A22, A25; P6 `finalizeLocked` step 5 (retry from `resultUrls`, 3 tries, 30 s apart; fal falls back to hot-link), `recordOutcome` breaker (3 failures/hour → 6 h off; overbill > 110 %; `no_balance` → provider off 1 h), `setOff`; P0.5 `offModels`, `EXPECTED_KIE_CREDITS`; console lists switched-off models; tests P6 21-22, P8 12. |
| 4 | Veo `creditsConsumed` never recorded | Accepted | Research: `creditsConsumed` documented for market `recordInfo` and callbacks only | Spec 3.3 `vid-sound` row, R1, section 8 step 6 (balance difference 60 vs ~250 before turning the model on); P2 Veo status parses a numeric `data.creditsConsumed` and documents whether record-info lists it; test in P2. |
| 5 | Refund after `wipeAccount` throws forever; re-registered address gets the refund | Accepted, extended | `credits.ts:20-21`, `account.ts:54` | Spec A32; P6 `failLocked` step 2 (`user_not_found` and a changed `createdAt` → terminal, `refunded: false`, marker kept); `accountSince` on the job; `notifyOwner` skipped too, so no `notifs:{email}` is recreated after a wipe; test P6 24. |
| 6 | Finalize ignores the refund marker | Accepted | plan finalize had no marker check | Spec 4.3; P6 `finalizeLocked` step 2; test P6 25. |
| 7 | Webhook `force` skips the poll throttle; global bucket drained before validation | Accepted (no global bucket) | Research: Higgsfield duplicates, 4xx permanent | Spec A30, 4.4 D; P8 hook route (per-IP only, `advance` without `force`); tests P6 20, P8 8. The proposal offered "charge the bucket after `jobForHook`" or "drop it"; dropping it is simpler because the shared 4 s job throttle already bounds provider calls per job. |
| 8 | Float `incrby` | Accepted | `node`: 40 of 1..400 give non-integers; `usage.ts:39` rounds | Spec A31; P6 `recordOutcome` (`Math.round`, `kie_centicredits`); test P6 33. Centicredits rather than decicredits so any kie fraction is kept. |
| 9 | fal `has_nsfw_concepts` ignored | Accepted | fal output schema (research `code.falIntegration`) | Spec 3.1, 3.3; P0.3 `SubmitResult` `failed`; P1 fal adapter; P6 step 14 (422 `nsfw`, refund); tests P1, P6 3. |
| 10 | Same as 1 (time budgets) | Accepted (duplicate of 1) | as 1 | As 1. The image route keeps `maxDuration = 120` with tightened, deadline-bound steps (worst case ~102 s of a 105 s deadline); the video route goes to 120. |
| 11 | Same as 2 (Higgsfield cap, daily sweep) | Accepted (duplicate of 2) | as 2 | As 2, including "two Higgsfield jobs older than 30 minutes do not block a new start" (test P6 11). |
| 12 | Test counters leak between tests | Accepted | `db.ts:88-90`, `rate.ts:5-16` | P0.7 `resetMediaCounters()` and `ipHeaders(n)`; `beforeEach` in `media-jobs`, `media-routes` (and `media-admin` where jobs start). |
| 13 | Same as 8 | Accepted (duplicate of 8) | as 8 | As 8; test uses 35 and 8.2. |
| 14 | `render:{email}` counters survive `wipeAccount` | Accepted (global counters only) | `account.ts:12-24` wipes `usage:` only; `tests/p1-fixes.test.ts:123-160` | Spec A19, 4.2 key table; P0.4 `mk.spend(month)` is global; `account.ts` stays on the must-not-change list. Remaining email-bearing keys are TTL-bound (`rate:`, `mflight`, `mtrialvid`, 7-day `mjob`), stated in A19 and in the help text (P9a). |
| 15 | Refused requests consume limits and the shared kie throttle | Accepted, extended | `rate.ts:7` increments on refusal | Spec A24; P6 order (balance pre-check → flight lock → limits → trial → throttle → charge); test P6 9. |
| 16 | Late finalize overwrites a newer render | Accepted | flight TTL 900/2100 s vs sweep | Spec 4.3; P6 `finalizeLocked` step 7 (media fields only when `mediaJob[kind]` matches; `mediaCredits` added either way); test P6 27. |
| 17 | `failOn: "error"` weaker than the default | Accepted | `node_modules/sharp/dist/index.d.mts:989-991` (sharp 0.35.4) | Spec 4.6; P4 `toJpeg` (no `failOn`); test for a truncated PNG; Z guard. |
| 18 | `TaskLite.mediaCredits` typed as always present; legacy credit dropped | Accepted | `brand.ts:119-137` | Spec A14, 4.2; P0.6 (optional field, no value import in `brand.ts`); P6 step 7 fallback `hasArtwork(t) ? IMAGE_COST : 0`; test P6 28. |
| 19 | Pinned `local` copy and no refresh after a render | Accepted | `Inbox.tsx:67-79` | P7 `onChanged` → `forgetLocal(id)` + `r.refresh()` on 200, 202, done and failed. |
| 20 | P9 cannot count routes while P8/P10 are in flight | Accepted | plan waves | Section 0: P9a (legal, help, product text) in wave 2, P9b (system and owner docs) in wave 3, Z in wave 4. |
| 21 | Arabic project docs unowned | Accepted | research `code.docsToUpdate` | P9b owns `docs/Owner_Tasks_AR.md` (spec section 8 steps, Q1-Q5, #190 ticked), `docs/Project_Summary_AR.md`, `docs/Requirements_and_Steps_AR.md`. |
| 22 | Console never touches the Blob store | Accepted | A15 as drafted | Spec A15, 4.6; P4 `probeBlob` (put, `isOurBlobUrl`, `del`; `del` signature confirmed with context7); P10 route and console; tests P4, P10. |
| 23 | Status calls while a job is being copied; webhook `force` | Accepted, different mechanism | `db.ts:170-178`: the memory lock stores an expiry timestamp, so `db.get` on a lock key cannot tell held from expired | Spec A20; P6 `advance` takes `mjoblock` before the status call (not won → no call) and holds it through finalize; webhooks without `force` (as 7); test P6 20. |
| 24 | Lockfile regeneration may move other direct dependencies | Accepted | CLAUDE.md lockfile rule | Spec A16; P0.1 `npm ls --depth=0` before/after and the pin-back rule; Z step 3. |
| 25 | Cited test line numbers off | Accepted | `tests/client-bundle.test.ts:41-45, 47-54`; `tests/routes-isolation.test.ts:35-50, 83-100` | P0.8 and P8 now cite the `it(...)` titles with the corrected lines. |
| 26 | `img-text` implies Arabic lettering; paused template quotes Arabic titles | Accepted | `model.ts:12` (`CLAUDE_PAUSED = true`); research: Arabic in image not documented | Spec A27, 3.1, R4, Q5; P0.2 label «صورة بعنوان إنجليزي» and hint; P1 text template (Latin brand name or design template, never the title) and "headline in English" rule; tests in P0.8 and P1; tests.md rule 108. |
| 27 | Every configured model goes live before the console check | Accepted | `modelAvailable` = keys + Blob | Spec A21, section 7, section 8 steps 4-6; P0.5 `modelsSwitchedOn()`; P0.7 `mediaEnv({models})`; tests P0.8, P8 3. |
| 28 | Pause invisible; video template product-only; no lifestyle style; video prompt hidden | Accepted | `model.ts:12`; `Inbox.tsx:200` | Spec 4.5; P1 templates (scene of a `{industry}` business, lifestyle style); P7 `pausedNote` (worded like the existing «إنشاء المحتوى متوقف مؤقتاً»), `videoPrompt` shown `dir="ltr"`; P7 page passes `paused`. |
| 29 | Paywall modal says the month's credits are used when they are not | Accepted | `LimitModal.tsx:13-16`; `app-i18n.ts:96,201` | P7: inline `needCredits` with a billing link when `have > 0`; modal only for `trial_over` or a zero balance; `notEnough` on options above the balance; page passes `credits`. |
| 30 | Sidebar balance stale after a charge or refund | Accepted (with 19) | `Sidebar.tsx:140,167` read server props | P7 `onChanged` refresh; running note `charged`. |
| 31 | Silent outcomes when the owner left the page | Accepted | `notifications.ts:30` (`pushNotif`, kind `info`) | Spec A28; P0.3 `lang` on the job; P6 `notifyOwner` (hook and sweep only, same-account only) and `mediaLast`; P7 shows `mediaLast`; tests P6 34-35. |
| 32 | Hints invisible on phones; image reuse unexplained | Accepted | `<option title>` not shown on iOS/Android | P7 radio cards with the selected hint as visible text (`aria-describedby`), `buildsOnImage`, disabled reasons on the card; P0.2 `mediaImageFor` shared by UI and server. |
| 33 | "Premium product shot" implies the owner's own product | Accepted | spec section 9 (no product uploads) | Spec section 3 note; P0.2 label «صورة إعلانية فاخرة» / "Premium ad image" and hint. |
| 34 | Square first frames give square clips | Accepted | research: no aspect field on Kling 2.5 i2v and Hailuo; Seedance aspect text-to-video only | Spec A26, 3.2; P0.2 `mediaImageFor`; P7 `squareClip` note for Photo to motion; tests P0.8, P8 7. |
| 35 | Higgsfield cap blocked by abandoned jobs (overlaps 2) | Accepted (with 2) | as 2 | As 2; "keep one slot for images" is "videos at most `HF_MAX_OPEN − 1`"; the `busy` text says no credit was used and to retry in a minute. |
| 36 | Trial accounts can spend dollars on video | Accepted as a default; founder decides | `auth.ts:86`, `referral.ts:6,25-26`, `Owner_Tasks_AR.md` (#49: any email gets 50 credits) | Spec A29, Q1; P0.2 `TRIAL_VIDEO_MODELS`, `TRIAL_VIDEOS`; P6 `mtrialvid` (released on refund); P8 `plan_required`; P7 `afterSubscribe`; tests P6 36, P8 13. A separate "1 per day" limit is not added: one kept video per trial already bounds it. |
| 37 | Spend invisible per model, on failures and for refunds | Accepted | plan `recordSpend` only on done | Spec 4.9; P6 `recordOutcome` (per-model jobs/failed/credits/usd_micro, `store_failed` cost, `mjobs:recent`); P10 per-model table and recent jobs; tests P6 21, 37, P10. Counters are global only (see 14). |
| 38 | Privacy text would claim DPAs and no training for providers that may train | Accepted | `legal.ts:11,35`; research commercial-use sections | Spec R6, section 8 step 7, Q3; P9a four-sentence text, DPA phrase only for recorded providers; `content-claims.test.ts`; tests.md rule 111. |
| 39 | Gendered imperatives; unwritten error texts | Accepted | memory: Arabic for the founder gender-neutral | Section 0 style rule; P0.2 hints; P7 exact strings for every key and `mediaErr` code; P0.8 whole-word check. Existing strings are not rewritten in this change. |
| 40 | "Design / poster" promises wording the prompt forbids | Accepted | P1 design template "no text" | P0.2 «تصميم جرافيك» / "Graphic design" and hint. |
| 41 | Quality claims; possible speech on sound models | Accepted | spec section 5 no-claims rule; research: speech language undocumented | P0.2 hints; P1 "no speech, no dialogue, no voice-over" in fixed and Sonnet video prompts; tests P0.8, P1. |
| 42 | Blank video box on iOS; clip not reachable in Photos; no "cannot publish" note | Accepted | `Inbox.tsx:200` | P7 poster / `#t=0.1`, save-or-share with `navigator.share({files})` and a download fallback (CORS checked by the implementer), `videoNoPublish`; P5 test: a video-only post is not an Instagram target. |
| 43 | One tap spends 12-24 credits or replaces paid media | Accepted | P7 draft posted on click | P0.2 `CONFIRM_FROM_CREDITS`; P7 inline confirm (`confirmCost`, `confirmReplace`); defaults never carried between cards. |
| 44 | "It will appear here" after the server already refunded | Accepted | `MAX_AGE_MS` 10/30 min vs client 11/31 min | P0.2 `MEDIA_MAX_AGE_MS` shared; P7 keeps polling (slower) until the server's outcome, hard stop at max age + 2 min with the new `stillRendering` text. |
| 45 | Help centre and PRODUCT.md out of date | Accepted | `help.ts:13,32`; `PRODUCT.md:31,34` | P9a help cost list, images answer, new video answer, deletion answer; `PRODUCT.md:31,34`. |
| 46 | Credits rise with no video tile or report line | Accepted | `stats.ts:107,129,148`; `ReportsPanel.tsx:49-58` | P10 `videos` KPI, tile, `statsText` line (P10 now owns `ReportsPanel.tsx`); P7 adds `reports.videos`. |

### Final package list

| Package | Wave | Owns | Depends on |
|---|---|---|---|
| P0 contracts | 0 | `package.json`, `package-lock.json`, `src/lib/media-catalog.ts`, `src/lib/media/{types,keys,config}.ts`, `src/lib/tasks.ts`, `src/lib/brand.ts`, `tests/helpers/media.ts`, `tests/client-bundle.test.ts`, `tests/media-catalog.test.ts` | — |
| P1 fal + prompts | 1 | `src/lib/media/{fal,prompts}.ts`, `tests/media-{fal,prompts}.test.ts` | P0 |
| P2 kie | 1 | `src/lib/media/kie.ts`, `tests/media-kie.test.ts` | P0 |
| P3 Higgsfield | 1 | `src/lib/media/higgsfield.ts`, `tests/media-higgsfield.test.ts` | P0 |
| P4 Blob store | 1 | `src/lib/media/blob.ts`, `tests/media-blob.test.ts` | P0 |
| P5 publishing | 1 | `src/lib/connectors/{targets,publish}.ts`, `tests/meta-publish.test.ts` | P0 |
| P6 job engine | 1 | `src/lib/media/jobs.ts`, `tests/media-jobs.test.ts` | P0 |
| P7 inbox UI | 1 | `src/components/app/{Inbox,MediaControls}.tsx`, `src/app/[lang]/app/page.tsx`, `src/lib/app-i18n.ts` | P0 (HTTP contract served by P8) |
| P8 routes + wiring | 2 | `src/lib/media/{registry,start}.ts`, `src/lib/images.ts` (delete), `src/lib/chat.ts`, the five media routes, `vercel.json`, `tests/media-routes.test.ts`, `tests/{regressions,model-pause,p1-round2,routes-isolation}.test.ts` | P0-P6 |
| P9a legal, help, product | 2 | `src/lib/{legal,help}.ts`, `PRODUCT.md`, `tests/content-claims.test.ts` | P0 (spec) |
| P10 console + reports | 2 | `src/lib/{admin-stats,stats}.ts`, `src/components/app/{AdminConsole,ReportsPanel}.tsx`, `src/app/api/admin/media/route.ts`, `tests/media-admin.test.ts` | P0, P2, P3, P4, P6, P7 |
| P9b system and owner docs | 3 | `docs/system/{architecture,flows,permissions,variables,costs,tests}.md`, `docs/{Owner_Tasks_AR,Project_Summary_AR,Requirements_and_Steps_AR}.md` | P8, P9a, P10 |
| Z integration | 4 | none | all |

### Open questions only the founder can answer

Spec section 11: Q1 trial video allowance; Q2 the Vercel plan (cron every 15 minutes or daily); Q3 which
data-processing agreements are accepted and when; Q4 `vid-cinematic` price or resolution if `/estimate` confirms
~$0.70; Q5 what to do with `img-text` after the Arabic headline test.
