import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeOn } from "./helpers/model";
import { db } from "@/lib/db";
import { liteOf, saveTask, type Brand, type Task } from "@/lib/brand";
import { agentMetrics, scopeMetrics, typeMetrics } from "@/lib/evals";
import { kpis } from "@/lib/stats";
import { hardChecks } from "@/lib/golden";

/**
 * The agent-quality numbers are what a founder uses to decide whether to widen auto-approve, retrain an agent or drop
 * one. Each test here is a way those numbers used to say something false.
 */
const daysAgo = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
let n = 0;
const task = (over: Partial<Task> = {}): Task => ({ id: `t${++n}`, type: "social", channel: "instagram", title: "t", body: "b", status: "pending", createdAt: daysAgo(1), lang: "ar", ...over });
const lastWeek = { from: new Date(Date.now() - 7 * 864e5), to: new Date() };

afterEach(() => { vi.doUnmock("@anthropic-ai/sdk"); vi.doUnmock("@/lib/model"); vi.unstubAllEnvs(); });

describe("an approval rate counts only what a person decided", () => {
  // Auto-approve on: ten items arrive "approved" and nobody opens them. One the owner approved, one they rejected.
  const rows = () => [
    ...Array.from({ length: 10 }, () => liteOf(task({ status: "approved" }))),
    liteOf(task({ status: "approved", decidedAt: daysAgo(0) })),
    liteOf(task({ status: "rejected", decidedAt: daysAgo(0) })),
  ];

  it("typeMetrics: 50%, not 92%", () => {
    const [m] = typeMetrics(rows());
    expect(m.approvalRate, "11 of 12 'approved' would read as a near-perfect agent nobody reviewed").toBe(50);
    expect(m.approved + m.rejected).toBe(2);
    expect(m.autoApproved).toBe(10);
  });

  it("agentMetrics carries the denominator next to the rate", async () => {
    const noor = (await agentMetrics(rows(), [], lastWeek)).find((a) => a.agent === "noor")!;
    expect(noor.approvalRate).toBe(50);
    expect(noor.decided, "the screen prints this beside the rate").toBe(2);
    expect(noor.autoApproved).toBe(10);
    expect(noor.n).toBe(12);
  });

  it("the KPI tile agrees with the table beneath it", async () => {
    const scope = "tile@test.example";
    await Promise.all([
      ...Array.from({ length: 10 }, () => saveTask(scope, task({ status: "approved" }), true)),
      saveTask(scope, task({ status: "approved", decidedAt: daysAgo(0) }), true),
      saveTask(scope, task({ status: "rejected", decidedAt: daysAgo(0) }), true),
    ]);
    const k = await kpis(scope, 7);
    expect(k.approvalRate).toBe(50);
    expect(k.approved, "approved is still a volume: those items really are approved").toBe(11);
    expect(k.autoApproved).toBe(10);
  });
});

describe("thumbs are counted inside the window", () => {
  it("a thumb from months ago does not appear on the 7-day view", async () => {
    const who = "thumbs@test.example";
    const push = (value: number, at: string) => db.lpush(`fblog:${who}`, JSON.stringify({ agent: "noor", value, at }));
    await push(-1, daysAgo(200));
    await push(-1, daysAgo(150));
    await push(1, daysAgo(2));
    const noor = (await agentMetrics([], [who], lastWeek)).find((a) => a.agent === "noor")!;
    expect([noor.thumbsUp, noor.thumbsDown], "lifetime counters showed 1/2 here, and could never improve").toEqual([1, 0]);
  });

  it("ignores a log row that names no real agent", async () => {
    const who = "thumbs2@test.example";
    await db.lpush(`fblog:${who}`, JSON.stringify({ agent: "__proto__", value: 1, at: daysAgo(1) }));
    await db.lpush(`fblog:${who}`, "not json");
    const all = await agentMetrics([], [who], lastWeek);
    expect(all.every((a) => a.thumbsUp === 0 && a.thumbsDown === 0)).toBe(true);
  });
});

describe("the report window is not re-anchored to today", () => {
  it("'last year' covers last year, not the trailing twelve months", async () => {
    const scope = "window@test.example";
    const now = new Date();
    const inLastYear = new Date(Date.UTC(now.getUTCFullYear() - 1, 5, 15)).toISOString();
    const thisYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 2)).toISOString();
    await saveTask(scope, task({ createdAt: inLastYear }), true);
    await saveTask(scope, task({ createdAt: thisYear }), true);
    const win = { from: new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1)), to: new Date(Date.UTC(now.getUTCFullYear(), 0, 1) - 1) };
    const noor = (await scopeMetrics(scope, win)).find((a) => a.agent === "noor")!;
    expect(noor.n, "this year's item must not appear in last year's table").toBe(1);
  });
});

describe("published means published", () => {
  it("a CMS draft is not counted as a live post", () => {
    const lite = liteOf(task({ published: [
      { provider: "wordpress", url: "u1", status: "draft", at: daysAgo(0) },
      { provider: "x", url: "u2", status: "published", at: daysAgo(0) },
    ] }));
    expect(lite.published).toBe(1);
  });
});

describe("the golden set's invented-price check", () => {
  const brand: Brand = { name: "محمصة", website: "", industry: "قهوة", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة، تأسست 2025، الهاتف 0550123456", audience: "الرياض", offers: "خصم على 250 كوب", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: daysAgo(0) };
  const run = (body: string) => {
    const c: Parameters<typeof hardChecks>[0] = { id: "p", type: "social", brand: "roastery", noPrices: true };
    return hardChecks(c, brand, [{ channel: "instagram", title: "t", body }]).find((x) => x.name === "no invented prices")!;
  };

  it("catches a price that only appears inside another number", () => {
    // "25" is a substring of "2025" and of "250". The old substring test let it through.
    expect(run("العرض الآن 25 ريال").pass).toBe(false);
  });

  it("accepts a price the brand file really states", () => {
    expect(run("كوب 250 ريال").pass).toBe(true);
  });
});

describe("the judge", () => {
  const brand: Brand = { name: "محمصة", website: "", industry: "قهوة", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: daysAgo(0) };
  const verdict = { completeness: 90, brand: 90, honesty: 90, language: 90, format: 90, notes: "ready" };
  const items = [{ channel: "instagram", title: "a", body: "x" }, { channel: "instagram", title: "b", body: "y" }, { channel: "instagram", title: "c", body: "z" }];

  const withJudgeReply = async (reply: unknown[]) => {
    const seen: { content: string }[] = [];
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    claudeOn();
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: async (p: { messages: { content: string }[] }) => {
            seen.push(p.messages[0]);
            return { model: "claude-sonnet-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify(reply) }] };
          },
        };
      },
    }));
    const { scoreItems } = await import("@/lib/judge");
    return { scoreItems, seen };
  };

  it("leaves an item unjudged when the reply is short, instead of scoring it 0", async () => {
    const { scoreItems } = await withJudgeReply([verdict]);
    const out = await scoreItems("j@test.example", brand, "social", items);
    expect(out[0]?.score).toBe(90);
    expect(out[1], "an unscored item used to be saved as a real 0 and raise a 'below 70' alert").toBeNull();
    expect(out[2]).toBeNull();
  });

  it("does not accept a verdict with a dimension missing", async () => {
    const { scoreItems } = await withJudgeReply([{ ...verdict, honesty: undefined }, verdict, verdict]);
    const out = await scoreItems("j@test.example", brand, "social", items);
    expect(out[0]).toBeNull();
    expect(out[1]?.score).toBe(90);
  });

  it("is told about a shortfall against what the owner asked for, not what came back", async () => {
    const { scoreItems, seen } = await withJudgeReply([verdict, verdict, verdict]);
    await scoreItems("j@test.example", brand, "social", items, 10);
    expect(seen[0].content, "asked for 10, delivered 3").toMatch(/SHORTFALL: the owner asked for 10 item\(s\) and only 3 were delivered/);
    expect(seen[0].content, "and must NOT be told the owner asked for 3").not.toMatch(/asked for exactly 3/);
  });

  it("writes its verdict to the item as stored now, and never brings back an item deleted meanwhile", async () => {
    const during = { fn: async () => {} };
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    claudeOn();
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: async () => {
            await during.fn();
            return { model: "claude-sonnet-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify([verdict, verdict]) }] };
          },
        };
      },
    }));
    const { judgeTasks } = await import("@/lib/judge");
    const store = await import("@/lib/brand");
    const { db: fresh } = await import("@/lib/db");
    const scope = `judgew${Date.now()}@test.example`, clip = "https://s1.public.blob.vercel-storage.com/media/clip.mp4";
    const a = task({ createdAt: daysAgo(0) }), b = task({ createdAt: daysAgo(0) });
    await Promise.all([store.saveTask(scope, a, true), store.saveTask(scope, b, true)]);
    // While the judge thinks, the owner deletes b.
    during.fn = async () => { await fresh.del(`task:${scope}:${b.id}`); };
    // And a render finishes on a between the judge's read of it and its write.
    const key = `task:${scope}:${a.id}`;
    const get = fresh.get.bind(fresh);
    let landing: Promise<unknown> | undefined;
    vi.spyOn(fresh, "get").mockImplementation(async (k: string) => {
      const v = await get(k);
      if (k === key && !landing) {
        landing = store.updateTask(scope, a.id, (t) => ({ ...t, videoUrl: clip }));
        // Waiting for it would deadlock under the task lock; a read-then-save let it land in full before saving.
        await Promise.race([landing, new Promise((r) => setTimeout(r, 300))]);
      }
      return v as never;
    });
    await judgeTasks(scope, scope, brand, [a, b]);
    await landing;
    vi.mocked(fresh.get).mockRestore();
    expect(await store.getTask(scope, a.id), "the clip and the verdict both stay").toMatchObject({ videoUrl: clip, quality: { score: 90 } });
    expect(await store.getTask(scope, b.id), "a deleted item stays deleted").toBeNull();
  });

  it("still honours a genuinely small request", async () => {
    const { scoreItems, seen } = await withJudgeReply([verdict, verdict]);
    await scoreItems("j@test.example", brand, "social", items.slice(0, 2), 2);
    expect(seen[0].content).toMatch(/asked for exactly 2 item\(s\)/);
    expect(seen[0].content).not.toMatch(/SHORTFALL/);
  });
});
