import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mediaEnv, noNetwork } from "./helpers/media";
import { KIE_MODELS, kieAdapter, kieTaskIdFrom, verifyKieSignature } from "@/lib/media/kie";
import { ProviderError, type SubmitInput } from "@/lib/media/types";
import type { MediaModelId } from "@/lib/media-catalog";

/**
 * kie.ai renders six catalogue models as tasks. Each model's request body is fixed here field by field (a wrong field
 * bills us for a render the owner did not ask for), every error carries a fixed code and never a byte of kie's reply
 * (chat tool errors reach the model, routes log them), a task id is format-checked before it enters a URL, and a
 * callback is believed only with a valid signature.
 */
type Call = { url: URL; init: RequestInit };
let calls: Call[] = [];
const real = globalThis.fetch;
/** A recording fetch that answers every call with `reply()`. */
const answer = (reply: (url: URL) => Response) => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return reply(url);
  }) as typeof fetch;
};
const json = (j: unknown, status = 200) => new Response(typeof j === "string" ? j : JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
const ok = (data: unknown) => () => json({ code: 200, msg: "success", data });
const KEY = "test-kie_api_key";
const TASK = "281e5b0abcdef0123456789f39b9";
const IMG = "https://abc.public.blob.vercel-storage.com/media/first.jpg";
const input = (over: Partial<SubmitInput> = {}): SubmitInput => ({ model: "img-balanced", prompt: "a cup of coffee", aspect: "square", ...over });
const signal = () => new AbortController().signal;
const sent = (i = 0) => JSON.parse(String(calls[i].init.body));

beforeEach(() => {
  calls = [];
  mediaEnv({ kie: true, store: true, models: "all" });
  vi.stubEnv("APP_ORIGIN", "");
});
afterEach(() => { globalThis.fetch = real; vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("request bodies, one per model", () => {
  const P = "a cup of coffee";
  /** The bodies of spec 3.1/3.2 as re-read on docs.kie.ai, written out rather than derived from KIE_MODELS. */
  const expected = (model: MediaModelId, aspect: "square" | "portrait", img?: string): { path: string; body: unknown } => {
    const r = aspect === "portrait" ? "9:16" : "1:1";
    const market = (body: unknown) => ({ path: "/api/v1/jobs/createTask", body });
    switch (model) {
      case "img-balanced":
        return market({ model: "nano-banana-2", input: img ? { prompt: P, image_input: [img], aspect_ratio: r, resolution: "1K", output_format: "jpg" } : { prompt: P, aspect_ratio: r, resolution: "1K", output_format: "jpg" } });
      case "img-premium":
        return market({ model: "nano-banana-pro", input: img ? { prompt: P, image_input: [img], aspect_ratio: r, resolution: "2K", output_format: "jpg" } : { prompt: P, aspect_ratio: r, resolution: "2K", output_format: "jpg" } });
      case "img-text":
        return market({ model: "gpt-image-2-text-to-image", input: { prompt: P, aspect_ratio: r, resolution: "1K" } });
      case "vid-quick":
        return market(img
          ? { model: "kling/v2-5-turbo-image-to-video-pro", input: { prompt: P, image_url: img, duration: "5", negative_prompt: "text, watermark, logo", cfg_scale: 0.5 } }
          : { model: "kling/v2-5-turbo-text-to-video-pro", input: { prompt: P, duration: "5", aspect_ratio: "9:16", negative_prompt: "text, watermark, logo", cfg_scale: 0.5 } });
      case "vid-sound":
        return {
          path: "/api/v1/veo/generate",
          body: img
            ? { prompt: P, model: "veo3_fast", aspect_ratio: "9:16", generationType: "FIRST_AND_LAST_FRAMES_2_VIDEO", imageUrls: [img], enableTranslation: true, duration: 8, resolution: "720p" }
            : { prompt: P, model: "veo3_fast", aspect_ratio: "9:16", generationType: "TEXT_2_VIDEO", enableTranslation: true, duration: 8, resolution: "720p" },
        };
      case "vid-premium": {
        const shot = { multi_shots: false, multi_prompt: [{ prompt: P, duration: 10 }] };
        return market({ model: "kling-3.0/video", input: img ? { prompt: P, image_urls: [img], sound: true, duration: "10", aspect_ratio: "9:16", mode: "std", ...shot } : { prompt: P, sound: true, duration: "10", aspect_ratio: "9:16", mode: "std", ...shot } });
      }
      default:
        throw new Error(`not a kie model: ${model}`);
    }
  };
  const cases = (Object.keys(KIE_MODELS) as MediaModelId[]).flatMap((model) =>
    (["square", "portrait"] as const).flatMap((aspect) => [undefined, IMG].map((img) => ({ model, aspect, img }))));

  it("covers exactly the six kie models of the catalogue", () => {
    expect(Object.keys(KIE_MODELS).sort()).toEqual(["img-balanced", "img-premium", "img-text", "vid-quick", "vid-sound", "vid-premium"].sort());
    expect(cases).toHaveLength(24);
  });

  it.each(cases)("$model, $aspect, image $img", async ({ model, aspect, img }) => {
    answer(ok({ taskId: TASK }));
    const r = await kieAdapter.submit(input({ model, aspect, imageUrl: img }), signal());
    expect(r).toEqual({ state: "pending", providerTaskId: TASK });
    const want = expected(model, aspect, img);
    expect(calls).toHaveLength(1);
    expect([calls[0].url.origin, calls[0].url.pathname, calls[0].url.search, calls[0].init.method]).toEqual(["https://api.kie.ai", want.path, "", "POST"]);
    expect(sent()).toEqual(want.body);
  });

  it("Veo translates a prompt that carries Arabic: the fixed template names the brand's Arabic industry", async () => {
    answer(ok({ taskId: TASK }));
    const arabic = "8-second vertical social video for مخبز السعادة: a scene that represents a مخابز business";
    await kieAdapter.submit(input({ model: "vid-sound", prompt: arabic }), signal());
    expect(sent()).toMatchObject({ prompt: arabic, enableTranslation: true });
  });

  it("Kling 3.0 sends its required multi_prompt as one shot of the full clip, within kie's 500-character cap", async () => {
    answer(ok({ taskId: TASK }));
    const head = "a slow push-in across a bakery counter, ".repeat(13).slice(0, 499);
    const long = `${head}😀 end`;
    await kieAdapter.submit(input({ model: "vid-premium", prompt: long }), signal());
    const { input: body } = sent();
    expect(body.prompt, "the clip's own prompt is never cut").toBe(long);
    expect(body.multi_shots).toBe(false);
    expect(body.multi_prompt).toHaveLength(1);
    expect(body.multi_prompt[0].duration).toBe(Number(body.duration));
    expect(long.startsWith(body.multi_prompt[0].prompt)).toBe(true);
    expect(body.multi_prompt[0].prompt.length).toBeLessThanOrEqual(500);
    expect(body.multi_prompt[0].prompt, "no half of a surrogate pair").not.toMatch(/[\uD800-\uDBFF]$/);
    // The emoji straddles unit 500: dropped whole, not split.
    expect(long.slice(0, 500)).toMatch(/[\uD800-\uDBFF]$/);
    expect(body.multi_prompt[0].prompt).toBe(head);
    // A short prompt goes into the shot as it is.
    await kieAdapter.submit(input({ model: "vid-premium", prompt: "a cup of coffee" }), signal());
    expect(sent(1).input.multi_prompt).toEqual([{ prompt: "a cup of coffee", duration: 10 }]);
  });

  it("sends the key only as a Bearer header, never in a URL, and hands fetch the caller's own signal", async () => {
    answer((url) => (url.pathname.includes("record") ? ok({ state: "waiting" })() : ok({ taskId: TASK })()));
    const c = new AbortController();
    await kieAdapter.submit(input(), c.signal);
    await kieAdapter.submit(input({ model: "vid-sound" }), signal());
    await kieAdapter.status({ providerTaskId: TASK, model: "img-balanced" }, signal());
    await kieAdapter.check!(signal());
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.url.host).toBe("api.kie.ai");
      expect(call.url.href).not.toContain(KEY);
      const h = new Headers(call.init.headers);
      expect(h.get("authorization")).toBe(`Bearer ${KEY}`);
    }
    expect(new Headers(calls[0].init.headers).get("content-type")).toBe("application/json");
    expect(calls[0].init.signal, "the engine's deadline is the only timeout").toBe(c.signal);
    expect(c.signal.aborted).toBe(false);
  });

  it("asks for a callback only with an explicit https APP_ORIGIN, at the top level of both body shapes", async () => {
    answer(ok({ taskId: TASK }));
    await kieAdapter.submit(input(), signal());
    await kieAdapter.submit(input({ model: "vid-sound" }), signal());
    expect(sent(0)).not.toHaveProperty("callBackUrl");
    expect(sent(1)).not.toHaveProperty("callBackUrl");
    vi.stubEnv("APP_ORIGIN", "https://nashr.example");
    await kieAdapter.submit(input(), signal());
    await kieAdapter.submit(input({ model: "vid-sound" }), signal());
    expect(sent(2).callBackUrl).toBe("https://nashr.example/api/media/hook/kie");
    expect(sent(2).input).not.toHaveProperty("callBackUrl");
    expect(sent(3).callBackUrl).toBe("https://nashr.example/api/media/hook/kie");
  });

  it("sends nothing without a key, or for a model that is not kie's", async () => {
    const net = noNetwork();
    try {
      vi.stubEnv("KIE_API_KEY", "");
      await expect(kieAdapter.submit(input(), signal())).rejects.toMatchObject({ code: "unavailable", message: "provider_unavailable" });
      await expect(kieAdapter.status({ providerTaskId: TASK, model: "img-balanced" }, signal())).rejects.toMatchObject({ code: "unavailable" });
      expect(await kieAdapter.check!(signal())).toEqual({ error: "not_configured" });
      vi.stubEnv("KIE_API_KEY", KEY);
      for (const model of ["img-fast", "img-lifestyle", "vid-motion"] as MediaModelId[]) {
        await expect(kieAdapter.submit(input({ model }), signal())).rejects.toMatchObject({ code: "rejected", message: "provider_rejected" });
        await expect(kieAdapter.status({ providerTaskId: TASK, model }, signal())).rejects.toMatchObject({ code: "rejected" });
      }
      expect(net.hosts).toEqual([]);
    } finally {
      net.restore();
    }
  });
});

describe("submit errors carry a fixed code and nothing of kie's reply", () => {
  const LEAK = `leak ${KEY} prompt echo`;
  const table: [string, string, () => Response][] = [
    ["HTTP 429", "provider_busy:429", () => json({ code: 429, msg: LEAK }, 429)],
    ["body code 429 on HTTP 200", "provider_busy:429", () => json({ code: 429, msg: LEAK })],
    ["HTTP 402", "provider_no_balance:402", () => json({ code: 402, msg: LEAK }, 402)],
    ["body code 402", "provider_no_balance:402", () => json({ code: 402, msg: LEAK })],
    ["body code 433", "provider_no_balance:433", () => json({ code: 433, msg: LEAK })],
    ["HTTP 401", "provider_unavailable:401", () => json({ code: 401, msg: LEAK }, 401)],
    ["body code 422", "provider_rejected:422", () => json({ code: 422, msg: LEAK })],
    ["HTTP 400", "provider_rejected:400", () => json({ code: 400, msg: LEAK }, 400)],
    ["body code 404 (unknown endpoint or model)", "provider_rejected:404", () => json({ code: 404, msg: LEAK })],
    ["body code 455", "provider_unavailable:455", () => json({ code: 455, msg: LEAK })],
    ["HTTP 503", "provider_unavailable:503", () => json(`<html>${LEAK}</html>`, 503)],
    ["body code 500", "provider_unavailable:500", () => json({ code: 500, msg: LEAK })],
    ["not JSON", "provider_bad_response", () => json(`{"code":200,"data":{"taskId":"${LEAK}`)],
    ["no data", "provider_bad_response", () => json({ code: 200, msg: LEAK })],
    ["no code", "provider_bad_response", () => json({ msg: LEAK, data: { taskId: TASK } })],
    ["a task id that is not one", "provider_bad_response", () => json({ code: 200, data: { taskId: `../${LEAK}` } })],
    ["a numeric task id", "provider_bad_response", () => json({ code: 200, data: { taskId: 12345678 } })],
  ];

  it.each(table)("%s → %s", async (_name, message, reply) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    answer(reply);
    const err = await kieAdapter.submit(input(), signal()).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    const m = (err as Error).message;
    expect(m).toBe(message);
    expect(m).toMatch(/^provider_[a-z_]+(:\d+)?$/);
    expect(m).not.toContain(KEY);
    expect(m).not.toContain("leak");
    // A log line may carry numbers only: never the body, never a header.
    for (const args of log.mock.calls) {
      expect(args[0]).toBe("kie");
      expect(args[1], "the status and the provider code, both numbers").toEqual({ status: expect.any(Number), provider_code: expect.any(Number) });
    }
    expect(calls, "a submit is never retried").toHaveLength(1);
  });

  it("a fetch that throws is 'unavailable', sent once", async () => {
    let n = 0;
    globalThis.fetch = (async () => { n++; throw new TypeError(`fetch failed ${KEY}`); }) as typeof fetch;
    await expect(kieAdapter.submit(input(), signal())).rejects.toMatchObject({ message: "provider_unavailable" });
    expect(n).toBe(1);
  });
});

describe("status", () => {
  const market = (data: unknown) => { answer(ok(data)); return kieAdapter.status({ providerTaskId: TASK, model: "img-premium" }, signal()); };
  const veo = (data: unknown) => { answer(ok(data)); return kieAdapter.status({ providerTaskId: TASK, model: "vid-sound" }, signal()); };

  it("polls the market task with GET recordInfo and the id as a query parameter", async () => {
    expect(await market({ taskId: TASK, state: "waiting" })).toEqual({ state: "pending" });
    expect([calls[0].url.origin, calls[0].url.pathname, calls[0].url.searchParams.get("taskId"), calls[0].init.method]).toEqual(["https://api.kie.ai", "/api/v1/jobs/recordInfo", TASK, "GET"]);
    expect(calls[0].init.body).toBeUndefined();
  });

  it.each(["waiting", "queuing", "generating"])("%s → pending", async (state) => {
    expect(await market({ state })).toEqual({ state: "pending" });
  });

  it("success parses the stringified resultJson and reports creditsConsumed, fractional too", async () => {
    const r = await market({ state: "success", resultJson: JSON.stringify({ resultUrls: ["https://tempfile.aiquickdraw.com/r/a.jpg"] }), creditsConsumed: 8.2 });
    expect(r).toEqual({ state: "done", urls: ["https://tempfile.aiquickdraw.com/r/a.jpg"], providerCredits: 8.2 });
  });

  it("an http: result URL is dropped; none left is a bad response, as is an unreadable resultJson", async () => {
    expect(await market({ state: "success", resultJson: JSON.stringify({ resultUrls: ["http://x.example/a.jpg", "https://x.example/b.jpg"] }), creditsConsumed: 18 }))
      .toEqual({ state: "done", urls: ["https://x.example/b.jpg"], providerCredits: 18 });
    await expect(market({ state: "success", resultJson: JSON.stringify({ resultUrls: ["http://x.example/a.jpg"] }) })).rejects.toMatchObject({ message: "provider_bad_response" });
    await expect(market({ state: "success", resultJson: "{not json" })).rejects.toMatchObject({ message: "provider_bad_response" });
    await expect(market({ state: "success" })).rejects.toMatchObject({ message: "provider_bad_response" });
    await expect(market({ state: "exploded" })).rejects.toMatchObject({ message: "provider_bad_response" });
  });

  it("a missing or non-numeric creditsConsumed is left out, not guessed", async () => {
    const r = await market({ state: "success", resultJson: JSON.stringify({ resultUrls: ["https://x.example/b.jpg"] }), creditsConsumed: "18" });
    expect(r).toEqual({ state: "done", urls: ["https://x.example/b.jpg"] });
    expect((r as { providerCredits?: number }).providerCredits).toBeUndefined();
  });

  it("a failure is a content refusal only when kie says so", async () => {
    expect(await market({ state: "fail", failCode: "400", failMsg: "" })).toEqual({ state: "failed", reason: "nsfw" });
    expect(await market({ state: "fail", failCode: 400, failMsg: "" })).toEqual({ state: "failed", reason: "nsfw" });
    expect(await market({ state: "fail", failCode: "422", failMsg: "The content violates our policy" })).toEqual({ state: "failed", reason: "nsfw" });
    expect(await market({ state: "fail", failCode: "GENERATION_FAILED", failMsg: "The generation task failed." })).toEqual({ state: "failed", reason: "provider_failed" });
    expect(await market({ state: "fail", failCode: "500", failMsg: "Internal Error" })).toEqual({ state: "failed", reason: "provider_failed" });
  });

  it("Veo polls its own record-info and reads successFlag", async () => {
    expect(await veo({ taskId: TASK, successFlag: 0 })).toEqual({ state: "pending" });
    expect([calls[0].url.pathname, calls[0].url.searchParams.get("taskId"), calls[0].init.method]).toEqual(["/api/v1/veo/record-info", TASK, "GET"]);
    expect(await veo({ successFlag: 1, response: { resultUrls: ["https://tempfile.aiquickdraw.com/v/a.mp4"] }, creditsConsumed: 60 }))
      .toEqual({ state: "done", urls: ["https://tempfile.aiquickdraw.com/v/a.mp4"], providerCredits: 60 });
    const bare = await veo({ successFlag: 1, response: { resultUrls: ["https://tempfile.aiquickdraw.com/v/a.mp4"] } });
    expect((bare as { providerCredits?: number }).providerCredits).toBeUndefined();
    expect(await veo({ successFlag: 2, errorCode: 500, errorMessage: "Internal Error - Timeout" })).toEqual({ state: "failed", reason: "provider_failed" });
    expect(await veo({ successFlag: 3, errorCode: 501, errorMessage: "" })).toEqual({ state: "failed", reason: "provider_failed" });
    expect(await veo({ successFlag: 2, errorCode: 400, errorMessage: "Your prompt was flagged by Website as violating content policies." })).toEqual({ state: "failed", reason: "nsfw" });
    // Code 400 also covers a first frame kie could not download: not the owner's content.
    expect(await veo({ successFlag: 3, errorCode: 400, errorMessage: "Failed to fetch the image. Kindly verify any access limits" })).toEqual({ state: "failed", reason: "provider_failed" });
    expect(await veo({ successFlag: 2, errorCode: 400, errorMessage: "public error unsafe image upload." })).toEqual({ state: "failed", reason: "nsfw" });
    await expect(veo({ successFlag: 1, response: { resultUrls: ["http://x.example/v.mp4"] } })).rejects.toMatchObject({ message: "provider_bad_response" });
    await expect(veo({ successFlag: 1, response: null })).rejects.toMatchObject({ message: "provider_bad_response" });
    await expect(veo({})).rejects.toMatchObject({ message: "provider_bad_response" });
  });

  it("a Veo prompt refused for its language is not reported as a content refusal, nor is a bare 400", async () => {
    // Veo files four causes under 400 (content, language, image fetch, unsafe image): only the message tells them apart.
    expect(await veo({ successFlag: 2, errorCode: 400, errorMessage: "Only English prompts are supported at this time." })).toEqual({ state: "failed", reason: "provider_failed" });
    expect(await veo({ successFlag: 3, errorCode: 400, errorMessage: "" })).toEqual({ state: "failed", reason: "provider_failed" });
    expect(await veo({ successFlag: 3, errorCode: 400 })).toEqual({ state: "failed", reason: "provider_failed" });
    // The market reading of a bare 400 is unchanged; a language message is not a refusal there either.
    expect(await market({ state: "fail", failCode: "400", failMsg: "" })).toEqual({ state: "failed", reason: "nsfw" });
    expect(await market({ state: "fail", failCode: "400", failMsg: "Only English prompts are supported" })).toEqual({ state: "failed", reason: "provider_failed" });
  });

  it("a status error is mapped like a submit error", async () => {
    answer(() => json({ code: 429, msg: "slow down" }, 429));
    await expect(kieAdapter.status({ providerTaskId: TASK, model: "vid-quick" }, signal())).rejects.toMatchObject({ code: "busy", message: "provider_busy:429" });
    answer(() => json({ code: 422, msg: "recordInfo is null", data: null }));
    await expect(kieAdapter.status({ providerTaskId: TASK, model: "vid-quick" }, signal())).rejects.toMatchObject({ message: "provider_rejected:422" });
  });

  it.each(["abc/def", "../../etc", "abcdef?x=1", "abcdef#x", "a%2Fbcdef", "abc", "", "x".repeat(81)])("task id %j never reaches fetch", async (id) => {
    const net = noNetwork();
    try {
      await expect(kieAdapter.status({ providerTaskId: id, model: "img-balanced" }, signal())).rejects.toMatchObject({ message: "provider_bad_response" });
      await expect(kieAdapter.status({ providerTaskId: id, model: "vid-sound" }, signal())).rejects.toMatchObject({ message: "provider_bad_response" });
      expect(net.hosts).toEqual([]);
    } finally {
      net.restore();
    }
  });

  it("offers no cancel: kie documents none", () => {
    expect(kieAdapter.cancel).toBeUndefined();
  });
});

describe("callback signature (KIE_WEBHOOK_HMAC_KEY)", () => {
  const HMAC = "test-kie_webhook_hmac_key";
  const NOW = 1_790_000_000;
  const sign = (taskId: string, ts: string, key = HMAC) => createHmac("sha256", key).update(`${taskId}.${ts}`).digest("base64");

  it("accepts kie's own signature within ±300 s", () => {
    expect(verifyKieSignature(TASK, String(NOW), sign(TASK, String(NOW)), HMAC, NOW)).toBe(true);
    expect(verifyKieSignature(TASK, String(NOW - 300), sign(TASK, String(NOW - 300)), HMAC, NOW)).toBe(true);
    expect(verifyKieSignature(TASK, String(NOW + 300), sign(TASK, String(NOW + 300)), HMAC, NOW)).toBe(true);
  });

  it("refuses a wrong key, a tampered task id, a stale or future timestamp", () => {
    expect(verifyKieSignature(TASK, String(NOW), sign(TASK, String(NOW), "another-key"), HMAC, NOW)).toBe(false);
    expect(verifyKieSignature(`${TASK}x`, String(NOW), sign(TASK, String(NOW)), HMAC, NOW)).toBe(false);
    expect(verifyKieSignature(TASK, String(NOW - 301), sign(TASK, String(NOW - 301)), HMAC, NOW)).toBe(false);
    expect(verifyKieSignature(TASK, String(NOW + 301), sign(TASK, String(NOW + 301)), HMAC, NOW)).toBe(false);
    // The signature of one timestamp does not carry over to another.
    expect(verifyKieSignature(TASK, String(NOW + 1), sign(TASK, String(NOW)), HMAC, NOW)).toBe(false);
  });

  it("refuses a missing header or key and a timestamp that is not an integer", () => {
    const ts = String(NOW);
    expect(verifyKieSignature(TASK, null, sign(TASK, ts), HMAC, NOW)).toBe(false);
    expect(verifyKieSignature(TASK, ts, null, HMAC, NOW)).toBe(false);
    expect(verifyKieSignature(TASK, ts, "", HMAC, NOW)).toBe(false);
    expect(verifyKieSignature(TASK, ts, sign(TASK, ts, ""), "", NOW)).toBe(false);
    expect(verifyKieSignature("", ts, sign("", ts), HMAC, NOW)).toBe(false);
    for (const bad of [`${NOW}.5`, "abc", `-${NOW}`, `${NOW} `, "1e9", ""]) expect(verifyKieSignature(TASK, bad, sign(TASK, bad), HMAC, NOW), bad).toBe(false);
  });

  it("uses the current time by default", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(verifyKieSignature(TASK, ts, sign(TASK, ts), HMAC)).toBe(true);
    expect(verifyKieSignature(TASK, "1000000000", sign(TASK, "1000000000"), HMAC)).toBe(false);
  });
});

describe("kieTaskIdFrom: the only field read from a callback body", () => {
  it("finds the id in each documented shape", () => {
    expect(kieTaskIdFrom({ taskId: TASK })).toBe(TASK);
    expect(kieTaskIdFrom({ code: 200, msg: "ok", data: { taskId: TASK, resultJson: "{}" } })).toBe(TASK);
    expect(kieTaskIdFrom({ code: 200, data: { task_id: TASK, callbackType: "complete" } })).toBe(TASK);
  });

  it("refuses anything that is not a well-formed id", () => {
    for (const body of [
      { taskId: "../x" }, { data: { taskId: "../../mjob" } }, { data: { task_id: "a/b/c/d" } }, { taskId: "x".repeat(200) },
      { taskId: 12345678 }, { data: { taskId: 12345678 } }, { taskId: "abc" }, { taskId: "" }, { data: null }, {}, null, "task_12345678", 42, [],
    ]) expect(kieTaskIdFrom(body), JSON.stringify(body)).toBeNull();
  });
});

describe("check: the kie balance for the founder console", () => {
  it("reads the balance from GET /api/v1/chat/credit", async () => {
    answer(ok(1234.5));
    expect(await kieAdapter.check!(signal())).toEqual({ balanceCredits: 1234.5 });
    expect([calls[0].url.origin, calls[0].url.pathname]).toEqual(["https://api.kie.ai", "/api/v1/chat/credit"]);
  });

  it("reports a failure as a fixed string, never kie's reply", async () => {
    answer(() => json({ code: 401, msg: `leak ${KEY}` }, 401));
    expect(await kieAdapter.check!(signal())).toEqual({ error: "http:401" });
    answer(() => json({ code: 401, msg: `leak ${KEY}` }));
    expect(await kieAdapter.check!(signal())).toEqual({ error: "code:401" });
    answer(() => json("not json"));
    expect(await kieAdapter.check!(signal())).toEqual({ error: "bad_response" });
    answer(ok("lots"));
    expect(await kieAdapter.check!(signal())).toEqual({ error: "bad_response" });
    globalThis.fetch = (async () => { throw new TypeError(`fetch failed ${KEY}`); }) as typeof fetch;
    expect(await kieAdapter.check!(signal())).toEqual({ error: "fetch_failed" });
  });
});
