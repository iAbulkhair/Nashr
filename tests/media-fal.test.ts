import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mediaEnv, noNetwork } from "./helpers/media";
import { falAdapter } from "@/lib/media/fal";
import { ProviderError, type SubmitInput } from "@/lib/media/types";

/**
 * The "Fast" image is the one render that answers in the same request. Its request body is fixed here field by field,
 * its errors carry a fixed code and never a byte of fal's reply (chat tool errors reach the model, routes log them),
 * and a picture fal's safety checker flagged is a content refusal, not a result to publish.
 */
type Call = { url: URL; init: RequestInit };
let calls: Call[] = [];
const real = globalThis.fetch;
/** A recording fetch that answers every call with `reply()`. */
const answer = (reply: () => Response) => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    return reply();
  }) as typeof fetch;
};
const ok = (j: unknown) => () => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
const IMG = "https://v3.fal.media/files/abc/out.jpeg";
const input = (over: Partial<SubmitInput> = {}): SubmitInput => ({ model: "img-fast", prompt: "a cup of coffee", aspect: "square", ...over });
const submit = (i = input(), signal = new AbortController().signal) => falAdapter.submit(i, signal);

beforeEach(() => { calls = []; mediaEnv({ fal: true }); });
afterEach(() => { globalThis.fetch = real; vi.unstubAllEnvs(); });

describe("the request", () => {
  it("posts the exact body to fal.run with the key header, for square and for portrait", async () => {
    answer(ok({ images: [{ url: IMG }], has_nsfw_concepts: [false] }));
    await submit(input({ aspect: "square" }));
    await submit(input({ aspect: "portrait", prompt: "tall" }));
    expect(calls.map((c) => [c.url.host, c.url.pathname, c.init.method])).toEqual([["fal.run", "/fal-ai/flux/schnell", "POST"], ["fal.run", "/fal-ai/flux/schnell", "POST"]]);
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("authorization")).toBe("Key test-fal_key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ prompt: "a cup of coffee", image_size: "square_hd", num_images: 1, enable_safety_checker: true, output_format: "jpeg" });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ prompt: "tall", image_size: "portrait_16_9", num_images: 1, enable_safety_checker: true, output_format: "jpeg" });
  });

  it("hands fetch the caller's signal itself, not one of its own that could fire first", async () => {
    answer(ok({ images: [{ url: IMG }], has_nsfw_concepts: [false] }));
    const c = new AbortController();
    await submit(input(), c.signal);
    expect(calls[0].init.signal, "the engine's deadline is the only timeout").toBe(c.signal);
    expect(c.signal.aborted).toBe(false);
  });

  it("sends nothing without a key, or for a model that is not fal's", async () => {
    const net = noNetwork();
    try {
      vi.stubEnv("FAL_KEY", "");
      await expect(submit()).rejects.toMatchObject({ code: "unavailable", message: "provider_unavailable" });
      vi.stubEnv("FAL_KEY", "test-fal_key");
      await expect(submit(input({ model: "img-balanced" }))).rejects.toMatchObject({ code: "rejected", message: "provider_rejected" });
      expect(net.hosts).toEqual([]);
    } finally {
      net.restore();
    }
  });
});

describe("the answer", () => {
  it("returns the https image", async () => {
    answer(ok({ images: [{ url: IMG }], has_nsfw_concepts: [false] }));
    expect(await submit()).toEqual({ state: "done", urls: [IMG] });
  });

  it("treats a flagged picture as a content refusal, even with a URL in the reply", async () => {
    answer(ok({ images: [{ url: IMG }], has_nsfw_concepts: [true] }));
    expect(await submit()).toEqual({ state: "failed", reason: "nsfw" });
  });

  it("refuses a result that is not an https URL, and a reply that is not the expected JSON", async () => {
    for (const j of [{ images: [{ url: "http://v3.fal.media/x.jpeg" }], has_nsfw_concepts: [false] }, { images: [{ url: "data:image/jpeg;base64,AAAA" }] }, { images: [] }, {}, null]) {
      answer(ok(j));
      await expect(submit(), JSON.stringify(j)).rejects.toMatchObject({ code: "bad_response", message: "provider_bad_response" });
    }
    answer(() => new Response("leak test-fal_key <html>", { status: 200 }));
    const e = await submit().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as Error).message, "a JSON.parse message would quote the body").toBe("provider_bad_response");
  });

  it("maps each HTTP status to a fixed code and never reads the body into the error", async () => {
    const cases: [number, string][] = [[429, "busy"], [401, "unavailable"], [403, "unavailable"], [400, "rejected"], [422, "rejected"], [500, "unavailable"], [503, "unavailable"]];
    for (const [status, code] of cases) {
      answer(() => new Response(`{"detail":"leak test-fal_key"}`, { status }));
      const e = (await submit().catch((x: unknown) => x)) as ProviderError;
      expect(e).toBeInstanceOf(ProviderError);
      expect([e.code, e.status, e.message]).toEqual([code, status, `provider_${code}:${status}`]);
      expect(e.message).not.toMatch(/test-fal_key|leak/);
    }
  });

  it("has nothing to poll: fal answers in the same request", async () => {
    await expect(falAdapter.status({ providerTaskId: "x", model: "img-fast" }, new AbortController().signal)).rejects.toMatchObject({ code: "bad_response" });
    expect(falAdapter.id).toBe("fal");
  });
});
