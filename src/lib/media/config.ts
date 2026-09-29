/**
 * Which media models this deployment may offer right now, and what each render costs us. Server-only: it reads the
 * environment and Redis, and the cost tables are our margins.
 */
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
