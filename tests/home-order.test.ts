import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { HOME_NAV } from "@/lib/home";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const page = read("src/app/[lang]/page.tsx");
const home = (f: string) => read(`src/components/home/${f}.tsx`);

describe("the homepage is D, without the game (rule 516)", () => {
  it("renders the cover, rules, day, steps, plans and questions in that order", () => {
    const at = ["Cover", "Rules", "Day", "Steps", "Plans", "HomeFaq"].map((c) => page.indexOf(`<${c} `));
    for (const i of at) expect(i).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
  it("mounts neither the dictionary game nor the old story and truths", () => {
    for (const gone of ["Dictionary", "Story", "Truths"]) expect(page).not.toMatch(new RegExp(`import ${gone}\\b`));
    // The game is unmounted, not deleted (it still uses StartForm); the old sections are deleted.
    for (const f of ["Dictionary", "StartForm"]) expect(existsSync(join(process.cwd(), `src/components/home/${f}.tsx`)), f).toBe(true);
    for (const f of ["Story", "Truths", "QuestionFlip", "Figure"]) expect(existsSync(join(process.cwd(), `src/components/home/${f}.tsx`)), f).toBe(false);
  });
  it("gives each section the id the homepage nav points at", () => {
    const ids: [string, string][] = [["Cover", "team"], ["Rules", "rules"], ["Day", "day"], ["Steps", "steps"], ["Plans", "price"], ["HomeFaq", "faq"]];
    for (const [file, id] of ids) expect(home(file), file).toMatch(new RegExp(`<section[^>]*\\bid="${id}"`));
    expect(HOME_NAV.map((n) => n.href)).toEqual(ids.map(([, id]) => `#${id}`));
    expect(page).toMatch(/<Nav [^>]*sections=\{HOME_NAV\}/);
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
});
