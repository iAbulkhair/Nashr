import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Rule 511. Motion stays calm (re-skin spec §1, Motion): no easing curve overshoots its end, and nothing animates its
 * width or height, which re-lays out the page on every frame. The launch-journey progress fill grows by `transform`.
 */
const read = (p: string) => readFileSync(p, "utf8");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const sheets = walk("src").filter((p) => p.endsWith(".css")).map((p) => ({ p, css: read(p).replace(/\/\*[\s\S]*?\*\//g, "") }));

/** The properties a `transition` or `transition-property` value animates; a part that starts with a time animates `all`. */
function transitioned(css: string): string[] {
  return [...css.matchAll(/transition(-property)?\s*:\s*([^;}]+)/g)].flatMap((m) =>
    m[2].split(",").map((part) => {
      const first = part.trim().split(/\s+/)[0];
      return m[1] || !/^-?\d*\.?\d+m?s$/.test(first) ? first : "all";
    }),
  );
}

describe("motion stays calm (rule 511)", () => {
  it("finds the stylesheets", () => {
    expect(sheets.map((s) => s.p)).toEqual(expect.arrayContaining(["src/app/globals.css", "src/components/home/home.module.css"]));
  });

  it("uses no overshoot easing", () => {
    for (const { p, css } of sheets) {
      for (const m of css.matchAll(/cubic-bezier\(([^)]+)\)/g)) {
        const [, y1, , y2] = m[1].split(",").map(Number);
        expect(y1 >= 0 && y1 <= 1 && y2 >= 0 && y2 <= 1, `${p}: ${m[0]}`).toBe(true);
      }
    }
  });

  it("never transitions width or height", () => {
    for (const { p, css } of sheets) {
      for (const prop of transitioned(css)) expect(["width", "height", "max-height", "all"], `${p}: transition of ${prop}`).not.toContain(prop);
    }
  });

  it("reads an implicit `all` as all", () => {
    expect(transitioned(".a{transition:.2s ease-out}")).toEqual(["all"]);
    expect(transitioned(".a{transition: opacity .2s, transform 300ms}")).toEqual(["opacity", "transform"]);
  });

  it("the progress fill grows by transform", () => {
    const css = read("src/app/globals.css");
    const fill = /\.journey-fill\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(fill).toContain("scaleX(var(--p))");
    expect(fill).not.toMatch(/transition[^;]*width/);
    expect(css).toMatch(/\[dir="?rtl"?\]\s*\.journey-fill\s*\{[^}]*transform-origin:\s*right/);
    for (const f of ["src/components/app/JourneyCard.tsx", "src/components/app/ChatPanel.tsx"]) {
      const src = read(f);
      expect(src, f).toContain('"--p"');
      expect(src, f).not.toMatch(/journey-fill"[^>]*width:/);
    }
  });

  it("looping decoration runs only inside the homepage, the one page with a motion switch (WCAG 2.2.2)", () => {
    // Face and the floats are reused on /agents and in onboarding, which have no pause control, so a loop there would
    // never stop. Every infinite animation in the homepage sheet is scoped under `.home`.
    const css = read("src/components/home/home.module.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const loops = [...css.matchAll(/([^{};]+)\{[^{}]*animation:[^;}]*infinite/g)].map((m) => m[1].trim());
    expect(loops.length).toBeGreaterThan(0);
    for (const sel of loops) expect(sel, sel).toMatch(/^html:not\(\[data-motion="off"\]\) \.home /);
  });
});
