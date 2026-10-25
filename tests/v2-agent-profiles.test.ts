import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, AGENT_IDS, agentForTask } from "@/lib/agents";
import { AGENT_PROFILES, REVIEW_FOCUS, TASK_SPECS, agentProfile } from "@/lib/agent-profiles";
import { reviewerRubric, taskSpec } from "@/lib/noor";
import { promptHashes } from "@/lib/prompt-stamp";
import { contentHash } from "@/lib/skills";
import { TASK_TYPES } from "@/lib/tasks";
import { TOOL_CAPS, authorityOf } from "@/lib/tool-authority";

/**
 * Agents as config (Thakeen v2, C14, rules 4600-4605, docs/system/tests/4600-v2-agent-profiles.md). A refactor: the
 * specs and review focus moved into one typed profile per agent without changing a byte of any prompt.
 */
const src = (p: string) => readFileSync(p, "utf8");
const code = (p: string) =>
  src(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");

describe("every task type has exactly one spec, under its owner (rule 4600)", () => {
  it("each profile's specs are exactly its tasks, in that order", () => {
    for (const p of AGENT_PROFILES) expect(Object.keys(p.specs), p.id).toEqual(p.tasks);
  });
  it("the specs cover every task type once, and the owner is the agent that lists it", () => {
    const owners = AGENT_PROFILES.flatMap((p) => Object.keys(p.specs).map((t) => [t, p.id] as const));
    expect(owners.map(([t]) => t).sort()).toEqual([...TASK_TYPES].sort());
    for (const [t, id] of owners) expect(agentForTask(t as (typeof TASK_TYPES)[number]).id, t).toBe(id);
    expect(Object.keys(TASK_SPECS).sort()).toEqual([...TASK_TYPES].sort());
    for (const p of AGENT_PROFILES)
      for (const [t, s] of Object.entries(p.specs)) expect(TASK_SPECS[t as keyof typeof TASK_SPECS]).toBe(s);
  });
  it("Reem owns no task type and still has a review focus", () => {
    expect(agentProfile("reem").specs).toEqual({});
    expect(agentProfile("reem").reviewFocus).toMatch(/^Secretary fit:/);
  });
});

describe("a profile is the roster entry plus its prompt half (rule 4601)", () => {
  it("one profile per agent, in the roster's order, with the roster's own fields unchanged", () => {
    expect(AGENT_PROFILES.map((p) => p.id)).toEqual(AGENT_IDS);
    for (const a of AGENTS) {
      const { specs, reviewFocus, ...identity } = agentProfile(a.id);
      expect(identity).toEqual(a);
      expect(reviewFocus.length).toBeGreaterThan(40);
      expect(specs).toBeTypeOf("object");
      expect(REVIEW_FOCUS[a.id]).toBe(reviewFocus);
    }
  });
  it("every agent with a skills file has it in content/skills", () => {
    for (const a of AGENTS)
      if (a.skills) expect(existsSync(join("content", "skills", `${a.skills}.md`)), a.skills).toBe(true);
  });
  it("holds no tool, model or cap field: no agent differs from the defaults there today", () => {
    const fields = new Set(AGENT_PROFILES.flatMap((p) => Object.keys(p)));
    expect([...fields].sort()).toEqual([
      "id",
      "name",
      "persona",
      "reviewFocus",
      "role",
      "skills",
      "slices",
      "specs",
      "tasks",
    ]);
    for (const a of AGENT_IDS) for (const c of TOOL_CAPS) expect(authorityOf(undefined, a, c)).toBe("on");
  });
});

describe("the prompts read the profiles and nothing else (rule 4602)", () => {
  it("taskSpec and reviewerRubric take their text from the owner's profile", () => {
    for (const t of TASK_TYPES) {
      const p = agentProfile(agentForTask(t).id);
      expect(taskSpec(t)).toBe(p.specs[t]!.replaceAll("{CURRENCY}", "SAR"));
      expect(reviewerRubric(t)).toContain(`\n6. ${p.reviewFocus}\n`);
    }
    expect(taskSpec("ads", { city: "Dubai" })).toContain("AED");
  });
  it("noor.ts keeps no spec or review-focus map of its own", () => {
    const noor = code("src/lib/noor.ts");
    expect(noor).toContain('import { REVIEW_FOCUS, TASK_SPECS } from "./agent-profiles";');
    expect(noor).not.toMatch(/const (SPECS|REVIEW_FOCUS)\b/);
    expect(noor).not.toMatch(/\bweekly_plan: "/);
    expect(noor).not.toMatch(/\bnoor: "Platform fit/);
  });
});

describe("the prompt text stays out of the browser (rule 4603)", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });
  it("no client component imports agent-profiles, and the registry still imports types only", () => {
    const clients = walk("src").filter((p) => /^\s*["']use client["']/.test(src(p)));
    expect(clients.length).toBeGreaterThan(20);
    for (const f of clients) expect(src(f), f).not.toMatch(/agent-profiles["']/);
    const imports = src("src/lib/agents.ts")
      .split("\n")
      .filter((l) => /^\s*import\s/.test(l));
    expect(imports.every((l) => /^\s*import\s+type\s/.test(l))).toBe(true);
    const own = src("src/lib/agent-profiles.ts")
      .split("\n")
      .filter((l) => /^\s*import\s/.test(l));
    expect(own.map((l) => /from\s+["']([^"']+)["']/.exec(l)?.[1])).toEqual(["./agents", "./tasks"]);
  });
});

describe("the refactor changed no prompt (rule 4604)", () => {
  // The code hashes of all 26 task types, combined: the persona, RULES, OUTPUT FORMAT, task spec, reviewer rubric and judge
  // rubric each type is written and checked under (src/lib/prompt-stamp.ts). The value is the one the code had before C14.
  // A deliberate prompt change updates it in the same commit and is followed by a golden run.
  it("the combined code hash is the one before the profiles existed", () => {
    const codes = Object.entries(promptHashes(TASK_TYPES))
      .filter(([k]) => k.startsWith("code:"))
      .sort(([a], [b]) => (a < b ? -1 : 1));
    expect(codes).toHaveLength(26);
    expect(contentHash(codes.map(([k, v]) => `${k}=${v}`).join("\n"))).toBe("620b125dc3f7");
  });
});

describe("a profile is platform code, not customer data (rule 4605)", () => {
  it("agent-profiles.ts reads no store, request or environment", () => {
    expect(code("src/lib/agent-profiles.ts")).not.toMatch(/\bdb\b|process\.env|fetch\(|\bawait\b/);
  });
});
