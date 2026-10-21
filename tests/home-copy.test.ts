import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { CAST, AGENT_CAST, STORM, BANTER, SLOGAN, TRUTHS, HOME, HERO, RULES, DAY, STEPS, HOME_FAQ, SECTIONS, HOME_NAV, RULE_LABEL, PLANS, STEP7_LINK, type Feature, type L } from "@/lib/home";
import { dict } from "@/lib/i18n";
import { agentById, isAgentId } from "@/lib/agents";
import { isTaskType } from "@/lib/tasks";

/**
 * A question that no task type backs must point at a feature the app really has: the agent capability that performs it
 * (`skills` in `src/lib/agents.ts`) and the page where the owner sees it. Kept here, not in `home.ts`, so the copy cannot
 * vouch for itself.
 */
const FEATURES: Record<Feature, { skills: string; page: string }> = {
  todo: { skills: "secretary", page: "src/app/[lang]/app/b/[brand]/todo/page.tsx" },
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

/** Every visible string of prototype D's homepage copy, both languages. */
const dCopy = (): string[] => {
  const ls: L[] = [
    ...Object.values(HERO),
    ...Object.values(SECTIONS).flatMap((s) => Object.values(s)),
    ...RULES.flatMap((r) => [r.law, ...r.lines.map((l) => l.text)]),
    ...Object.values(DAY).flatMap((p) => Object.values(p).filter((v): v is L => typeof v === "object" && !Array.isArray(v))),
    ...STEPS.flatMap((s) => [s.title, s.body, s.aside, ...(s.paused ? [s.paused] : [])]),
    ...HOME_FAQ.flatMap((f) => [f.q, f.a]),
    ...HOME_NAV.map((n) => n.label),
    RULE_LABEL,
    PLANS.h,
    PLANS.tape,
    PLANS.rule,
    PLANS.aside.text,
    STEP7_LINK,
  ];
  return ls.flatMap((l) => [l.ar, l.en]);
};

/**
 * Connections the catalog marks "soon" (`src/lib/integrations.ts`). A line may name one only while saying it is not
 * live yet, so the homepage never claims a measurement source the product cannot read today.
 */
const NOT_LIVE = [/meta|ميتا/i, /snap|سناب/i, /salla|سلة/i, /shopify|شوبيفاي/i, /\bzid\b|زد/i];
const SAYS_SOON = /قريب|لما ينطلق|لما تربط|once .*(launch|connect)|coming soon/i;

describe("the D homepage copy is true (rule 514)", () => {
  const cast = new Set(CAST.map((c) => c.id));
  it("has four rules, four day panels, seven steps and three questions, each spoken by a real cast member", () => {
    expect(RULES).toHaveLength(4);
    expect(Object.keys(DAY)).toEqual(["morning", "peek", "owners", "word"]);
    expect(STEPS).toHaveLength(7);
    expect(HOME_FAQ).toHaveLength(3);
    for (const r of RULES) for (const l of r.lines) expect(isAgentId(l.who)).toBe(true);
    for (const s of STEPS) if (s.who) expect(cast.has(s.who), s.title.en).toBe(true);
    for (const q of DAY.morning.clouds) expect(STORM).toContain(q);
  });
  it("every string is written in both languages", () => {
    for (const s of dCopy()) expect(s.trim().length, s).toBeGreaterThan(0);
  });
  it("names no AI model", () => {
    for (const s of dCopy()) expect(s, s).not.toMatch(/Claude|Anthropic|GPT|OpenAI|Gemini|Opus|Sonnet|Haiku/i);
  });
  it("has no number but a clock time, the masthead's issue and the 90-day plan", () => {
    const clock = [DAY.morning.cap.ar, DAY.morning.cap.en, HERO.issue.en];
    for (const s of dCopy().filter((s) => !clock.includes(s))) expect(s.replace(/90/g, ""), s).not.toMatch(/[0-9٠-٩]/);
    // Western digits on the Arabic page too (rule 1584).
    expect(DAY.morning.cap.ar).toBe("7:58 الصبح.");
  });
  it("promises nothing NOT_YET lists", () => {
    for (const s of dCopy()) expect(promises(s), s).toEqual([]);
  });
  it("names a connection the catalog marks soon only while saying so", () => {
    for (const bad of ["We measure Meta and Snapchat ad results.", "مبيعات سلة وزد"]) {
      expect(NOT_LIVE.some((p) => p.test(bad)) && !SAYS_SOON.test(bad), bad).toBe(true);
    }
    for (const s of dCopy()) if (NOT_LIVE.some((p) => p.test(s))) expect(s, s).toMatch(SAYS_SOON);
  });
  it("draws the morning's clouds from the agents' own questions, and ends on the approved word", () => {
    const first = (id: string) => AGENT_CAST.find((a) => a.id === id)!.questions[0];
    expect(DAY.morning.clouds).toEqual([first("noor"), first("razan"), first("layan")]);
    expect(DAY.word.stamp).toEqual(HOME.finaleWord);
    expect(DAY.word.end).toEqual(HOME.finaleLine);
  });
  it("keeps the hero's offer and the masthead's line verbatim from D", () => {
    expect(HERO.offer.ar).toBe("ثمانية وكلاء يعرفون علامتك.");
    expect(HERO.offerSwash.ar).toBe("هم يشتغلون، وأنت توافق.");
    expect(HERO.tbox.ar).toBe("الذكي المكين.");
  });
  it("draws the approved slogan as the h1: the wordmark, a full stop, then the masthead's line (rule 516)", () => {
    for (const lang of ["ar", "en"] as const) expect(`${dict[lang].brand}. ${HERO.tbox[lang]}`).toBe(SLOGAN.line1[lang]);
  });
  it("lets Razan speak beside the plans, and keeps the approval rule on every plan (rule 516)", () => {
    expect(isAgentId(PLANS.aside.who)).toBe(true);
    expect(PLANS.rule.ar).toContain("موافقتك");
  });
});

describe("the public FAQ, enterprise page and help centre name no AI assistant by brand (rule 514, founder 2026-10-04)", () => {
  // Claude is the assistant the product runs on, and the founder asked that public copy not name it. Competitors are not
  // named either since 2026-10-13 (rule 1740, tests/compare-generic.test.ts).
  it("the site FAQ, the enterprise copy and the help topics never say Claude", async () => {
    const { SITE } = await import("@/lib/site");
    const { HELP } = await import("@/lib/help");
    const text = JSON.stringify([dict.ar.faq, dict.en.faq, SITE.ar.enterprise, SITE.en.enterprise, HELP]);
    expect(text).not.toMatch(/Claude|Anthropic/i);
  });

  it("the comparison and sector pages never say Claude either", async () => {
    const { COMPARE_PAGE } = await import("@/lib/pages-compare");
    const { INDUSTRY_PAGES } = await import("@/lib/pages-industry");
    expect(JSON.stringify([COMPARE_PAGE, INDUSTRY_PAGES])).not.toMatch(/Claude|Anthropic/i);
  });

  it("the public wishlist and the definition page's ask links never say Claude", async () => {
    const { SEED_WISHES, CHANGELOG } = await import("@/lib/changelog");
    expect(JSON.stringify([SEED_WISHES, CHANGELOG])).not.toMatch(/Claude|Anthropic/i);
    const page = readFileSync("src/app/[lang]/ai-marketing-agent/page.tsx", "utf8");
    expect(page).not.toMatch(/Claude|claude\.ai/);
  });
});
