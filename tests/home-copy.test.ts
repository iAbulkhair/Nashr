import { describe, expect, it } from "vitest";
import { CAST, AGENT_CAST, STORM, BANTER, SLOGAN, TRUTHS, HOME } from "@/lib/home";
import { agentById, isAgentId } from "@/lib/agents";
import { isTaskType } from "@/lib/tasks";

describe("home copy is true to the product", () => {
  it("lists the seven agents in order, then the owner", () => {
    expect(CAST.map((c) => c.id)).toEqual(["noor", "sami", "razan", "faris", "dana", "majed", "layan", "you"]);
    expect(AGENT_CAST.map((c) => c.id)).toEqual(["noor", "sami", "razan", "faris", "dana", "majed", "layan"]);
  });
  it("gives every agent a value line, a name and at least four questions in both languages", () => {
    for (const a of AGENT_CAST) {
      expect([a.value.ar, a.value.en, a.name.ar, a.name.en].every(Boolean)).toBe(true);
      expect(a.questions.length).toBeGreaterThanOrEqual(4);
      for (const q of a.questions) expect(q.ar.length > 0 && q.en.length > 0).toBe(true);
    }
  });
  it("ties every question to a task that agent really does", () => {
    for (const a of AGENT_CAST) for (const q of a.questions) {
      expect(isTaskType(q.task), `${a.id}: ${q.en}`).toBe(true);
      expect(agentById(a.id).tasks, `${a.id}: ${q.en}`).toContain(q.task);
    }
  });
  it("builds the storm from exactly the agents' 36 questions", () => {
    expect(STORM).toHaveLength(36);
    expect(STORM).toEqual(AGENT_CAST.flatMap((a) => a.questions));
  });
  it("keeps the approved slogan and finale verbatim", () => {
    expect(SLOGAN.line1.ar).toBe("ذكين. الذكي المكين.");
    expect(SLOGAN.line2.ar).toBe("أسئلة كثيرة تدور في راسك كل يوم… وذكين يحلها.");
    expect(HOME.finaleWord.ar).toBe("موافق.");
    expect(CAST.find((c) => c.id === "you")?.questions).toEqual([]);
  });
  it("has four banter exchanges spoken only by agents, and four truths", () => {
    expect(BANTER).toHaveLength(4);
    for (const b of BANTER) for (const l of b.lines) expect(isAgentId(l.who)).toBe(true);
    expect(TRUTHS).toHaveLength(4);
  });
});
