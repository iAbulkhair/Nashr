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
  "src/app/[lang]/app/page.tsx",
  "src/app/[lang]/app/chat/page.tsx",
  "src/app/[lang]/app/conversations/page.tsx",
  "src/app/[lang]/app/todo/page.tsx",
  "src/app/[lang]/app/tasks/page.tsx",
  "src/app/[lang]/app/calendar/page.tsx",
  "src/app/[lang]/app/files/page.tsx",
  "src/app/[lang]/app/brands/page.tsx",
  "src/app/[lang]/app/generate/page.tsx",
  "src/app/[lang]/app/inspo/page.tsx",
  "src/components/app/HomeSide.tsx",
  "src/components/app/Inbox.tsx",
  "src/components/app/ChatPanel.tsx",
  "src/components/app/ChatAllowanceCard.tsx",
  "src/components/app/JourneyCard.tsx",
  "src/components/app/TodoPanel.tsx",
  "src/components/app/TasksPanel.tsx",
  "src/components/app/SeriesPanel.tsx",
  "src/components/app/CalendarPanel.tsx",
  "src/components/app/FilesPanel.tsx",
  "src/components/app/BrandsPanel.tsx",
  "src/components/app/GeneratePanel.tsx",
  "src/components/app/InspoPanel.tsx",
  "src/components/app/MediaControls.tsx",
  "src/components/app/AwayPanel.tsx",
  "src/components/app/WorkingDaysPanel.tsx",
  "src/components/app/AgentAvatar.tsx",
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

describe("an agent's avatar in the app is its initial on its own colour (rules 517, 519)", () => {
  it("fills with agent-<id> inside a hand-drawn ring; text is ink, paper on Faris and Majed", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { default: AgentAvatar } = await import("@/components/app/AgentAvatar");
    const noor = renderToStaticMarkup(createElement(AgentAvatar, { id: "noor", name: "نور" }));
    expect(noor).toContain("--s-fill:var(--color-agent-noor)");
    expect(noor).toMatch(/class="[^"]*text-ink[^"]*"/);
    expect(noor).toContain("ن</span>");
    expect(noor).toContain('aria-hidden="true"');
    for (const id of ["faris", "majed"] as const) expect(renderToStaticMarkup(createElement(AgentAvatar, { id, name: id }))).toMatch(/class="[^"]*text-paper[^"]*"/);
  });
  it("the chat, onboarding and inbox avatars use it", () => {
    for (const file of ["src/components/app/ChatPanel.tsx", "src/components/app/Inbox.tsx"]) {
      const src = read(file);
      expect(src, file).toMatch(/<AgentAvatar /);
      expect(src, file).not.toMatch(/rounded-full bg-(oasis|ink)[^"]*text-(saffron|lemon)[^"]*"[^>]*>\{[^}]*name\.charAt\(0\)\}/);
    }
  });
});
