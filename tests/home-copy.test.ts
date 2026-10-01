import { existsSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { CAST, AGENT_CAST, STORM, BANTER, SLOGAN, TRUTHS, HOME, type Feature } from "@/lib/home";
import { agentById, isAgentId } from "@/lib/agents";
import { isTaskType } from "@/lib/tasks";

/**
 * A question that no task type backs must point at a feature the app really has: the agent capability that performs it
 * (`skills` in `src/lib/agents.ts`) and the page where the owner sees it. Kept here, not in `home.ts`, so the copy cannot
 * vouch for itself.
 */
const FEATURES: Record<Feature, { skills: string; page: string }> = {
  todo: { skills: "secretary", page: "src/app/[lang]/app/todo/page.tsx" },
};

/**
 * Reem's homepage copy is a draft (spec §5.2), written when she had no reminders and no WhatsApp or Telegram. Phase 2
 * (PR #231) added timed reminders, in the app and by email; she still sends nothing on WhatsApp or Telegram (Telegram
 * is deferred). Until the founder approves copy that names the reminders, her lines stay free of all of these words,
 * in any spelling.
 */
const NOT_YET = [/remind/i, /whats\s*app/i, /telegram/i, /ذكّر/, /ذكر(ي)?ني/, /تذكير/, /واتس\s*اب/, /تي?لي?[جغ]رام/];
const promises = (text: string) => NOT_YET.filter((p) => p.test(text)).map(String);

describe("home copy is true to the product", () => {
  it("lists the eight agents in order, then the owner", () => {
    expect(CAST.map((c) => c.id)).toEqual(["noor", "sami", "razan", "faris", "dana", "majed", "layan", "reem", "you"]);
    expect(AGENT_CAST.map((c) => c.id)).toEqual(["noor", "sami", "razan", "faris", "dana", "majed", "layan", "reem"]);
  });
  it("gives every agent a value line, a name and at least four questions in both languages", () => {
    for (const a of AGENT_CAST) {
      expect([a.value.ar, a.value.en, a.name.ar, a.name.en].every(Boolean)).toBe(true);
      expect(a.questions.length).toBeGreaterThanOrEqual(4);
      for (const q of a.questions) expect(q.ar.length > 0 && q.en.length > 0).toBe(true);
    }
  });
  it("ties every question to a task that agent really does, or to a feature that agent really runs", () => {
    for (const a of AGENT_CAST) {
      const agent = agentById(a.id);
      // `agentById` falls back to Noor: make sure this is the agent itself.
      expect(agent.id).toBe(a.id);
      for (const q of a.questions) {
        const label = `${a.id}: ${q.en}`;
        // Exactly one backing: a task type or a feature.
        expect([q.task, q.feature].filter((x) => x !== undefined), label).toHaveLength(1);
        if (q.task !== undefined) {
          expect(isTaskType(q.task), label).toBe(true);
          expect(agent.tasks, label).toContain(q.task);
        } else {
          const feature = FEATURES[q.feature];
          expect(feature, label).toBeDefined();
          expect(agent.skills, label).toBe(feature.skills);
          expect(existsSync(join(process.cwd(), feature.page)), label).toBe(true);
        }
      }
    }
  });
  it("gives Reem, who owns no task type, only questions her to-do list answers", () => {
    const reem = AGENT_CAST.find((a) => a.id === "reem")!;
    expect(agentById("reem").tasks).toEqual([]);
    expect(reem.questions.map((q) => q.feature)).toEqual(reem.questions.map(() => "todo"));
  });
  it("never has Reem promise a reminder or a channel she does not have", () => {
    // The guard itself: each of these lines would promise something that does not exist.
    for (const bad of [
      "She reminds you on time.",
      "A reminder on WhatsApp",
      "Telegram alerts",
      "وتذكّرك بالموعد",
      "ذكريني بكرة",
      "تذكير يومي",
      "على الواتساب",
      "على واتس اب",
      "على تيليجرام",
      "على تلغرام",
    ]) {
      expect(promises(bad), bad).not.toEqual([]);
    }
    const reem = AGENT_CAST.find((a) => a.id === "reem")!;
    for (const text of [reem.value.ar, reem.value.en, ...reem.questions.flatMap((q) => [q.ar, q.en])]) {
      expect(promises(text), text).toEqual([]);
    }
  });
  it("builds the storm from exactly the agents' 41 questions", () => {
    expect(STORM).toHaveLength(41);
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
