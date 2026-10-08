import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { AGENT_CAST } from "@/lib/home";
import { PER_SLIDE, STORIES, STORIES_LIST } from "@/lib/stories";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const lines = STORIES_LIST.flatMap((s) => [s.say.ar, s.say.en, s.role.ar, s.role.en]);

describe("the homepage stories are labelled illustrations, never invented customers", () => {
  it("has more than twenty personas, filling whole slides of four", () => {
    expect(STORIES_LIST.length).toBeGreaterThan(20);
    expect(STORIES_LIST.length % PER_SLIDE).toBe(0);
    expect(PER_SLIDE).toBe(4);
    expect(new Set(STORIES_LIST.map((s) => s.id)).size).toBe(STORIES_LIST.length);
  });
  it("gives each persona both languages, a real agent, a kind and a drawable look", () => {
    const agents = AGENT_CAST.map((a) => a.id);
    for (const s of STORIES_LIST) {
      expect(s.say.ar.trim() && s.say.en.trim() && s.role.ar.trim() && s.role.en.trim(), s.id).toBeTruthy();
      expect(agents, s.id).toContain(s.who);
      expect(Object.keys(STORIES.kind), s.id).toContain(s.kind);
      expect(["short", "long", "bun", "curly", "bald", "cap"], s.id).toContain(s.look.hair);
    }
  });
  it("uses every agent at least once, so no one is left out of the slides", () => {
    expect(new Set(STORIES_LIST.map((s) => s.who))).toEqual(new Set(AGENT_CAST.map((a) => a.id)));
  });
  it("invents no figures, results or time saved", () => {
    for (const t of lines) {
      // The only number allowed is Faris's real 90-day plan (his value line on the homepage).
      expect(t.replace(/90-day|٩٠/g, ""), t).not.toMatch(/[0-9٠-٩]|%|٪/);
      expect(t, t).not.toMatch(/\b(faster|saved|saves|doubled|tripled|grew|increase[ds]?|roi)\b|أسرع|وفّر|ضاعف|زادت مبيعاتي/i);
    }
  });
  it("names no person and no company: a persona is a role", () => {
    for (const s of STORIES_LIST) expect(s.role.en, s.id).not.toMatch(/\b(Mr|Mrs|Dr|Co|Ltd|LLC|Inc)\b|[A-Z][a-z]+ [A-Z][a-z]+ (Cafe|Café|Clinic|Salon)/);
  });
  it("keeps Reem's lines free of promises she cannot keep yet (WhatsApp, Telegram, reminders)", () => {
    for (const s of STORIES_LIST.filter((x) => x.who === "reem")) {
      for (const t of [s.say.ar, s.say.en]) expect(t, t).not.toMatch(/remind|whats\s*app|telegram|ذكّر|تذكير|واتس|تلي?جرام/i);
    }
  });
  it("badges the section as illustrative, and mounts it right under the cover", () => {
    expect(STORIES.badge.en).toMatch(/illustrative/i);
    expect(STORIES.badge.en).toMatch(/not real customer/i);
    expect(src("src/components/home/Stories.tsx")).toMatch(/STORIES\.badge\[lang\]/);
    const page = src("src/app/[lang]/page.tsx");
    const at = ["<Cover ", "<Stories ", "<Rules "].map((c) => page.indexOf(c));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
  it("keeps the faces out of the accessibility tree", () => {
    expect(src("src/components/home/Avatar.tsx")).toMatch(/aria-hidden="true"/);
    expect(src("src/components/home/Stories.tsx")).toMatch(/className=\{`\$\{styles\.dface\} \$\{styles\.dfaceLg\}`\} aria-hidden="true"/);
  });
  it("draws every face happy: a smile on each, brows arched up, never slanted", () => {
    const avatar = src("src/components/home/Avatar.tsx");
    expect(avatar).toMatch(/const SMILES = \[/);
    expect(avatar).toMatch(/smileOnInk/);
    const brows = avatar.match(/const BROWS = \[([^\]]*)\]/)?.[1] ?? "";
    expect(brows).toMatch(/q/);
    expect(brows).not.toMatch(/ L/);
  });
});
