import { afterEach, describe, expect, it, vi } from "vitest";
import { newUser } from "./helpers/session";
import { db } from "@/lib/db";
import { writeFile } from "@/lib/files";
import { AGENTS } from "@/lib/agents";
import { GOLDEN_BRANDS, summarize, type GoldenResult, type GoldenRun } from "@/lib/golden";
import { getUser, saveUser } from "@/lib/auth";
import { listTasks, type Brand } from "@/lib/brand";
import { INSTRUCTION_PLAN } from "@/lib/instructions-safety";
import type { Instruction, InstructionSet } from "@/lib/instructions-store";
import { NO_LAYERS, instructionBlocks, type Layers } from "@/lib/agent-instructions";
import { fixedPrompt, systemPrompt } from "@/lib/noor";
import { promptStamp } from "@/lib/prompt-stamp";

/**
 * Rules 946-947: the instruction layers reach the batch prompt in one place (946): the platform text is appended to the
 * static block 1 (identical across brands), the workspace text sits in block 2 after the industry playbook and before the
 * workspace files, and with no layers all three blocks are byte for byte what they were. The prompt stamp records a hash
 * of each block on every task and every golden result, and a golden run whose platform text moved reads as "prompt
 * changed" (947).
 */
const noor = AGENTS.find((a) => a.id === "noor")!;
let n = 0;
const item = (text: string, extra: Partial<Instruction> = {}): Instruction => ({
  id: (++n).toString(16).padStart(12, "0"),
  text,
  agents: "all",
  on: true,
  src: "owner",
  at: "2026-10-10T00:00:00.000Z",
  ...extra,
});
const set = (items: Instruction[]): InstructionSet => ({ items, v: 1 });
const AGENCY = { ...INSTRUCTION_PLAN.agency, chars: 600 as const };
const layers = (p: Instruction[], w: Instruction[], o: Partial<Layers> = {}): Layers => ({ platform: set(p), workspace: set(w), refs: {}, paused: false, limits: AGENCY, ...o });
const LINE = "When an explicit owner instruction and a learned preference disagree, the owner instruction wins.";

afterEach(() => vi.useRealTimers());

describe("systemPrompt with layers (rule 946)", () => {
  it("rule 946: with NO_LAYERS (or none passed) all three blocks equal the output before layers existed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    const before = systemPrompt(GOLDEN_BRANDS.roastery, ["no emojis"], noor, "m1", "fb").map((b) => b.text);
    const explicit = systemPrompt(GOLDEN_BRANDS.roastery, ["no emojis"], noor, "m1", "fb", NO_LAYERS).map((b) => b.text);
    expect(explicit).toEqual(before);
    expect(before[0]).toBe(fixedPrompt(noor));
    expect(before[1]).not.toContain("OWNER INSTRUCTIONS");
    expect(before[1]).not.toContain(LINE);
    // A layers object with nothing that applies is the same as none.
    expect(systemPrompt(GOLDEN_BRANDS.roastery, ["no emojis"], noor, "m1", "fb", layers([], [])).map((b) => b.text)).toEqual(before);
  });

  it("rule 946: block 1 is fixedPrompt + platform text, identical across brands with the same platform layer", () => {
    const l = layers([item("Always answer in the owner's language.")], []);
    const platform = instructionBlocks(l, "noor").platform;
    expect(platform).toContain("Always answer in the owner's language.");
    const a = systemPrompt(GOLDEN_BRANDS.roastery, ["a"], noor, "m1", undefined, l)[0].text;
    const b = systemPrompt(GOLDEN_BRANDS.clinic, ["b"], noor, "m2", "fb", l)[0].text;
    expect(a).toBe(`${fixedPrompt(noor)}\n\n${platform}`);
    expect(b).toBe(a);
  });

  it("rule 946: the workspace block sits in block 2 after the industry playbook and before WORKSPACE FILES; the platform text stays out of block 2", () => {
    const l = layers([item("Platform standard")], [item("Owner wants short captions")]);
    const [, ws, today] = systemPrompt(GOLDEN_BRANDS.roastery, [], noor, "--- brand.md ---\nhello", undefined, l).map((x) => x.text);
    const block = instructionBlocks(l, "noor").workspace;
    expect(ws).toContain(block);
    expect(ws.indexOf(block)).toBeGreaterThan(ws.indexOf("BRAND FILE"));
    expect(ws.indexOf(block)).toBeLessThan(ws.indexOf("WORKSPACE FILES"));
    expect(ws).not.toContain("Platform standard");
    expect(today).not.toContain("Owner wants short captions");
  });

  it("rule 946: the learned-preference line is in block 2 only when the workspace block is non-empty", () => {
    const withWs = systemPrompt(GOLDEN_BRANDS.roastery, ["p"], noor, undefined, undefined, layers([], [item("Owner text")])).map((x) => x.text);
    expect(withWs[1]).toContain(LINE);
    expect(withWs[0]).not.toContain(LINE);
    expect(withWs[2]).toContain("OWNER PREFERENCES LEARNED FROM PAST EDITS (highest priority)");
    const onlyPlatform = systemPrompt(GOLDEN_BRANDS.roastery, ["p"], noor, undefined, undefined, layers([item("Platform only")], [])).map((x) => x.text);
    expect(onlyPlatform[1]).not.toContain(LINE);
    // A paused workspace renders nothing, so no line either.
    const paused = systemPrompt(GOLDEN_BRANDS.roastery, ["p"], noor, undefined, undefined, layers([], [item("Owner text")], { paused: true })).map((x) => x.text);
    expect(paused[1]).not.toContain(LINE);
  });
});

describe("the prompt stamp (rule 947)", () => {
  it("rule 947: promptStamp records plat and ins when given, and leaves them out otherwise", () => {
    expect(promptStamp("social", GOLDEN_BRANDS.roastery)).not.toHaveProperty("plat");
    expect(promptStamp("social", GOLDEN_BRANDS.roastery)).not.toHaveProperty("ins");
    const s = promptStamp("social", GOLDEN_BRANDS.roastery, { plat: "abc123def456", ins: "none" });
    expect(s).toMatchObject({ plat: "abc123def456", ins: "none" });
    // The other fields are what they were.
    expect({ ...s, plat: undefined, ins: undefined }).toEqual({ ...promptStamp("social", GOLDEN_BRANDS.roastery), plat: undefined, ins: undefined });
  });

  it("rule 947: the stamp of NO_LAYERS is none and none, and moves with the platform and the workspace text", () => {
    expect(instructionBlocks(NO_LAYERS, "noor").stamp).toEqual({ plat: "none", ins: "none" });
    const a = instructionBlocks(layers([item("One")], [item("Mine")]), "noor").stamp;
    const b = instructionBlocks(layers([item("Two")], [item("Mine")]), "noor").stamp;
    expect(a.plat).not.toBe("none");
    expect(a.plat).not.toBe(b.plat);
    expect(a.ins).toBe(b.ins);
  });
});

const run = (results: GoldenResult[]): GoldenRun => ({ id: "r", version: 0, trigger: "manual", startedAt: "2026-10-10T00:00:00.000Z", finishedAt: "2026-10-10T00:10:00.000Z", status: "complete", overall: null, usd: 0, results, agents: [], regressions: [], playbooks: {} }) as unknown as GoldenRun;
const res = (id: string, pb?: GoldenResult["pb"]): GoldenResult => ({ id, agent: "noor", type: "social", brand: "x", ok: true, score: 90, dims: null, notes: [], checks: [], items: [], ms: 1, delta: null, ...(pb ? { pb } : {}) }) as GoldenResult;
const changed = (r: GoldenRun) => r.agents.find((a) => a.agent === "noor")!.promptChanged;
const stampWith = (plat?: string) => ({ ...promptStamp("social", GOLDEN_BRANDS.roastery), ...(plat ? { plat } : {}) });

describe("golden promptChangeOf (rule 947)", () => {
  it("rule 947: a plat difference alone is a prompt change; the same plat is not", () => {
    const cur = run([res("n1", stampWith("aaa111aaa111"))]);
    summarize(cur, run([res("n1", stampWith("bbb222bbb222"))]));
    expect(changed(cur)).toBe(true);
    const same = run([res("n1", stampWith("aaa111aaa111"))]);
    summarize(same, run([res("n1", stampWith("aaa111aaa111"))]));
    expect(changed(same)).toBe(false);
  });

  it("rule 947: a row without plat (before this release) compares as before, so the first run after the release is not flagged", () => {
    const cur = run([res("n1", stampWith("aaa111aaa111"))]);
    summarize(cur, run([res("n1", stampWith())]));
    expect(changed(cur)).toBe(false);
    const back = run([res("n1", stampWith())]);
    summarize(back, run([res("n1", stampWith("aaa111aaa111"))]));
    expect(changed(back)).toBe(false);
  });
});

/**
 * The caller-level test: a stored workspace instruction with an attached reference file travels from Redis through
 * `generateBatch` to the system prompt the Anthropic client receives, and the stored task carries the stamp.
 */
const brand: Brand = { name: "مقهى الفنجان", website: "", industry: "مقاهي", dialect: "saudi", languages: ["ar"], tone: "ودود", products: "قهوة مختصة", audience: "الرياض", offers: "", competitors: "", banned: "رخيص", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-09-29T00:00:00.000Z" };
const reply = (text: string) => ({ model: "claude-opus-5", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 100 }, content: [{ type: "text", text }] });
const ITEM = { channel: "instagram", title: "قهوة اليوم", body: "نص تجريبي للعنصر يكفي للمراجعة" };

async function load() {
  vi.resetModules();
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  vi.doMock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));
  const systems: { text: string }[][] = [];
  vi.doMock("@anthropic-ai/sdk", () => ({
    default: class {
      static BadRequestError = class extends Error {};
      beta = { messages: { stream: (p: { system: { text: string }[] }) => { systems.push(p.system); return { finalMessage: async () => reply(JSON.stringify([ITEM])) }; } } };
      messages = {
        stream: () => ({ finalMessage: async () => reply("تمام") }),
        create: async () => reply(JSON.stringify([{ completeness: 90, brand: 90, honesty: 90, language: 90, format: 90, autofail: null, notes: "ready" }])),
      };
    },
  }));
  return { ...(await import("@/lib/generate-batch")), systems };
}

describe("generateBatch reads the layers (rules 946-947)", () => {
  afterEach(async () => {
    const { settle } = await import("./helpers/session");
    await settle();
    for (const m of ["@anthropic-ai/sdk", "@/lib/model"]) vi.doUnmock(m);
    vi.unstubAllEnvs();
    await db.del("skills:platform");
  });

  it("rule 946: a workspace instruction with an attached file reaches system block 2, the platform text reaches block 1, and the task is stamped", async () => {
    const u0 = await newUser("ip-batch");
    await db.set(`brand:${u0.email}`, brand);
    await saveUser({ ...(await getUser(u0.email))!, plan: "starter", credits: 500 });
    const u = (await getUser(u0.email))!;
    await writeFile(u.email, "style-guide.md", "REFERENCE FACT: sign off every caption with the shop hours.", "user");
    await db.set(`skills:${u.email}`, { active: set([item("Keep every caption under twenty words.", { refs: ["style-guide.md"] })]), draft: null, at: "x", by: null });
    await db.set("skills:platform", { active: set([item("Never use exclamation marks.")]), draft: null, at: "x", by: null });

    const { generateBatch, systems } = await load();
    const r = await generateBatch(u, u.email, { type: "social", source: "manual", via: "app" });
    expect(r.ok).toBe(true);
    const gen = systems.find((s) => s.length === 3);
    expect(gen, "the generation call sent the three-block system prompt").toBeTruthy();
    const [b1, b2] = gen!.map((x) => x.text);
    expect(b1).toContain("THAKEEN STANDARDS");
    expect(b1).toContain("Never use exclamation marks.");
    expect(b2).toContain("Keep every caption under twenty words.");
    expect(b2).toContain("REFERENCE FACT: sign off every caption with the shop hours.");
    expect(b2).not.toContain("Never use exclamation marks.");
    expect(b2).toContain(LINE);

    const tasks = await listTasks(u.email);
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      expect(t.pb?.plat).toMatch(/^[0-9a-f]{12}$/);
      expect(t.pb?.ins).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it("rule 947: an account with no instructions gets the unchanged prompt and a stamp that says none, explicitly", async () => {
    const u0 = await newUser("ip-batch-none");
    await db.set(`brand:${u0.email}`, brand);
    await saveUser({ ...(await getUser(u0.email))!, plan: "starter", credits: 500 });
    const u = (await getUser(u0.email))!;
    const { generateBatch, systems } = await load();
    const r = await generateBatch(u, u.email, { type: "social", source: "manual", via: "app" });
    expect(r.ok).toBe(true);
    const gen = systems.find((s) => s.length === 3)!;
    expect(gen[0].text).toBe(fixedPrompt(AGENTS.find((a) => a.id === "noor")!));
    expect(gen[1].text).not.toContain("OWNER INSTRUCTIONS");
    for (const t of await listTasks(u.email)) expect([t.pb?.plat, t.pb?.ins]).toEqual(["none", "none"]);
  });
});
