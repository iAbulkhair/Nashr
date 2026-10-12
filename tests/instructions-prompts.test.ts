import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newUser } from "./helpers/session";
import { db } from "@/lib/db";
import { writeFile } from "@/lib/files";
import { AGENTS } from "@/lib/agents";
import { GOLDEN_BRANDS, summarize, type GoldenResult, type GoldenRun } from "@/lib/golden";
import { getUser, saveUser } from "@/lib/auth";
import { listTasks, type Brand, type Task } from "@/lib/brand";
import { INSTRUCTION_PLAN } from "@/lib/instructions-safety";
import type { Instruction, InstructionSet } from "@/lib/instructions-store";
import { NO_LAYERS, instructionBlocks, type Layers } from "@/lib/agent-instructions";
import { brandFileBlock, fixedPrompt, playbookBlock, systemPrompt } from "@/lib/noor";
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
  it("rule 946: with NO_LAYERS (or none passed) all three blocks are what they were before layers existed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    const brand = GOLDEN_BRANDS.roastery;
    const none = systemPrompt(brand, ["no emojis"], noor, "m1", "fb").map((b) => b.text);
    // Block 1 and the head of block 2 are built here from the pieces that existed before layers: no default argument is compared with itself.
    expect(none[0]).toBe(fixedPrompt(noor));
    expect(none[1].startsWith(`${brandFileBlock(brand)}\n\n${playbookBlock(brand)}\n\nWORKSPACE FILES (Noor's memory:`)).toBe(true);
    expect(systemPrompt(brand, [], noor).map((b) => b.text)[1]).toBe(`${brandFileBlock(brand)}\n\n${playbookBlock(brand)}`);
    for (const text of none) {
      for (const marker of ["THAKEEN STANDARDS", "OWNER INSTRUCTIONS", "<owner_instructions>", "<reference_files>", "HOW TO USE THEM", LINE]) expect(text).not.toContain(marker);
    }
    // Every shape of "nothing to render" gives the same three blocks: none passed, NO_LAYERS, an explicitly empty object,
    // empty sets, and a paused workspace (its items render nowhere).
    const empty: Layers = { platform: null, workspace: null, refs: {}, paused: false, limits: null };
    for (const l of [NO_LAYERS, empty, layers([], []), layers([], [item("Owner text")], { paused: true }), layers([], [item("Owner text")], { limits: null })]) {
      expect(systemPrompt(brand, ["no emojis"], noor, "m1", "fb", l).map((b) => b.text)).toEqual(none);
    }
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
    // Right after the industry playbook, then the workspace files: not merely somewhere after the brand file.
    const play = playbookBlock(GOLDEN_BRANDS.roastery);
    expect(ws.indexOf(block)).toBe(ws.indexOf(play) + play.length + 2);
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
  const creates: { system: string; user: string }[] = [];
  vi.doMock("@anthropic-ai/sdk", () => ({
    default: class {
      static BadRequestError = class extends Error {};
      beta = { messages: { stream: (p: { system: { text: string }[] }) => { systems.push(p.system); return { finalMessage: async () => reply(JSON.stringify([ITEM])) }; } } };
      messages = {
        // The reviewer and the judge stream through `metered` (rules 980-981); both are recorded like a `create`.
        stream: (b: { system: string | { text: string }[]; messages: { content: string }[] }) => {
          creates.push({ system: typeof b.system === "string" ? b.system : b.system.map((x) => x.text).join("\n"), user: b.messages[0].content });
          return { finalMessage: async () => reply(JSON.stringify([{ completeness: 90, brand: 90, honesty: 90, language: 90, format: 90, autofail: null, notes: "ready" }])) };
        },
        create: async (b: { system: { text: string }[]; messages: { content: string }[] }) => creates.push({ system: b.system.map((x) => x.text).join("\n"), user: b.messages[0].content }) && reply(JSON.stringify([{ completeness: 90, brand: 90, honesty: 90, language: 90, format: 90, autofail: null, notes: "ready" }])),
      };
    },
  }));
  return { ...(await import("@/lib/generate-batch")), systems, creates };
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

  it("rule 948: the same layers reach the reviewer and the judge of the batch (generateBatch hands them over)", async () => {
    const u0 = await newUser("ip-batch-judge");
    await db.set(`brand:${u0.email}`, brand);
    await saveUser({ ...(await getUser(u0.email))!, plan: "starter", credits: 500 });
    const u = (await getUser(u0.email))!;
    await db.set(`skills:${u.email}`, { active: set([item("Keep every caption under twenty words.")]), draft: null, at: "x", by: null });
    await db.set("skills:platform", { active: set([item("Judge standard", { agents: ["judge"] }), item("Reviewer standard", { agents: ["reviewer"] })]), draft: null, at: "x", by: null });
    const { generateBatch, creates } = await load();
    expect((await generateBatch(u, u.email, { type: "social", source: "manual", via: "app" })).ok).toBe(true);
    const { settle } = await import("./helpers/session");
    await settle();
    const reviewer = creates.find((c) => c.system.includes("quality reviewer"))!;
    const judge = creates.find((c) => c.system.includes("quality judge"))!;
    expect(reviewer.system).toContain("Reviewer standard");
    expect(reviewer.system).not.toContain("Judge standard");
    expect(reviewer.user).toContain("Keep every caption under twenty words.");
    expect(judge.system).toContain("Judge standard");
    expect(judge.system).not.toContain("Reviewer standard");
    expect(judge.user).toContain("Keep every caption under twenty words.");
    expect(judge.user).toContain(FOLLOWS);
  });

  it("rule 948: a workspace item that names the reviewer or the judge, written straight to Redis, reaches no prompt of the batch", async () => {
    const u0 = await newUser("ip-batch-raw");
    await db.set(`brand:${u0.email}`, brand);
    await saveUser({ ...(await getUser(u0.email))!, plan: "pro", credits: 500 });
    const u = (await getUser(u0.email))!;
    // Under the workspace layer's own key, with no validation on the way: the render must drop what the store would have refused.
    await db.set(`skills:${u.email}`, { active: set([item("RAW-REVIEWER secret rule", { agents: ["reviewer"] }), item("RAW-JUDGE secret rule", { agents: ["judge"] }), item("RAW-CONTROL keep captions short.", { agents: ["noor"] })]), draft: null, at: "x", by: null });
    const { generateBatch, systems, creates } = await load();
    expect((await generateBatch(u, u.email, { type: "social", source: "manual", via: "app" })).ok).toBe(true);
    const { settle } = await import("./helpers/session");
    await settle();
    const prompts = [...systems.flat().map((b) => b.text), ...creates.flatMap((c) => [c.system, c.user])].join("\n");
    const reviewer = creates.find((c) => c.system.includes("quality reviewer"))!;
    const judge = creates.find((c) => c.system.includes("quality judge"))!;
    expect(systems.length && reviewer && judge, "generate, reviewer and judge all ran").toBeTruthy();
    // The control item, written the same way but naming an agent, does arrive: the test would see a leak.
    for (const text of [systems.find((s) => s.length === 3)![1].text, reviewer.user, judge.user]) expect(text).toContain("RAW-CONTROL keep captions short.");
    expect(prompts).not.toContain("RAW-REVIEWER");
    expect(prompts).not.toContain("RAW-JUDGE");
  });
});

/**
 * Rule 948: the same layers reach the chat, the reviewer, the cross-reviewers, the judge and the image and video prompt
 * writer. The platform text goes to the system text, always for the agent that reads it (never from the workspace); the
 * owner's text goes next to the data it applies to (chat block 2, the user message of the others), fenced. A call
 * with no layers sends what it sent before layers existed.
 */
const PLAT = [
  item("PLAT-ALL"),
  item("PLAT-NOOR", { agents: ["noor"] }),
  item("PLAT-RAZAN", { agents: ["razan"] }),
  item("PLAT-REVIEWER", { agents: ["reviewer"] }),
  item("PLAT-JUDGE", { agents: ["judge"] }),
  item("PLAT-MEDIA", { agents: ["media"] }),
];
const WS = [
  item("WS-ALL"),
  item("WS-NOOR", { agents: ["noor"] }),
  item("WS-RAZAN", { agents: ["razan"] }),
  item("WS-MEDIA", { agents: ["media"] }),
  // Only the founder's layer may name the reviewer or the judge. One written straight to Redis is never rendered.
  item("WS-REVIEWER", { agents: ["reviewer"] }),
  item("WS-JUDGE", { agents: ["judge"] }),
];
const L948 = layers(PLAT, WS);
const only = (text: string, ...tokens: string[]) => tokens.forEach((t) => expect(text).toContain(t));
const none = (text: string, ...tokens: string[]) => tokens.forEach((t) => expect(text).not.toContain(t));
const FOLLOWS = "An item that follows an owner instruction is not marked down for it.";

describe("chat system() with layers (rule 948)", () => {
  // The chat's NOW block reads the clock: frozen so two builds in one test never straddle a minute boundary.
  // Only Date is faked; the Redis stub and dynamic imports keep real timers. The file's afterEach restores them.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T13:24:59.900Z"));
  });
  const sys = async (brand: Brand | null, l: Layers | undefined, agent: "noor" | "razan" = "noor") => {
    const { system } = await import("@/lib/chat");
    const u = await newUser("ip-chat");
    return system(brand, u, ["p1"], "--- m.md ---\nhello", ["a.md"], [], agent, undefined, undefined, undefined, ...(l ? [l] : [])).map((b) => b.text);
  };

  it("rule 948: block 1 gains the platform text for the chat's agent, identical across two brands; the workspace text stays out of it", async () => {
    const platform = instructionBlocks(L948, "noor").platform;
    const base = (await sys(brand, undefined))[0];
    const a = (await sys(brand, L948))[0];
    const b = (await sys({ ...brand, name: "عيادة" }, L948))[0];
    expect(a).toBe(`${base}\n\n${platform}`);
    expect(b).toBe(a);
    only(a, "THAKEEN STANDARDS", "PLAT-ALL", "PLAT-NOOR");
    none(a, "PLAT-RAZAN", "PLAT-REVIEWER", "PLAT-JUDGE", "PLAT-MEDIA", "WS-ALL", "WS-NOOR", "OWNER INSTRUCTIONS");
  });

  it("rule 948: the workspace block sits in block 2 after the brand file and the owner preferences, before the memory files, with the precedence line", async () => {
    const [, ws, now] = await sys(brand, L948);
    const block = instructionBlocks(L948, "noor").workspace;
    only(ws, block, "WS-ALL", "WS-NOOR", LINE);
    none(ws, "WS-RAZAN", "WS-MEDIA", "PLAT-ALL", "THAKEEN STANDARDS");
    expect(ws.indexOf("OWNER PREFERENCES: p1")).toBeGreaterThan(ws.indexOf("<brand_file>"));
    expect(ws.indexOf(block)).toBeGreaterThan(ws.indexOf("OWNER PREFERENCES: p1"));
    expect(ws.indexOf(block)).toBeLessThan(ws.indexOf("MEMORY FILES"));
    none(now, "WS-ALL", "PLAT-ALL", "OWNER INSTRUCTIONS");
  });

  it("rule 948: another agent's chat reads its own items, and no workspace item that names the reviewer or the judge reaches any prompt", async () => {
    const [fixed, ws] = await sys(brand, L948, "razan");
    only(fixed, "PLAT-ALL", "PLAT-RAZAN");
    none(fixed, "PLAT-NOOR");
    only(ws, "WS-ALL", "WS-RAZAN");
    none(ws, "WS-NOOR", "WS-REVIEWER", "WS-JUDGE");
  });

  it("rule 948: no layers, NO_LAYERS or nothing that applies leaves all three blocks as they were", async () => {
    const before = await sys(brand, undefined);
    none(before.join("\n"), "THAKEEN STANDARDS", "OWNER INSTRUCTIONS", "<owner_instructions>", LINE);
    only(before[2], "NOW (Riyadh, UTC+3)", "4:24 PM"); // the frozen clock, not the real one
    for (const l of [NO_LAYERS, layers([], []), layers([], WS, { paused: true }), layers([], WS, { limits: null })]) expect(await sys(brand, l)).toEqual(before);
  });
});

/** A fresh noor/judge/prompts pair over a recording SDK: every `messages.stream` or `create` call is kept with its system text and user message. */
type Call = { system: string; user: string };
async function loadModels() {
  vi.resetModules();
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  vi.doMock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "on" as const }));
  const calls: Call[] = [];
  const answer = JSON.stringify([{ ok: true, id: 1, verdict: "ok", completeness: 90, brand: 90, honesty: 90, language: 90, format: 90, autofail: null, notes: "ready" }]);
  const gen = JSON.stringify([{ channel: "instagram", title: "قهوة اليوم", body: "نص تجريبي للعنصر يكفي للمراجعة والتدقيق" }]);
  const text = (t: string) => ({ model: "claude-sonnet-5-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: t }] });
  vi.doMock("@anthropic-ai/sdk", () => ({
    default: class {
      static BadRequestError = class extends Error {};
      beta = { messages: { stream: () => ({ finalMessage: async () => text(gen) }) } };
      messages = {
        // Generation streams through `beta`; the reviewer, cross-review, judge and media prompts stream here (rules 980-981).
        stream: (b: { system: string | { text: string }[]; messages: { content: string }[] }) => {
          calls.push({ system: typeof b.system === "string" ? b.system : b.system.map((x) => x.text).join("\n"), user: b.messages[0].content });
          return { finalMessage: async () => text(answer) };
        },
        create: async (b: { system: string | { text: string }[]; messages: { content: string }[] }) => {
          calls.push({ system: typeof b.system === "string" ? b.system : b.system.map((x) => x.text).join("\n"), user: b.messages[0].content });
          return text(answer);
        },
      };
    },
  }));
  return { noor: await import("@/lib/noor"), judge: await import("@/lib/judge"), prompts: await import("@/lib/media/prompts"), calls };
}
const unload = () => { for (const m of ["@anthropic-ai/sdk", "@/lib/model"]) vi.doUnmock(m); vi.unstubAllEnvs(); };
const owner = (user: string) => user.slice(user.indexOf("<owner_instructions>"), user.indexOf("</owner_instructions>"));

describe("reviewer and cross-review with layers (rule 948)", () => {
  afterEach(unload);

  it("rule 948: the reviewer's system text gains the reviewer platform block only; the owner's instructions are data in its user message", async () => {
    const m = await loadModels();
    await m.noor.generate("social", brand, [], "", { crossReview: false, layers: L948 });
    expect(m.calls).toHaveLength(1);
    const { system, user } = m.calls[0];
    expect(system).toBe(`${m.noor.reviewerPrompt("social")}\n\n${instructionBlocks(L948, "reviewer").platform}`);
    only(system, "THAKEEN STANDARDS", "PLAT-REVIEWER");
    none(system, "PLAT-ALL", "PLAT-NOOR", "PLAT-JUDGE", "WS-ALL", "WS-NOOR", "OWNER INSTRUCTIONS");
    // The owning agent's workspace block, next to <owner_preferences>, before the items.
    const block = instructionBlocks(L948, "reviewer", "noor").workspace;
    only(user, block, "WS-ALL", "WS-NOOR", "<owner_instructions>");
    none(user, "WS-RAZAN", "WS-MEDIA", "WS-REVIEWER", "WS-JUDGE", "PLAT-");
    expect(user.indexOf("</owner_preferences>")).toBeLessThan(user.indexOf("<owner_instructions>"));
    expect(user.indexOf("</owner_instructions>")).toBeLessThan(user.indexOf("<items>"));
  });

  it("rule 948: the reviewer's system text is the same for two brands with different workspace sets; only its user message differs", async () => {
    const m = await loadModels();
    await m.noor.generate("social", brand, [], "", { crossReview: false, layers: layers(PLAT, [item("WS-ONE")]) });
    await m.noor.generate("social", { ...brand, name: "عيادة" }, [], "", { crossReview: false, layers: layers(PLAT, [item("WS-TWO"), item("WS-THREE", { agents: ["noor"] })]) });
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1].system).toBe(m.calls[0].system);
    only(m.calls[0].user, "WS-ONE");
    only(m.calls[1].user, "WS-TWO", "WS-THREE");
    none(m.calls[1].user, "WS-ONE");
  });

  it("rule 948: with no layers the reviewer's system text and user message carry no instruction text", async () => {
    const m = await loadModels();
    await m.noor.generate("social", brand, [], "", { crossReview: false });
    await m.noor.generate("social", brand, [], "", { crossReview: false, layers: layers([], []) });
    expect(m.calls[0].system).toBe(m.noor.reviewerPrompt("social"));
    expect(m.calls[1]).toEqual(m.calls[0]);
    none(m.calls[0].user, "OWNER INSTRUCTIONS", "owner_instructions");
  });

  it("rule 948: both cross-reviewers get the reviewer platform block in their system text and the author's owner instructions as data in the shared user message", async () => {
    const m = await loadModels();
    const author = (await import("@/lib/agents")).agentForTask("gtm_plan").id;
    const l = layers(PLAT, [item("WS-ALL"), item(`WS-AUTHOR-${author}`, { agents: [author] }), item("WS-NOOR", { agents: ["noor"] })]);
    await m.noor.generate("gtm_plan", brand, [], "", { reviewer: false, layers: l });
    const cross = m.calls.filter((c) => c.system.startsWith("You are Razan") || c.system.startsWith("You are Majed"));
    expect(cross).toHaveLength(2);
    for (const c of cross) {
      expect(c.system.endsWith(`\n\n${instructionBlocks(l, "reviewer").platform}`)).toBe(true);
      only(c.system, "PLAT-REVIEWER");
      none(c.system, "PLAT-ALL", "WS-ALL");
      only(owner(c.user), "WS-ALL", `WS-AUTHOR-${author}`);
      none(c.user, "WS-NOOR", "PLAT-");
      expect(c.user.indexOf("</owner_instructions>")).toBeLessThan(c.user.indexOf("<items>"));
    }
    expect(cross[0].user).toBe(cross[1].user);
    // A batch with no layers sends the prompt it sent before.
    m.calls.length = 0;
    await m.noor.generate("gtm_plan", brand, [], "", { reviewer: false });
    for (const c of m.calls) {
      expect(c.system).toBe(c.system.startsWith("You are Razan") ? m.noor.crossReviewPrompt("razan") : m.noor.crossReviewPrompt("majed"));
      none(c.user, "owner_instructions");
    }
  });
});

describe("judge with layers (rule 948)", () => {
  afterEach(unload);
  const items = [{ channel: "instagram", title: "t", body: "نص تجريبي للعنصر يكفي للتقييم" }];

  it("rule 948: the judge's system text gains the judge platform block; the owner's instructions and the not-marked-down line are in its user message", async () => {
    const m = await loadModels();
    await m.judge.scoreItems("j@test.example", brand, "social", items, 1, { layers: L948 });
    const { system, user } = m.calls[0];
    expect(system).toBe(`${m.judge.JUDGE_RUBRIC}${(await import("@/lib/skills")).reviewBlock()}\n\n${instructionBlocks(L948, "judge").platform}`);
    only(system, "THAKEEN STANDARDS", "PLAT-JUDGE");
    none(system, "PLAT-ALL", "PLAT-REVIEWER", "WS-ALL", FOLLOWS);
    only(owner(user), "WS-ALL", "WS-NOOR");
    none(user, "WS-RAZAN", "WS-REVIEWER", "WS-JUDGE", "WS-MEDIA", "PLAT-");
    only(user, FOLLOWS);
    expect(user.indexOf(FOLLOWS)).toBeGreaterThan(user.indexOf("</owner_instructions>"));
    expect(user.indexOf(FOLLOWS)).toBeLessThan(user.indexOf("<items>"));
  });

  it("rule 948: with no layers (or nothing that applies) the judge's call is what it was", async () => {
    const m = await loadModels();
    await m.judge.scoreItems("j@test.example", brand, "social", items, 1);
    await m.judge.scoreItems("j@test.example", brand, "social", items, 1, { layers: layers([], []) });
    expect(m.calls[0].system).toBe(`${m.judge.JUDGE_RUBRIC}${(await import("@/lib/skills")).reviewBlock()}`);
    expect(m.calls[1]).toEqual(m.calls[0]);
    none(m.calls[0].user, "owner_instructions", FOLLOWS);
  });
});

describe("media prompt writer with layers (rule 948)", () => {
  afterEach(unload);
  const post = { id: "t1", type: "social", channel: "instagram", title: "قهوة", body: "قهوة مختصة محمصة اليوم", status: "pending", createdAt: "2026-10-10T00:00:00.000Z", lang: "ar" } as Task;

  it("rule 948: the image prompt's system text gains the media platform block; the user message carries the items for media, all and the task's agent", async () => {
    const m = await loadModels();
    await m.prompts.imagePrompt(brand, post, "img-fast", "square", "o@test.example", 10_000);
    await m.prompts.imagePrompt(brand, post, "img-fast", "square", "o@test.example", 10_000, L948);
    const [bare, withL] = m.calls;
    expect(withL.system).toBe(`${bare.system}\n\n${instructionBlocks(L948, "media").platform}`);
    only(withL.system, "THAKEEN STANDARDS", "PLAT-ALL", "PLAT-MEDIA");
    none(withL.system, "PLAT-NOOR", "PLAT-RAZAN", "PLAT-REVIEWER", "WS-");
    expect(withL.user.startsWith(bare.user)).toBe(true);
    only(owner(withL.user), "WS-ALL", "WS-NOOR", "WS-MEDIA");
    none(withL.user, "WS-RAZAN", "WS-REVIEWER", "WS-JUDGE", "PLAT-");
    // Without layers the call is what it was: the system text is the writer's alone and the user message holds the post only.
    none(bare.system, "THAKEEN STANDARDS");
    none(bare.user, "owner_instructions");
  });

  it("rule 948: the video prompt reads the same layers", async () => {
    const m = await loadModels();
    await m.prompts.videoPrompt(brand, post, "vid-quick", false, "o@test.example", 10_000, L948);
    const { system, user } = m.calls[0];
    only(system, "PLAT-MEDIA");
    only(owner(user), "WS-MEDIA", "WS-NOOR");
  });

  it("rule 948: the fallback template gets none, whatever the layers: its output is the fixed template (model paused)", async () => {
    vi.resetModules();
    vi.doMock("@/lib/model", async (orig) => ({ ...(await orig<typeof import("@/lib/model")>()), modelState: () => "paused" as const }));
    const p = await import("@/lib/media/prompts");
    expect(await p.imagePrompt(brand, post, "img-fast", "square", undefined, 10_000, L948)).toBe(p.fixedImagePrompt(brand, post, "img-fast", "square"));
    expect(await p.videoPrompt(brand, post, "vid-quick", false, undefined, 10_000, L948)).toBe(p.fixedVideoPrompt(brand, post, "vid-quick", false));
    for (const text of [p.fixedImagePrompt(brand, post, "img-fast", "square"), p.fixedVideoPrompt(brand, post, "vid-quick", false)]) none(text, "WS-", "PLAT-");
    vi.doUnmock("@/lib/model");
  });
});

describe("the render start loads the layers (rule 948)", () => {
  // Also on a failed assertion: the platform key is shared by every test in the file.
  afterEach(async () => { for (const m of ["@/lib/media/prompts", "@/lib/media/jobs", "@/lib/media/config"]) vi.doUnmock(m); await db.del("skills:platform"); });

  it("rule 948: renderImage and renderVideo pass the caller's own layers for media and the item's agent to the prompt writer", async () => {
    vi.resetModules();
    const seen: { kind: string; layers?: Layers }[] = [];
    vi.doMock("@/lib/media/prompts", async (orig) => ({
      ...(await orig<typeof import("@/lib/media/prompts")>()),
      imagePrompt: async (...a: unknown[]) => { seen.push({ kind: "image", layers: a[6] as Layers }); return "p"; },
      videoPrompt: async (...a: unknown[]) => { seen.push({ kind: "video", layers: a[6] as Layers }); return "p"; },
    }));
    vi.doMock("@/lib/media/jobs", async (orig) => ({
      ...(await orig<typeof import("@/lib/media/jobs")>()),
      startMedia: async (input: { prompt(ms: number): Promise<string> }) => { await input.prompt(10_000); return { ok: false, status: 409, error: "model_unavailable" }; },
    }));
    vi.doMock("@/lib/media/config", async (orig) => ({ ...(await orig<typeof import("@/lib/media/config")>()), modelAvailable: () => true }));
    const u0 = await newUser("ip-media");
    await saveUser({ ...(await getUser(u0.email))!, plan: "pro", credits: 500 });
    const u = (await getUser(u0.email))!;
    await writeFile(u.email, "look.md", "REFERENCE FACT: warm light.", "user");
    await db.set(`skills:${u.email}`, { active: set([item("Keep the light warm.", { agents: ["media"], refs: ["look.md"] }), item("Never touch Razan.", { agents: ["razan"] })]), draft: null, at: "x", by: null });
    await db.set("skills:platform", { active: set([item("Media standard", { agents: ["media"] })]), draft: null, at: "x", by: null });
    const { renderImage, renderVideo } = await import("@/lib/media/start");
    const t = { id: "t2", type: "social", channel: "instagram", title: "t", body: "b", status: "pending", createdAt: "2026-10-10T00:00:00.000Z", lang: "ar" } as Task;
    await renderImage(u, t, brand, "img-fast", { deadline: Date.now() + 60_000 });
    await renderVideo(u, t, brand, "vid-quick", { deadline: Date.now() + 60_000 });
    expect(seen.map((s) => s.kind)).toEqual(["image", "video"]);
    for (const { layers } of seen) {
      expect(layers, "layers passed").toBeTruthy();
      const b = instructionBlocks(layers!, "media", "noor");
      only(b.platform, "Media standard");
      only(b.workspace, "Keep the light warm.", "REFERENCE FACT: warm light.");
      none(b.workspace, "Never touch Razan.");
    }
  });
});
