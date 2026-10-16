/**
 * kie.ai: the Balanced, Premium and English-headline images and the three kie video clips. Every render is a task: the
 * submit answers with a task id, and the result is polled (or hinted by a callback, which only ever names the task id).
 * Plain fetch to a fixed host, never retried here (types.ts: a retry could render and bill twice).
 */
import { createHmac } from "crypto";
import { sameSecret } from "../rate";
import { callbackUrl } from "./config";
import { PROVIDER_TASK_ID } from "./keys";
import { ProviderError, type MediaAdapter, type ProviderCheck, type ProviderErrorCode, type StatusResult, type SubmitInput } from "./types";
import { log } from "../log";

const HOST = "https://api.kie.ai";

type KieModelId = "img-balanced" | "img-premium" | "img-text" | "vid-quick" | "vid-sound" | "vid-premium";
/** "market" is POST /api/v1/jobs/createTask + GET /api/v1/jobs/recordInfo; "veo" is the legacy Veo 3.1 endpoints. */
type KieSpec = { family: "market" | "veo"; body(i: SubmitInput): Record<string, unknown> };

const ratio = (i: SubmitInput) => (i.aspect === "portrait" ? "9:16" : "1:1");
const NEGATIVE = "text, watermark, logo";
/** vid-premium's length: the clip's `duration` and its one `multi_prompt` shot, which must agree. */
const KLING3_SECONDS = 10;
/** kie's cap on a `multi_prompt` shot. Cut in UTF-16 units without splitting a pair, so it holds however kie counts. */
const shotPrompt = (p: string) => {
  const s = p.slice(0, 500);
  return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
};

/**
 * One place per model: a wrong field is a one-line fix. Re-read on 2026-09-29 from the raw pages (llms.txt index):
 * market/google/nanobanana2.md, market/google/pro-image-to-image.md, market/gpt/gpt-image-2-text-to-image.md,
 * market/kling/v25-turbo-text-to-video-pro.md, market/kling/v25-turbo-image-to-video-pro.md, market/kling/kling-3-0.md,
 * veo3-api/generate-veo-3-video.md, old-model/veo3-api/generate-veo-3-video.md,
 * old-model/veo3-api/get-veo-3-video-details.md, market/common/get-task-detail.md, common-api/get-account-credits.md and
 * common-api/webhook-verification.md. None of the six schemas lists `nsfw_checker`, so no body sends it.
 * - The Kling 2.5 image-to-video enum still says kling/v2-1-master-image-to-video; its description, example and callback
 *   enum say kling/v2-5-turbo-image-to-video-pro, which is what we send. It has no aspect field (spec A26).
 * - Kling 3.0 lists both `multi_shots` and `multi_prompt` in input.required. `multi_prompt` (up to 5 shots of
 *   {prompt ≤ 500 characters, duration 1-12}) takes effect only when `multi_shots` is true, and the schema's own example
 *   sends it with `multi_shots: false`. So we send one shot that repeats the prompt at the full length: whichever way kie
 *   reads the list, the clip is the same single shot.
 * - Veo 3.1 (spec A5): the unified schema (model "veo-3-1" on createTask) still has no Fast/Quality/Lite selector, so
 *   "Clip with sound" stays on the legacy /api/v1/veo/generate with model "veo3_fast". `duration` (4, 6 or 8; default 8)
 *   and `resolution` (default 720p) are now documented there and are sent at their defaults, so the 8 s the label
 *   promises and the price it was set at do not move if a default does. Its record-info page does not document
 *   `creditsConsumed` (the market recordInfo and the callbacks do): veoStatus reads it only when present.
 * - Veo code 400 includes "Only English prompts are supported", and a video prompt can carry Arabic (the brand's
 *   industry label and name in the fixed template). `enableTranslation` translates the prompt to English first. Its
 *   description says the default is true and its schema says false, so it is sent explicitly as true.
 */
export const KIE_MODELS: Record<KieModelId, KieSpec> = {
  "img-balanced": {
    family: "market",
    body: (i) => ({ model: "nano-banana-2", input: { prompt: i.prompt, ...(i.imageUrl ? { image_input: [i.imageUrl] } : {}), aspect_ratio: ratio(i), resolution: "1K", output_format: "jpg" } }),
  },
  "img-premium": {
    family: "market",
    body: (i) => ({ model: "nano-banana-pro", input: { prompt: i.prompt, ...(i.imageUrl ? { image_input: [i.imageUrl] } : {}), aspect_ratio: ratio(i), resolution: "2K", output_format: "jpg" } }),
  },
  // No output_format on this schema: the Blob store re-encodes to JPEG.
  "img-text": {
    family: "market",
    body: (i) => ({ model: "gpt-image-2-text-to-image", input: { prompt: i.prompt, aspect_ratio: ratio(i), resolution: "1K" } }),
  },
  "vid-quick": {
    family: "market",
    body: (i) => i.imageUrl
      ? { model: "kling/v2-5-turbo-image-to-video-pro", input: { prompt: i.prompt, image_url: i.imageUrl, duration: "5", negative_prompt: NEGATIVE, cfg_scale: 0.5 } }
      : { model: "kling/v2-5-turbo-text-to-video-pro", input: { prompt: i.prompt, duration: "5", aspect_ratio: "9:16", negative_prompt: NEGATIVE, cfg_scale: 0.5 } },
  },
  "vid-sound": {
    family: "veo",
    body: (i) => ({
      prompt: i.prompt,
      model: "veo3_fast",
      aspect_ratio: "9:16",
      generationType: i.imageUrl ? "FIRST_AND_LAST_FRAMES_2_VIDEO" : "TEXT_2_VIDEO",
      ...(i.imageUrl ? { imageUrls: [i.imageUrl] } : {}),
      enableTranslation: true,
      duration: 8,
      resolution: "720p",
    }),
  },
  "vid-premium": {
    family: "market",
    body: (i) => ({
      model: "kling-3.0/video",
      input: {
        prompt: i.prompt,
        ...(i.imageUrl ? { image_urls: [i.imageUrl] } : {}),
        sound: true,
        duration: String(KLING3_SECONDS),
        aspect_ratio: "9:16",
        mode: "std",
        multi_shots: false,
        multi_prompt: [{ prompt: shotPrompt(i.prompt), duration: KLING3_SECONDS }],
      },
    }),
  },
};
const specFor = (model: string): KieSpec | undefined => (Object.keys(KIE_MODELS).includes(model) ? KIE_MODELS[model as KieModelId] : undefined);

/** kie answers errors both as HTTP statuses and as a `code` in a 200 body; both mean the same. */
function codeError(code: number): ProviderErrorCode {
  if (code === 429) return "busy";
  if (code === 402 || code === 433) return "no_balance";
  if (code === 401 || code === 403 || code === 455 || code >= 500) return "unavailable";
  // 400, 404 (unknown endpoint or model) and 422: our request is wrong, a defect the breaker should see (spec A22).
  if (code >= 400) return "rejected";
  return "bad_response";
}

const headers = (key: string) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" });

/**
 * One call. The response body is never put in an error or a log (it can echo the prompt), and not res.json(): a
 * JSON.parse error quotes the start of the body in its message. Anything but HTTP 200 with body code 200 throws.
 */
async function call(path: string, init: RequestInit, signal: AbortSignal): Promise<Record<string, unknown>> {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new ProviderError("unavailable");
  let res: Response;
  try {
    res = await fetch(`${HOST}${path}`, { ...init, signal, headers: headers(key) });
  } catch {
    throw new ProviderError("unavailable");
  }
  let j: { code?: unknown; data?: unknown } | null = null;
  try {
    j = JSON.parse(await res.text());
  } catch {
    /* handled below */
  }
  const code = typeof j?.code === "number" ? j.code : 0;
  if (!res.ok || code !== 200) {
    log.error("kie", { status: res.status, provider_code: code });
    if (!res.ok) throw new ProviderError(codeError(res.status), res.status);
    throw code ? new ProviderError(codeError(code), code) : new ProviderError("bad_response");
  }
  const data = j?.data;
  if (!data || typeof data !== "object") throw new ProviderError("bad_response");
  return data as Record<string, unknown>;
}

/** Only https result URLs leave the adapter; everything in them is provider output, fetched later through safeFetch. */
function httpsUrls(v: unknown): string[] {
  const urls = Array.isArray(v) ? v.filter((u): u is string => typeof u === "string" && u.startsWith("https://")) : [];
  if (!urls.length) throw new ProviderError("bad_response");
  return urls;
}
/** kie `creditsConsumed` (it may be fractional); spend and the overbill breaker use it (spec A22, A31). */
const credits = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/**
 * A content refusal, as opposed to a render that failed. Code 400 also covers an image kie could not fetch and (on Veo)
 * a prompt refused for its language, and neither is one. On Veo a bare 400 is not believed either: its record-info
 * files four different causes under it, so only the message can say which. `bare400` keeps the market reading.
 */
function refused(code: unknown, msg: unknown, bare400: boolean): boolean {
  const m = typeof msg === "string" ? msg : "";
  if (/fetch|english/i.test(m)) return false;
  return /policy|policies|nsfw|sensitive|violat|unsafe|flagged/i.test(m) || (bare400 && String(code) === "400");
}

async function marketStatus(id: string, signal: AbortSignal): Promise<StatusResult> {
  const d = await call(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(id)}`, { method: "GET" }, signal);
  if (d.state === "waiting" || d.state === "queuing" || d.state === "generating") return { state: "pending" };
  if (d.state === "fail") return { state: "failed", reason: refused(d.failCode, d.failMsg, true) ? "nsfw" : "provider_failed" };
  if (d.state !== "success" || typeof d.resultJson !== "string") throw new ProviderError("bad_response");
  let result: { resultUrls?: unknown } | null;
  try {
    result = JSON.parse(d.resultJson);
  } catch {
    throw new ProviderError("bad_response");
  }
  return { state: "done", urls: httpsUrls(result?.resultUrls), providerCredits: credits(d.creditsConsumed) };
}

async function veoStatus(id: string, signal: AbortSignal): Promise<StatusResult> {
  const d = await call(`/api/v1/veo/record-info?taskId=${encodeURIComponent(id)}`, { method: "GET" }, signal);
  if (d.successFlag === 0) return { state: "pending" };
  if (d.successFlag === 2 || d.successFlag === 3) return { state: "failed", reason: refused(d.errorCode, d.errorMessage, false) ? "nsfw" : "provider_failed" };
  if (d.successFlag !== 1) throw new ProviderError("bad_response");
  const response = d.response as { resultUrls?: unknown } | null | undefined;
  // Not documented on record-info as of 2026-09-29 (only on the market recordInfo and callbacks): read when present,
  // otherwise the founder's balance check before and after one render proves the tier (spec 3.3, owner step 6).
  return { state: "done", urls: httpsUrls(response?.resultUrls), providerCredits: credits(d.creditsConsumed) };
}

export const kieAdapter: MediaAdapter = {
  id: "kie",
  async submit(input, signal) {
    if (!process.env.KIE_API_KEY) throw new ProviderError("unavailable");
    const spec = specFor(input.model);
    if (!spec) throw new ProviderError("rejected");
    const hook = callbackUrl("kie");
    const body = { ...spec.body(input), ...(hook ? { callBackUrl: hook } : {}) };
    const path = spec.family === "veo" ? "/api/v1/veo/generate" : "/api/v1/jobs/createTask";
    const d = await call(path, { method: "POST", body: JSON.stringify(body) }, signal);
    const id = d.taskId;
    if (typeof id !== "string" || !PROVIDER_TASK_ID.kie.test(id)) throw new ProviderError("bad_response");
    return { state: "pending", providerTaskId: id };
  },
  async status({ providerTaskId, model }, signal) {
    if (!process.env.KIE_API_KEY) throw new ProviderError("unavailable");
    const spec = specFor(model);
    if (!spec) throw new ProviderError("rejected");
    // The id came from a provider answer: checked again before it goes into a URL.
    if (!PROVIDER_TASK_ID.kie.test(providerTaskId)) throw new ProviderError("bad_response");
    return spec.family === "veo" ? veoStatus(providerTaskId, signal) : marketStatus(providerTaskId, signal);
  },
  // No cancel: kie documents none.
  /** Founder console (spec A15): the kie credit balance, or a fixed error string. */
  async check(signal): Promise<ProviderCheck> {
    const key = process.env.KIE_API_KEY;
    if (!key) return { error: "not_configured" };
    let res: Response;
    try {
      res = await fetch(`${HOST}/api/v1/chat/credit`, { signal, headers: headers(key) });
    } catch {
      return { error: "fetch_failed" };
    }
    if (!res.ok) return { error: `http:${res.status}` };
    let j: { code?: unknown; data?: unknown } | null = null;
    try {
      j = JSON.parse(await res.text());
    } catch {
      return { error: "bad_response" };
    }
    if (j?.code !== 200) return { error: `code:${typeof j?.code === "number" ? j.code : 0}` };
    return typeof j.data === "number" && Number.isFinite(j.data) ? { balanceCredits: j.data } : { error: "bad_response" };
  },
};

/** base64(HMAC-SHA256(`${taskId}.${timestamp}`, key)), compared with sameSecret; timestamp within ±300 s. */
export function verifyKieSignature(taskId: string, timestamp: string | null, signature: string | null, key: string, nowS = Math.floor(Date.now() / 1000)): boolean {
  if (!taskId || !timestamp || !signature || !key || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowS - Number(timestamp)) > 300) return false;
  // Signed over the header exactly as sent, which is what kie hashed.
  return sameSecret(signature, createHmac("sha256", key).update(`${taskId}.${timestamp}`).digest("base64"));
}

/** The task id from a callback body: taskId, then data.taskId, then data.task_id; null unless it matches PROVIDER_TASK_ID.kie. */
export function kieTaskIdFrom(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { taskId?: unknown; data?: { taskId?: unknown; task_id?: unknown } | null };
  const data = b.data && typeof b.data === "object" ? b.data : {};
  const id = [b.taskId, data.taskId, data.task_id].find((v) => v !== undefined && v !== null);
  return typeof id === "string" && PROVIDER_TASK_ID.kie.test(id) ? id : null;
}
