import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaDeps } from "@/lib/media/types";

/**
 * Renders go through the media engine; the registry is its one seam, so an image test gets scripted providers and no
 * test reaches a provider or the Blob store. Without `g.deps` the real registry answers, as in production.
 */
const g = vi.hoisted(() => ({ deps: null as MediaDeps | null }));
vi.mock("@/lib/media/registry", async (orig) => {
  const real = await orig<typeof import("@/lib/media/registry")>();
  return { mediaDeps: () => g.deps ?? real.mediaDeps() };
});

import { json, newUser, params, settle, signIn } from "./helpers/session";
import { fakeAdapter, fakeDeps, mediaEnv, resetMediaCounters } from "./helpers/media";
import { ProviderError } from "@/lib/media/types";
import { claudeOn } from "./helpers/model";
import { getUser, saveUser, type User } from "@/lib/auth";
import { agentSpendFor, monthKey, refund } from "@/lib/credits";
import { db } from "@/lib/db";
import { AGENT_CAP_MAX, getGov, saveGov, type GovPatch } from "@/lib/governance";
import { listNotifs, warnAgentCap } from "@/lib/notifications";
import { KINDS, getUsage, meter, usageMonthKeys } from "@/lib/usage";
import { listTasks, saveTask, type Brand, type Task } from "@/lib/brand";
import { addBrand, scopeFor } from "@/lib/brands";
import { createMcpToken } from "@/lib/mcp";
import { wipeAccount } from "@/lib/account";
import { AGENT_IDS, type AgentId } from "@/lib/agents";
import { runTool } from "@/lib/chat";
import { runWeekly } from "@/lib/schedule";
import { TASK_COST, type TaskType } from "@/lib/tasks";
import type { SiteSnapshot } from "@/lib/crawl";
import * as generateRoute from "@/app/api/generate/route";
import * as imageRoute from "@/app/api/tasks/[id]/image/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as govRoute from "@/app/api/governance/route";

/**
 * Rules 106-110: what each agent spends is counted per brand scope and month, the owner's monthly cap per agent is
 * enforced in code on every charging path before anything is charged or any model is called, the owner is warned once at
 * 80%, governance validates what it stores, and model usage is metered per agent. The ledger itself is in
 * credits.test.ts.
 */
const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
const task = (id: string, type: TaskType): Task => ({ id, type, channel: type === "social" ? "instagram" : "doc", title: `title ${id}`, body: "نص العنصر", status: "pending", createdAt: new Date().toISOString(), lang: "ar" });
/** A signed-in owner with a brand file, on `lang`. */
async function owner(prefix: string, lang: "ar" | "en" = "ar"): Promise<User> {
  const u = await newUser(prefix);
  if (lang !== "ar") await saveUser({ ...u, lang });
  await db.set(`brand:${u.email}`, brand);
  await signIn(u.email);
  return (await getUser(u.email))!;
}
const spend = async (email: string, scope = email) => agentSpendFor((await getUser(email))!, scope);
const credits = async (email: string) => (await getUser(email))!.credits;
const mcpCall = (token: string, name: string, args: Record<string, unknown>) =>
  mcpRoute.POST(new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));

type Params = { system: string | { text: string }[]; messages: { role: string; content: unknown }[]; output_config?: { format?: unknown } };
const reply = (text: string) => ({ model: "claude-sonnet-5", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 100 }, content: [{ type: "text", text }] });
const toolUse = (name: string, input: Record<string, unknown>) => ({ model: "claude-opus-5", stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: "tool_use", id: "tu1", name, input }] });
const verdict = { completeness: 90, brand: 90, honesty: 90, language: 90, format: 90, autofail: null, notes: "ready" };

/**
 * The SDK, replaced, with Claude switched on: `made` counts clients, so "before any model call" is a number. Generation
 * returns one item (or fails), the reviewer passes, the judge scores, an image prompt is a sentence, onboarding parts are
 * empty objects, and a chat call answers with `chat(params)` when given.
 */
function sdk(opts: { genFails?: boolean; chat?: (p: Params) => unknown } = {}) {
  vi.resetModules();
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  claudeOn();
  const made = { n: 0 };
  vi.doMock("@anthropic-ai/sdk", () => ({
    default: class {
      static BadRequestError = class extends Error {};
      constructor() { made.n++; }
      beta = { messages: { stream: () => ({ finalMessage: async () => { if (opts.genFails) throw new Error("model down"); return reply(JSON.stringify([{ channel: "doc", title: "t", body: "نص تجريبي للعنصر يكفي للمراجعة" }])); } }) } };
      messages = {
        stream: (p: Params) => ({ finalMessage: async () => (p.output_config?.format ? reply("{}") : opts.chat ? opts.chat(p) : reply("تمام")) }),
        create: async (p: Params) => {
          const sys = typeof p.system === "string" ? p.system : p.system[0].text;
          return reply(sys.startsWith("You are the quality judge") ? JSON.stringify([verdict]) : sys.startsWith("You write one image") ? "a cup of coffee on a wooden table" : JSON.stringify([{ ok: true }]));
        },
      };
    },
  }));
  return made;
}

afterEach(() => { vi.doUnmock("@anthropic-ai/sdk"); vi.doUnmock("@/lib/model"); vi.unstubAllEnvs(); vi.restoreAllMocks(); g.deps = null; });

describe("every charging path enforces the agent's cap before charging (rules 107-108)", () => {
  it("/api/generate answers 402 agent_cap before any model call and without debiting; under the cap it charges the owning agent", async () => {
    const made = sdk();
    const u = await owner("cap-gen");
    await saveGov(u.email, { agentCaps: { razan: 3 } });
    const route = await import("@/app/api/generate/route");

    const res = await route.POST(json("/api/generate", "POST", { type: "pricing_review" }));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ ok: false, error: "agent_cap", agent: "razan", spent: 0, cap: 3 });
    expect(made.n, "a capped request reached the model").toBe(0);
    expect(await credits(u.email)).toBe(50);
    expect(await spend(u.email)).toEqual({});
    expect(await listTasks(u.email)).toEqual([]);

    // Noor has no cap; Razan's cap does not touch her.
    expect((await route.POST(json("/api/generate", "POST", { type: "whatsapp" }))).status).toBe(200);
    expect(made.n).toBeGreaterThan(0);
    await saveGov(u.email, { agentCaps: { razan: 10 } });
    expect((await route.POST(json("/api/generate", "POST", { type: "pricing_review" }))).status).toBe(200);
    expect(await spend(u.email)).toEqual({ noor: 3, razan: 4 });
    expect(await credits(u.email)).toBe(50 - 3 - 4);
    await settle();
  });

  it("a failed generation gives back the credits and lowers the counter it raised", async () => {
    sdk({ genFails: true });
    const u = await owner("cap-genfail");
    await saveGov(u.email, { agentCaps: { razan: 10 } });
    const route = await import("@/app/api/generate/route");
    expect((await route.POST(json("/api/generate", "POST", { type: "pricing_review" }))).status).toBe(502);
    expect(await credits(u.email)).toBe(50);
    expect(await spend(u.email)).toEqual({ razan: 0 });
  });

  it("the image route charges the owner of the item it illustrates, stops at that agent's cap, a failed render refunds both, and a placeholder charges neither", async () => {
    resetMediaCounters();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mediaEnv({ fal: true });
    const fal = fakeAdapter("fal");
    g.deps = fakeDeps({ fal });
    const u = await owner("cap-img");
    // Every item type that takes an image is Noor's (src/lib/tasks.ts IMAGE_TYPES, src/lib/agents.ts).
    await Promise.all(["post", "post2", "post3", "post4"].map((id) => saveTask(u.email, task(id, "social"), true)));
    await saveGov(u.email, { agentCaps: { noor: 0, razan: 5 } });
    const post = (id: string) => imageRoute.POST(json(`/api/tasks/${id}/image`, "POST"), params({ id }));

    const stopped = await post("post");
    expect(stopped.status).toBe(402);
    expect(await stopped.json()).toEqual({ ok: false, error: "agent_cap", agent: "noor", spent: 0, cap: 0 });
    expect(await credits(u.email)).toBe(50);
    expect(fal.submits, "a capped render reached the provider").toHaveLength(0);

    // Under the cap: charged to Noor, the item's owner, in this brand scope.
    await saveGov(u.email, { agentCaps: { noor: 5, razan: 5 } });
    const ok = await post("post2");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, provider: "fal", credits: 49 });
    expect(await spend(u.email)).toEqual({ noor: 1 });

    // A render that fails is refunded by the engine: the balance and Noor's counter both come back.
    g.deps = fakeDeps({ fal: fakeAdapter("fal", { submit: () => { throw new ProviderError("unavailable", 503); } }) });
    const failed = await post("post3");
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ ok: false, error: "media_failed", credits: 49 });
    expect(await spend(u.email)).toEqual({ noor: 1 });

    // No image service: the placeholder card costs nothing, so neither the balance nor the cap stands in its way.
    mediaEnv({});
    await saveGov(u.email, { agentCaps: { noor: 0 } });
    const card = await post("post4");
    expect(card.status).toBe(200);
    expect(await card.json()).toMatchObject({ ok: true, provider: "placeholder", credits: 49 });
    expect(await credits(u.email)).toBe(49);
    expect(await spend(u.email)).toEqual({ noor: 1 });
  });

  it("MCP generate_content returns a tool error at the cap and charges nothing", async () => {
    const u = await owner("cap-mcp");
    await saveGov(u.email, { agentCaps: { razan: 0 } });
    const token = await createMcpToken(u.email);
    const res = await mcpCall(token, "generate_content", { type: "cash_forecast" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0].text).toMatch(/Razan reached the monthly credit cap .* \(0 of 0 credits this month\)\. No credits were used/);
    expect(await credits(u.email)).toBe(50);
    expect(await listTasks(u.email)).toEqual([]);
  });

  it("chat generate_content, draft_items and generate_image return a sentence to relay and push limit:agent_cap", async () => {
    resetMediaCounters();
    // An image service is configured, so generate_image reaches the charge (without one it is a free placeholder).
    mediaEnv({ fal: true });
    const fal = fakeAdapter("fal");
    g.deps = fakeDeps({ fal });
    const u = await owner("cap-chat-tools");
    await saveTask(u.email, task("post", "social"), true);
    await saveGov(u.email, { agentCaps: { razan: 0, noor: 0 } });
    for (const [tool, input] of [["generate_content", { type: "pricing_review" }], ["draft_items", { type: "social", count: 1, brief: "منشور" }], ["generate_image", { task_id: "post" }]] as const) {
      const actions: string[] = [];
      const out = await runTool((await getUser(u.email))!, tool, input, actions);
      expect(out, tool).toMatch(/^Not done: (Razan|Noor) reached the monthly credit cap the owner set for this agent in Governance \(0 of 0 credits this month\), so nothing was created and no credits were used\./);
      expect(actions, tool).toEqual(["limit:agent_cap"]);
    }
    expect(await credits(u.email)).toBe(50);
    expect(await listTasks(u.email)).toHaveLength(1);
    expect(fal.submits, "a capped image reached the provider").toHaveLength(0);
  });

  it("the chat reply carries limit agent_cap, and the model is told in a sentence", async () => {
    const seen: Params[] = [];
    sdk({ chat: (p) => { seen.push(p); return seen.length === 1 ? toolUse("generate_content", { type: "pricing_review" }) : reply("وصلت رزان إلى حدها الشهري."); } });
    const u = await owner("cap-chat");
    await saveGov(u.email, { agentCaps: { razan: 2 } });
    const route = await import("@/app/api/chat/route");
    const res = await route.POST(json("/api/chat", "POST", { text: "راجعي أسعارنا", agent: "razan" }));
    const j = (await res.json()) as { ok: boolean; limit: string | null; message: { actions: string[] } };
    expect(j).toMatchObject({ ok: true, limit: "agent_cap" });
    expect(j.message.actions, "limit actions are not stored with the message").toEqual([]);
    expect(JSON.stringify(seen[1].messages), "the tool result the model relays").toContain("reached the monthly credit cap");
    expect(await credits(u.email)).toBe(50);
  });

  it("the weekly plan is Noor's: at her cap it returns agent_cap and charges nothing", async () => {
    const u = await owner("cap-weekly");
    await saveGov(u.email, { agentCaps: { noor: 0 } });
    expect(await runWeekly((await getUser(u.email))!)).toBe("agent_cap");
    expect(await credits(u.email)).toBe(50);
    await saveGov(u.email, { agentCaps: { noor: 5 } });
    expect(await runWeekly((await getUser(u.email))!)).toMatch(/^ok:/);
    expect(await spend(u.email)).toEqual({ noor: TASK_COST.weekly_plan });
    await settle();
  });

  it("caps and counters belong to the active brand: another brand's cap never applies", async () => {
    const u = await owner("cap-brands");
    await saveUser({ ...u, plan: "agency" });
    await saveGov(u.email, { agentCaps: { razan: 0 } }); // the default brand's cap
    const second = await addBrand((await getUser(u.email))!, "Second");
    if ("error" in second) throw new Error(second.error);
    const scope = scopeFor(u.email, second.id);
    await db.set(`brand:${scope}`, brand);
    expect((await generateRoute.POST(json("/api/generate", "POST", { type: "pricing_review" }))).status).toBe(200);
    expect(await spend(u.email, scope)).toEqual({ razan: 4 });
    expect(await spend(u.email)).toEqual({});
    await saveGov(scope, { agentCaps: { razan: 4 } });
    const res = await generateRoute.POST(json("/api/generate", "POST", { type: "pricing_review" }));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ ok: false, error: "agent_cap", agent: "razan", spent: 4, cap: 4 });
    await settle();
  });
});

describe("the 80% warning (rule 108)", () => {
  it("fires once per scope, agent and month, naming the agent, the brand and X of Y only", async () => {
    const u = await owner("cap-warn");
    await saveGov(u.email, { agentCaps: { razan: 5 } });
    expect((await generateRoute.POST(json("/api/generate", "POST", { type: "pricing_review" }))).status).toBe(200);
    const warned = (await listNotifs(u.email)).filter((x) => x.kind === "credits");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ agent: "razan", title: "رزان في «مقهى الفنجان»: 4 من 5 كريدت هذا الشهر", href: "/ar/app/governance" });
    expect(warned[0].body).toContain("«مقهى الفنجان»");
    expect(warned[0].body, "no number other than X of Y").not.toMatch(/\d/);

    // A refund dips below 80% and the next batch crosses it again: still one warning this month.
    await refund(u.email, 4, { scope: u.email, agent: "razan", month: monthKey() });
    expect((await generateRoute.POST(json("/api/generate", "POST", { type: "pricing_review" }))).status).toBe(200);
    expect((await listNotifs(u.email)).filter((x) => x.kind === "credits")).toHaveLength(1);
    await settle();
  });

  it("is in the owner's language, and silent without warn80 or a cap", async () => {
    const u = await owner("cap-warn-en", "en");
    const base = { ok: true as const, credits: 10, scope: u.email, agent: "dana" as AgentId, month: monthKey(), spent: 8 };
    await warnAgentCap(u, { ...base, cap: 10, warn80: false });
    await warnAgentCap(u, { ...base, warn80: true });
    expect(await listNotifs(u.email)).toEqual([]);
    await warnAgentCap(u, { ...base, cap: 10, warn80: true });
    await warnAgentCap(u, { ...base, cap: 10, warn80: true });
    const n = await listNotifs(u.email);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ kind: "credits", agent: "dana", title: "Dana in “مقهى الفنجان”: 8 of 10 credits this month", href: "/en/app/governance" });
  });

  it("names the brand the cap belongs to, not the one that is open: the bell is per account", async () => {
    const u = await owner("cap-warn-brand", "en");
    await saveUser({ ...u, plan: "agency" });
    const second = await addBrand((await getUser(u.email))!, "Oud House");
    if ("error" in second) throw new Error(second.error);
    const base = { ok: true as const, credits: 10, agent: "noor" as AgentId, month: monthKey(), spent: 16, cap: 20, warn80: true };
    // The default brand is open; the second brand's routine crosses 80% of its own cap from the cron.
    await warnAgentCap(u, { ...base, scope: scopeFor(u.email, second.id) });
    await warnAgentCap(u, { ...base, scope: u.email });
    const [open, other] = await listNotifs(u.email);
    expect(other.title).toBe("Noor in “Oud House”: 16 of 20 credits this month");
    expect(other.body).toContain("switch to that brand");
    expect(open.title, "the default brand is named by its brand file").toBe("Noor in “مقهى الفنجان”: 16 of 20 credits this month");
    // A brand with no name anywhere keeps the plain wording.
    const bare = await newUser("cap-warn-bare");
    await warnAgentCap(bare, { ...base, scope: bare.email });
    expect((await listNotifs(bare.email))[0].title).toBe("نور: 16 من 20 كريدت هذا الشهر");
  });

  it("wipeAccount deletes the warning's marker for every brand, so an account made again at the same address is warned", async () => {
    const u = await owner("cap-warn-wipe");
    await saveUser({ ...u, plan: "agency" });
    const second = await addBrand((await getUser(u.email))!, "Second");
    if ("error" in second) throw new Error(second.error);
    const month = monthKey();
    const scopes = [u.email, scopeFor(u.email, second.id)];
    await Promise.all(scopes.map((scope) => warnAgentCap(u, { ok: true, credits: 10, scope, agent: "razan", month, spent: 4, cap: 5, warn80: true })));
    for (const scope of scopes) expect(await db.get(`notifseen:${u.email}:agentcap80:${scope}:razan:${month}`), scope).toBe(1);
    await wipeAccount(u.email);
    for (const scope of scopes) expect(await db.get(`notifseen:${u.email}:agentcap80:${scope}:razan:${month}`), scope).toBeNull();
  });
});

describe("governance validates what it stores (rule 109)", () => {
  it("caps: agents only, finite, whole, clamped; null or empty removes; other fields keep their caps", async () => {
    const u = await newUser("gov-caps");
    const g = await saveGov(u.email, { agentCaps: { razan: 12.7, noor: -5, sami: NaN, faris: "7", dana: 1e9, hacker: 3, constructor: 1, layan: Infinity } } as unknown as GovPatch);
    expect(g.agentCaps).toEqual({ razan: 12, noor: 0, dana: AGENT_CAP_MAX });
    expect((await saveGov(u.email, { agentCaps: { razan: null, noor: "", majed: 3 } })).agentCaps).toEqual({ dana: AGENT_CAP_MAX, majed: 3 });
    expect((await saveGov(u.email, { learning: false })).agentCaps).toEqual({ dana: AGENT_CAP_MAX, majed: 3 });
    expect((await getGov(u.email)).agentCaps).toEqual({ dana: AGENT_CAP_MAX, majed: 3 });
  });

  it("auto-approve takes task types with boolean values only; NaN never replaces a number; a non-object body changes nothing", async () => {
    const u = await newUser("gov-fields");
    const g = await saveGov(u.email, { autoApprove: { social: true, ads: "yes", gbp: 1, constructor: true, hacker: true }, weeklyCap: NaN, notifyMinutes: Infinity } as unknown as GovPatch);
    expect(g.autoApprove).toEqual({ social: true });
    expect(g.weeklyCap).toBe(20);
    expect(g.notifyMinutes).toBe(60);
    expect((await saveGov(u.email, { weeklyCap: 500, notifyMinutes: -3 })).weeklyCap).toBe(200);
    for (const body of [null, [], "x", 7]) expect(await saveGov(u.email, body as unknown as GovPatch)).toEqual(await getGov(u.email));
  });

  it("the PUT route stores caps under the caller's active brand only, echoes them, and survives a null body", async () => {
    const u = await owner("gov-route");
    await saveUser({ ...u, plan: "agency" });
    const second = await addBrand((await getUser(u.email))!, "Second");
    if ("error" in second) throw new Error(second.error);
    const scope = scopeFor(u.email, second.id);
    const res = await govRoute.PUT(json("/api/governance", "PUT", { agentCaps: { razan: 40, ghost: 1 }, scope: u.email, email: "other@test.example" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { governance: { agentCaps: unknown } }).governance.agentCaps).toEqual({ razan: 40 });
    expect((await getGov(scope)).agentCaps).toEqual({ razan: 40 });
    expect((await getGov(u.email)).agentCaps).toEqual({});
    expect((await govRoute.PUT(json("/api/governance", "PUT", null))).status).toBe(200);
    expect((await getGov(scope)).agentCaps).toEqual({ razan: 40 });
  });
});

describe("model usage per agent (rule 110)", () => {
  it("meter writes calls and cost per agent next to the totals, and getUsage returns them", async () => {
    const u = await newUser("usage-agent");
    const m = monthKey();
    const all = Number((await db.get(`usage:_all:${m}:agent:faris:calls`)) ?? 0);
    await meter(u.email, "claude-opus-5", "generate", { input_tokens: 1000, output_tokens: 1000 }, "faris");
    await meter(u.email, "claude-sonnet-5", "judge", { input_tokens: 1000, output_tokens: 0 }, "faris");
    await meter(u.email, "claude-sonnet-5", "tool", { input_tokens: 10, output_tokens: 10 });
    await meter(u.email, "claude-sonnet-5", "tool", { input_tokens: 10, output_tokens: 10 }, "ghost" as AgentId);
    expect(await db.get(`usage:${u.email}:${m}:agent:faris:calls`)).toBe(2);
    expect(await db.get(`usage:${u.email}:${m}:agent:faris:usd_micro`)).toBe(30000 + 2000);
    expect(Number(await db.get(`usage:_all:${m}:agent:faris:calls`))).toBe(all + 2);
    expect(await db.get(`usage:${u.email}:${m}:agent:ghost:calls`)).toBeNull();
    const usage = await getUsage(u.email);
    expect(usage.calls).toBe(4);
    expect(usage.byAgent).toEqual({ faris: { calls: 2, usd: 0.032 } });
  });

  it("every model call is attributed: generation, review and judge to the type's owner, the cross-agent review to the reviewer, a chat turn to its agent, an image prompt to the item's owner, onboarding to Noor", async () => {
    sdk();
    const u = await owner("usage-pipeline");
    const route = await import("@/app/api/generate/route");
    expect((await route.POST(json("/api/generate", "POST", { type: "pricing_review" }))).status).toBe(200);
    await settle();
    const { chat } = await import("@/lib/chat");
    await chat((await getUser(u.email))!, "مرحبا", undefined, "sami");
    // The image prompt is written for the item's owner (src/lib/media/prompts.ts), the agent its render is charged to.
    const { imagePrompt } = await import("@/lib/media/prompts");
    await imagePrompt(brand, task("post", "social"), "img-fast", "square", u.email);
    const { buildFromSite } = await import("@/lib/onboard");
    await buildFromSite({ url: "https://cafe.example", ok: true, title: "Cafe", description: "", text: "", links: [], platform: "unknown" } as SiteSnapshot, "ar", undefined, u.email);

    const { getUsage: usageOf } = await import("@/lib/usage");
    const usage = await usageOf(u.email);
    const k = (kind: string) => usage.byKind[kind]?.calls ?? 0;
    expect(usage.byAgent.razan?.calls).toBe(k("generate") + k("review") + k("judge"));
    expect(k("generate") + k("review") + k("judge")).toBe(3);
    // Razan's pricing review is cross-reviewed by Majed: that call is his work, metered to him (rule 267).
    expect(usage.byAgent.majed?.calls).toBe(k("xreview"));
    expect(k("xreview")).toBe(1);
    expect(usage.byAgent.sami?.calls).toBe(k("chat"));
    expect(k("chat")).toBe(1);
    expect(usage.byAgent.noor?.calls).toBe(k("image_prompt") + k("onboard"));
    expect(k("onboard")).toBe(3);
    expect(Object.values(usage.byAgent).reduce((s, a) => s + a.calls, 0), "a call with no agent").toBe(usage.calls);
  });

  it("wipeAccount deletes every per-agent counter; the key list is built from KINDS and AGENT_IDS", async () => {
    const u = await newUser("usage-wipe");
    await Promise.all(AGENT_IDS.map((a) => meter(u.email, "claude-opus-5", "generate", { input_tokens: 5, output_tokens: 5 }, a)));
    expect(await db.get(`usage:${u.email}:${monthKey()}:agent:layan:usd_micro`)).not.toBeNull();
    await wipeAccount(u.email);
    const mem = (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown>; lists: Map<string, string[]>; sets: Map<string, Set<string>> } }).__nashrMem;
    const residue = [...mem.kv.keys(), ...mem.lists.keys(), ...mem.sets.keys()].filter((key) => key.includes(u.email) && mem.kv.get(key) !== null);
    expect(residue).toEqual([]);

    const keys = usageMonthKeys("x@test.example", "2026-09");
    for (const kind of KINDS) expect(keys).toContain(`usage:x@test.example:2026-09:kind:${kind}:usd_micro`);
    for (const a of AGENT_IDS) expect(keys).toEqual(expect.arrayContaining([`usage:x@test.example:2026-09:agent:${a}:calls`, `usage:x@test.example:2026-09:agent:${a}:usd_micro`]));
  });
});
