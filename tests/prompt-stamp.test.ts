import { afterEach, describe, expect, it, vi } from "vitest";
import { acct } from "@/lib/account-id";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json, newUser, signIn } from "./helpers/session";
import { claudeOn } from "./helpers/model";
import { getUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getTask, listLite, type Brand } from "@/lib/brand";
import { codeHash, promptHashes, promptStamp } from "@/lib/prompt-stamp";
import { contentHash, playbook, playbookHash, skillsBlock, skillsHash } from "@/lib/skills";
import { PLAYBOOKS, pickPlaybook } from "@/lib/playbooks";
import { taskFromItem } from "@/lib/generate-batch";
import { saveExternalDraft } from "@/lib/external-drafts";
import { summarize, type GoldenResult, type GoldenRun } from "@/lib/golden";
import { agentById, type AgentId } from "@/lib/agents";
import * as generateRoute from "@/app/api/generate/route";

/**
 * Rules 229-230: every generated task records which prompts made it (229), and the golden set says when an agent's
 * prompts changed between two runs, so a drop in its score is looked at next to the prompt change (230).
 */
const brand: Brand = { name: "متجر العود", website: "", industry: "متجر إلكتروني", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "عود", audience: "الرياض", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
const HEX = /^[a-f0-9]{12}$/;

afterEach(() => {
  vi.doUnmock("@anthropic-ai/sdk");
  vi.doUnmock("@/lib/model");
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("every generated task records which prompts made it (rule 229)", () => {
  it("one hash per source: the owning agent's playbook, review.md, the brand's industry playbook, and the prompts in code", () => {
    const s = promptStamp("social", brand);
    const ecommerce = PLAYBOOKS.find((p) => p.id === "ecommerce")!;
    expect(s).toEqual({ skills: contentHash(skillsBlock(agentById("noor"))), review: contentHash(playbook("review")), industry: `ecommerce:${contentHash(ecommerce.text)}`, code: codeHash("social") });
    for (const v of [s.skills, s.review, s.code]) expect(v).toMatch(HEX);
    expect(promptStamp("social", brand), "the same content gives the same stamp").toEqual(s);
    expect(promptStamp("pricing_review").skills, "Razan's items carry the hash of her playbook and slices").toBe(skillsHash(agentById("razan")));
    expect(skillsHash(agentById("razan")), "her ads slice is part of what the stamp records").not.toBe(playbookHash("finance"));
    expect(promptStamp("strategy_review").skills, "Majed has no slices: his stamp is his playbook alone").toBe(playbookHash("executive"));
    expect(promptStamp("social"), "no brand, no industry part").not.toHaveProperty("industry");
    expect(pickPlaybook("مقاهي")).toBeNull();
    expect(promptStamp("social", { industry: "مقاهي" }).industry).toMatch(/^general:[a-f0-9]{12}$/);
    expect(codeHash("social")).not.toBe(codeHash("article"));
    expect(contentHash(""), "a playbook that did not load is its own value").toBe("none");
  });

  it("changes when a playbook's text changes, only in that part, and reads 'none' once it is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nashr-pb-"));
    const skills = join(dir, "content", "skills");
    mkdirSync(skills, { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    // A fresh module graph is a fresh process: the playbook cache and the hashes are per process, as deployed.
    const stamp = async () => { vi.resetModules(); return (await import("@/lib/prompt-stamp")).promptStamp("social", brand); };
    try {
      writeFileSync(join(skills, "marketing.md"), "# Marketing v1");
      writeFileSync(join(skills, "review.md"), "# Review v1");
      const a = await stamp();
      expect(await stamp()).toEqual(a);
      writeFileSync(join(skills, "marketing.md"), "# Marketing v2");
      const b = await stamp();
      expect(b.skills).not.toBe(a.skills);
      expect([b.review, b.industry, b.code]).toEqual([a.review, a.industry, a.code]);
      writeFileSync(join(skills, "review.md"), "# Review v2");
      const c = await stamp();
      expect(c.review).not.toBe(b.review);
      expect(c.code, "review.md has its own hash; the code hash covers only what is written in code").toBe(b.code);
      rmSync(join(skills, "marketing.md"));
      expect((await stamp()).skills).toBe("none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it("the code hash covers the agent's own system prompt (persona, rules, output format), not only the spec, reviewer and judge", async () => {
    const before = { social: codeHash("social"), sales: codeHash("sales_script") };
    try {
      // A fresh module graph is a fresh process; the agents module is the one the fresh prompt-stamp reads.
      vi.resetModules();
      const agents = await import("@/lib/agents");
      const noor = agents.agentForTask("social");
      const noorBlock = (await import("@/lib/noor")).fixedPrompt(noor, "x");
      expect(noorBlock).toContain(noor.persona);
      expect(noorBlock).toContain("RULES");
      expect(noorBlock).toContain("OUTPUT FORMAT");
      noor.persona = `${noor.persona} Always answer in verse.`;
      const fresh = await import("@/lib/prompt-stamp");
      expect(fresh.codeHash("social"), "Noor's persona changed").not.toBe(before.social);
      expect(fresh.codeHash("sales_script"), "Sami's prompts did not").toBe(before.sales);
    } finally {
      vi.resetModules();
    }
  });

  it("taskFromItem stamps every task, and so every generated batch; a draft from the owner's own assistant has none", async () => {
    const t = taskFromItem({ channel: "instagram", title: "t", body: "b" }, { type: "social", brand, source: "manual", createdAt: "2026-09-29T00:00:00.000Z" });
    expect(t.pb).toEqual(promptStamp("social", brand));

    const u = await newUser("stamp-gen");
    await db.set(`brand:${acct(u)}`, brand);
    await signIn(u.email);
    expect((await generateRoute.POST(json("/api/generate", "POST", { type: "whatsapp" }))).status).toBe(200);
    const tasks = await Promise.all((await listLite(acct(u))).map((l) => getTask(acct(u), l.id)));
    expect(tasks.length).toBeGreaterThan(0);
    // A batch also records the instruction blocks it carried (rule 947): none, none for an account with no instructions.
    for (const x of tasks) expect(x!.pb).toEqual(promptStamp("whatsapp", brand, { plat: "none", ins: "none" }));

    const saved = await saveExternalDraft((await getUser(acct(u)))!, { type: "social", channel: "instagram", title: "مسودة", body: "نص كتبه مساعد المالك" });
    if (!saved.ok) throw new Error(saved.reason);
    expect(saved.task).not.toHaveProperty("pb");
  });
});

describe("the golden set says when an agent's prompts changed (rule 230)", () => {
  const P = { skills: "aaaaaaaaaaaa", review: "cccccccccccc", code: "dddddddddddd" };
  const res = (id: string, agent: AgentId, score: number | null, over: Partial<GoldenResult> = {}): GoldenResult =>
    ({ id, agent, type: agent === "noor" ? "social" : "sales_script", brand: "roastery", ok: true, score, dims: null, notes: [], checks: [{ name: "c", pass: true }], items: [], ms: 1, delta: null, pb: P, ...over });
  const run = (results: GoldenResult[], playbooks?: Record<string, string>): GoldenRun =>
    ({ id: "r", version: 5, trigger: "manual", startedAt: "2026-09-29T00:00:00.000Z", finishedAt: "2026-09-29T00:00:00.000Z", status: "complete", overall: null, usd: 0, agents: [], results, regressions: [], ...(playbooks ? { playbooks } : {}) });
  const changedOf = (r: GoldenRun, agent: AgentId) => r.agents.find((a) => a.agent === agent)!.promptChanged;
  const old = "2026-09-20T00:00:00.000Z";

  it("unknown when the previous run's cases have no stamps; unchanged when they match", () => {
    const cur = run([res("n1", "noor", 60), res("s1", "sami", 60)]);
    summarize(cur, run([res("n1", "noor", 90, { pb: undefined }), res("s1", "sami", 90, { pb: undefined })]));
    expect([changedOf(cur, "noor"), changedOf(cur, "sami")]).toEqual([null, null]);
    expect(cur.regressions).toContain("n1: score 60");
    const same = run([res("n1", "noor", 60)]);
    summarize(same, run([res("n1", "noor", 90)]));
    expect(changedOf(same, "noor")).toBe(false);
    expect(same.regressions).toContain("n1: score 60");
  });

  it("marks the agent whose playbook, review.md or code prompt changed, and tags only its regression lines", () => {
    const cur = run([res("n1", "noor", 60, { pb: { ...P, skills: "ffffffffffff" } }), res("n2", "noor", 70, { pb: { ...P, skills: "ffffffffffff" } }), res("s1", "sami", 60)]);
    summarize(cur, run([res("n1", "noor", 90), res("n2", "noor", 90), res("s1", "sami", 90)]));
    expect([changedOf(cur, "noor"), changedOf(cur, "sami")]).toEqual([true, false]);
    expect(cur.regressions).toContain("noor: -25 vs previous run (prompt changed)");
    expect(cur.regressions).toContain("n1: score 60 (prompt changed)");
    expect(cur.regressions).toContain("s1: score 60");

    const review = run([res("n1", "noor", 90, { pb: { ...P, review: "ffffffffffff" } }), res("s1", "sami", 90, { pb: { ...P, review: "ffffffffffff" } })]);
    summarize(review, run([res("n1", "noor", 90), res("s1", "sami", 90)]));
    expect([changedOf(review, "noor"), changedOf(review, "sami")]).toEqual([true, true]);

    const code = run([res("n1", "noor", 90), res("s1", "sami", 90, { pb: { ...P, code: "ffffffffffff" } })]);
    summarize(code, run([res("n1", "noor", 90), res("s1", "sami", 90)]));
    expect([changedOf(code, "noor"), changedOf(code, "sami")]).toEqual([false, true]);
  });

  it("sees an industry playbook change through the cases' stamps, and ignores carried rows", () => {
    const cur = run([res("n1", "noor", 90, { pb: { ...P, industry: "ecommerce:222222222222" } })]);
    summarize(cur, run([res("n1", "noor", 90, { pb: { ...P, industry: "ecommerce:111111111111" } })]));
    expect(changedOf(cur, "noor")).toBe(true);

    const carried = run([res("n1", "noor", 50, { carried: old, pb: { ...P, skills: "ffffffffffff" } })]);
    summarize(carried, run([res("n1", "noor", 90)]));
    expect(changedOf(carried, "noor"), "a carried row was made by an older prompt").toBeNull();
    expect(carried.regressions).toContain("n1: score 50");
  });

  it("compares with the stamps of the rows the previous run carried, not the prompts that run started with", () => {
    // Run 2 reran only Sami after Noor's playbook changed from A to B: Noor's rows were carried with their A stamps, while
    // the run itself started with B. Run 3 measures Noor with B, so her drop comes with a prompt change.
    const B = { ...P, skills: "bbbbbbbbbbbb" };
    const run2 = run([res("n1", "noor", 90, { carried: old }), res("n2", "noor", 90, { carried: old }), res("s1", "sami", 90)], { marketing: B.skills });
    const run3 = run([res("n1", "noor", 60, { pb: B }), res("n2", "noor", 70, { pb: B }), res("s1", "sami", 90)], { marketing: B.skills });
    summarize(run3, run2);
    expect([changedOf(run3, "noor"), changedOf(run3, "sami")]).toEqual([true, false]);
    expect(run3.regressions).toContain("noor: -25 vs previous run (prompt changed)");
    expect(run3.regressions).toContain("n1: score 60 (prompt changed)");
  });

  it("a resumed run compares the rows its first attempt measured by their own stamps", () => {
    // A partial run measured Noor with A; a deploy changed her playbook to B; the resume added Sami's case under B.
    const B = { ...P, skills: "bbbbbbbbbbbb" };
    const prev = run([res("n1", "noor", 90), res("s1", "sami", 90)], { marketing: P.skills });
    const resumed = run([res("n1", "noor", 65), res("s1", "sami", 60, { pb: { ...P, code: "eeeeeeeeeeee" } })], { marketing: B.skills });
    summarize(resumed, prev);
    expect(changedOf(resumed, "noor"), "Noor's row and the previous run's were both made with A").toBe(false);
    expect(resumed.regressions).toContain("n1: score 65");
    expect(changedOf(resumed, "sami")).toBe(true);
    expect(resumed.regressions).toContain("s1: score 60 (prompt changed)");
  });

  it("a run records the prompt versions it started with and each case's stamp; the console returns the deployed ones", async () => {
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    vi.stubEnv("WAITLIST_ADMIN_KEY", "test-admin-key-0123456789");
    claudeOn();
    const reply = (text: string) => ({ model: "claude-sonnet-5-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text }] });
    const verdict = { completeness: 90, brand: 90, honesty: 90, language: 90, format: 90, autofail: null, notes: "ready" };
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        static BadRequestError = class extends Error {};
        beta = { messages: { stream: () => ({ finalMessage: async () => reply(JSON.stringify([{ channel: "instagram", title: "t", body: "نص تجريبي للعنصر يكفي للمراجعة والحكم عليه في المجموعة الذهبية" }])) }) } };
        messages = { create: async (p: { system: { text: string }[] }) => reply(JSON.stringify(p.system[0].text.startsWith("You are the quality judge") ? [verdict] : [{ ok: true }])), stream(p: unknown, o?: unknown) { return { finalMessage: async () => (this.create as (...a: unknown[]) => unknown)(p, o) }; } };
      },
    }));
    const { runGolden, GOLDEN_CASES, GOLDEN_BRANDS } = await import("@/lib/golden");
    const stamps = await import("@/lib/prompt-stamp");
    const run = await runGolden("manual");
    expect(run).not.toBeNull();
    expect(run!.playbooks).toEqual(stamps.promptHashes(GOLDEN_CASES.map((c) => c.type)));
    expect(Object.keys(run!.playbooks!)).toEqual(expect.arrayContaining(["marketing", "sales", "finance", "gtm", "reporting", "executive", "product", "review", "code:social"]));
    for (const r of run!.results) {
      const c = GOLDEN_CASES.find((x) => x.id === r.id)!;
      expect(r.pb).toEqual(stamps.promptStamp(c.type, GOLDEN_BRANDS[c.brand], { plat: "none", ins: "none" }));
    }
    const golden = await import("@/app/api/admin/golden/route");
    const body = (await (await golden.GET(json("/api/admin/golden", "GET", undefined, { "x-admin-key": "test-admin-key-0123456789" }))).json()) as { hashes: Record<string, string>; latest: GoldenRun };
    expect(body.hashes).toEqual(run!.playbooks);
    expect(body.latest.playbooks).toEqual(run!.playbooks);
    expect(promptHashes(["social"])["code:social"]).toBe(codeHash("social"));
  });

  it("a resumed run keeps the prompt versions its first attempt started with, and the rows it measured keep their stamps", async () => {
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    claudeOn();
    const reply = (text: string) => ({ model: "claude-sonnet-5-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text }] });
    const verdict = { completeness: 90, brand: 90, honesty: 90, language: 90, format: 90, autofail: null, notes: "ready" };
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        static BadRequestError = class extends Error {};
        beta = { messages: { stream: () => ({ finalMessage: async () => reply(JSON.stringify([{ channel: "instagram", title: "t", body: "نص تجريبي للعنصر يكفي للمراجعة والحكم عليه في المجموعة الذهبية" }])) }) } };
        messages = { create: async (p: { system: { text: string }[] }) => reply(JSON.stringify(p.system[0].text.startsWith("You are the quality judge") ? [verdict] : [{ ok: true }])), stream(p: unknown, o?: unknown) { return { finalMessage: async () => (this.create as (...a: unknown[]) => unknown)(p, o) }; } };
      },
    }));
    const { runGolden, GOLDEN_CASES, GOLDEN_VERSION } = await import("@/lib/golden");
    const c = GOLDEN_CASES[0];
    const earlier: GoldenResult = { ...res(c.id, "noor", 88), type: c.type };
    const partial: GoldenRun = { ...run([earlier], { marketing: "0ld0ld0ld0ld" }), id: "2026-09-26-a1b2c3", version: GOLDEN_VERSION, status: "partial" };
    await db.set(`golden:run:${partial.id}`, partial);
    await db.lpush("golden:runs", partial.id);
    const out = await runGolden("manual", { resume: true });
    expect(out!.id).toBe(partial.id);
    expect(out!.playbooks, "the versions it started with, not today's").toEqual(partial.playbooks);
    expect(out!.results.find((r) => r.id === c.id)).toMatchObject({ score: 88, pb: P });
    expect(out!.results).toHaveLength(GOLDEN_CASES.length);
  });
});
