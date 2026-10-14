import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { HOME_NAV } from "@/lib/home";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const page = read("src/app/[lang]/page.tsx");
const home = (f: string) => read(`src/components/home/${f}.tsx`);

describe("the homepage is D, without the game (rule 516)", () => {
  it("renders the cover, scenes, rules, day, steps, plans and questions in that order", () => {
    const at = ["Cover", "Stories", "Rules", "Day", "Steps", "Plans", "HomeFaq"].map((c) => page.indexOf(`<${c} `));
    for (const i of at) expect(i).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
  it("mounts neither the dictionary game nor the old story and truths", () => {
    for (const gone of ["Dictionary", "Story", "Truths"]) expect(page).not.toMatch(new RegExp(`import ${gone}\\b`));
    // The game component and the start form are deleted (2026-10-12, nothing imported them; the first-login game is `DictionaryStart` in the app).
    for (const f of ["Dictionary", "StartForm", "Story", "Truths", "QuestionFlip", "Figure"]) expect(existsSync(join(process.cwd(), `src/components/home/${f}.tsx`)), f).toBe(false);
  });
  it("keeps no CSS for the deleted game and start form, and keeps the face circle the app's game uses (rule 1459)", () => {
    const css = read("src/components/home/home.module.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const dead = ["start", "startInput", "startButton", "dict", "dictTitle", "dictSub", "dictPanel", "dictStep", "dictBody", "dictNav", "dictBack", "dictNext", "dictCta", "dictCtaLine", "dictLive", "dictCount", "dictInput", "dictLabel", "rail", "railStep", "railNum", "railName", "sectors", "sectorList", "sector", "words", "word", "tick", "counter", "say", "bubble", "sayName", "samples", "sample", "sampleHead", "sampleFaces", "sampleWho", "exampleTag", "planList", "post", "chat", "approveBox", "approve", "approveNote", "preview"];
    for (const c of dead) expect(css, c).not.toMatch(new RegExp(`\\.${c}(?![\\w-])`));
    expect(css).not.toContain("dictPop");
    // The face circle the app's first-login game reads as `cast.face` stays.
    expect(css).toMatch(/\n\.face \{/);
  });
  it("gives each section the id the homepage's section chips point at (rule 1854)", () => {
    // The cover keeps `#team` for links from elsewhere; it has no chip because the chips sit right under it.
    expect(home("Cover")).toMatch(/<section[^>]*\bid="team"/);
    const ids: [string, string][] = [["Rules", "rules"], ["Day", "day"], ["Steps", "steps"], ["Plans", "price"], ["HomeFaq", "faq"]];
    for (const [file, id] of ids) expect(home(file), file).toMatch(new RegExp(`<section[^>]*\\bid="${id}"`));
    expect(HOME_NAV.map((n) => n.href)).toEqual(ids.map(([, id]) => `#${id}`));
    // The chips render under the cover, and the site menu takes no homepage anchors any more.
    expect(page.indexOf("<SectionChips ")).toBeGreaterThan(page.indexOf("<Cover "));
    expect(page.indexOf("<SectionChips ")).toBeLessThan(page.indexOf("<Stories "));
    expect(page).toMatch(/<Nav t=\{t\} lang=\{lang\} \/>/);
  });
  it("takes every price, credit and seat from the pricing module", () => {
    const plans = home("Plans");
    expect(plans).toMatch(/from "@\/lib\/pricing"/);
    expect(plans.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")).not.toMatch(/\b\d{3,}\b/);
  });
  it("shows a step's paused note only while the model is paused", () => {
    const steps = home("Steps");
    expect(steps).toMatch(/import \{[^}]*\bCLAUDE_PAUSED\b[^}]*\} from "@\/lib\/model"/);
    expect(steps).toMatch(/CLAUDE_PAUSED\s*&&\s*\w+\.paused/);
  });
  it("keeps the decoration out of the accessibility tree and still when motion is off", () => {
    const decor = home("Decor");
    expect(decor.match(/aria-hidden/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    const css = read("src/components/home/home.module.css");
    expect(css).toMatch(/prefers-reduced-motion:\s*no-preference/);
    expect(css).toMatch(/html\[data-motion="off"\]/);
    expect(read("src/components/home/motion.ts")).toMatch(/dataset\.motion/);
  });
  it("keeps the page's padding out of the app's 48px face, which borrows .home for its colours", () => {
    expect(read("src/components/app/DictionaryStart.tsx")).toMatch(/\$\{cast\.home\} \$\{cast\.face\}/);
    const css = read("src/components/home/home.module.css");
    expect(css).toMatch(/\.home \{[^}]*\bpadding:/);
    expect(css.match(/\n\.face \{[^}]*\}/)?.[0]).toMatch(/\bpadding: 0;/);
  });
});
