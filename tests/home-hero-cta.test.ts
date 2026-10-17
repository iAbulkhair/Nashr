// The home cover after the founder's review of 2026-10-13 (docs/system/tests/1830-home-hero-cta.md): the call to action
// stands under the team (rules 1830, 1831; back there on 2026-10-15, rule 1892), and the figures take turns thinking on their own (rules 1832-1835).
// Source-reading checks, static renders and the pure turn rule.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dict, LANGS } from "@/lib/i18n";
import { HERO } from "@/lib/home";
import { HERO_START } from "@/lib/home-hero";
import Cover from "@/components/home/Cover";
import { REST_MS, SAY_MS, takesTurns } from "@/components/home/Lineup";

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  usePathname: () => "/ar",
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
}));

const read = (f: string) => readFileSync(f, "utf8");
const LINEUP = read("src/components/home/Lineup.tsx");
const MOTION = read("src/components/home/motion.ts");
const CSS = read("src/components/home/home.module.css").replace(/\/\*[\s*][\s\S]*?\*\//g, "");

describe("rule 1892 (replaces 1844, restores 1830): the cover's call to action stands under the team", () => {
  for (const lang of LANGS) {
    it(`renders headline, offer and hint, then the team, then the form, the trial line and the freshness chip (${lang})`, () => {
      const html = renderToStaticMarkup(h(Cover, { lang, t: dict[lang] }));
      const at = (s: string) => {
        const i = html.indexOf(s);
        expect(i, s).toBeGreaterThan(-1);
        return i;
      };
      const h1 = at("<h1");
      const offer = at(HERO.offerSwash[lang]);
      const hint = at(HERO.hintMouse[lang]);
      const team = at('data-testid="lineup"');
      const form = at(`action="/${lang}/app/signup"`);
      const trial = at(dict[lang].pricing.trial.replace(/&/g, "&amp;"));
      const chip = at(HERO_START.chip[lang]);
      expect(h1).toBeLessThan(offer);
      expect(offer).toBeLessThan(hint);
      expect(hint).toBeLessThan(team);
      expect(team).toBeLessThan(form);
      expect(form).toBeLessThan(trial);
      expect(trial).toBeLessThan(chip);
      // One form on the cover, no second signup path.
      expect(html.match(/<form /g)).toHaveLength(1);
    });
  }
  it("keeps the form out of the headline column", () => {
    const src = read("src/components/home/Cover.tsx");
    const top = src.slice(src.indexOf("styles.ctop"), src.indexOf("<Lineup"));
    expect(top).not.toMatch(/<UrlStart|trialLine|styles\.fresh/);
    expect(src.indexOf("<Lineup")).toBeLessThan(src.indexOf("<UrlStart"));
  });
  it("centres the column, the wrapped button and the lines, with no left or right (rule 1831)", () => {
    const block = [...CSS.matchAll(/^\.(coverCta[^{]*|cover > \.lineup )\{[^}]*\}/gm)].map((m) => m[0]).join("\n");
    expect(block).toMatch(/\.coverCta \{[^}]*justify-items:\s*center/);
    expect(block).toMatch(/\.coverCta \{[^}]*margin-inline:\s*auto/);
    expect(block).toMatch(/\.coverCta > form \{[^}]*justify-content:\s*center/);
    expect(block).toMatch(/\.cover > \.lineup \{/);
    expect(block).not.toMatch(/\b(left|right)\b|#[0-9a-f]{3,8}\b/i);
  });
  it("hands the lineup its figures drawn on the server (rule 1866)", () => {
    expect(LINEUP).not.toMatch(/from "\.\/Doodle"/);
    expect(LINEUP).toMatch(/\{figures\[member\.id\]\}/);
    expect(read("src/components/home/Cover.tsx")).toMatch(/<Lineup lang=\{lang\} figures=\{figures\} \/>/);
  });
});

describe("rule 1832: the figures take turns thinking on their own", () => {
  it("shows each thought a few seconds, with a short rest between", () => {
    expect(SAY_MS).toBeGreaterThanOrEqual(3000);
    expect(SAY_MS).toBeLessThanOrEqual(6000);
    expect(REST_MS).toBeGreaterThanOrEqual(500);
    expect(REST_MS).toBeLessThan(SAY_MS);
  });
  it("goes round the cast in reading order and grows the figure whose turn it is, like a chosen one", () => {
    expect(LINEUP).toMatch(/show\(CAST\[order\.current % CAST\.length\]\.id, false, true\)/);
    expect(LINEUP).toMatch(/data-turn=\{turning && shown === member\.id \? "" : undefined\}/);
    expect(CSS).toMatch(/\.who:is\(:hover, :focus-visible, \[aria-pressed="true"\], \[data-turn\]\) \.fig \{ transform: scale\(1\.25\); \}/);
  });
});

describe("rule 1833: the turns stop for reduced motion, the pause button, an off-screen row, a hidden tab and a held figure", () => {
  it("takes turns only when nothing asks it to stay still (WCAG 2.2.2)", () => {
    const on = { reduced: false, paused: false, showing: true, held: false };
    expect(takesTurns(on)).toBe(true);
    for (const k of ["reduced", "paused", "held"] as const) expect(takesTurns({ ...on, [k]: true }), k).toBe(false);
    expect(takesTurns({ ...on, showing: false })).toBe(false);
  });
  it("reads the page's pause switch, reduced motion and the row's visibility from motion.ts", () => {
    expect(LINEUP).toMatch(/import \{ useMotionPaused, useReducedMotion, useShowing \} from "\.\/motion"/);
    expect(LINEUP).toMatch(/takesTurns\(\{ reduced, paused, showing, held: focused \|\| \(shown !== null && !turning\) \}\)/);
    // Keyboard focus on any figure holds the row, as it holds the scenes' slider.
    expect(LINEUP).toMatch(/onFocus=\{\(e\) => setFocused\(e\.target\.matches\(":focus-visible"\)\)\}/);
    // useShowing answers false for a hidden tab as well as an off-screen element.
    expect(MOTION).toMatch(/document\.visibilityState === "visible"/);
    // A thought the row was showing on its own goes away when the motion stops.
    expect(LINEUP).toMatch(/if \(turning && \(reduced \|\| paused \|\| !showing\)\) hide\(\)/);
  });
  it("hands a turning figure to the visitor who reaches it: pointer and focus take it, a tap shows a new thought", () => {
    expect(LINEUP).toMatch(/take\(member\.id, false\)/);
    expect(LINEUP).toMatch(/:focus-visible"\)\) take\(member\.id, true\)/);
    expect(LINEUP).toMatch(/setPressed\(member\.id\);\s*show\(member\.id, true\)/);
  });
});

describe("rule 1834: the turns are silent; only keyboard focus and taps speak", () => {
  it("never fills the live region on a turn", () => {
    // `show(id, speak, turn)`: the one call that starts a turn passes speak = false.
    const calls = [...LINEUP.matchAll(/\bshow\(([^\n]*)\);?\s*$/gm)].map((m) => m[1].split(", "));
    const turns = calls.filter((args) => args.length === 3);
    expect(turns).toHaveLength(1);
    for (const args of turns) expect(args.slice(1)).toEqual(["false", "true"]);
    expect(LINEUP).toMatch(/setSaid\(speak \? /);
    expect(LINEUP).toMatch(/aria-live="polite"/);
    // The cloud itself stays out of the accessibility tree.
    expect(LINEUP).toMatch(/className=\{`s-cloud \$\{styles\.think\}`\}[^>]*aria-hidden="true"/);
  });
  it("speaks a turning figure's thought once a keyboard takes it", () => {
    expect(LINEUP).toMatch(/if \(speak\) setSaid\(`\$\{CAST\.find\(\(m\) => m\.id === id\)\?\.name\[lang\]\}: \$\{text\}`\)/);
  });
});

describe("rule 1835: one reduced-motion answer for the home page, motion-off on the server", () => {
  it("lives in motion.ts and answers true before hydration", () => {
    expect(MOTION).toMatch(/export function useReducedMotion\(\): boolean/);
    expect(MOTION).toMatch(/useSyncExternalStore\(watchReduced, \(\) => window\.matchMedia\(REDUCED\)\.matches, \(\) => true\)/);
    const track = read("src/components/home/SceneTrack.tsx");
    expect(track).toMatch(/useReducedMotion\(\)/);
    expect(track).not.toMatch(/matchMedia\(REDUCED\)/);
  });
});
