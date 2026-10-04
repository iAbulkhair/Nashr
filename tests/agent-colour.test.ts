import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Rule 517. An agent's colour is a fill or a stroke, never the colour of text: most of them (lemon noor, cyan razan, green
 * layan) fail contrast as text on paper. So no `text-agent-*`, `decoration-agent-*` or `placeholder-agent-*` utility and
 * no CSS `color:` taken from an agent variable anywhere in src/.
 */
const SRC = (readdirSync("src", { recursive: true }) as string[]).map((f) => join("src", f)).filter((f) => /\.(?:ts|tsx|css)$/.test(f));
const TEXT = /(?:^|[\s"'`:])(?:text|decoration|placeholder)-agent-[a-z]+/;
const CSS_COLOR = /(?:^|[;{\s])color:\s*var\(--color-agent-/;

describe("agent colours are fills, never text (rule 517)", () => {
  it("knows a text use from a fill", () => {
    for (const bad of ['className="text-agent-noor"', "hover:text-agent-sami", "decoration-agent-razan", "placeholder-agent-dana", ".x { color: var(--color-agent-reem); }"]) {
      expect(TEXT.test(bad) || CSS_COLOR.test(bad), bad).toBe(true);
    }
    for (const ok of ['className="bg-agent-noor"', "border-agent-sami", "fill: var(--color-agent-razan);", "background-color: var(--color-agent-dana)", "--s-fill:var(--color-agent-noor)"]) {
      expect(TEXT.test(ok) || CSS_COLOR.test(ok), ok).toBe(false);
    }
  });

  for (const file of SRC) {
    it(file, () => {
      const src = readFileSync(file, "utf8");
      expect(src.match(TEXT)?.[0], file).toBeUndefined();
      expect(src.match(CSS_COLOR)?.[0], file).toBeUndefined();
    });
  }
});
