import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Rule 19: the chat's event stream and the saved reply behind it. A turn can run for minutes, and a phone's carrier or a
 * proxy drops a connection that stays silent for 30-60 s, so the route writes a comment line every 10 s while the model
 * works. When the connection drops anyway, the turn goes on and its reply is saved to the thread, which is what the
 * panel's recovery poll (`GET /api/chat?conv=`) reads. The model is the only fake; the route, the chat engine and the
 * store are the real ones.
 */
const h = vi.hoisted(() => ({
  turns: [] as (() => Promise<unknown> | unknown)[],
  calls: 0,
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      stream: () => ({
        finalMessage: async () => {
          h.calls++;
          const next = h.turns.shift();
          if (!next) throw new Error("no scripted model turn left");
          return next();
        },
      }),
    };
  },
}));
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));

import { saveBrand, type Brand } from "@/lib/brand";
import { json, newUser, settle, signIn } from "./helpers/session";
import * as chatRoute from "@/app/api/chat/route";

const brand: Brand = { name: "Rose Coffee", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "warm", products: "coffee", audience: "Riyadh", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "Riyadh", updatedAt: new Date().toISOString() };
const usage = { input_tokens: 1, output_tokens: 1 };
const answer = (text: string) => ({ model: "claude-sonnet-5-5", stop_reason: "end_turn", usage, content: [{ type: "text", text }] });
const real = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean | Promise<boolean>, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await real(10);
  }
}

/** A model turn that waits until the test lets it answer. */
function slowTurn(text: string) {
  let release = () => {};
  const turn = () => new Promise((res) => { release = () => res(answer(text)); });
  return { turn, release: () => release() };
}
/** The chunks of a stream as they arrive, and a promise for the end of it. */
function collect(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const chunks: string[] = [];
  const finished = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      chunks.push(dec.decode(value, { stream: true }));
    }
  })();
  return { reader, chunks, finished, text: () => chunks.join("") };
}
const pings = (chunks: string[]) => chunks.filter((c) => c === ": ping\n\n").length;

beforeEach(async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.turns = [];
  h.calls = 0;
  const u = await newUser("cs");
  await saveBrand(u.email, brand);
  await signIn(u.email);
});
afterEach(async () => {
  vi.useRealTimers();
  await settle();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const post = (body: Record<string, unknown> = {}) => chatRoute.POST(json("/api/chat", "POST", { text: "مرحبا", stream: true, ...body }));
const thread = async (conv = "default") => ((await (await chatRoute.GET(json(`/api/chat?conv=${conv}`, "GET"))).json()) as { messages: { role: string; content: string; at: string }[] }).messages;

describe("the chat stream's heartbeat (rule 19)", () => {
  it("writes a comment line every 10 s while the model works, then the message, and stops the timer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const slow = slowTurn("أهلاً بك");
    h.turns = [slow.turn];
    const res = await post();
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(res.headers.get("x-accel-buffering"), "a proxy must not buffer the stream").toBe("no");
    const s = collect(res);
    await until(() => h.calls === 1, "the model call");

    // Nothing before 10 s, then one line per 10 s.
    vi.advanceTimersByTime(9_999);
    await real(0);
    expect(pings(s.chunks)).toBe(0);
    vi.advanceTimersByTime(1);
    await until(() => pings(s.chunks) === 1, "the first ping");
    vi.advanceTimersByTime(10_000);
    await until(() => pings(s.chunks) === 2, "the second ping");
    expect(s.text(), "no message before the model answers").not.toContain('"type":"message"');

    slow.release();
    await s.finished;
    const text = s.text();
    expect(text).toContain('data: {"type":"message"');
    expect(text.indexOf(": ping")).toBeLessThan(text.indexOf('"type":"message"'));
    expect(vi.getTimerCount(), "the heartbeat timer outlived the turn").toBe(0);
  });

  it("a failed turn ends the stream with an error event and stops the timer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    h.turns = [() => { throw new Error("model down"); }];
    const s = collect(await post());
    await s.finished;
    expect(s.text()).toContain('data: {"type":"error","error":"chat_failed"}');
    expect(s.text()).not.toContain('"type":"message"');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a reply the client never received is saved and found again (rule 19)", () => {
  it("the turn finishes after the connection is dropped, and the thread's last message is the reply, dated after the send", async () => {
    const slow = slowTurn("هذا هو الرد المحفوظ");
    h.turns = [slow.turn];
    const sentAt = Date.now();
    const s = collect(await post({ text: "ما أفضل وقت للنشر؟" }));
    await until(() => h.calls === 1, "the model call");

    // The phone loses the connection while the model is still working.
    await s.reader.cancel();
    await s.finished;
    slow.release();

    // What the panel's recovery poll reads: the last message, an assistant's, no older than the send (minus its 5 s slack).
    await until(async () => (await thread()).at(-1)?.role === "assistant", "the saved reply");
    const msgs = await thread();
    const last = msgs.at(-1)!;
    expect(last.content).toBe("هذا هو الرد المحفوظ");
    expect(new Date(last.at).getTime()).toBeGreaterThanOrEqual(sentAt - 5000);
    expect(msgs.at(-2)).toMatchObject({ role: "user", content: "ما أفضل وقت للنشر؟" });
    expect(h.calls, "the dropped connection did not make the server ask twice").toBe(1);
  });
});
