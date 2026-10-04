import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Rule 519. App screens wear the quiet version of prototype D (re-skin spec §3, decision A): plain ink lines on tables
 * and forms, the underline scribble on page titles, the ink pill on the main action of the sign-in screens, and error
 * boxes in a faint rose fill with a danger border (decision B). Each slice 4 task adds its files to `APP`.
 */
export const APP: string[] = [
  "src/components/app/AuthForm.tsx",
  "src/components/app/JoinForm.tsx",
  "src/components/app/PasswordRules.tsx",
  "src/components/app/DictionaryStart.tsx",
  "src/components/app/ReadOnlyNote.tsx",
  "src/components/app/BrandForm.tsx",
  "src/components/app/StartLaunch.tsx",
  "src/components/app/OnboardCards.tsx",
  "src/app/[lang]/app/start/page.tsx",
];
const read = (p: string) => readFileSync(p, "utf8");

describe("app screens are quiet D (rule 519)", () => {
  for (const file of APP) {
    it(file, () => {
      const src = read(file);
      for (const h1 of src.match(/<h1 className="page-title[^>]*>.*?<\/h1>/g) ?? []) {
        expect(h1, `${file}: page title carries the underline scribble`).toMatch(/<span className="s-ul"><Scribble kind="underline" seed="[^"]+" \/>/);
      }
      expect(src, `${file}: error boxes are rose, not a tint of danger`).not.toMatch(/bg-danger\/\d/);
      expect(src, `${file}: the old sadu band is gone`).not.toMatch(/sadu-thin/);
    });
  }

  it("the sign-in, sign-up, reset and join screens lead with the ink pill", () => {
    for (const file of ["src/components/app/AuthForm.tsx", "src/components/app/JoinForm.tsx"]) {
      const src = read(file);
      expect(src, file).not.toMatch(/<button\b[^>]*className="btn btn-primary"/);
      expect(src.match(/className="s-btn"><Scribble kind="pill" seed="[^"]+" fill="ink" shadow ring \/>/g)?.length ?? 0, file).toBeGreaterThan(0);
    }
  });

  it("a disabled pill keeps its label readable: lilac fill under ink text", () => {
    const css = read("src/app/scribble.css");
    expect(css).toMatch(/\.s-btn:is\(:disabled, \[aria-disabled="true"\]\) > \.scribble \.fill \{ fill: var\(--color-lilac\); \}/);
    expect(css).toMatch(/\.s-btn\[aria-disabled="true"\]\s*\{[^}]*color: var\(--color-ink\)/);
  });
});
