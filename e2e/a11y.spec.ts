import { test, expect, type Page } from "@playwright/test";

/**
 * Automatic accessibility check (rules 1800-1802, docs/system/tests/1800-ui-leftovers.md). axe-core runs on the pages a
 * visitor meets first, in both languages, and fails on a serious or critical WCAG 2.1 A/AA violation. It also reads the
 * text of every Arabic page and fails on an Arabic-Indic digit: the founder chose Western digits everywhere (2026-10-13).
 *
 * Kept small on purpose because CI minutes are paid (rule 772): one browser (desktop Chromium), seven pages, one axe
 * run each, no screenshots. The phone project skips it; the markup it checks is the same.
 */
// Playwright loads specs as CommonJS here, so `require.resolve` finds the copy in node_modules.
const AXE = require.resolve("axe-core/axe.min.js");
const PAGES = ["/ar", "/en", "/ar/pricing", "/en/pricing", "/ar/app/login", "/en/app/signup", "/ar/help"];
const ARABIC_INDIC = /[\u0660-\u0669\u06F0-\u06F9]/;

type Violation = { id: string; impact: string | null; help: string; nodes: { target: string[] }[] };

async function axe(page: Page): Promise<Violation[]> {
  await page.addScriptTag({ path: AXE });
  const found = await page.evaluate(async () => {
    const run = (window as unknown as { axe: { run: (ctx: Document, o: object) => Promise<{ violations: Violation[] }> } }).axe.run;
    return (await run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] })).violations;
  });
  return found.filter((v) => v.impact === "serious" || v.impact === "critical");
}

test.describe("accessibility and digits on the first pages", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "one browser keeps the run short (rule 772)");

  for (const path of PAGES) {
    test(`${path}: no serious or critical axe violation${path.startsWith("/ar") ? ", no Arabic-Indic digit" : ""}`, async ({ page }) => {
      await page.goto(path, { waitUntil: "load" });
      const bad = await axe(page);
      expect(bad.map((v) => `${v.impact} ${v.id}: ${v.help} at ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
      if (path.startsWith("/ar")) {
        const text = await page.evaluate(() => document.body.innerText);
        expect(text.match(new RegExp(`.{0,20}${ARABIC_INDIC.source}.{0,20}`, "g")) ?? []).toEqual([]);
      }
    });
  }
});
