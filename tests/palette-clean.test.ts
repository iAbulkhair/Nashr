import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Rule 513. Files moved to prototype D speak only D's colour names (ink, muted, paper, ground, lilac, lemon, gold,
 * danger, agent-<id>): no old oasis, saffron, sadu, salt or mist class and no hard-coded hex. The whole of `src/` is
 * checked; the old names no longer exist as aliases, so a stray one would also fail the build's styles.
 */
/** Every source file under src/. */
const CLEAN: string[] = (readdirSync("src", { recursive: true }) as string[])
  .map((f) => join("src", f))
  .filter((f) => /\.(?:ts|tsx|css)$/.test(f))
  .sort();

/**
 * Files that may write a hex value, each for a reason: the token sheets (light, and dark since rule 1202) are where the values live; global-error replaces
 * the document and cannot load the stylesheet, so it writes D's values out (reskin-marketing pins them); the crawler and
 * the media store handle colours found in customers' sites and files, which are data, not the product's palette.
 */
const HEX_OK = new Set(["src/app/tokens.css", "src/app/theme-dark.css", "src/app/global-error.tsx", "src/lib/crawl.ts", "src/lib/media/blob.ts"]);

/**
 * An old palette name used as a colour: a utility (`text-oasis`, `hover:bg-salt-dim/40`), a CSS variable
 * (`--color-saffron`) or a class of the old bands (`sadu-thin`). The journey's "oasis" level is a word, not a colour.
 */
const OLD = /(?:\b(?:text|bg|border|ring|accent|outline|fill|stroke|decoration|from|to|via|divide|placeholder|caret|shadow)-|--color-|\bsadu-)(?:oasis|saffron|sadu|salt|mist|thin|band)(?:-deep|-dim)?\b/;
/** The source without block comments and `//` line comments (a `//` after a colon is a URL, not a comment). */
const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("files moved to D use only D's names (rule 513)", () => {
  for (const file of CLEAN) {
    it(file, () => {
      const src = code(file);
      expect(src.match(OLD)?.[0], file).toBeUndefined();
      if (!HEX_OK.has(file)) expect(src.match(/#[0-9a-f]{6}\b/i)?.[0], file).toBeUndefined();
    });
  }

  it("knows an old colour from the journey's oasis level", () => {
    for (const bad of ["text-oasis", "hover:bg-oasis-deep/40", "border-saffron/60", "text-sadu-deep", "bg-salt-dim", "text-mist", "var(--color-mist-dim)", "sadu-thin"]) expect(bad, bad).toMatch(OLD);
    for (const ok of ['levels: { oasis: "Oasis" }', '<Icon name="oasis" />', '"seed" | "palm" | "oasis"']) expect(ok, ok).not.toMatch(OLD);
  });

  it("the wordmark carries no dot", () => {
    expect(code("src/components/Nav.tsx")).not.toMatch(/<Wordmark[\s\S]{0,200}rounded-full bg-/);
    expect(code("src/app/[lang]/app/layout.tsx")).not.toMatch(/appName\}[\s\S]{0,200}rounded-full bg-/);
  });
});

/**
 * Rule 529. Secondary text is `text-muted` (about 7:1 on ground), never ink faded to 60% or less (about 4:1 at 60%,
 * under the 4.5:1 that WCAG AA asks of body text). A disabled control is exempt, as WCAG exempts it.
 */
const FADED = /(?<!disabled:)(?<![\w-])text-ink\/(?:[1-6]0|[1-5])\b/;

describe("secondary text is muted, not faded ink (rule 529)", () => {
  for (const file of CLEAN) {
    it(file, () => {
      expect(code(file).match(FADED)?.[0], file).toBeUndefined();
    });
  }

  it("tells faded ink from readable ink and from a disabled control", () => {
    for (const bad of ["text-ink/60", "text-ink/50", "hover:text-ink/40", "placeholder:text-ink/30"]) expect(`a ${bad}`).toMatch(FADED);
    for (const ok of ["text-ink/70", "text-ink/80", "text-muted", "disabled:text-ink/40", "border-ink/40"]) expect(`a ${ok}`).not.toMatch(FADED);
  });
});
