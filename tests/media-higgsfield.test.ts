import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomInt } from "crypto";
import { mediaEnv, noNetwork } from "./helpers/media";
import { HF_MODELS, hfRequestIdFrom, higgsfieldAdapter } from "@/lib/media/higgsfield";
import { MEDIA_MODELS, type Aspect, type MediaModelId } from "@/lib/media-catalog";
import { ProviderError, type SubmitInput } from "@/lib/media/types";

// The Soul seed comes from crypto.randomInt; the real one by default, so a bound can be forced one call at a time.
vi.mock("crypto", async (orig) => {
  const real = await orig<typeof import("crypto")>();
  return { ...real, randomInt: vi.fn((max: number) => real.randomInt(max)) };
});

/**
 * Higgsfield is one account shared by every tenant, with strict request schemas and no idempotency key. So: one fixed
 * host, the key pair only in the Authorization header, each model's body pinned field by field, a submit that is never
 * repeated, errors that are fixed codes carrying no byte of the reply, and ids checked before they enter a URL path.
 */
type Call = { url: URL; raw: string; init: RequestInit };
let calls: Call[] = [];
const real = globalThis.fetch;
/** A recording fetch that answers each call with `reply(call)`. */
const answer = (reply: (c: Call) => Response | Promise<Response>) => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const c = { url: new URL(String(input)), raw: String(input), init: init ?? {} };
    calls.push(c);
    return reply(c);
  }) as typeof fetch;
};
const res = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
const ok = (j: unknown, status = 200) => () => res(j, status);

const KEY_ID = "test-higgsfield_api_key_id";
const KEY_SECRET = "test-higgsfield_api_key_secret";
const RID = "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff";
const OUR = "https://abc.public.blob.vercel-storage.com/media/0123456789abcdef0123456789abcdef.jpg";
const QUEUED = { status: "queued", request_id: RID, status_url: `https://api.higgsfield.ai/requests/${RID}/status`, cancel_url: `https://api.higgsfield.ai/requests/${RID}/cancel` };
const input = (over: Partial<SubmitInput> = {}): SubmitInput => ({ model: "img-lifestyle", prompt: "a cup of coffee", aspect: "square", ...over });
const submit = (i = input(), signal = new AbortController().signal) => higgsfieldAdapter.submit(i, signal);
const status = (id = RID, model: MediaModelId = "img-lifestyle") => higgsfieldAdapter.status({ providerTaskId: id, model }, new AbortController().signal);
const bodyOf = (c: Call) => JSON.parse(String(c.init.body)) as Record<string, unknown>;

beforeEach(() => {
  calls = [];
  mediaEnv({ higgsfield: true, blob: true, models: "all" });
  vi.stubEnv("APP_ORIGIN", "");
});
afterEach(() => { globalThis.fetch = real; vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("the model table", () => {
  it("covers exactly the catalogue's Higgsfield models", () => {
    expect(Object.keys(HF_MODELS).sort()).toEqual(MEDIA_MODELS.filter((m) => m.provider === "higgsfield").map((m) => m.id).sort());
  });
});

describe("the request", () => {
  it("posts to the fixed host with the key pair in the Authorization header, and never a secret in a URL", async () => {
    answer((c) => (c.url.pathname.startsWith("/estimate/") ? res({ credits: "1.5", usd: "0.094" }) : c.url.pathname.endsWith("/status") ? res({ status: "queued", request_id: RID }) : res(QUEUED)));
    vi.stubEnv("APP_ORIGIN", "https://nashr.example");
    for (const model of Object.keys(HF_MODELS) as MediaModelId[]) await submit(input({ model, imageUrl: OUR }));
    await submit(input({ model: "vid-cinematic" }));
    await status();
    await higgsfieldAdapter.cancel!({ providerTaskId: RID, model: "img-lifestyle" });
    await higgsfieldAdapter.check!(new AbortController().signal);
    expect(calls.length).toBe(5 + 1 + 1 + 5);
    for (const c of calls) {
      expect(c.url.origin, c.raw).toBe("https://api.higgsfield.ai");
      expect(new Headers(c.init.headers).get("authorization"), c.raw).toBe(`Key ${KEY_ID}:${KEY_SECRET}`);
      expect(new Headers(c.init.headers).get("content-type"), c.raw).toBe("application/json");
      expect(decodeURIComponent(c.raw)).not.toContain(KEY_ID);
      expect(decodeURIComponent(c.raw)).not.toContain(KEY_SECRET);
    }
    expect(calls.slice(0, 5).map((c) => c.init.method)).toEqual(["POST", "POST", "POST", "POST", "POST"]);
  });

  it("pins every model's body and endpoint, square and portrait, with and without our image", async () => {
    answer(ok(QUEUED));
    const style = "3db34ab5-3439-4317-9e03-08dc30852e69";
    const cases: [MediaModelId, Aspect, string | undefined, string, Record<string, unknown>][] = [
      ["img-lifestyle", "square", undefined, "/higgsfield-ai/soul/v2/standard", { prompt: "p", aspect_ratio: "1:1", resolution: "1080p", batch_size: 1, enhance_prompt: false, style_id: style }],
      ["img-lifestyle", "portrait", undefined, "/higgsfield-ai/soul/v2/standard", { prompt: "p", aspect_ratio: "9:16", resolution: "1080p", batch_size: 1, enhance_prompt: false, style_id: style }],
      // No reference-image field on either image model: our image is not sent even when the engine offers one.
      ["img-lifestyle", "square", OUR, "/higgsfield-ai/soul/v2/standard", { prompt: "p", aspect_ratio: "1:1", resolution: "1080p", batch_size: 1, enhance_prompt: false, style_id: style }],
      ["img-design", "square", undefined, "/recraft/v4.1/text-to-image", { prompt: "p", resolution: "1k", aspect_ratio: "1:1", output_format: "jpg" }],
      ["img-design", "portrait", OUR, "/recraft/v4.1/text-to-image", { prompt: "p", resolution: "1k", aspect_ratio: "9:16", output_format: "jpg" }],
      ["vid-cinematic", "portrait", undefined, "/bytedance/seedance-2.0/text-to-video", { prompt: "p", duration: 5, resolution: "720p", aspect_ratio: "9:16", generate_audio: false }],
      ["vid-cinematic", "portrait", OUR, "/bytedance/seedance-2.0/image-to-video", { prompt: "p", image_url: OUR, duration: 5, resolution: "720p", generate_audio: false }],
      ["vid-motion", "portrait", OUR, "/minimax/hailuo-2.3/standard/image-to-video", { prompt: "p", image_url: OUR, duration: 6, prompt_optimizer: false }],
      ["vid-motion", "square", OUR, "/minimax/hailuo-2.3/standard/image-to-video", { prompt: "p", image_url: OUR, duration: 6, prompt_optimizer: false }],
    ];
    for (const [model, aspect, imageUrl, path, expected] of cases) {
      calls = [];
      expect(await submit(input({ model, aspect, imageUrl, prompt: "p" }))).toEqual({ state: "pending", providerTaskId: RID });
      const tag = `${model} ${aspect} ${imageUrl ? "image" : "text"}`;
      expect(calls.length, tag).toBe(1);
      expect(calls[0].url.pathname, tag).toBe(path);
      expect(calls[0].url.search, tag).toBe("");
      const body = bodyOf(calls[0]);
      if (model === "img-lifestyle") {
        expect(Number.isInteger(body.seed), tag).toBe(true);
        expect(body.seed as number, tag).toBeGreaterThanOrEqual(1);
        expect(body.seed as number, tag).toBeLessThanOrEqual(1_000_000);
        delete body.seed;
      }
      expect(body, tag).toEqual(expected);
    }
  });

  it("keeps the Soul seed inside the documented 1..1000000 at both ends of randomInt", async () => {
    answer(ok(QUEUED));
    vi.mocked(randomInt).mockImplementationOnce(() => 0).mockImplementationOnce(() => 999_999);
    await submit();
    await submit();
    expect(calls.map((c) => bodyOf(c).seed)).toEqual([1, 1_000_000]);
  });

  it("hands fetch the caller's signal itself", async () => {
    answer(ok(QUEUED));
    const c = new AbortController();
    await submit(input(), c.signal);
    expect(calls[0].init.signal, "the engine's deadline is the only timeout").toBe(c.signal);
  });

  it("sends nothing without both keys, for Photo to motion without an image, for another provider's model, or for an image that is not ours", async () => {
    const net = noNetwork();
    try {
      for (const [id, secret] of [["", KEY_SECRET], [KEY_ID, ""], ["", ""]]) {
        vi.stubEnv("HIGGSFIELD_API_KEY_ID", id);
        vi.stubEnv("HIGGSFIELD_API_KEY_SECRET", secret);
        await expect(submit()).rejects.toMatchObject({ code: "unavailable", message: "provider_unavailable" });
        await expect(status()).rejects.toMatchObject({ code: "unavailable" });
        await expect(higgsfieldAdapter.check!(new AbortController().signal)).rejects.toMatchObject({ code: "unavailable" });
        await expect(higgsfieldAdapter.cancel!({ providerTaskId: RID, model: "img-lifestyle" })).resolves.toBeUndefined();
      }
      mediaEnv({ higgsfield: true, blob: true, models: "all" });
      await expect(submit(input({ model: "vid-motion", aspect: "portrait" }))).rejects.toMatchObject({ code: "rejected", message: "provider_rejected" });
      for (const model of ["img-fast", "img-balanced", "vid-quick", "toString", "__proto__"] as MediaModelId[]) {
        await expect(submit(input({ model })), model).rejects.toMatchObject({ code: "rejected" });
      }
      for (const imageUrl of ["https://evil.example/x.jpg", "http://abc.public.blob.vercel-storage.com/x.jpg", "https://user:pw@abc.public.blob.vercel-storage.com/x.jpg", ""]) {
        await expect(submit(input({ model: "vid-cinematic", aspect: "portrait", imageUrl })), imageUrl).rejects.toMatchObject({ code: "rejected" });
      }
      expect(net.hosts).toEqual([]);
    } finally {
      net.restore();
    }
  });
});

describe("the webhook parameter", () => {
  it("is absent without APP_ORIGIN, and for a local or plain-http origin", async () => {
    answer(ok(QUEUED));
    for (const origin of ["", "http://nashr.example", "https://localhost:3000"]) {
      vi.stubEnv("APP_ORIGIN", origin);
      await submit();
    }
    expect(calls.map((c) => c.raw)).toEqual(Array(3).fill("https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard"));
  });

  it("carries our hook route, URL-encoded, and nothing else", async () => {
    answer(ok(QUEUED));
    vi.stubEnv("APP_ORIGIN", "https://nashr.example/");
    await submit(input({ model: "vid-motion", imageUrl: OUR }));
    expect(calls[0].raw).toBe("https://api.higgsfield.ai/minimax/hailuo-2.3/standard/image-to-video?hf_webhook=https%3A%2F%2Fnashr.example%2Fapi%2Fmedia%2Fhook%2Fhiggsfield");
    expect([...calls[0].url.searchParams]).toEqual([["hf_webhook", "https://nashr.example/api/media/hook/higgsfield"]]);
  });
});

describe("the submit answer", () => {
  it("accepts only a well-formed request id", async () => {
    answer(ok(QUEUED));
    expect(await submit()).toEqual({ state: "pending", providerTaskId: RID });
    for (const j of [{ status: "queued" }, { request_id: "../../x" }, { request_id: 42 }, { request_id: `${RID}/cancel` }, null, [QUEUED]]) {
      answer(ok(j));
      await expect(submit(), JSON.stringify(j)).rejects.toMatchObject({ code: "bad_response", message: "provider_bad_response" });
    }
    answer(() => new Response(`<html>${KEY_SECRET}</html>`, { status: 200 }));
    const e = await submit().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(String((e as Error).message)).toBe("provider_bad_response");
  });

  it("maps every refusal to a fixed code that carries neither a key nor the reply", async () => {
    const table: [number, unknown, string][] = [
      [400, { detail: "Maximum number of concurrent requests (4) has been reached" }, "provider_busy:400"],
      [400, { detail: "Invalid parameters" }, "provider_rejected:400"],
      [400, { detail: [{ msg: "concurrent" }] }, "provider_rejected:400"],
      [400, "not json", "provider_rejected:400"],
      [401, { detail: "Invalid credentials" }, "provider_unavailable:401"],
      [402, { detail: "Payment required" }, "provider_no_balance:402"],
      [403, { detail: "Insufficient credits" }, "provider_no_balance:403"],
      [404, { detail: "Not found" }, "provider_unavailable:404"],
      [422, { detail: [{ loc: ["body", "x"], msg: "Extra inputs are not permitted" }] }, "provider_rejected:422"],
      [423, { detail: "Model is temporarily blocked" }, "provider_unavailable:423"],
      [429, { detail: "Too many" }, "provider_busy:429"],
      [500, { detail: "boom" }, "provider_unavailable:500"],
      [503, { detail: "Model is disabled" }, "provider_unavailable:503"],
    ];
    for (const [code, body, message] of table) {
      answer(() => new Response(typeof body === "string" ? body : JSON.stringify({ ...(body as object), echo: `${KEY_ID}:${KEY_SECRET}` }), { status: code }));
      const e = await submit().catch((x: unknown) => x);
      expect(e, `${code}`).toBeInstanceOf(ProviderError);
      const m = (e as Error).message;
      expect(m, `${code}`).toBe(message);
      expect(m).toMatch(/^provider_[a-z_]+(:\d+)?$/);
      expect(m).not.toContain(KEY_ID);
      expect(m).not.toContain(KEY_SECRET);
    }
  });

  it("is never retried: one fetch, whether it throws or answers 503", async () => {
    const boom = new TypeError("fetch failed");
    answer(() => { throw boom; });
    await expect(submit()).rejects.toBe(boom);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    calls = [];
    answer(ok({ detail: "Model is disabled" }, 503));
    await expect(submit()).rejects.toMatchObject({ code: "unavailable" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("status", () => {
  it("reads every documented state from the fixed status URL, never the one in the reply", async () => {
    const IMG = "https://cdn.higgsfield.ai/out/image-1.jpg";
    const VID = "https://cdn.higgsfield.ai/out/video.mp4";
    const table: [unknown, unknown][] = [
      [{ status: "queued", request_id: RID, status_url: "https://evil.example/status" }, { state: "pending" }],
      [{ status: "in_progress", request_id: RID }, { state: "pending" }],
      [{ status: "completed", request_id: RID, images: [{ url: IMG }, { url: "https://cdn.higgsfield.ai/out/image-2.jpg" }] }, { state: "done", urls: [IMG] }],
      [{ status: "completed", request_id: RID, video: { url: VID } }, { state: "done", urls: [VID] }],
      [{ status: "nsfw", request_id: RID, error: null }, { state: "failed", reason: "nsfw" }],
      [{ status: "failed", request_id: RID, error: "Generation failed" }, { state: "failed", reason: "provider_failed" }],
      [{ status: "canceled", request_id: RID }, { state: "failed", reason: "provider_failed" }],
    ];
    for (const [reply, expected] of table) {
      calls = [];
      answer(ok(reply));
      expect(await status(), JSON.stringify(reply)).toEqual(expected);
      expect(calls.map((c) => [c.raw, c.init.method ?? "GET"])).toEqual([[`https://api.higgsfield.ai/requests/${RID}/status`, "GET"]]);
    }
  });

  it("refuses a completed request with no https result, an unknown state, and a reply that is not JSON", async () => {
    for (const j of [
      { status: "completed", request_id: RID, images: [{ url: "http://cdn.higgsfield.ai/x.jpg" }] },
      { status: "completed", request_id: RID, video: { url: "javascript:alert(1)" } },
      { status: "completed", request_id: RID, images: [] },
      { status: "completed", request_id: RID },
      { status: "exploded", request_id: RID },
      {},
    ]) {
      answer(ok(j));
      await expect(status(), JSON.stringify(j)).rejects.toMatchObject({ code: "bad_response", message: "provider_bad_response" });
    }
    answer(() => new Response("<html>oops</html>", { status: 200 }));
    await expect(status()).rejects.toMatchObject({ code: "bad_response" });
    answer(ok({ detail: "Not found" }, 404));
    await expect(status()).rejects.toMatchObject({ code: "unavailable", message: "provider_unavailable:404" });
  });

  it("never puts an id that is not a uuid into a URL", async () => {
    const net = noNetwork();
    try {
      for (const id of ["../../estimate/x", `${RID}/cancel`, `${RID}?x=1`, "abc", "", RID.replace(/-/g, "")]) {
        await expect(status(id), id).rejects.toMatchObject({ code: "bad_response" });
        await expect(higgsfieldAdapter.cancel!({ providerTaskId: id, model: "vid-motion" })).resolves.toBeUndefined();
      }
      expect(net.hosts).toEqual([]);
    } finally {
      net.restore();
    }
  });
});

describe("cancel", () => {
  it("posts to the fixed cancel URL and swallows every failure", async () => {
    answer(() => new Response(null, { status: 202 }));
    await higgsfieldAdapter.cancel!({ providerTaskId: RID, model: "vid-cinematic" });
    expect(calls.map((c) => [c.raw, c.init.method])).toEqual([[`https://api.higgsfield.ai/requests/${RID}/cancel`, "POST"]]);
    answer(ok({ detail: "Request already started" }, 400));
    await expect(higgsfieldAdapter.cancel!({ providerTaskId: RID, model: "vid-cinematic" })).resolves.toBeUndefined();
    answer(() => { throw new TypeError("fetch failed"); });
    await expect(higgsfieldAdapter.cancel!({ providerTaskId: RID, model: "vid-cinematic" })).resolves.toBeUndefined();
  });

  it("gives up after 5 seconds", async () => {
    vi.useFakeTimers();
    answer((c) => new Promise<Response>((_, reject) => c.init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    let done = false;
    const p = higgsfieldAdapter.cancel!({ providerTaskId: RID, model: "vid-cinematic" }).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });
});

describe("check (founder console)", () => {
  it("asks /estimate for each model with its real body, in parallel, and parses the price", async () => {
    let inFlight = 0, peak = 0;
    answer(async (c) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return res({ credits: "1.500", usd: c.url.pathname.includes("seedance") ? "0.7035" : "0.094" });
    });
    const out = await higgsfieldAdapter.check!(new AbortController().signal);
    expect(out).toEqual({ "img-lifestyle": 0.094, "img-design": 0.094, "vid-cinematic": 0.7035, "vid-motion": 0.094, "vid-cinematic:text": 0.7035 });
    expect(peak, "one Promise.all, not a loop").toBe(5);
    const byPath = Object.fromEntries(calls.map((c) => [c.url.pathname, bodyOf(c)]));
    expect(Object.keys(byPath).sort()).toEqual([
      "/estimate/bytedance/seedance-2.0/image-to-video",
      "/estimate/bytedance/seedance-2.0/text-to-video",
      "/estimate/higgsfield-ai/soul/v2/standard",
      "/estimate/minimax/hailuo-2.3/standard/image-to-video",
      "/estimate/recraft/v4.1/text-to-image",
    ]);
    // The same bodies a real submit sends (the check proves the submit, spec A15).
    const img = "https://example.public.blob.vercel-storage.com/check.jpg";
    expect(byPath["/estimate/recraft/v4.1/text-to-image"]).toEqual({ prompt: "check", resolution: "1k", aspect_ratio: "9:16", output_format: "jpg" });
    expect(byPath["/estimate/bytedance/seedance-2.0/text-to-video"]).toEqual({ prompt: "check", duration: 5, resolution: "720p", aspect_ratio: "9:16", generate_audio: false });
    expect(byPath["/estimate/bytedance/seedance-2.0/image-to-video"]).toEqual({ prompt: "check", image_url: img, duration: 5, resolution: "720p", generate_audio: false });
    expect(byPath["/estimate/minimax/hailuo-2.3/standard/image-to-video"]).toEqual({ prompt: "check", image_url: img, duration: 6, prompt_optimizer: false });
    expect({ ...byPath["/estimate/higgsfield-ai/soul/v2/standard"], seed: 0 }).toEqual({ prompt: "check", aspect_ratio: "9:16", resolution: "1080p", batch_size: 1, enhance_prompt: false, style_id: "3db34ab5-3439-4317-9e03-08dc30852e69", seed: 0 });
    for (const c of calls) expect(c.url.search, "no webhook on an estimate").toBe("");
  });

  it("reports one failing model as error:<status> and still reports the others", async () => {
    answer((c) => {
      if (c.url.pathname.includes("hailuo")) return res({ detail: "Not found" }, 404);
      if (c.url.pathname.includes("recraft")) return res({ credits: "1", usd: null });
      if (c.url.pathname.includes("text-to-video")) throw new TypeError("fetch failed");
      return res({ credits: "1.5", usd: 0.25 });
    });
    expect(await higgsfieldAdapter.check!(new AbortController().signal)).toEqual({
      "img-lifestyle": 0.25, "img-design": "error:bad_response", "vid-cinematic": 0.25, "vid-motion": "error:404", "vid-cinematic:text": "error:unreachable",
    });
  });
});

describe("hfRequestIdFrom (webhook hint)", () => {
  it("takes request_id from the documented envelope and nothing else", () => {
    expect(hfRequestIdFrom({ request_id: RID, status: "completed", error: null, payload: { images: [{ url: "https://x" }] } })).toBe(RID);
    expect(hfRequestIdFrom({ request_id: RID.toUpperCase(), status: "failed" })).toBe(RID.toUpperCase());
  });

  it("rejects every other string and shape", () => {
    for (const b of [
      null, undefined, RID, 42, [RID], [{ request_id: RID }], {}, { request_id: 42 }, { request_id: "../x" }, { request_id: `${RID}/cancel` },
      { request_id: `${RID} ` }, { requestId: RID }, { payload: { request_id: RID } }, { request_id: "a".repeat(200) },
    ]) expect(hfRequestIdFrom(b), JSON.stringify(b)).toBeNull();
  });
});
