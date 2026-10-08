import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { AGENT_CAST, SCENES, SCENES_COPY, type Feature } from "@/lib/home";
import { agentById } from "@/lib/agents";
import { isTaskType } from "@/lib/tasks";
import { PER_SLIDE } from "@/components/home/Stories";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** As in home-copy.test.ts: a line no task type backs must point at a feature the agent really runs. */
const FEATURES: Record<Feature, { skills: string; page: string }> = {
  todo: { skills: "secretary", page: "src/app/[lang]/app/todo/page.tsx" },
};
/** Reem's draft copy names no reminders, WhatsApp or Telegram (home-copy.test.ts). */
const NOT_YET = [/remind/i, /whats\s*app/i, /telegram/i, /ذكّر/, /ذكر(ي)?ني/, /تذكير/, /واتس\s*اب/, /تي?لي?[جغ]رام/];

describe("the scenes under the cover are illustrative and true to the product (rule 775)", () => {
  it("draws more than twenty people, four to a slide, in full slides", () => {
    expect(SCENES.length).toBeGreaterThan(20);
    expect(PER_SLIDE).toBe(4);
    expect(SCENES.length % PER_SLIDE).toBe(0);
  });
  it("gives every scene a role and a line in both languages, and names a role, never a person", () => {
    const names = AGENT_CAST.flatMap((a) => [a.name.ar, a.name.en]);
    for (const s of SCENES) {
      expect([s.role.ar, s.role.en, s.line.ar, s.line.en].every(Boolean)).toBe(true);
      for (const n of names) expect(s.role.ar.includes(n) || s.role.en.includes(n), s.role.en).toBe(false);
    }
  });
  it("ties every line to a task its agent really does, or a feature it really runs", () => {
    for (const s of SCENES) {
      const agent = agentById(s.agent);
      expect(agent.id, s.role.en).toBe(s.agent);
      expect([s.task, s.feature].filter((x) => x !== undefined), s.role.en).toHaveLength(1);
      if (s.task !== undefined) {
        expect(isTaskType(s.task), s.role.en).toBe(true);
        expect(agent.tasks, s.role.en).toContain(s.task);
      } else {
        expect(agent.skills, s.role.en).toBe(FEATURES[s.feature].skills);
        expect(existsSync(join(process.cwd(), FEATURES[s.feature].page)), s.role.en).toBe(true);
      }
    }
  });
  it("names the agent the line is about, in both languages", () => {
    for (const s of SCENES) {
      const a = AGENT_CAST.find((x) => x.id === s.agent)!;
      expect(s.line.ar.includes(a.name.ar), s.role.en).toBe(true);
      expect(s.line.en.includes(a.name.en), s.role.en).toBe(true);
    }
  });
  it("invents no number: no digit in any scene, Latin or Arabic-Indic", () => {
    for (const s of SCENES) for (const t of [s.role.ar, s.role.en, s.line.ar, s.line.en]) expect(t, t).not.toMatch(/[0-9٠-٩۰-۹%٪]/);
  });
  it("keeps Reem's lines free of what she does not do yet", () => {
    for (const s of SCENES.filter((x) => x.agent === "reem")) for (const p of NOT_YET) expect(`${s.line.ar} ${s.line.en}`).not.toMatch(p);
  });
  it("says on the page, before the first scene, that these are not customer reviews", () => {
    expect(SCENES_COPY.note.ar).toMatch(/توضيحية/);
    expect(SCENES_COPY.note.en).toMatch(/not customer reviews/i);
    const src = read("src/components/home/Stories.tsx");
    expect(src.indexOf("c.note[lang]")).toBeGreaterThan(-1);
    expect(src.indexOf("c.note[lang]")).toBeLessThan(src.indexOf("<SceneTrack"));
  });
  it("draws every face smiling, in an empty ring", () => {
    const person = read("src/components/home/Person.tsx");
    expect(person).toMatch(/The grin/);
    expect(read("src/components/home/Stories.tsx")).toMatch(/kind="circleLoop"[^>]*fill="none"/);
  });
  it("sits right under the cover", () => {
    const page = read("src/app/[lang]/page.tsx");
    const at = ["<Cover ", "<Stories ", "<Rules "].map((c) => page.indexOf(c));
    for (const i of at) expect(i).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});
