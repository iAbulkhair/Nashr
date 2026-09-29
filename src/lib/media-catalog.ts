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
  { id: "img-premium", kind: "image", provider: "kie", credits: 2, usesImage: true, label: { ar: "صورة إعلانية فاخرة", en: "Premium ad image" }, hint: { ar: "أعلى دقة بين الخيارات. الصورة لا تُبنى على صورة منتجك الحقيقية.", en: "The highest resolution here. It does not use a photo of your real product." } },
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
/**
 * An inbox string with a count in it: each "{one|other}" group takes its first form when `count` is 1 and its second
 * otherwise ("1 credit", "12 credits"), then {n} (or each name in `vars`) takes its value. The Arabic strings keep the
 * invariant كريدت and carry no group, so they only get their numbers.
 */
export function plural(s: string, count: number, vars: Record<string, string | number> = { n: count }): string {
  return s
    .replace(/\{([^{}|]*)\|([^{}|]*)\}/g, (_, one: string, other: string) => (count === 1 ? one : other))
    .replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}
/** Portrait for video and for the vertical channels, square otherwise: the rule fal images followed before this catalogue. */
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
