import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const css = read("src/components/home/home.module.css").replace(/\/\*[\s*][\s\S]*?\*\//g, "");
const lineup = read("src/components/home/Lineup.tsx");

/** Every rule as [media query or "", selector, body], one level of @media deep. */
function rules(text: string): [string, string, string][] {
  const out: [string, string, string][] = [];
  const walk = (src: string, media: string) => {
    const re = /([^{}]+)\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const head = m[1].trim();
      let depth = 1, i = re.lastIndex;
      for (; i < src.length && depth; i++) depth += src[i] === "{" ? 1 : src[i] === "}" ? -1 : 0;
      const body = src.slice(re.lastIndex, i - 1);
      if (head.startsWith("@media")) walk(body, head);
      else if (!head.startsWith("@")) out.push([media, head, body]);
      re.lastIndex = i;
    }
  };
  walk(text, "");
  return out;
}

const all = rules(css);
const find = (media: RegExp | "", sel: RegExp) =>
  all.filter(([m, s]) => (media === "" ? m === "" : media.test(m)) && sel.test(s)).map(([, , b]) => b).join(";");

describe("the lineup wraps and the chosen figure grows in place (rule 515)", () => {
  // Rule 2310 replaced the 5+4 step from 600px and the 1200px row with one row of nine from 700px.
  it("wraps 3+3+3 by default and stands in one row of nine from 700px", () => {
    expect(find("", /^\.cast$/)).toMatch(/display:\s*flex/);
    expect(find("", /^\.cast$/)).toMatch(/flex-wrap:\s*wrap/);
    expect(find("", /^\.cast > li$/)).toMatch(/flex:\s*0 0 calc\(100% \/ 3\)/);
    expect(find(/min-width:\s*700px/, /^\.cast > li$/)).toMatch(/flex-basis:\s*calc\(100% \/ 9\)/);
  });
  it("keeps each figure between 70px and 92px wide on phones, 52px and 84px in the one row", () => {
    expect(find("", /^\.fig$/)).toMatch(/width:\s*clamp\(70px,\s*[^,]+,\s*92px\)/);
    expect(find(/min-width:\s*700px/, /^\.fig$/)).toMatch(/width:\s*clamp\(52px,\s*[^,]+,\s*84px\)/);
  });
  it("grows the chosen figure by transform from its feet, and the chosen state changes nothing else's size", () => {
    expect(find("", /\.who:is\(:hover, :focus-visible, \[aria-pressed="true"\], \[data-turn\]\) \.fig/)).toMatch(/transform:\s*scale\(1\.25\)/);
    expect(find("", /^\.fig$/)).toMatch(/transform-origin:\s*50% 100%/);
    const chosen = all.filter(([, s]) => /\.(who|fig|tag|cast)/.test(s) && /:hover|:focus-visible|aria-pressed/.test(s));
    expect(chosen.length).toBeGreaterThan(0);
    for (const [, s, b] of chosen) {
      expect(b, s).not.toMatch(/(^|[;\s])(width|height|min-width|max-width|flex|flex-basis|margin|padding|inset|top|left|right|bottom)\s*:/);
      expect(b, s).not.toMatch(/--w\s*:/);
    }
  });
  it("moves the figure with a token transition that names transform, and none under reduced motion", () => {
    expect(find("", /^\.fig$/)).toMatch(/transition:\s*transform var\(--duration-normal\) var\(--ease-out\)/);
    expect(find(/prefers-reduced-motion:\s*reduce/, /\.fig/)).toMatch(/transition:\s*none/);
  });
  it("gives the chosen tag the agent's colour, with paper text on the two dark agents", () => {
    expect(lineup).toMatch(/--tag["']?\s*:\s*`var\(--color-agent-\$\{/);
    expect(lineup).toMatch(/"faris"[\s\S]{0,40}"majed"|"majed"[\s\S]{0,40}"faris"/);
  });
  it("renders the whole cast in order, as pressable buttons, with one live thought cloud", () => {
    expect(lineup).toMatch(/CAST\.map\(/);
    expect(lineup).toMatch(/aria-pressed=\{/);
    expect(lineup).toMatch(/aria-live="polite"/);
    expect(lineup).toMatch(/kind="cloud"/);
    expect(lineup).toMatch(/kind="puddle"/);
    expect(lineup).toMatch(/Escape/);
  });
});
