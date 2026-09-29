/**
 * fal.ai FLUX schnell: the "Fast" image (img-fast), rendered in the same request.
 * Plain fetch to a fixed host, never retried here (types.ts: a retry could render and bill twice).
 */
import { ProviderError, type MediaAdapter, type SubmitInput } from "./types";

const URL_SCHNELL = "https://fal.run/fal-ai/flux/schnell";

/** The one request body. Fields checked against https://fal.ai/models/fal-ai/flux/schnell/api on 2026-09-29. */
const body = (i: SubmitInput) => ({
  prompt: i.prompt,
  image_size: i.aspect === "portrait" ? "portrait_16_9" : "square_hd",
  num_images: 1,
  enable_safety_checker: true,
  output_format: "jpeg",
});

/** The response body is never read into the error: it can echo the request, and errors reach the model and the logs. */
function httpError(status: number): ProviderError {
  if (status === 429) return new ProviderError("busy", status);
  if (status === 400 || status === 422) return new ProviderError("rejected", status);
  return new ProviderError("unavailable", status);
}

export const falAdapter: MediaAdapter = {
  id: "fal",
  async submit(input, signal) {
    const key = process.env.FAL_KEY;
    if (!key) throw new ProviderError("unavailable");
    if (input.model !== "img-fast") throw new ProviderError("rejected");
    const res = await fetch(URL_SCHNELL, {
      method: "POST",
      signal,
      headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body(input)),
    });
    if (!res.ok) throw httpError(res.status);
    // Not res.json(): a JSON.parse error quotes the start of the body in its message.
    let j: { images?: { url?: unknown }[]; has_nsfw_concepts?: unknown[] };
    try {
      j = JSON.parse(await res.text());
    } catch {
      throw new ProviderError("bad_response");
    }
    // With the safety checker on, a flagged image comes back blanked: a content refusal, not a result.
    if (j?.has_nsfw_concepts?.[0] === true) return { state: "failed", reason: "nsfw" };
    const url = j?.images?.[0]?.url;
    if (typeof url !== "string" || !url.startsWith("https://")) throw new ProviderError("bad_response");
    return { state: "done", urls: [url] };
  },
  // Synchronous: the engine never polls fal.
  async status() {
    throw new ProviderError("bad_response");
  },
};
