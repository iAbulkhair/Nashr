/**
 * Higgsfield: "Lifestyle photo", "Graphic design", "Cinematic" and "Photo to motion". Asynchronous: a submit answers with
 * a request id, and the engine polls its status (a webhook only hints that it changed). Plain fetch to one fixed host,
 * no SDK: @higgsfield/client retries POSTs and Higgsfield has no idempotency key, so a retried submit could render and
 * bill twice. Nothing here retries.
 */
import { randomInt } from "crypto";
import { isOurBlobUrl } from "../media-catalog";
import { callbackUrl } from "./config";
import { PROVIDER_TASK_ID, abortAfter } from "./keys";
import { ProviderError, type MediaAdapter, type ProviderCheck, type SubmitInput } from "./types";

const HOST = "https://api.higgsfield.ai";

type HfModelId = "img-lifestyle" | "img-design" | "vid-cinematic" | "vid-motion";
type HfSpec = { endpoint(i: SubmitInput): string; body(i: SubmitInput): Record<string, unknown> };

const ratio = (i: SubmitInput) => (i.aspect === "portrait" ? "9:16" : "1:1");
/** Photo to motion has nothing to animate without the post's image: refused before any request, and refunded. */
function needImage(i: SubmitInput): string {
  if (!i.imageUrl) throw new ProviderError("rejected");
  return i.imageUrl;
}

/**
 * One place per model. Higgsfield schemas are strict (the Recraft and Seedance pages declare additionalProperties:
 * false), and docs and console defaults differ, so every parameter is sent.
 *
 * Endpoint ids and fields re-read on 2026-09-29 against https://docs.higgsfield.ai/docs/llms.txt and the model pages
 * /docs/models/soul-2/generate.md, /docs/models/recraft-v4-1/text-to-image.md,
 * /docs/models/seedance-2/text-to-video.md, /docs/models/seedance-2/image-to-video.md and
 * /docs/models/hailuo-2-3/standard-image-to-video.md (/docs/models/hailuo-2-3.md is only the index of the two Hailuo
 * workflows). /docs/openapi.json lists only older ids (soul/standard, not v2) and llms.txt calls it supplementary, so the
 * model pages decide. Every field below is on its page with the value sent: Soul v2 resolution "720p" | "1080p",
 * batch_size 1 | 4, seed 1..1000000 (null invalid), style_id's documented default; Recraft v4.1 resolution "1k" only;
 * Seedance aspect_ratio on text-to-video only (image-to-video follows the image) and generate_audio defaults to true;
 * Hailuo duration 6 | 10 and prompt_optimizer defaults to true. `GET /api/admin/media` proves each line against the
 * live account with /estimate (check below) before a model goes into MEDIA_MODELS_ON.
 */
export const HF_MODELS: Record<HfModelId, HfSpec> = {
  "img-lifestyle": {
    endpoint: () => "higgsfield-ai/soul/v2/standard",
    // randomInt(n) is 0..n-1, so 1 + randomInt(1_000_000) is exactly the documented 1..1000000.
    body: (i) => ({ prompt: i.prompt, aspect_ratio: ratio(i), resolution: "1080p", batch_size: 1, enhance_prompt: false, style_id: "3db34ab5-3439-4317-9e03-08dc30852e69", seed: 1 + randomInt(1_000_000) }),
  },
  "img-design": {
    endpoint: () => "recraft/v4.1/text-to-image",
    body: (i) => ({ prompt: i.prompt, resolution: "1k", aspect_ratio: ratio(i), output_format: "jpg" }),
  },
  "vid-cinematic": {
    endpoint: (i) => (i.imageUrl ? "bytedance/seedance-2.0/image-to-video" : "bytedance/seedance-2.0/text-to-video"),
    // No sound (spec A13): "Clip with sound" is the audio product.
    body: (i) => (i.imageUrl
      ? { prompt: i.prompt, image_url: i.imageUrl, duration: 5, resolution: "720p", generate_audio: false }
      : { prompt: i.prompt, duration: 5, resolution: "720p", aspect_ratio: "9:16", generate_audio: false }),
  },
  "vid-motion": {
    endpoint: () => "minimax/hailuo-2.3/standard/image-to-video",
    body: (i) => ({ prompt: i.prompt, image_url: needImage(i), duration: 6, prompt_optimizer: false }),
  },
};

/** Keys travel only in this header, never in a URL. Checked before any request. */
function headers(): Record<string, string> {
  const id = process.env.HIGGSFIELD_API_KEY_ID, secret = process.env.HIGGSFIELD_API_KEY_SECRET;
  if (!id || !secret) throw new ProviderError("unavailable");
  return { Authorization: `Key ${id}:${secret}`, "Content-Type": "application/json" };
}

/** Not res.json(): a JSON.parse error quotes the start of the body in its message, and errors reach the model and logs. */
async function json(r: Response): Promise<Record<string, unknown> | null> {
  try {
    const j: unknown = JSON.parse(await r.text());
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * docs/concepts/errors.md. A concurrency refusal is a 400 like a bad request, so `detail` is read to tell them apart
 * (busy is refunded and retried by the owner; rejected counts toward the breaker). It never goes into the error.
 */
async function httpError(r: Response): Promise<ProviderError> {
  const s = r.status;
  if (s === 400) {
    const detail = (await json(r))?.detail;
    return new ProviderError(typeof detail === "string" && /concurren/i.test(detail) ? "busy" : "rejected", s);
  }
  if (s === 402 || s === 403) return new ProviderError("no_balance", s);
  if (s === 429) return new ProviderError("busy", s);
  if (s === 401 || s === 404 || s === 408 || s === 423 || s >= 500) return new ProviderError("unavailable", s);
  return new ProviderError("rejected", s);
}

const https = (u: unknown): u is string => typeof u === "string" && u.startsWith("https://");

function spec(i: SubmitInput): HfSpec {
  // Spec A9: only our own Blob copy of a generated image ever leaves the building as a reference.
  if (!Object.hasOwn(HF_MODELS, i.model) || (i.imageUrl !== undefined && !isOurBlobUrl(i.imageUrl))) throw new ProviderError("rejected");
  return HF_MODELS[i.model as HfModelId];
}

/** What /estimate is asked for each model: the real bodies, with an image so every endpoint that takes one is covered. */
const CHECK: SubmitInput[] = [
  ...(Object.keys(HF_MODELS) as HfModelId[]).map((model): SubmitInput => ({ model, prompt: "check", aspect: "portrait", imageUrl: "https://example.public.blob.vercel-storage.com/check.jpg" })),
  // Seedance switches endpoint on the image, and most cinematic clips have none (spec A26): prove that body too.
  { model: "vid-cinematic", prompt: "check", aspect: "portrait" },
];
const checkKey = (i: SubmitInput) => (i.model === "vid-cinematic" && !i.imageUrl ? "vid-cinematic:text" : i.model);

/** The price of one render in USD, or `error:<status>`: 200 with a price proves the endpoint id and the body. */
async function estimate(i: SubmitInput, h: Record<string, string>, signal: AbortSignal): Promise<number | string> {
  const s = spec(i);
  try {
    const r = await fetch(`${HOST}/estimate/${s.endpoint(i)}`, { method: "POST", signal, headers: h, body: JSON.stringify(s.body(i)) });
    if (!r.ok) return `error:${r.status}`;
    const usd = (await json(r))?.usd; // documented as a string, e.g. "0.094"
    const n = typeof usd === "number" || (typeof usd === "string" && usd.trim() !== "") ? Number(usd) : NaN;
    return Number.isFinite(n) ? n : "error:bad_response";
  } catch {
    return "error:unreachable";
  }
}

export const higgsfieldAdapter: MediaAdapter = {
  id: "higgsfield",
  async submit(input, signal) {
    const h = headers();
    const s = spec(input);
    const body = JSON.stringify(s.body(input));
    const hook = callbackUrl("higgsfield");
    const r = await fetch(`${HOST}/${s.endpoint(input)}${hook ? `?hf_webhook=${encodeURIComponent(hook)}` : ""}`, { method: "POST", signal, headers: h, body });
    if (!r.ok) throw await httpError(r);
    const id = (await json(r))?.request_id;
    if (typeof id !== "string" || !PROVIDER_TASK_ID.higgsfield.test(id)) throw new ProviderError("bad_response");
    return { state: "pending", providerTaskId: id };
  },
  async status({ providerTaskId: id }, signal) {
    // The id goes into a URL path, so it is checked again here; the response's own status_url is never followed, so
    // the host stays fixed whatever Higgsfield answers.
    if (!PROVIDER_TASK_ID.higgsfield.test(id)) throw new ProviderError("bad_response");
    const h = headers();
    const r = await fetch(`${HOST}/requests/${id}/status`, { signal, headers: h });
    if (!r.ok) throw await httpError(r);
    const j = await json(r);
    switch (j?.status) {
      case "queued":
      case "in_progress":
        return { state: "pending" };
      case "nsfw":
        return { state: "failed", reason: "nsfw" };
      case "failed":
      case "canceled":
        return { state: "failed", reason: "provider_failed" };
      case "completed": {
        const out = j as { images?: { url?: unknown }[]; video?: { url?: unknown } };
        const url = [out.images?.[0]?.url, out.video?.url].find(https);
        // Completed with no usable URL means the output shape changed: thrown, so it ends as a timeout the breaker counts.
        if (!url) throw new ProviderError("bad_response");
        return { state: "done", urls: [url] };
      }
    }
    throw new ProviderError("bad_response");
  },
  // Best effort, for a job past its max age: Higgsfield cancels (and refunds) only while the request is still queued,
  // and answers 400 once it runs.
  async cancel({ providerTaskId: id }) {
    if (!PROVIDER_TASK_ID.higgsfield.test(id)) return;
    try {
      await fetch(`${HOST}/requests/${id}/cancel`, { method: "POST", signal: abortAfter(5_000), headers: headers() });
    } catch {
      // swallowed: the job fails as a timeout either way
    }
  },
  /** Founder console (spec A15): /estimate per model with its real body, in parallel. Validates without generating. */
  async check(signal): Promise<ProviderCheck> {
    const h = headers();
    const rows = await Promise.all(CHECK.map(async (i) => [checkKey(i), await estimate(i, h, signal)] as const));
    return Object.fromEntries(rows);
  },
};

/** request_id from a webhook body; null unless it matches PROVIDER_TASK_ID.higgsfield. Nothing else in the body is read. */
export function hfRequestIdFrom(body: unknown): string | null {
  const id = body && typeof body === "object" && !Array.isArray(body) ? (body as { request_id?: unknown }).request_id : undefined;
  return typeof id === "string" && PROVIDER_TASK_ID.higgsfield.test(id) ? id : null;
}
