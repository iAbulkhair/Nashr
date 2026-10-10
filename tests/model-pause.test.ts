import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, newUser, params, signIn, signOut } from "./helpers/session";

/**
 * Rule 76: while Claude is paused (src/lib/model.ts) no surface calls the model, none charges or keeps a credit, and
 * none falls back to the [DEV MOCK] placeholders a customer must never see. The state is forced to "paused" here, so
 * the rule stays pinned whether or not the switch is on today.
 */
const sdk = vi.hoisted(() => ({ made: 0, crawled: 0, charged: 0 }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { constructor() { sdk.made++; } } }));
vi.mock("@/lib/crawl", () => ({ crawl: async () => { sdk.crawled++; throw new Error("no network in tests"); } }));
// Counts charges, so "refuses before charging" is told apart from "charges, then refunds".
vi.mock("@/lib/credits", async (orig) => { const m = await orig<typeof import("@/lib/credits")>(); return { ...m, charge: (...a: Parameters<typeof m.charge>) => { sdk.charged++; return m.charge(...a); } }; });
vi.mock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "paused" as const }));

import { db } from "@/lib/db";
import { getUser } from "@/lib/auth";
import { getBrand, listTasks, type Brand, type Task } from "@/lib/brand";
import { createMcpToken } from "@/lib/mcp";
import { chat, history, runTool } from "@/lib/chat";
import { generate } from "@/lib/noor";
import { buildFromSite } from "@/lib/onboard";
import { scoreItems } from "@/lib/judge";
import { imagePrompt, videoPrompt } from "@/lib/media/prompts";
import { runGolden } from "@/lib/golden";
import { runWeekly, saveSchedule } from "@/lib/schedule";
import { ROUTINE_IDS, runRoutine } from "@/lib/routines";
import { ModelPaused, PAUSED_REPLY } from "@/lib/model";
import * as generateRoute from "@/app/api/generate/route";
import * as onboardRoute from "@/app/api/onboard/route";
import * as confirmRoute from "@/app/api/onboard/confirm/route";
import * as toolRoute from "@/app/api/tools/[tool]/route";
import * as mcpRoute from "@/app/api/mcp/route";
import { TOOLS } from "@/lib/tools";

const brand: Brand = { name: "محمصة", website: "", industry: "قهوة", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-28T00:00:00.000Z" };
const withBrand = async () => { const u = await newUser("paused"); await db.set(`brand:${u.email}`, brand); return u; };
const credits = async (email: string) => (await getUser(email))!.credits;

beforeEach(() => { vi.stubEnv("ANTHROPIC_API_KEY", "test"); sdk.made = 0; sdk.crawled = 0; sdk.charged = 0; });
afterEach(() => { vi.unstubAllEnvs(); expect(sdk.made, "the SDK must never be constructed while paused").toBe(0); });

describe("the switch itself", () => {
  it("leaves the no-key development path alone and pauses only a configured deployment", async () => {
    const real = await vi.importActual<typeof import("@/lib/model")>("@/lib/model");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(real.modelState(), "dev and CI have no key and keep their mock path").toBe("mock");
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    expect(real.modelState()).toBe(real.CLAUDE_PAUSED ? "paused" : "on");
  });

  it("pauses the same way whichever provider the key is for (provider switch)", async () => {
    const real = await vi.importActual<typeof import("@/lib/model")>("@/lib/model");
    vi.stubEnv("LLM_PROVIDER", "straitly");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("STRAITLY_API_KEY", "");
    expect(real.modelState(), "straitly without any key keeps the dev mock path").toBe("mock");
    vi.stubEnv("STRAITLY_API_KEY", "test");
    expect(real.modelState()).toBe(real.CLAUDE_PAUSED ? "paused" : "on");
    vi.stubEnv("STRAITLY_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    expect(real.modelState(), "the Anthropic key alone is the fallback").toBe(real.CLAUDE_PAUSED ? "paused" : "on");
  });
});

describe("while Claude is paused (rule 76)", () => {
  it("/api/generate refuses before charging and creates nothing", async () => {
    const u = await withBrand();
    await signIn(u.email);
    const res = await generateRoute.POST(json("/api/generate", "POST", { type: "social" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("model_paused");
    expect(sdk.charged).toBe(0);
    expect(await credits(u.email)).toBe(50);
    expect(await listTasks(u.email)).toEqual([]);
  });

  it("generate() throws instead of returning mock items, and a caller that charged first refunds", async () => {
    await expect(generate("social", brand, [])).rejects.toBeInstanceOf(ModelPaused);
    const u = await withBrand();
    await expect(runTool(u, "generate_content", { type: "social" }, [])).rejects.toThrow("model_paused");
    expect([sdk.charged, await credits(u.email)], "charged once, refunded in full").toEqual([1, 50]);
    expect(await listTasks(u.email)).toEqual([]);
  });

  it("the chat answers in the owner's language, without [DEV MOCK], and runs no tool", async () => {
    const u = await withBrand();
    for (const lang of ["ar", "en"] as const) {
      const m = await chat(u, "جهزي 3 منشورات", undefined, "noor", { lang });
      expect(m.content).toBe(PAUSED_REPLY[lang]);
      expect(m.content).not.toMatch(/DEV MOCK/);
    }
    expect((await history(u.email)).at(-1)!.content).toBe(PAUSED_REPLY.en);
    expect(sdk.charged).toBe(0);
  });

  it("MCP generate_content refuses before charging", async () => {
    const u = await withBrand();
    const token = await createMcpToken(u.email);
    const req = new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "generate_content", arguments: { type: "social" } } }) });
    const out = (await (await mcpRoute.POST(req)).json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0].text).toMatch(/paused/);
    expect(sdk.charged).toBe(0);
    expect(await credits(u.email)).toBe(50);
  });

  it("onboarding refuses before crawling, so no mock brand file is saved to end it for good", async () => {
    const u = await newUser("paused");
    await signIn(u.email);
    await confirmRoute.POST(json("/api/onboard/confirm", "POST", { url: "roastery.example" }));
    const res = await onboardRoute.POST(json("/api/onboard", "POST", { url: "roastery.example" }));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("paused");
    expect(sdk.crawled).toBe(0);
    expect(await getBrand(u.email)).toBeNull();
    expect(await db.get(`onboardlock:${u.email}`), "no lock left behind").toBeNull();
    const site = { url: "https://roastery.example", ok: true, title: "Roastery", description: "", text: "", links: [], platform: "unknown" };
    await expect(buildFromSite(site as never, "ar"), "the builder itself never hands back the mock brand").rejects.toBeInstanceOf(ModelPaused);
  });

  it("the free tools refuse before the rate limit, so a visitor's daily allowance is untouched", async () => {
    signOut();
    const slug = TOOLS[0].slug;
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await toolRoute.POST(json(`/api/tools/${slug}`, "POST", {}, { "x-forwarded-for": "203.0.113.76" }), params({ tool: slug }))).status);
    expect(codes, "never 429: a refusal is not a use").toEqual(Array(7).fill(503));
  });

  it("the weekly plan leaves the week open for a catch-up, charges nothing, and the judge, image and video prompts and golden set stand down", async () => {
    const u = await withBrand();
    expect(await runWeekly(u)).toBe("retry:paused");
    expect(sdk.charged).toBe(0);
    // The routines the owner turned on leave their day open the same way.
    await saveSchedule(u.email, { routines: Object.fromEntries(ROUTINE_IDS.map((id) => [id, true])) });
    for (const id of ROUTINE_IDS) expect(await runRoutine(u, id), id).toBe("retry:paused");
    expect(sdk.charged).toBe(0);
    expect(await scoreItems(u.email, brand, "social", [{ channel: "instagram", title: "t", body: "b" }])).toEqual([]);
    const task: Task = { id: "img1", type: "social", channel: "instagram", title: "t", body: "b", status: "approved", createdAt: "2026-09-28T00:00:00.000Z", lang: "ar" };
    expect(await imagePrompt(brand, task, "img-fast", "square"), "the fixed prompt, not a model call").toMatch(/^Premium قهوة product photo/);
    expect(await videoPrompt(brand, task, "vid-quick", false), "the fixed video prompt, not a model call").toMatch(/second vertical social video/);
    expect(await runGolden("manual")).toBeNull();
  });
});
