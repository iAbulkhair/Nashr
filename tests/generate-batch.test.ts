import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { json, newUser, settle, signIn } from "./helpers/session";
import { acct, currentUser, getUser, saveUser, type User } from "@/lib/auth";
import { scopeFor } from "@/lib/brands";
import { agentSpendFor } from "@/lib/credits";
import { db } from "@/lib/db";
import { saveGov } from "@/lib/governance";
import { listTasks, type Brand } from "@/lib/brand";
import { createMcpToken } from "@/lib/mcp";
import { saveSchedule } from "@/lib/schedule";
import { TASK_COST } from "@/lib/tasks";
import type { SalesSnapshot } from "@/lib/connectors/sales";

/**
 * Rules 221-224: one generation pipeline (src/lib/generate-batch.ts). Every paid text batch goes through
 * `generateBatch`: the same order of checks before the charge, the same refund with the charge's receipt, one task
 * builder, one concurrent save and the same grounding to the judge. `load()` wraps it so every call from any caller is
 * recorded while the real pipeline runs, so "each caller goes through it" is a list, not a hope.
 */
const calls: { via: string; source: string; type: string; scope: string }[] = [];

const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "رخيص", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
type Item = { channel: string; title: string; body: string };
const ITEM: Item = { channel: "instagram", title: "قهوة اليوم", body: "نص تجريبي للعنصر يكفي للمراجعة" };
type Params = { system: string | { text: string }[]; messages: { role: string; content: unknown }[] };
const reply = (text: string) => ({ model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 100 }, content: [{ type: "text", text }] });
const verdict = { completeness: 90, brand: 90, honesty: 90, language: 90, format: 90, autofail: null, notes: "ready" };

/** An owner with a brand file, re-read so the object carries the stored balance. */
async function owner(prefix: string, withBrand = true): Promise<User> {
  const u = await newUser(prefix);
  if (withBrand) await db.set(`brand:${acct(u)}`, brand);
  return (await getUser(acct(u)))!;
}
const credits = async (email: string) => (await getUser(email))!.credits;
const spend = async (email: string) => agentSpendFor((await getUser(email))!, email);

/**
 * A fresh module graph with the model state forced and the SDK and the ledger's charge counted: `made` counts clients
 * (a model call), `charged` counts calls to `charge` (so "refused before the charge" is told apart from "charged and
 * refunded"), `judged` holds what the judge was shown, and `saves` the order in which task saves started and ended.
 */
async function load(o: { state?: "on" | "paused" | "mock"; items?: Item[]; genFails?: boolean; statsFail?: boolean } = {}) {
  vi.resetModules();
  const state = o.state ?? "on";
  vi.stubEnv("ANTHROPIC_API_KEY", state === "mock" ? "" : "test");
  vi.doMock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => state }));
  const seen = { made: 0, charged: 0, judged: [] as string[], saves: [] as string[] };
  vi.doMock("@/lib/credits", async (orig) => {
    const m = await orig<typeof import("@/lib/credits")>();
    return { ...m, charge: (...a: Parameters<typeof m.charge>) => { seen.charged++; return m.charge(...a); } };
  });
  vi.doMock("@/lib/brand", async (orig) => {
    const m = await orig<typeof import("@/lib/brand")>();
    return { ...m, saveTask: async (...a: Parameters<typeof m.saveTask>) => { seen.saves.push("start"); await m.saveTask(...a); seen.saves.push("end"); } };
  });
  if (o.statsFail) vi.doMock("@/lib/stats", async (orig) => ({ ...(await orig<typeof import("@/lib/stats")>()), statsFor: async () => { throw new Error("upstash timeout"); } }));
  // Registered on every load, after the reset: a factory given to a hoisted vi.mock would keep its first result.
  vi.doMock("@/lib/generate-batch", async (orig) => {
    const real = await orig<typeof import("@/lib/generate-batch")>();
    return {
      ...real,
      generateBatch: (...a: Parameters<typeof real.generateBatch>) => {
        calls.push({ via: a[2].via, source: a[2].source, type: a[2].type, scope: a[1] });
        return real.generateBatch(...a);
      },
    };
  });
  const items = o.items ?? [ITEM];
  vi.doMock("@anthropic-ai/sdk", () => ({
    default: class {
      static BadRequestError = class extends Error {};
      constructor() { seen.made++; }
      beta = { messages: { stream: () => ({ finalMessage: async () => { if (o.genFails) throw new Error("model down"); return reply(JSON.stringify(items)); } }) } };
      messages = {
        chat: () => ({ finalMessage: async () => reply("تمام") }),
        create: async (p: Params) => {
          const sys = typeof p.system === "string" ? p.system : p.system[0].text;
          if (!sys.startsWith("You are the quality judge")) return reply(JSON.stringify([{ ok: true }]));
          seen.judged.push(String(p.messages[0].content));
          return reply(JSON.stringify(items.map(() => verdict)));
        },
        stream(p: { tools?: unknown; tool_choice?: unknown; output_config?: { format?: unknown } }, o?: unknown) { return (p.tools && !p.tool_choice) || p.output_config?.format ? (this.chat as (...a: unknown[]) => unknown)(p, o) : { finalMessage: async () => (this.create as (...a: unknown[]) => unknown)(p, o) }; },
      };
    },
  }));
  // The Sunday plan's module first: generate-batch reaches it again through notifications, and an import made while the
  // wrapper above is still being built gets the unwrapped module, so the plan would bypass the record.
  await import("@/lib/schedule");
  return { ...(await import("@/lib/generate-batch")), seen };
}

afterEach(async () => {
  await settle();
  for (const m of ["@anthropic-ai/sdk", "@/lib/model", "@/lib/credits", "@/lib/brand", "@/lib/stats", "@/lib/generate-batch"]) vi.doUnmock(m);
  vi.unstubAllEnvs();
  calls.length = 0;
});

describe("the checks before the charge come in one order, typed, and charge nothing (rule 221)", () => {
  it("while paused, every path but chat refuses before reading the brand or charging; chat keeps the throw-and-refund backstop", async () => {
    const { generateBatch, seen } = await load({ state: "paused" });
    // No brand file: "paused" coming back rather than "no_brand" shows the model switch is checked first.
    const u = await owner("gb-paused", false);
    for (const via of ["app", "mcp", "weekly", "routine"] as const) {
      const settled = { n: 0 };
      const r = await generateBatch(u, acct(u), { type: "social", source: "manual", via, settle: async () => { settled.n++; } });
      expect(r, via).toEqual({ ok: false, reason: "paused" });
      expect(settled.n, `${via}: a refusal gives back a routine's attempt`).toBe(1);
    }
    expect([seen.charged, seen.made, await credits(acct(u))]).toEqual([0, 0, 50]);

    // Chat: its turn answers while paused before any tool runs, so the tool itself is not pre-checked.
    const v = await owner("gb-paused-chat");
    const r = await generateBatch(v, acct(v), { type: "social", source: "chat", via: "chat" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason === "failed" && (r.error as Error).name).toBe("ModelPaused");
    expect([seen.charged, await credits(acct(v)), await spend(acct(v))], "charged once, refunded in full with the receipt").toEqual([1, 50, { noor: 0 }]);
    expect(await listTasks(acct(v))).toEqual([]);
  });

  it("brand, then trial, then the type's data, then the owning agent's cap, then the balance", async () => {
    const { generateBatch, countCost, seen } = await load();
    const settled = { n: 0 };
    const count = async () => { settled.n++; };
    const past = new Date(Date.now() - 864e5).toISOString();

    // No brand wins over an ended trial.
    const a = await owner("gb-nobrand", false);
    await saveUser({ ...a, trialEnds: past });
    expect(await generateBatch({ ...a, trialEnds: past }, acct(a), { type: "social", source: "manual", via: "app", settle: count })).toEqual({ ok: false, reason: "no_brand" });

    // An ended trial wins over missing cart data.
    const b = await owner("gb-trial");
    expect(await generateBatch({ ...b, trialEnds: past }, acct(b), { type: "cart_recovery", source: "manual", via: "app", settle: count })).toEqual({ ok: false, reason: "trial_over" });

    // Missing data wins over the owning agent's cap.
    const c = await owner("gb-missing");
    await saveGov(acct(c), { agentCaps: { noor: 0 } });
    expect(await generateBatch(c, acct(c), { type: "cart_recovery", source: "manual", via: "app", settle: count })).toEqual({ ok: false, reason: "missing_data", missing: "no_cart_data" });

    // The cap wins over the balance, and names the agent the type belongs to.
    const d = await owner("gb-cap");
    await saveGov(acct(d), { agentCaps: { razan: 0 } });
    await saveUser({ ...d, credits: 0 });
    expect(await generateBatch({ ...d, credits: 0 }, acct(d), { type: "pricing_review", source: "manual", via: "mcp", settle: count })).toEqual({ ok: false, reason: "agent_cap", agent: "razan", spent: 0, cap: 0, credits: 0 });

    // The balance: the full batch's price, or a small ask's share of it.
    const e = await owner("gb-broke");
    await saveUser({ ...e, credits: 0 });
    expect(await generateBatch({ ...e, credits: 0 }, acct(e), { type: "pricing_review", source: "manual", via: "app", settle: count })).toEqual({ ok: false, reason: "no_credits", need: TASK_COST.pricing_review, credits: 0 });
    expect(await generateBatch({ ...e, credits: 0 }, acct(e), { type: "social", count: 2, source: "chat", via: "chat", settle: count })).toEqual({ ok: false, reason: "no_credits", need: countCost("social", 2), credits: 0 });
    expect([countCost("social", 1), countCost("whatsapp", 1), countCost("ads", 3)]).toEqual([1, 1, 3]);

    expect(settled.n, "every refusal settles").toBe(6);
    expect(seen.made, "no refusal reaches the model").toBe(0);
    expect([await credits(acct(b)), await credits(acct(c)), await spend(acct(d))]).toEqual([50, 50, {}]);
  });

  it("a small ask is only for DRAFT_TYPES: any other type with a count throws before any read or charge (rule 250)", async () => {
    const { generateBatch, seen } = await load();
    const u = await owner("gb-draft-type");
    for (const type of ["article", "weekly_plan", "cart_recovery", "board_deck"] as const) {
      await expect(generateBatch(u, acct(u), { type, count: 1, source: "chat", via: "chat" })).rejects.toThrow(`not_draft_type:${type}`);
    }
    expect([seen.charged, seen.made]).toEqual([0, 0]);
    expect(await credits(acct(u))).toBe(50);
    expect(await listTasks(acct(u))).toEqual([]);
  });
});

describe("a failed read or a failed generation is refunded with the receipt (rule 222)", () => {
  it("a read inside the try that fails gives back the credits and the agent's counter, and settles once", async () => {
    const { generateBatch, seen } = await load({ statsFail: true });
    const u = await owner("gb-readfail");
    const settled = { n: 0 };
    const r = await generateBatch(u, acct(u), { type: "weekly_report", source: "scheduled", via: "routine", settle: async () => { settled.n++; } });
    expect(r).toMatchObject({ ok: false, reason: "failed", credits: 50 });
    expect(!r.ok && r.reason === "failed" && (r.error as Error).message).toBe("upstash timeout");
    expect([seen.charged, seen.made, settled.n, u.credits]).toEqual([1, 0, 1, 50]);
    expect(await spend(acct(u))).toEqual({ dana: 0 });
    expect(await listTasks(acct(u))).toEqual([]);
  });

  it("a generation that throws does the same", async () => {
    const { generateBatch, seen } = await load({ genFails: true });
    const u = await owner("gb-genfail");
    const r = await generateBatch(u, acct(u), { type: "pricing_review", source: "manual", via: "app" });
    expect(r).toMatchObject({ ok: false, reason: "failed", credits: 50 });
    expect(seen.made).toBeGreaterThan(0);
    expect([await credits(acct(u)), await spend(acct(u))]).toEqual([50, { razan: 0 }]);
    expect(await listTasks(acct(u))).toEqual([]);
  });

  it("a generation that returns no usable item is a failure and is refunded, never charged (rule 1306, issue #79)", async () => {
    for (const items of [[], [{ channel: "instagram", title: "no body" }]] as unknown as Item[][]) {
      const { generateBatch, seen } = await load({ items });
      const u = await owner("gb-empty");
      const r = await generateBatch(u, acct(u), { type: "pricing_review", source: "manual", via: "app" });
      expect(r).toMatchObject({ ok: false, reason: "failed", credits: 50 });
      expect(!r.ok && r.reason === "failed" && (r.error as Error).message).toBe("empty_generation");
      expect(seen.charged).toBe(1);
      expect([await credits(acct(u)), await spend(acct(u))]).toEqual([50, { razan: 0 }]);
      expect(await listTasks(acct(u))).toEqual([]);
    }
  });

  it("a small ask that fails gives back exactly what it was charged, not the full batch price (rules 222 and 241)", async () => {
    const { generateBatch, countCost } = await load({ genFails: true });
    const u = await owner("gb-smallfail");
    // One social draft costs less than a full social batch, so a refund of the batch price would add credits.
    expect(countCost("social", 1)).toBeLessThan(TASK_COST.social);
    const r = await generateBatch(u, acct(u), { type: "social", count: 1, brief: "b", source: "chat", via: "chat" });
    expect(r).toMatchObject({ ok: false, reason: "failed", credits: 50 });
    expect([await credits(acct(u)), await spend(acct(u))]).toEqual([50, { noor: 0 }]);
  });
});

describe("tasks are built in one place, saved together and judged with what the agent had (rule 223)", () => {
  it("source, brief, lang and one creation time; auto-approve still goes through the brand gate; a forced batch waits", async () => {
    const items = [ITEM, { channel: "instagram", title: "عرض", body: "قهوة رخيص اليوم فقط للمراجعة" }];
    const { generateBatch, seen } = await load({ items });
    const u = await owner("gb-build");
    await saveGov(acct(u), { autoApprove: { social: true }, reviewer: false });
    const r = await generateBatch(u, acct(u), { type: "social", notes: `  عرض الخريف ${"م".repeat(600)}`, source: "manual", via: "app" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tasks.map((t) => t.status), "the item with a banned word waits even under auto-approve").toEqual(["approved", "pending"]);
    for (const t of r.tasks) {
      expect(t).toMatchObject({ type: "social", source: "manual", lang: "ar" });
      expect(t.brief).toHaveLength(500);
      expect(t.brief!.startsWith("عرض الخريف")).toBe(true);
    }
    expect(new Set(r.tasks.map((t) => t.createdAt)).size).toBe(1);
    // Two of the ten a social batch asks for: a short batch, charged per item delivered (rule 2276), 2/10 of the price.
    const kept = Math.floor((TASK_COST.social * 2) / 10);
    expect(r).toMatchObject({ credits: 50 - kept, cost: kept, short: { asked: 10, delivered: 2 }, refunded: TASK_COST.social - kept, agent: "noor", receipt: { ok: true, agent: "noor", scope: acct(u) } });
    expect((await listTasks(acct(u))).map((t) => t.id).sort()).toEqual(r.tasks.map((t) => t.id).sort());
    // Together, not one after another: every save starts before the first one ends.
    expect(seen.saves).toEqual(["start", "start", "end", "end"]);

    const forced = await generateBatch(u, acct(u), { type: "social", source: "chat", via: "chat", forcePending: true, brief: "given brief" });
    expect(forced.ok && forced.tasks.map((t) => [t.status, t.source, t.brief])).toEqual([["pending", "chat", "given brief"], ["pending", "chat", "given brief"]]);
    // Without notes there is no brief.
    const plain = await generateBatch(u, acct(u), { type: "social", source: "manual", via: "app" });
    expect(plain.ok && plain.tasks.every((t) => !("brief" in t))).toBe(true);
  });

  it("each item reaches the brand gate with its own channel: a {{1}} slot is auto-approved on WhatsApp and held on a post (rule 213)", async () => {
    const body = "أهلاً {{1}}، قهوتك المفضلة بانتظارك اليوم في الفرع";
    const { generateBatch } = await load({ items: [{ channel: "whatsapp", title: "تذكير", body }, { channel: "instagram", title: "تذكير", body }] });
    const u = await owner("gb-slot");
    await saveGov(acct(u), { autoApprove: { whatsapp: true }, reviewer: false });
    const r = await generateBatch(u, acct(u), { type: "whatsapp", source: "manual", via: "app" });
    // One batch, one type and one body: only the channel tells the two apart.
    expect(r.ok && r.tasks.map((t) => [t.channel, t.status])).toEqual([["whatsapp", "approved"], ["instagram", "pending"]]);
  });

  it("the same gate holds for every caller's source and via: chat, MCP, the Sunday plan and a routine (rules 213 and 223)", async () => {
    const slot = "أهلاً {{1}}، قهوتك المفضلة بانتظارك اليوم في الفرع";
    const items = [
      { channel: "whatsapp", title: "تذكير", body: slot },
      { channel: "instagram", title: "تذكير", body: slot },
      { channel: "whatsapp", title: "عرض", body: "خصم [رقم] على كل كوب اليوم في الفرع" },
    ];
    const { generateBatch } = await load({ items });
    const u = await owner("gb-gate-all");
    await saveGov(acct(u), { autoApprove: { whatsapp: true }, reviewer: false });
    // Each pair is one a caller passes (rule 224): the gate must not depend on who asked.
    const pairs = [["manual", "app"], ["chat", "chat"], ["chat", "mcp"], ["scheduled", "weekly"], ["scheduled", "routine"]] as const;
    for (const [source, via] of pairs) {
      const r = await generateBatch((await getUser(acct(u)))!, acct(u), { type: "whatsapp", source, via });
      expect(r.ok && r.tasks.map((t) => [t.channel, t.status]), `${source}/${via}`).toEqual([["whatsapp", "approved"], ["instagram", "pending"], ["whatsapp", "pending"]]);
    }
  });

  it("the judge gets the notes, the workspace files, the data block and the count the owner asked for", async () => {
    const { generateBatch, seen } = await load();
    const u = await owner("gb-judge");
    await db.set(`onboardplan:${acct(u)}`, { goal: "a weekly report every Sunday", plan: [], at: "2026-09-29T00:00:00.000Z" });
    expect((await generateBatch(u, acct(u), { type: "weekly_report", notes: "compare with Ramadan week", source: "manual", via: "app" })).ok).toBe(true);
    await settle();
    expect(seen.judged).toHaveLength(1);
    for (const part of ["<owner_notes>", "compare with Ramadan week", "<workspace_files>", "a weekly report every Sunday", "<workspace_data>"]) expect(seen.judged[0]).toContain(part);

    expect((await generateBatch(u, acct(u), { type: "social", notes: "one post", count: 1, source: "chat", via: "chat" })).ok).toBe(true);
    await settle();
    expect(seen.judged[1]).toMatch(/OVERRIDE: the owner asked for exactly 1 item/);
  });
});

describe("every paid text batch goes through generateBatch (rule 224)", () => {
  it("the generate route, both chat tools, MCP and the weekly plan, each with its own source and via, in the caller's scope", async () => {
    await load({ state: "mock" });
    const u = await owner("gb-callers");
    await signIn(u.email);
    const route = await import("@/app/api/generate/route");
    expect((await route.POST(json("/api/generate", "POST", { type: "social" }))).status).toBe(200);
    const { runTool } = await import("@/lib/chat");
    expect(await runTool((await currentUser())!, "generate_content", { type: "whatsapp" }, [])).toMatch(/^Created 3 whatsapp/);
    expect(await runTool((await currentUser())!, "draft_items", { type: "social", count: 1, brief: "b" }, [])).toMatch(/^Drafted 1 social/);
    const mcp = await import("@/app/api/mcp/route");
    const token = await createMcpToken(acct(u));
    const res = await mcp.POST(new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "generate_content", arguments: { type: "gbp" } } }) }));
    expect(((await res.json()) as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    const { runWeekly } = await import("@/lib/schedule");
    expect(await runWeekly((await currentUser())!)).toMatch(/^ok:/);
    expect(calls).toEqual([
      { via: "app", source: "manual", type: "social", scope: acct(u) },
      { via: "chat", source: "chat", type: "whatsapp", scope: acct(u) },
      { via: "chat", source: "chat", type: "social", scope: acct(u) },
      { via: "mcp", source: "chat", type: "gbp", scope: acct(u) },
      { via: "weekly", source: "scheduled", type: "weekly_plan", scope: acct(u) },
    ]);
  });

  it("a routine", async () => {
    await load();
    const u = await owner("gb-routine");
    const snap: SalesSnapshot = { provider: "salla", at: new Date().toISOString(), days: 30, orders: { count: 4, read: 4, canceled: 0, revenue: { SAR: 900 }, top: [{ name: "عود", qty: 2 }] }, carts: { count: 0, read: 0, value: {}, top: [] }, unread: 0 };
    await Promise.all([db.set(`storesales:${acct(u)}`, snap), saveSchedule(acct(u), { routines: { razan_cash_forecast: true } })]);
    const { runRoutine } = await import("@/lib/routines");
    expect(await runRoutine({ ...u, scope: scopeFor(acct(u), "default") }, "razan_cash_forecast")).toBe("ok:1");
    expect(calls).toEqual([{ via: "routine", source: "scheduled", type: "cash_forecast", scope: acct(u) }]);
  });

  it("no caller charges, generates, saves or judges a batch on its own", () => {
    const callers = ["src/app/api/generate/route.ts", "src/lib/chat-run-tool.ts", "src/app/api/mcp/route.ts", "src/lib/schedule.ts", "src/lib/routines.ts"];
    for (const file of callers) {
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
      expect(code, file).toMatch(/\bgenerateBatch\(/);
      expect(code.match(/\b(charge|refund|generate|saveTask|judgeLater|initialStatus)\(/g), file).toBeNull();
    }
  });
});

describe("a short batch is charged per item delivered (founder decision 2026-10-19, rules 2276-2279)", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ ...ITEM, title: `قهوة ${i + 1}` }));
  it("batchKeeps: the price times delivered of asked, rounded down in the owner's favour; rule 801 unchanged on a full batch (rules 2276, 2277)", async () => {
    const { batchKeeps } = await load();
    expect(batchKeeps(10, 10, 3, 0), "3 of 10 keeps 3/10").toBe(3);
    expect(batchKeeps(25, 10, 3, 0), "7.5 credits keeps 7").toBe(7);
    expect(batchKeeps(10, 10, 10, 0), "a full batch keeps all").toBe(10);
    expect(batchKeeps(10, 3, 5, 0), "more than asked is never charged more").toBe(10);
    expect(batchKeeps(10, 10, 0, 0), "nothing made keeps nothing").toBe(0);
    expect(batchKeeps(0, 10, 3, 0)).toBe(0);
    // Full batches with items held: exactly what rule 801 kept before, `charged - ceil(charged * held / made)`.
    for (const [charged, made, held] of [[10, 10, 1], [10, 10, 3], [7, 10, 1], [5, 5, 2], [10, 10, 10]]) {
      expect(batchKeeps(charged, made, made, held), `${charged}/${made}/${held}`).toBe(charged - Math.ceil((charged * held) / made));
    }
    // Short and held together: the share of the asked items that came, of which the share the check let through.
    expect(batchKeeps(10, 10, 4, 1), "4 of 10 came, 3 of them kept: 3/10").toBe(3);
  });
  it("3 of 10: the balance, the agent's counter, the activity row and the answer show 3/10 of the price; one refund (rules 2276, 2279)", async () => {
    const { generateBatch, seen } = await load({ items: items(3) });
    const u = await owner("gb-short");
    const cost = TASK_COST.social;
    const kept = Math.floor((cost * 3) / 10);
    const r = await generateBatch(u, acct(u), { type: "social", source: "manual", via: "app" });
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    expect(r).toMatchObject({ cost: kept, credits: 50 - kept, short: { asked: 10, delivered: 3 }, refunded: cost - kept });
    expect(r.held).toBeUndefined();
    expect(r.tasks).toHaveLength(3);
    expect(seen.charged, "charged once, then one refund for the part not delivered").toBe(1);
    expect(await credits(acct(u))).toBe(50 - kept);
    expect(await spend(acct(u))).toEqual({ noor: kept });
    const { listActivity } = await import("@/lib/activity");
    const row = (await listActivity(acct(u))).rows.find((a) => a.kind === "generated")!;
    expect([row.credits, row.count]).toEqual([kept, 3]);
  });
  it("a full batch has no `short` and keeps its whole price; an asked count is the batch's size (rule 2276)", async () => {
    const full = await load({ items: items(10) });
    const u = await owner("gb-full");
    const r = await full.generateBatch(u, acct(u), { type: "social", source: "manual", via: "app" });
    if (!r.ok) throw new Error("refused");
    expect([r.cost, r.short, r.refunded]).toEqual([TASK_COST.social, undefined, undefined]);
    // Two asked, two delivered: full, charged the count's own price (`countCost`).
    const two = await load({ items: items(2) });
    const v = await owner("gb-count");
    const c = await two.generateBatch(v, acct(v), { type: "social", source: "manual", via: "app", count: 2 });
    if (!c.ok) throw new Error("refused");
    expect([c.cost, c.short]).toEqual([two.countCost("social", 2), undefined]);
  });
  it("an empty batch stays free: refunded whole, nothing saved (rule 1306 unchanged)", async () => {
    const { generateBatch } = await load({ items: [] });
    const u = await owner("gb-empty");
    const r = await generateBatch(u, acct(u), { type: "social", source: "manual", via: "app" });
    expect(r.ok).toBe(false);
    expect([await credits(acct(u)), await spend(acct(u)), await listTasks(acct(u))]).toEqual([50, { noor: 0 }, []]);
  });
  it("a claim's batch gives the short share back from its hold and lowers the hold; a later refundOnce gives back only the rest (rule 2278)", async () => {
    const { generateBatch } = await load({ items: items(3) });
    const u = await owner("gb-short-once");
    const claim = `weekly:${acct(u)}:short`;
    const cost = TASK_COST.social;
    const kept = Math.floor((cost * 3) / 10);
    const r = await generateBatch(u, acct(u), { type: "social", source: "manual", via: "weekly", once: claim });
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    expect(r).toMatchObject({ cost: kept, refunded: cost - kept, short: { asked: 10, delivered: 3 } });
    const after = (await getUser(acct(u)))!;
    expect(after.credits).toBe(50 - kept);
    expect(after.paidOnce?.[claim]?.credits, "the hold now holds what was kept").toBe(kept);
    const { refundOnce } = await import("@/lib/credits");
    expect((await refundOnce(acct(u), claim)).refunded, "never the short share twice").toBe(kept);
    expect(await credits(acct(u))).toBe(50);
  });
  it("refundOncePart: at most the hold, a missing hold gives nothing, bad input throws (rule 2278)", async () => {
    const { chargeOnce, refundOncePart } = await import("@/lib/credits");
    const u = await owner("gb-part");
    const meta = { scope: acct(u), agent: "noor" as const };
    expect((await chargeOnce(acct(u), 10, meta, "c")).ok).toBe(true);
    expect(await refundOncePart(acct(u), "c", 4)).toEqual({ credits: 44, refunded: 4 });
    expect((await getUser(acct(u)))!.paidOnce?.c?.credits).toBe(6);
    expect(await refundOncePart(acct(u), "c", 99)).toEqual({ credits: 50, refunded: 6 });
    expect(await refundOncePart(acct(u), "c", 1)).toEqual({ credits: 50, refunded: 0 });
    expect(await refundOncePart(acct(u), "none", 3)).toEqual({ credits: 50, refunded: 0 });
    await expect(refundOncePart(acct(u), "c", -1)).rejects.toThrow("invalid_delta");
    await expect(refundOncePart(acct(u), "c", 1.5)).rejects.toThrow("invalid_delta");
    expect(await spend(acct(u))).toEqual({ noor: 0 });
  });
});
