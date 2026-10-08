import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { inspect } from "node:util";
import { anthropic, effectiveProvider, llmProvider, modelState } from "@/lib/model";
import { db } from "@/lib/db";

/**
 * Provider switch (src/lib/model.ts). `LLM_PROVIDER=straitly` sends the same SDK calls to the Straitly gateway; a Claude
 * model that Straitly fails on, with a connection error or a 5xx before any response byte, is sent once more to Anthropic
 * with ANTHROPIC_API_KEY. The default stays "anthropic", so nothing changes until the variable is set.
 *
 * These tests use the real SDK against an injected `fetch` (stubbed global): no network, no real key. The key values below
 * are distinctive strings so a leak into an error or a log line is found by a plain search.
 */
const STRAITLY_KEY = "sk-straitly-UNIT-TEST-ONLY-1111";
const ANTHROPIC_KEY = "sk-ant-UNIT-TEST-ONLY-2222";

type Call = { url: string; headers: Headers; body: string };
const MESSAGE = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
const ok = () => new Response(JSON.stringify(MESSAGE), { status: 200, headers: { "content-type": "application/json" } });
const fail = (status: number) => new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream failed" } }), { status, headers: { "content-type": "application/json" } });

/** Replaces the global fetch the SDK picks up, and records every request it is handed. */
function stubFetch(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  return calls;
}

const ask = (model: string, o: { maxRetries?: number } = {}) => anthropic({ timeoutMs: 30_000, maxRetries: o.maxRetries ?? 0 }).messages.create({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
const reason = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as Error & { status?: number }; } };

/** Every place a key could leak to from a failed call: message, stack, cause chain, own properties. */
const everything = (e: unknown) => inspect(e, { depth: 8, showHidden: true });

/**
 * console.warn, silenced and recorded for every test: the fallback writes one line per request it re-sends, and a test
 * that does not look at them should not print them. Restored after each test (`vi.restoreAllMocks`).
 */
let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // The machine running the tests may carry these; the SDK reads them implicitly when an option is not passed.
  vi.stubEnv("ANTHROPIC_BASE_URL", "");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
  vi.stubEnv("LLM_PROVIDER", "");
  vi.stubEnv("STRAITLY_BASE_URL", "");
  vi.stubEnv("STRAITLY_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const straitly = (keys: { straitly?: string; anthropic?: string } = { straitly: STRAITLY_KEY, anthropic: ANTHROPIC_KEY }) => {
  vi.stubEnv("LLM_PROVIDER", "straitly");
  vi.stubEnv("STRAITLY_API_KEY", keys.straitly ?? "");
  vi.stubEnv("ANTHROPIC_API_KEY", keys.anthropic ?? "");
};

describe("the provider switch", () => {
  it("defaults to anthropic when LLM_PROVIDER is unset or unknown", async () => {
    for (const v of [undefined, "", "anthropic", "openai", "Straitly", " straitly", "STRAITLY", "1"]) {
      vi.stubEnv("LLM_PROVIDER", v as string);
      expect(llmProvider(), JSON.stringify(v)).toBe("anthropic");
    }
    vi.stubEnv("LLM_PROVIDER", "straitly");
    expect(llmProvider()).toBe("straitly");

    // And the call itself: Anthropic's origin, ANTHROPIC_API_KEY, even with a Straitly key lying around.
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("STRAITLY_API_KEY", STRAITLY_KEY);
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_KEY);
    const calls = stubFetch(ok);
    await ask("claude-opus-5");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers.get("x-api-key")).toBe(ANTHROPIC_KEY);
    expect(JSON.stringify([...calls[0].headers])).not.toContain(STRAITLY_KEY);
  });

  it("straitly provider sends requests to STRAITLY_BASE_URL with STRAITLY_API_KEY", async () => {
    straitly();
    // An ambient bearer token must not ride along to the gateway.
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-token-must-not-be-sent");
    const calls = stubFetch(ok);

    await ask("claude-opus-5");
    expect(calls[0].url, "the SDK appends /v1/messages itself, so the default base has no /v1").toBe("https://api.straitly.ai/v1/messages");
    expect(calls[0].headers.get("x-api-key")).toBe(STRAITLY_KEY);
    expect(calls[0].headers.get("authorization")).toBeNull();
    expect(calls[0].headers.get("anthropic-version")).toBeTruthy();
    expect(JSON.stringify([...calls[0].headers])).not.toContain(ANTHROPIC_KEY);

    vi.stubEnv("STRAITLY_BASE_URL", "https://gateway.example.test");
    await ask("claude-sonnet-5");
    expect(calls[1].url).toBe("https://gateway.example.test/v1/messages");
    expect(calls[1].headers.get("x-api-key")).toBe(STRAITLY_KEY);
  });

  it("keeps both argument checks and the timeout and retry numbers under straitly", () => {
    straitly();
    for (const timeoutMs of [0, -1, NaN, Infinity]) expect(() => anthropic({ timeoutMs, maxRetries: 0 }), String(timeoutMs)).toThrow(/invalid_model_timeout/);
    for (const maxRetries of [-1, 1.5, 3, NaN]) expect(() => anthropic({ timeoutMs: 1000, maxRetries }), String(maxRetries)).toThrow(/invalid_model_retries/);
    const c = anthropic({ timeoutMs: 1234.9, maxRetries: 2 });
    expect(c.timeout).toBe(1234);
    expect(c.maxRetries).toBe(2);
  });

  it("STRAITLY_BASE_URL must be https (or loopback) and a URL, and the error names neither it nor a key", async () => {
    straitly();
    const calls = stubFetch(ok);
    const refused = async (bad: string) => {
      vi.stubEnv("STRAITLY_BASE_URL", bad);
      return reason(Promise.resolve().then(() => anthropic({ timeoutMs: 1000, maxRetries: 0 })));
    };
    // Not a URL, or a scheme the key may not travel over: plain http is for a loopback HOST only, and a host that merely
    // starts with "localhost" or puts it in the user info is not one.
    for (const bad of ["http://gateway.example.test", "not a url", "ftp://gateway.example.test", "//gateway.example.test", "http://localhost.evil.com", "http://localhost@evil.com", "http://127.0.0.1@evil.com", "http://127.0.0.2:8787"]) {
      const e = await refused(bad);
      expect(e?.message, bad).toBe("invalid_straitly_base_url");
      expect(everything(e), bad).not.toContain("evil");
    }
    expect(calls, "nothing was sent").toHaveLength(0);
  });

  it("STRAITLY_BASE_URL is an origin only: no /v1 or other path, no query, fragment or user info, and the error never prints it", async () => {
    straitly();
    const calls = stubFetch(ok);
    // The SDK adds /v1/messages itself, so a base with /v1 would send every call to /v1/v1/messages; a path or a query
    // changes where the key goes, and user info puts a secret in the URL.
    for (const bad of [
      "https://api.straitly.ai/v1", "https://api.straitly.ai/v1/", "https://gateway.example.test/proxy", "https://gateway.example.test/proxy/",
      "https://gateway.example.test/?x=1", "https://gateway.example.test?", "https://gateway.example.test#top", "https://gateway.example.test#",
      "https://user:pw-SECRET@gateway.example.test", "https://user-SECRET@gateway.example.test", "https://:pw-SECRET@gateway.example.test", "https://localhost@evil.com", "http://user:pw-SECRET@localhost:8787",
    ]) {
      vi.stubEnv("STRAITLY_BASE_URL", bad);
      const e = await reason(Promise.resolve().then(() => anthropic({ timeoutMs: 1000, maxRetries: 0 })));
      expect(e?.message, bad).toBe("invalid_straitly_base_url: origin only, no /v1 or other path, no query, fragment or user info");
      for (const part of [bad, "SECRET", "gateway.example.test", "evil", STRAITLY_KEY, ANTHROPIC_KEY]) expect(everything(e), `${bad}: ${part}`).not.toContain(part);
    }
    expect(calls, "nothing was sent").toHaveLength(0);

    // Accepted, and sent to the origin: a trailing slash, an upper-case scheme or host, a port, a loopback stand-in.
    for (const [base, sent] of [
      ["https://gateway.example.test/", "https://gateway.example.test/v1/messages"],
      ["HTTPS://Gateway.Example.TEST", "https://gateway.example.test/v1/messages"],
      ["https://gateway.example.test:8443", "https://gateway.example.test:8443/v1/messages"],
      ["http://localhost:8787", "http://localhost:8787/v1/messages"],
      ["HTTP://LOCALHOST:8787/", "http://localhost:8787/v1/messages"],
      ["http://127.0.0.1:8787", "http://127.0.0.1:8787/v1/messages"],
      ["http://[::1]:8787", "http://[::1]:8787/v1/messages"],
      ["  https://gateway.example.test  ", "https://gateway.example.test/v1/messages"],
    ] as const) {
      vi.stubEnv("STRAITLY_BASE_URL", base);
      await ask("claude-opus-5");
      expect(calls.at(-1)?.url, base).toBe(sent);
      expect(calls.at(-1)?.headers.get("x-api-key"), base).toBe(STRAITLY_KEY);
    }
  });

  it("straitly without STRAITLY_API_KEY sends to Anthropic and never hands the Anthropic key to the gateway", async () => {
    straitly({ anthropic: ANTHROPIC_KEY });
    const calls = stubFetch(ok);
    await ask("claude-opus-5");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers.get("x-api-key")).toBe(ANTHROPIC_KEY);
  });
});

describe("modelState with the provider switch (rule 431)", () => {
  it("anthropic provider: exactly as before", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_KEY);
    vi.stubEnv("STRAITLY_API_KEY", STRAITLY_KEY);
    expect(modelState(), "a Straitly key alone does not matter while the provider is anthropic").toBe("on");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(modelState(), "no Anthropic key, not production: the dev mock").toBe("mock");
  });

  it("straitly is on with either key", () => {
    straitly({ straitly: STRAITLY_KEY });
    expect(modelState()).toBe("on");
    straitly({ anthropic: ANTHROPIC_KEY });
    expect(modelState(), "the Anthropic key is the fallback").toBe("on");
    straitly();
    expect(modelState()).toBe("on");
  });

  it("straitly without STRAITLY_API_KEY or ANTHROPIC_API_KEY is paused in production and mock outside", () => {
    straitly({});
    for (const env of [{ NODE_ENV: "development" }, { VERCEL_ENV: "preview" }, { APP_ENV: "test", NODE_ENV: "production" }]) {
      vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VERCEL_ENV", ""); vi.stubEnv("APP_ENV", "");
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      expect(modelState(), JSON.stringify(env)).toBe("mock");
    }
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const env of [{ VERCEL_ENV: "production" }, { APP_ENV: "production" }, { NODE_ENV: "production" }]) {
      vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VERCEL_ENV", ""); vi.stubEnv("APP_ENV", "");
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      expect(modelState(), JSON.stringify(env)).toBe("paused");
    }
    expect(JSON.stringify(err.mock.calls), "the log line names a variable, never a value").not.toMatch(/sk-/);
  });
});

describe("the direct Anthropic fallback", () => {
  it("a 5xx or connection error from Straitly on a claude-* model is retried once against api.anthropic.com with ANTHROPIC_API_KEY", async () => {
    for (const first of ["503", "500", "529", "network"] as const) {
      straitly();
      const calls = stubFetch((_c, n) => {
        if (n > 0) return ok();
        if (first === "network") throw new TypeError("fetch failed");
        return fail(Number(first));
      });
      const msg = await ask("claude-sonnet-5-5");
      expect((msg.content[0] as { text: string }).text, first).toBe("ok");
      expect(calls, first).toHaveLength(2);
      expect(calls[0].url).toBe("https://api.straitly.ai/v1/messages");
      expect(calls[0].headers.get("x-api-key")).toBe(STRAITLY_KEY);
      expect(calls[1].url).toBe("https://api.anthropic.com/v1/messages");
      expect(calls[1].headers.get("x-api-key"), "Anthropic's key, not Straitly's").toBe(ANTHROPIC_KEY);
      expect(calls[1].headers.get("authorization")).toBeNull();
      expect(calls[1].headers.get("anthropic-version"), "the other headers stay").toBe(calls[0].headers.get("anthropic-version"));
      expect(calls[1].headers.get("content-type")).toBe(calls[0].headers.get("content-type"));
      expect(calls[1].body, "the same request body, read once").toBe(calls[0].body);
      expect(JSON.parse(calls[1].body)).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 16 });
      expect(JSON.stringify([...calls[1].headers])).not.toContain(STRAITLY_KEY);
      // One log line per re-sent request: a status code or "connection error", never a key, a header or a body.
      expect(warn.mock.calls.at(-1), first).toEqual([first === "network" ? "model_fallback: straitly connection error, retried on anthropic" : `model_fallback: straitly status ${first}, retried on anthropic`]);
      vi.unstubAllGlobals();
    }
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("is one retry: when Anthropic fails too, the error comes out and nothing is sent a third time", async () => {
    straitly();
    const calls = stubFetch(() => fail(503));
    const e = await reason(ask("claude-opus-5"));
    expect(e?.status).toBe(503);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["api.straitly.ai", "api.anthropic.com"]);

    straitly();
    const net = stubFetch(() => { throw new TypeError("fetch failed"); });
    expect(await reason(ask("claude-opus-5"))).toBeInstanceOf(Error);
    expect(net).toHaveLength(2);
  });

  it("counts each request it re-sends to Anthropic in one global counter, and nothing else (plan Task 8)", async () => {
    const key = `usage:_all:${new Date().toISOString().slice(0, 7)}:provider:fallback`;
    const spy = vi.spyOn(db, "incrby");
    const incrKeys = () => [...new Set(spy.mock.calls.map((c) => String(c[0])))];
    const count = async () => Number((await db.get<number>(key)) ?? 0);
    const base = await count();
    // A gateway success, a 4xx, a non-claude model and a missing Anthropic key re-send nothing: no count.
    straitly();
    stubFetch(ok);
    await ask("claude-opus-5");
    vi.unstubAllGlobals();
    for (const [model, status] of [["claude-opus-5", 400], ["claude-opus-5", 429], ["deepseek-v3.2", 503]] as const) {
      straitly();
      stubFetch(() => fail(status));
      await reason(ask(model));
      vi.unstubAllGlobals();
    }
    straitly({ straitly: STRAITLY_KEY });
    stubFetch(() => fail(503));
    await reason(ask("claude-opus-5"));
    vi.unstubAllGlobals();
    await new Promise((r) => setTimeout(r, 5));
    expect(await count()).toBe(base);
    // A 5xx and a connection error that end in a request to Anthropic: one each.
    for (const first of ["503", "network"] as const) {
      straitly();
      stubFetch((_c, n) => {
        if (n > 0) return ok();
        if (first === "network") throw new TypeError("fetch failed");
        return fail(503);
      });
      expect(((await ask("claude-sonnet-5-5")).content[0] as { text: string }).text).toBe("ok");
      vi.unstubAllGlobals();
    }
    await vi.waitFor(async () => expect(await count()).toBe(base + 2));
    // Nothing else is written: the one key is this month's fallback counter, with no account, model or key in its name.
    const written = incrKeys();
    expect(written.length).toBeGreaterThan(0);
    expect(written.filter((k) => k !== key)).toEqual([]);
  });

  it("a store that fails never changes the retry or what is logged", async () => {
    straitly();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const incr = vi.spyOn(db, "incrby").mockImplementation(() => { throw new Error(`store down ${STRAITLY_KEY} ${ANTHROPIC_KEY}`); });
    const calls = stubFetch((_c, n) => (n === 0 ? fail(503) : ok()));
    expect(((await ask("claude-opus-5")).content[0] as { text: string }).text).toBe("ok");
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["api.straitly.ai", "api.anthropic.com"]);
    expect(incr).toHaveBeenCalled();
    incr.mockRejectedValue(new Error(`store down ${STRAITLY_KEY}`));
    const net = stubFetch((_c, n) => { if (n === 0) throw new TypeError("fetch failed"); return ok(); });
    expect(((await ask("claude-opus-5")).content[0] as { text: string }).text).toBe("ok");
    expect(net).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 5));
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).not.toContain(STRAITLY_KEY);
    expect(logged).not.toContain(ANTHROPIC_KEY);
    expect(logged).not.toContain("store down");
  });

  it("keeps the SDK's path and the query string, and changes only the origin", async () => {
    straitly();
    vi.stubEnv("STRAITLY_BASE_URL", "https://gateway.example.test");
    const calls = stubFetch((_c, n) => (n === 0 ? fail(502) : ok()));
    await anthropic({ timeoutMs: 30_000, maxRetries: 0 }).beta.messages.create({ model: "claude-opus-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
    expect(calls[0].url).toBe("https://gateway.example.test/v1/messages?beta=true");
    expect(calls[1].url).toBe("https://api.anthropic.com/v1/messages?beta=true");
  });

  it("no fallback without ANTHROPIC_API_KEY, for a 4xx, or when the caller aborted", async () => {
    straitly({ straitly: STRAITLY_KEY });
    let calls = stubFetch(() => fail(503));
    expect((await reason(ask("claude-opus-5")))?.status).toBe(503);
    expect(calls, "no Anthropic key, so nothing to fall back with").toHaveLength(1);

    for (const status of [400, 401, 404, 408, 429]) {
      straitly();
      calls = stubFetch(() => fail(status));
      expect((await reason(ask("claude-opus-5")))?.status, String(status)).toBe(status);
      expect(calls, String(status)).toHaveLength(1);
    }

    straitly();
    const ac = new AbortController();
    calls = stubFetch(() => { ac.abort(); throw new DOMException("This operation was aborted", "AbortError"); });
    const aborted = await reason(anthropic({ timeoutMs: 30_000, maxRetries: 0 }).messages.create({ model: "claude-opus-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }, { signal: ac.signal }));
    expect(aborted).toBeInstanceOf(Error);
    expect(calls, "the attempt's time was the caller's: a second try would run past it").toHaveLength(1);
  });

  it("no fallback for a non-claude model", async () => {
    for (const model of ["deepseek-v3.2", "gpt-5", "gemini-3-pro", "glm-4.6", "Claude-opus-5", "anthropic/claude-opus-5"]) {
      straitly();
      const calls = stubFetch(() => fail(503));
      expect((await reason(ask(model)))?.status, model).toBe(503);
      expect(calls, model).toHaveLength(1);
      expect(calls[0].url).toContain("api.straitly.ai");
      vi.unstubAllGlobals();
    }
  });

  it("no fallback once the first response byte arrived", async () => {
    const enc = new TextEncoder();
    // A 200 whose body dies halfway: the headers came, so the reply has started and a second request would repeat it.
    straitly();
    let calls = stubFetch(() => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('{"id":"msg_1","type":"mess')); c.error(new TypeError("terminated")); } }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(await reason(ask("claude-opus-5"))).toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);

    // The same for a streamed reply cut after its first event.
    straitly();
    const first = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { ...MESSAGE, content: [] } })}\n\n`;
    calls = stubFetch(() => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(first)); c.error(new TypeError("terminated")); } }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const stream = await anthropic({ timeoutMs: 30_000, maxRetries: 0 }).messages.create({ model: "claude-opus-5", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(await reason((async () => { for await (const ev of stream) void ev; })())).toBeInstanceOf(Error);
    expect(calls).toHaveLength(1);
  });

  it("the SDK's own retries still apply on top, each starting at Straitly", async () => {
    straitly();
    const calls = stubFetch(() => fail(503));
    const e = await reason(ask("claude-opus-5", { maxRetries: 1 }));
    expect(e?.status).toBe(503);
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["api.straitly.ai", "api.anthropic.com", "api.straitly.ai", "api.anthropic.com"]);
  }, 20_000);
});

describe("the keys stay secret", () => {
  it("the key never appears in a thrown error message or console output", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const spies = [warn, error, ...(["log", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))];
    const seen: unknown[] = [];

    for (const mode of ["5xx", "network", "non-claude", "4xx"] as const) {
      straitly();
      stubFetch(() => { if (mode === "network") throw new TypeError("fetch failed"); return fail(mode === "4xx" ? 401 : 503); });
      seen.push(await reason(ask(mode === "non-claude" ? "deepseek-v3.2" : "claude-opus-5")));
      vi.unstubAllGlobals();
    }
    expect(warn, "the 5xx and the network error were re-sent, and logged").toHaveBeenCalledTimes(2);

    // The no-key line in production, from a fresh copy of the module each time: the line is written once per instance,
    // and an earlier test in this file already wrote it from the copy imported above, so that copy would write nothing
    // here and the check below would pass on no line at all. The first case has the other provider's key set, so a value
    // that leaked into the line would be found.
    const cases = [
      ["anthropic with only a Straitly key", () => { vi.stubEnv("LLM_PROVIDER", "anthropic"); vi.stubEnv("STRAITLY_API_KEY", STRAITLY_KEY); vi.stubEnv("ANTHROPIC_API_KEY", ""); }, "model_not_configured: ANTHROPIC_API_KEY is not set in production; the agents refuse as paused"],
      ["straitly with no key", () => straitly({}), "model_not_configured: STRAITLY_API_KEY and ANTHROPIC_API_KEY are not set in production; the agents refuse as paused"],
    ] as const;
    for (const [label, setup, line] of cases) {
      setup();
      vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VERCEL_ENV", ""); vi.stubEnv("APP_ENV", "");
      vi.resetModules();
      const fresh = await import("@/lib/model");
      const from = error.mock.calls.length;
      expect(fresh.modelState(), label).toBe("paused");
      expect(fresh.modelState(), label).toBe("paused");
      expect(error.mock.calls.slice(from), `${label}: one line, naming variables only`).toEqual([[line]]);
    }
    vi.resetModules();

    for (const e of seen) {
      expect(e).toBeInstanceOf(Error);
      for (const key of [STRAITLY_KEY, ANTHROPIC_KEY]) expect(everything(e)).not.toContain(key);
    }
    for (const s of spies) for (const key of [STRAITLY_KEY, ANTHROPIC_KEY]) expect(JSON.stringify(s.mock.calls)).not.toContain(key);
  });
});

describe("the provider a call really goes to (effectiveProvider, plan Task 8)", () => {
  it("is straitly only with LLM_PROVIDER=straitly AND STRAITLY_API_KEY, and always the origin the client built by anthropic() sends to", async () => {
    const configs: { label: string; provider: string; keys: { straitly?: string; anthropic?: string }; expected: "anthropic" | "straitly" }[] = [
      { label: "unset, Anthropic key", provider: "", keys: { anthropic: ANTHROPIC_KEY }, expected: "anthropic" },
      { label: "a typo with both keys", provider: "openai", keys: { straitly: STRAITLY_KEY, anthropic: ANTHROPIC_KEY }, expected: "anthropic" },
      { label: "anthropic with both keys", provider: "anthropic", keys: { straitly: STRAITLY_KEY, anthropic: ANTHROPIC_KEY }, expected: "anthropic" },
      { label: "straitly with both keys", provider: "straitly", keys: { straitly: STRAITLY_KEY, anthropic: ANTHROPIC_KEY }, expected: "straitly" },
      { label: "straitly with only its key", provider: "straitly", keys: { straitly: STRAITLY_KEY }, expected: "straitly" },
      { label: "straitly with only the Anthropic key", provider: "straitly", keys: { anthropic: ANTHROPIC_KEY }, expected: "anthropic" },
    ];
    for (const c of configs) {
      vi.stubEnv("LLM_PROVIDER", c.provider);
      vi.stubEnv("STRAITLY_API_KEY", c.keys.straitly ?? "");
      vi.stubEnv("ANTHROPIC_API_KEY", c.keys.anthropic ?? "");
      expect(effectiveProvider(), c.label).toBe(c.expected);
      // The same answer as the request itself: the host the real SDK client sends to.
      const calls = stubFetch(ok);
      await ask("claude-opus-5");
      expect(new URL(calls[0].url).host === "api.straitly.ai" ? "straitly" : "anthropic", `${c.label}: where the call went`).toBe(c.expected);
      vi.unstubAllGlobals();
    }
  });

  it("is anthropic when no key is set at all, and it reads the configuration at call time", () => {
    vi.stubEnv("LLM_PROVIDER", "straitly");
    expect(effectiveProvider()).toBe("anthropic");
    vi.stubEnv("STRAITLY_API_KEY", STRAITLY_KEY);
    expect(effectiveProvider()).toBe("straitly");
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    expect(effectiveProvider()).toBe("anthropic");
  });
});
