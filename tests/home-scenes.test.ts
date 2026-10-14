import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { AGENT_CAST, SCENES, SCENES_COPY, type Feature } from "@/lib/home";
import { agentById } from "@/lib/agents";
import { isTaskType } from "@/lib/tasks";
import { PER_SLIDE } from "@/components/home/Stories";
import { AUTO_MS, autoplays, wrapIndex } from "@/components/home/SceneTrack";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** As in home-copy.test.ts: a line no task type backs must point at a feature the agent really runs. */
const FEATURES: Record<Feature, { skills: string; page: string }> = {
  todo: { skills: "secretary", page: "src/app/[lang]/app/todo/page.tsx" },
};
/** Reem's draft copy names no reminders, WhatsApp or Telegram (home-copy.test.ts). */
const NOT_YET = [/remind/i, /whats\s*app/i, /telegram/i, /ذكّر/, /ذكر(ي)?ني/, /تذكير/, /واتس\s*اب/, /تي?لي?[جغ]رام/];

describe("the scenes under the cover are illustrative and true to the product (rule 775)", () => {
  it("shows eight scenarios, four to a slide, in full slides (rule 1841)", () => {
    expect(SCENES.length).toBe(8);
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
  it("puts the line under the heading before the first scene; heading and line name no customers and say no \"example\" (rules 926, 1840)", () => {
    expect(SCENES_COPY.h.ar).toBe("كيف يشتغل ذكين مع أصحاب المحلات.");
    expect(SCENES_COPY.h.en).toBe("How Thakeen works with shop owners.");
    expect(SCENES_COPY.sub.ar).toBe("عندك محل؟ هذا اللي يسويه الفريق معك.");
    expect(SCENES_COPY.sub.en).toBe("Run a shop? Here's what the team does with you.");
    const copy = JSON.stringify(SCENES_COPY);
    expect(copy).not.toMatch(/مثال|أمثلة|Example|Illustrative/i);
    expect(copy).not.toMatch(/عملاء جربوا|customers who/i);
    const src = read("src/components/home/Stories.tsx");
    expect(src.indexOf("c.sub[lang]")).toBeGreaterThan(-1);
    expect(src.indexOf("c.sub[lang]")).toBeLessThan(src.indexOf("<SceneTrack"));
  });
  it("loops the slider: previous on the first slide lands on the last, next on the last lands on the first, no arrow is disabled", () => {
    const n = Math.ceil(SCENES.length / PER_SLIDE);
    expect(wrapIndex(-1, n)).toBe(n - 1);
    expect(wrapIndex(n, n)).toBe(0);
    expect(wrapIndex(0, n)).toBe(0);
    expect(wrapIndex(n - 1, n)).toBe(n - 1);
    expect(wrapIndex(3, 0)).toBe(0);
    expect(read("src/components/home/SceneTrack.tsx")).not.toMatch(/disabled=/);
  });
  it("slides by itself only while nothing asks it to stay put (WCAG 2.2.2)", () => {
    const on = { reduced: false, paused: false, held: false, over: false, focused: false, showing: true, n: 6 };
    expect(autoplays(on)).toBe(true);
    for (const k of ["reduced", "paused", "held", "over", "focused"] as const) expect(autoplays({ ...on, [k]: true }), k).toBe(false);
    expect(autoplays({ ...on, showing: false })).toBe(false);
    expect(autoplays({ ...on, n: 1 })).toBe(false);
    expect(AUTO_MS).toBeGreaterThanOrEqual(5000);
    expect(AUTO_MS).toBeLessThanOrEqual(10000);
  });
  it("gives the slider its own pause and play button, named in both languages, hidden for reduced motion", () => {
    for (const l of ["ar", "en"] as const) {
      expect(SCENES_COPY.pause[l].length, `pause ${l}`).toBeGreaterThan(0);
      expect(SCENES_COPY.play[l].length, `play ${l}`).toBeGreaterThan(0);
      expect(SCENES_COPY.pause[l]).not.toBe(SCENES_COPY.play[l]);
    }
    const track = read("src/components/home/SceneTrack.tsx");
    expect(track).toMatch(/useMotionPaused/);
    expect(track).toMatch(/aria-live=\{auto \? "off" : "polite"\}/);
    expect(read("src/components/home/Stories.tsx")).toMatch(/pause=\{c\.pause\[lang\]\} play=\{c\.play\[lang\]\}/);
    expect(read("src/components/home/home.module.css")).toMatch(/prefers-reduced-motion: reduce\) \{ \.autoBtn \{ display: none; \}/);
  });
  it("draws every face smiling, in an empty ring", () => {
    const person = read("src/components/home/Person.tsx");
    expect(person).toMatch(/The grin/);
    expect(read("src/components/home/Stories.tsx")).toMatch(/kind="circleLoop"[^>]*fill="none"/);
  });
  it("tells every card as a scenario: «لو عندك…» / \"If you run…\", one business per card, no repeat (rule 1840)", () => {
    for (const s of SCENES) {
      expect(s.line.ar.startsWith("لو عندك"), s.role.en).toBe(true);
      expect(s.line.en.startsWith("If you run"), s.role.en).toBe(true);
    }
    expect(new Set(SCENES.map((s) => s.role.en)).size).toBe(SCENES.length);
  });
  it("carries no stamp on the cards and quotes nobody: no blockquote, no like/learned tag (rules 1841-1842)", () => {
    expect(SCENES_COPY).not.toHaveProperty("stamp");
    const src = read("src/components/home/Stories.tsx");
    expect(src).not.toMatch(/s-stamp|c\.stamp/);
    expect(src).not.toMatch(/<blockquote|<figure|<figcaption/);
    expect(src).not.toMatch(/kinds\[/);
    expect(JSON.stringify(SCENES_COPY)).not.toMatch(/يعجبني|I like/);
  });
  it("sits right under the cover", () => {
    const page = read("src/app/[lang]/page.tsx");
    const at = ["<Cover ", "<Stories ", "<Rules "].map((c) => page.indexOf(c));
    for (const i of at) expect(i).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});
