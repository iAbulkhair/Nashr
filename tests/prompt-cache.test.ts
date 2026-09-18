import { afterEach, describe, expect, it, vi } from "vitest";
import { systemPrompt } from "@/lib/noor";
import { AGENTS } from "@/lib/agents";
import { GOLDEN_BRANDS } from "@/lib/golden";

// Prompt caching only hits on an identical prefix. These tests pin the block order that makes hits possible.
const noor = AGENTS.find((a) => a.id === "noor")!;
const sami = AGENTS.find((a) => a.id === "sami")!;

describe("generation system prompt", () => {
  afterEach(() => vi.useRealTimers());

  it("is three blocks: static per agent (cached), per workspace (cached), volatile (not cached)", () => {
    const b = systemPrompt(GOLDEN_BRANDS.roastery, ["no emojis"], noor, "--- brand.md ---\nhello");
    expect(b).toHaveLength(3);
    expect(b[0].cache_control).toEqual({ type: "ephemeral" });
    expect(b[1].cache_control).toEqual({ type: "ephemeral" });
    expect("cache_control" in b[2]).toBe(false);
  });

  it("keeps the static block identical across brands, preferences and days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T10:00:00Z"));
    const a = systemPrompt(GOLDEN_BRANDS.roastery, ["a"], noor, "m1")[0].text;
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    const c = systemPrompt(GOLDEN_BRANDS.clinic, ["b", "c"], noor, "m2")[0].text;
    expect(a).toBe(c);
  });

  it("puts every section where it belongs and repeats no header", () => {
    const [fixed, workspace, today] = systemPrompt(GOLDEN_BRANDS.roastery, ["no emojis"], noor, "--- brand.md ---\nhello").map((x) => x.text);
    for (const h of ["RULES", "SKILLS PLAYBOOK", "OUTPUT FORMAT"]) expect(fixed.split(h).length - 1).toBe(1);
    expect(fixed).not.toContain(GOLDEN_BRANDS.roastery.name);
    expect(fixed).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(workspace.split("BRAND FILE").length - 1).toBe(1);
    expect(workspace).toContain(GOLDEN_BRANDS.roastery.name);
    expect(workspace).toContain("WORKSPACE FILES");
    expect(today).toMatch(/TODAY: \d{4}-\d{2}-\d{2}/);
    expect(today).toContain("no emojis");
  });

  it("gives each agent its own static block", () => {
    expect(systemPrompt(GOLDEN_BRANDS.saas, [], noor)[0].text).not.toBe(systemPrompt(GOLDEN_BRANDS.saas, [], sami)[0].text);
  });
});
