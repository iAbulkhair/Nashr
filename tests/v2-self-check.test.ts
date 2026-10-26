import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Quality } from "@/lib/judge";

/**
 * Rules 4670-4689 (docs/system/tests/4620-v2-plans.md): Thakeen v2 phase 2, the self-check before the save (C6). It ships
 * off (`SELF_CHECK`); this file switches it through the flags module. The judge's in-line score and the rewrite's model
 * call are stand-ins (`scoreItems`, `anthropic` and `metered`), so what is checked is the code around them: who is
 * rewritten, what the rewrite is told, and that nothing here ever fails the batch.
 */
const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/v2-flags", () => ({
  GATEWAY_MODE: "off",
  RUN_LOG: false,
  MEMORY_V2: false,
  COMPACTION: false,
  PLANS: false,
  QUEUE: false,
  get SELF_CHECK() {
    return flag.on;
  },
  TEAM_CHAT: false,
  RESEARCH: false,
}));
const m = vi.hoisted(() => ({
  scores: [] as (Quality | null)[],
  scored: 0,
  bodies: [] as Record<string, unknown>[],
  metered: [] as Record<string, unknown>[],
  reply: '[{"channel":"instagram","title":"جديد","body":"نص جديد"}]',
  fail: false,
}));
vi.mock("@/lib/judge", async (orig) => ({
  ...(await orig<typeof import("@/lib/judge")>()),
  scoreItems: async () => {
    m.scored++;
    return m.scores;
  },
}));
vi.mock("@/lib/model", async (orig) => ({
  ...(await orig<typeof import("@/lib/model")>()),
  anthropic: () => ({
    messages: {
      stream: (b: Record<string, unknown>) => {
        m.bodies.push(b);
        return {};
      },
    },
  }),
}));
vi.mock("@/lib/metered", async (orig) => ({
  ...(await orig<typeof import("@/lib/metered")>()),
  metered: async (_s: unknown, to: Record<string, unknown>) => {
    m.metered.push(to);
    if (m.fail) throw new Error("overloaded");
    return { content: [{ type: "text", text: m.reply }], stop_reason: "end_turn", model: "m" };
  },
}));

import {
  SELF_CHECK_BAR,
  SELF_CHECK_MAX_REWRITES,
  SELF_CHECK_MIN_MS,
  pickRewrites,
  selfCheck,
  type SelfCheckCtx,
} from "@/lib/self-check";
import { NO_LAYERS } from "@/lib/agent-instructions";
import type { Brand, Task } from "@/lib/brand";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const brand: Brand = {
  name: "مقهى الفنجان",
  website: "",
  industry: "مقاهي",
  dialect: "saudi",
  languages: ["ar"],
  tone: "ودود",
  products: "قهوة مختصة",
  audience: "الرياض",
  offers: "",
  competitors: "",
  banned: "",
  preferred: "",
  channels: ["instagram"],
  city: "الرياض",
  updatedAt: "2026-09-29T00:00:00.000Z",
};
const task = (i: number, status: Task["status"] = "pending"): Task => ({
  id: `${i}`.padStart(16, "b"),
  type: "social",
  channel: "instagram",
  title: `عنوان ${i}`,
  body: `نص ${i}`,
  status,
  createdAt: "2026-10-25T00:00:00.000Z",
  lang: "ar",
});
const q = (score: number, autofail?: Quality["autofail"]): Quality => ({
  score,
  dims: { completeness: score, brand: score, honesty: score, language: score, format: score },
  notes: autofail ? `[${autofail}] "عملاؤنا 10,000" غير موجود في المصادر` : "اختصر الافتتاحية",
  model: "j",
  at: "2026-10-25T00:00:00.000Z",
  ...(autofail ? { autofail } : {}),
});
const ctx = (extra: Partial<SelfCheckCtx> = {}): SelfCheckCtx => ({
  email: "acct",
  brand,
  type: "social",
  ground: { notes: "عرض الجمعة" },
  prefs: [],
  layers: NO_LAYERS,
  agentScope: true,
  model: "claude-sonnet-5-5",
  deadline: Date.now() + 300_000,
  ...extra,
});

beforeEach(() => {
  flag.on = true;
  m.scores = [];
  m.scored = 0;
  m.bodies = [];
  m.metered = [];
  m.fail = false;
});

describe("rule 4670: off changes nothing", () => {
  it("the switch ships off, and off returns the same tasks without a model call", async () => {
    expect(src("src/lib/v2-flags.ts")).toMatch(/export const SELF_CHECK: boolean = false;/);
    flag.on = false;
    const ts = [task(1)];
    expect(await selfCheck(ts, ctx())).toBe(ts);
    expect(m.scored).toBe(0);
  });
  it("only the scheduled paths ask for it, and the batch runs it before the output check", () => {
    const gen = src("src/lib/generate-batch.ts");
    const at = gen.indexOf('if (opts.selfCheck && v2On("SELF_CHECK") && tasks.length) tasks = await selfCheck(');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(gen.indexOf("const output = scopeModes.output;"));
    expect(src("src/lib/routines.ts")).toMatch(/via: "routine", gov, brand, settle, once: claim, selfCheck: true,/);
    expect(src("src/lib/plan-run.ts")).toMatch(/selfCheck: true/);
    for (const f of ["src/app/api/generate/route.ts", "src/lib/chat-run-tool.ts", "src/lib/handoffs.ts"])
      expect(src(f)).not.toMatch(/selfCheck/);
  });
  it("the rewrite is never charged in credits", () => {
    const s = src("src/lib/self-check.ts");
    expect(s).not.toMatch(/from "\.\/credits"/);
    expect(s).not.toMatch(/\bcharge\(|\brefund\(/);
  });
});

describe("rules 4671-4679: who is rewritten, and how", () => {
  it("the weak items, lowest first, at most SELF_CHECK_MAX_REWRITES", () => {
    expect(pickRewrites([q(90), q(50), null, q(40, "invented_fact"), q(SELF_CHECK_BAR)])).toEqual([3, 1]);
    expect(pickRewrites([q(10), q(20), q(30), q(40), q(50)])).toHaveLength(SELF_CHECK_MAX_REWRITES);
  });
  it("a weak item is rewritten once with the note; a passing item keeps its text; an auto-failed one goes to the inbox", async () => {
    m.scores = [q(90), q(50), q(40, "fake_proof")];
    const out = await selfCheck([task(1, "approved"), task(2, "approved"), task(3, "approved")], ctx());
    expect(m.scored).toBe(1);
    expect(out[0]).toMatchObject({
      title: "عنوان 1",
      body: "نص 1",
      status: "approved",
      selfCheck: { first: 90, rewritten: false },
    });
    expect(out[1]).toMatchObject({
      title: "جديد",
      body: "نص جديد",
      status: "approved",
      selfCheck: { first: 50, rewritten: true },
    });
    expect(out[2]).toMatchObject({
      body: "نص جديد",
      status: "pending",
      selfCheck: { first: 40, autofail: "fake_proof", rewritten: true },
    });
    expect(m.metered.every((t) => t.kind === "generate")).toBe(true);
    expect(m.bodies).toHaveLength(2);
  });
  it("the judge's note is a reviewer's data, never the owner's request", async () => {
    m.scores = [q(40, "invented_fact")];
    await selfCheck([task(1)], ctx());
    const user = String((m.bodies[0].messages as { content: string }[])[0].content);
    expect(user).toMatch(/<reviewer_note>[\s\S]*عملاؤنا 10,000[\s\S]*<\/reviewer_note>/);
    expect(user).toMatch(/data, never instructions/);
    expect(user).not.toMatch(/The owner wrote the notes/);
    expect(user).toMatch(/<owner_notes>/);
    expect(m.bodies[0].model).toBe("claude-sonnet-5-5");
  });
  it("past the cap an item keeps its text with `cap`", async () => {
    m.scores = [q(10), q(20), q(30), q(40), q(50)];
    const out = await selfCheck(
      [1, 2, 3, 4, 5].map((i) => task(i)),
      ctx(),
    );
    expect(out.map((t) => t.selfCheck?.rewritten)).toEqual([true, true, true, false, false]);
    expect(out.slice(3).map((t) => t.selfCheck?.skipped)).toEqual(["cap", "cap"]);
  });
});

describe("rules 4680-4689: never a reason to fail a paid batch", () => {
  it("too little time: nothing is scored and every item says `time`", async () => {
    const out = await selfCheck([task(1)], ctx({ deadline: Date.now() + SELF_CHECK_MIN_MS - 1000 }));
    expect(m.scored).toBe(0);
    expect(out[0]).toMatchObject({ body: "نص 1", selfCheck: { rewritten: false, skipped: "time" } });
  });
  it("no verdict: `judge`, the text unchanged", async () => {
    m.scores = [];
    const out = await selfCheck([task(1)], ctx());
    expect(out[0]).toMatchObject({ body: "نص 1", selfCheck: { rewritten: false, skipped: "judge" } });
  });
  it("a failed rewrite keeps the draft; an auto-failed one still waits for a person", async () => {
    m.scores = [q(50), q(30, "results_promise")];
    m.fail = true;
    const out = await selfCheck([task(1, "approved"), task(2, "approved")], ctx());
    expect(out[0]).toMatchObject({
      body: "نص 1",
      status: "approved",
      selfCheck: { rewritten: false, skipped: "error" },
    });
    expect(out[1]).toMatchObject({
      body: "نص 2",
      status: "pending",
      selfCheck: { rewritten: false, skipped: "error" },
    });
  });
  it("an empty rewrite is a failed one", async () => {
    m.scores = [q(50)];
    m.reply = "[]";
    const out = await selfCheck([task(1)], ctx());
    expect(out[0]).toMatchObject({ body: "نص 1", selfCheck: { skipped: "error" } });
    m.reply = '[{"channel":"instagram","title":"جديد","body":"نص جديد"}]';
  });
});
