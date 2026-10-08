import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * `route()` owns every model choice, and a choice is one decision (spec 2026-10-08-straitly-model-routing, section 4; plan
 * Task 5). The models the code calls and the models the credits and the allowance are priced for must be one value:
 *
 * - a chat turn resolves its model once, reserves its messages for that model (`reserveChatTurn`) and runs `chat()` on the
 *   same value, on the web, in the stream and over MCP;
 * - a generation batch resolves its model once, charges `creditsFor(base, model, "generate")` and runs `generate()` on the
 *   same value; the judge is told which model generated, so it never marks its own work;
 * - every other call site (reviewer, cross-review, judge, onboarding, image prompt, free tools) asks `route()` for its own
 *   purpose and sends what it gets.
 *
 * The SDK is scripted and records every call it receives. `route` is wrapped, not replaced: it runs for real unless a test
 * sets `rt.pick[purpose]`, so an Opus-vs-Sonnet case is possible before any customer can store a pick (plan Task 6).
 */
type Call = { api: "generate" | "stream" | "create"; model: string; system: string };
const sdk = vi.hoisted(() => ({
  calls: [] as { api: "generate" | "stream" | "create"; model: string; system: string }[],
  fail: false,
  usage: { input_tokens: 1000, output_tokens: 200 },
}));
const rt = vi.hoisted(() => ({ pick: {} as Record<string, string | undefined>, asked: [] as { purpose: string; ctx: unknown }[] }));

vi.mock("@anthropic-ai/sdk", () => {
  const items = JSON.stringify([{ channel: "instagram", title: "قهوة اليوم", body: "نص تجريبي للعنصر يكفي للمراجعة" }]);
  const verdict = { completeness: 90, brand: 90, honesty: 90, language: 90, format: 90, autofail: null, notes: "ready" };
  const sysText = (s: unknown): string => (typeof s === "string" ? s : Array.isArray(s) ? String((s[0] as { text?: string } | undefined)?.text ?? "") : "");
  const answer = (model: string, text: string) => ({ model, stop_reason: "end_turn", usage: sdk.usage, content: [{ type: "text", text }] });
  return {
    default: class {
      static BadRequestError = class extends Error {};
      beta = {
        messages: {
          stream: (p: { model: string; system: unknown }) => ({
            finalMessage: async () => {
              sdk.calls.push({ api: "generate", model: p.model, system: sysText(p.system) });
              if (sdk.fail) throw new Error("model down");
              return answer(p.model, items);
            },
          }),
        },
      };
      messages = {
        stream: (p: { model: string; system: unknown }) => ({
          finalMessage: async () => {
            sdk.calls.push({ api: "stream", model: p.model, system: sysText(p.system) });
            if (sdk.fail) throw new Error("overloaded");
            return answer(p.model, "أهلاً");
          },
        }),
        create: async (p: { model: string; system: unknown }) => {
          const system = sysText(p.system);
          sdk.calls.push({ api: "create", model: p.model, system });
          // The judge reads an array of five scores; the reviewer an array of `ok`; the cross-review an array of ids; anything
          // else (a tool, an image prompt, onboarding) reads free text, and onboarding's parse failure is caught by its caller.
          if (system.startsWith("You are the quality judge")) return answer(p.model, JSON.stringify([verdict, verdict, verdict, verdict, verdict]));
          return answer(p.model, JSON.stringify([{ ok: true, id: 1, verdict: "ok" }]));
        },
      };
    },
  };
});
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));
vi.mock("@/lib/models/route", async (orig) => {
  const m = await orig<typeof import("@/lib/models/route")>();
  return {
    ...m,
    route: (purpose: Parameters<typeof m.route>[0], ctx?: Parameters<typeof m.route>[1]) => {
      rt.asked.push({ purpose, ctx });
      const model = rt.pick[purpose];
      return model ? { model, overridden: true } : m.route(purpose, ctx);
    },
  };
});

import { db } from "@/lib/db";
import { currentUser, getUser, saveUser, type User } from "@/lib/auth";
import type { Brand, Task } from "@/lib/brand";
import { agentSpendFor } from "@/lib/credits";
import { chatMsgKey } from "@/lib/usage";
import { createMcpToken } from "@/lib/mcp";
import { TASK_COST } from "@/lib/tasks";
import { TOOLS } from "@/lib/tools";
import { DEFAULTS } from "@/lib/models/route";
import { chatUnitsFor, creditsFor } from "@/lib/models/credits";
import { CHAT_MODEL } from "@/lib/chat";
import { crossReviewPrompt, generate, reviewerPrompt } from "@/lib/noor";
import { generateBatch } from "@/lib/generate-batch";
import { buildFromSite } from "@/lib/onboard";
import { imagePrompt } from "@/lib/media/prompts";
import { json, newUser, params, settle, signIn } from "./helpers/session";
import * as chatRoute from "@/app/api/chat/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as toolRoute from "@/app/api/tools/[tool]/route";

const OPUS = "claude-opus-5";
const SONNET = "claude-sonnet-5";
const SONNET55 = "claude-sonnet-5-5";

const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "رخيص", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };

const calls = (api?: Call["api"]) => sdk.calls.filter((c) => !api || c.api === api);
const judged = () => sdk.calls.filter((c) => c.api === "create" && c.system.startsWith("You are the quality judge"));
const askedFor = (purpose: string) => rt.asked.filter((a) => a.purpose === purpose);

/** A signed-in owner on a paid plan with a brand file and credits to spare. */
async function owner(prefix: string, used = 0): Promise<User> {
  const u = await newUser(prefix);
  await saveUser({ ...u, plan: "starter", credits: 500 });
  await db.set(`brand:${u.email}`, brand);
  if (used) await db.set(chatMsgKey(u.email), used);
  await signIn(u.email);
  return (await currentUser())!;
}
const count = async (u: Pick<User, "email">) => Number((await db.get<number>(chatMsgKey(u.email))) ?? 0);
const send = (body: Record<string, unknown> = {}) => chatRoute.POST(json("/api/chat", "POST", { text: "مرحبا", ...body }));
const ask = async (token: string, message: string) =>
  (await (await mcpRoute.POST(new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_noor", arguments: { message } } }) }))).json()) as { result: { content: { text: string }[]; isError?: boolean } };

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  sdk.calls = [];
  sdk.fail = false;
  rt.pick = {};
  rt.asked = [];
});
afterEach(async () => {
  await settle();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("chat: the model the turn runs on is the model its messages were counted for", () => {
  it("by default the turn runs on Sonnet 5.5 and counts one message, and route() was asked for chat once", async () => {
    const u = await owner("mrc-def");
    const r = await send();
    expect(r.status).toBe(200);
    expect(calls("stream").map((c) => c.model)).toEqual([SONNET55]);
    expect(await count(u)).toBe(1);
    expect(askedFor("chat")).toHaveLength(1);
    expect(CHAT_MODEL).toBe(DEFAULTS.chat);
  });

  it("a turn routed to Opus 5 sends Opus 5 to the model AND counts Opus 5's messages (2), from one decision", async () => {
    rt.pick.chat = OPUS;
    const u = await owner("mrc-opus");
    const r = await send();
    expect(r.status).toBe(200);
    expect(calls("stream").map((c) => c.model)).toEqual([OPUS]);
    expect(chatUnitsFor(OPUS)).toBe(2);
    expect(await count(u)).toBe(chatUnitsFor(OPUS));
    expect((await r.json()).chat).toMatchObject({ used: 2 });
    expect(askedFor("chat")).toHaveLength(1);
  });

  it("the streamed reply runs on the same model it counted", async () => {
    rt.pick.chat = OPUS;
    const u = await owner("mrc-stream");
    const r = await send({ stream: true });
    expect(r.headers.get("content-type")).toMatch(/text\/event-stream/);
    const body = await r.text();
    expect(body).toContain('"type":"message"');
    expect(calls("stream").map((c) => c.model)).toEqual([OPUS]);
    expect(await count(u)).toBe(chatUnitsFor(OPUS));
    expect(askedFor("chat")).toHaveLength(1);
  });

  it("over MCP (ask_noor) too: the model sent and the messages counted are Opus 5's", async () => {
    rt.pick.chat = OPUS;
    const u = await owner("mrc-mcp");
    const out = await ask(await createMcpToken(u.email), "مرحبا");
    expect(out.result.isError).toBeFalsy();
    expect(calls("stream").map((c) => c.model)).toEqual([OPUS]);
    expect(await count(u)).toBe(chatUnitsFor(OPUS));
    expect(askedFor("chat")).toHaveLength(1);
  });

  it("a turn that fails gives back the messages it reserved for the routed model, not one", async () => {
    rt.pick.chat = OPUS;
    sdk.fail = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const u = await owner("mrc-fail", 10);
    expect((await send()).status).toBe(502);
    expect(await count(u)).toBe(10);
  });

  it("an allowance with one message left refuses an Opus 5 turn (2 messages) before the model is called, and a Sonnet 5.5 turn (1) is answered", async () => {
    rt.pick.chat = OPUS;
    const u = await owner("mrc-edge", 249);
    const refused = await send();
    expect(refused.status).toBe(402);
    expect(calls("stream")).toHaveLength(0);
    expect(await count(u)).toBe(249);
    rt.pick.chat = undefined;
    expect((await send()).status).toBe(200);
    expect(calls("stream").map((c) => c.model)).toEqual([SONNET55]);
    expect(await count(u)).toBe(250);
  });

  it("the routes reserve with the routed model and hand the gate's model to chat(): no other source for either", () => {
    // Web chat routes the conversation's pick (`chatRouteFor`, plan Task 6); MCP ask_noor has no conversation record.
    const reserve: Record<string, RegExp> = {
      "src/app/api/chat/route.ts": /const routed = chatRouteFor\(u, record\);\s*const gate = await reserveChatTurn\(u, routed\.model\)/,
      "src/app/api/mcp/route.ts": /reserveChatTurn\(\w+, route\("chat"\)\.model\)/,
    };
    for (const [f, re] of Object.entries(reserve)) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toMatch(re);
      const turns = src.split("\n").filter((l) => /(await|=>) chat\(/.test(l));
      expect(turns.length, f).toBeGreaterThan(0);
      for (const l of turns) expect(l, f).toMatch(/\bmodel: gate\.model\b/);
    }
  });
});

describe("generation: the model the batch is charged for is the model generate() runs on", () => {
  const base = TASK_COST.social;

  async function run(o: { type?: "social" | "gtm_plan"; model?: string } = {}) {
    const u = await owner("mrg");
    const before = (await getUser(u.email))!.credits;
    const r = await generateBatch(u, u.email, { type: o.type ?? "social", source: "manual", via: "app", ...(o.model ? { model: o.model } : {}) });
    await settle();
    const after = (await getUser(u.email))!;
    return { r, u, spent: before - after.credits, agentSpend: agentSpendFor(after, u.email) };
  }

  it("by default the batch runs on Opus 5 and costs its base credits; route(\"generate\") was asked once", async () => {
    const { r, spent } = await run();
    expect(r.ok).toBe(true);
    expect(calls("generate").map((c) => c.model)).toEqual([OPUS]);
    expect(spent).toBe(creditsFor(base, OPUS, "generate"));
    expect(spent).toBe(base);
    expect(askedFor("generate")).toHaveLength(1);
  });

  it("a batch routed to Sonnet 5 runs on Sonnet 5 and is charged Sonnet 5's price, from one decision", async () => {
    rt.pick.generate = SONNET;
    const { r, spent } = await run();
    expect(r.ok).toBe(true);
    expect(calls("generate").map((c) => c.model)).toEqual([SONNET]);
    expect(spent).toBe(creditsFor(base, SONNET, "generate"));
    expect(spent).toBeLessThan(base);
    expect(r.ok && r.cost).toBe(spent);
    expect(askedFor("generate")).toHaveLength(1);
  });

  it("a caller that names the model (opts.model) is not routed again: that model is charged and called", async () => {
    const { r, spent } = await run({ model: SONNET55 });
    expect(r.ok).toBe(true);
    expect(calls("generate").map((c) => c.model)).toEqual([SONNET55]);
    expect(spent).toBe(creditsFor(base, SONNET55, "generate"));
    expect(askedFor("generate")).toHaveLength(0);
  });

  it("generate() called directly (the golden set) asks route() for generate once and runs on the default", async () => {
    await generate("social", brand, [], undefined, { reviewer: false, crossReview: false });
    expect(calls("generate").map((c) => c.model)).toEqual([DEFAULTS.generate]);
    expect(askedFor("generate")).toHaveLength(1);
  });

  it("the reviewer asks for review, the cross-reviewers for xreview (once for both), the judge for judge with the generating model", async () => {
    const { r } = await run({ type: "gtm_plan" });
    expect(r.ok).toBe(true);
    const create = calls("create");
    const review = create.filter((c) => c.system === reviewerPrompt("gtm_plan"));
    const cross = create.filter((c) => c.system === crossReviewPrompt("razan") || c.system === crossReviewPrompt("majed"));
    expect(review.map((c) => c.model)).toEqual([DEFAULTS.review]);
    expect(cross).toHaveLength(2);
    expect(cross.map((c) => c.model)).toEqual([DEFAULTS.xreview, DEFAULTS.xreview]);
    expect(judged().map((c) => c.model)).toEqual([DEFAULTS.judge]);
    expect(askedFor("review")).toHaveLength(1);
    expect(askedFor("xreview")).toHaveLength(1);
    expect(askedFor("judge")).toHaveLength(1);
    expect(askedFor("judge")[0].ctx).toMatchObject({ generatedBy: OPUS });
  });

  it("the reviewer, cross-review and judge send whatever route() returns for their purpose", async () => {
    rt.pick.review = "routed-review";
    rt.pick.xreview = "routed-xreview";
    rt.pick.judge = "routed-judge";
    await run({ type: "gtm_plan" });
    const create = calls("create");
    expect(create.filter((c) => c.system === reviewerPrompt("gtm_plan")).map((c) => c.model)).toEqual(["routed-review"]);
    expect(create.filter((c) => c.system === crossReviewPrompt("razan")).map((c) => c.model)).toEqual(["routed-xreview"]);
    expect(create.filter((c) => c.system === crossReviewPrompt("majed")).map((c) => c.model)).toEqual(["routed-xreview"]);
    expect(judged().map((c) => c.model)).toEqual(["routed-judge"]);
  });

  it("the judge is told which model generated the batch: a batch Sonnet 5 wrote is judged by Sonnet 5.5, never by Sonnet 5", async () => {
    rt.pick.generate = SONNET;
    await run();
    expect(calls("generate").map((c) => c.model)).toEqual([SONNET]);
    expect(askedFor("judge")[0].ctx).toMatchObject({ generatedBy: SONNET });
    expect(judged().map((c) => c.model)).toEqual([SONNET55]);
  });

  it("a batch Opus 5 wrote is judged by Sonnet 5, as today", async () => {
    await run();
    expect(judged().map((c) => c.model)).toEqual([SONNET]);
  });
});

describe("the other call sites ask route() for their purpose and send what it returns", () => {
  const TOOL = TOOLS[0].slug;
  const toolCall = () => toolRoute.POST(json(`/api/tools/${TOOL}`, "POST", { lang: "ar" }), params({ tool: TOOL }));
  const task = { id: "t1", type: "social", channel: "instagram", title: "t", body: "نص تجريبي", status: "pending" } as unknown as Task;
  const site = { url: "https://example.test", ok: true, platform: "unknown", title: "t", description: "d", links: [], text: "x" } as unknown as Parameters<typeof buildFromSite>[0];

  it("today's models, call site by call site: tool Sonnet 5, image prompt Sonnet 5, onboarding Opus 5", async () => {
    expect((await toolCall()).status).toBe(200);
    expect(calls("create").map((c) => c.model)).toEqual([SONNET]);
    sdk.calls = [];
    await imagePrompt(brand, task, "img-fast", "square", "mrc@test.example", 20_000);
    expect(calls("create").map((c) => c.model)).toEqual([SONNET]);
    sdk.calls = [];
    await buildFromSite(site, "ar", undefined, undefined, undefined, Date.now() + 285_000).catch(() => null);
    expect(calls("stream").length).toBeGreaterThan(0);
    expect(new Set(calls("stream").map((c) => c.model))).toEqual(new Set([OPUS]));
  });

  it("the free tools ask for the tool purpose", async () => {
    rt.pick.tool = "routed-tool";
    expect((await toolCall()).status).toBe(200);
    expect(calls("create").map((c) => c.model)).toEqual(["routed-tool"]);
    expect(askedFor("tool")).toHaveLength(1);
  });

  it("the image prompt asks for imagePrompt", async () => {
    rt.pick.imagePrompt = "routed-image";
    await imagePrompt(brand, task, "img-fast", "square", "mrc@test.example", 20_000);
    expect(calls("create").map((c) => c.model)).toEqual(["routed-image"]);
    expect(askedFor("imagePrompt")).toHaveLength(1);
  });

  it("onboarding asks for onboard once, and every one of its parts runs on what it got", async () => {
    rt.pick.onboard = "routed-onboard";
    await buildFromSite(site, "ar", undefined, undefined, undefined, Date.now() + 285_000).catch(() => null);
    expect(calls("stream").length).toBeGreaterThan(0);
    expect(new Set(calls("stream").map((c) => c.model))).toEqual(new Set(["routed-onboard"]));
    expect(askedFor("onboard")).toHaveLength(1);
  });
});

describe("no call site names a model", () => {
  /**
   * The only files under src that may hold a Claude model id as a string, each for one reason. A file that is not here
   * and holds one fails; so does a file that is here and no longer holds one, so the list never outlives its reason.
   */
  const ALLOWED: Record<string, string> = {
    "src/lib/models/route.ts": "DEFAULTS: the model each purpose runs on when nobody picked",
    "src/lib/models/catalog.ts": "MODELS: the catalog entries themselves (id, label, tier, rates)",
    "src/lib/models/tiers.ts": "PRICED_AT: the models the credit multipliers are relative to (import-free, so the browser may read it)",
    "src/lib/usage.ts": "RATES: the rate table from before the catalog, the fallback for an id the catalog lacks until a contract release removes it (rule 679)",
  };
  const LITERAL = /["'`]claude-[a-z0-9.-]+["'`]/;
  /** The code without its comments: a comment may name a model, a string may not. */
  const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("no file under src holds a Claude model id outside the four that define the defaults, the catalog, the priced-at models and the old rates", () => {
    const files = (readdirSync("src", { recursive: true }) as string[]).map((f) => join("src", f).split(sep).join("/")).filter((f) => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(f));
    expect(files.length).toBeGreaterThan(200);
    expect(files.filter((f) => LITERAL.test(code(f))).sort()).toEqual(Object.keys(ALLOWED).sort());
    for (const [f, why] of Object.entries(ALLOWED)) expect(why.trim().length, f).toBeGreaterThan(20);
  });

  it("the scan sees a literal in code and ignores one in a comment", () => {
    expect(LITERAL.test('const m = "claude-opus-5";')).toBe(true);
    expect(LITERAL.test("const m = `claude-sonnet-5-5`;")).toBe(true);
    expect(LITERAL.test('if (model.startsWith("claude-")) retry();')).toBe(false);
    expect(readFileSync("src/lib/model.ts", "utf8")).toMatch(/startsWith\("claude-"\)/);
  });
});
