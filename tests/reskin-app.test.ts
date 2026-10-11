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
  "src/app/[lang]/app/settings/brands/page.tsx",
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
  // Task 18: account screens (rule 519).
  "src/app/[lang]/app/settings/billing/page.tsx",
  "src/app/[lang]/app/partner/page.tsx",
  "src/app/[lang]/app/refer/page.tsx",
  "src/app/[lang]/app/settings/members/page.tsx",
  "src/app/[lang]/app/notifications/page.tsx",
  "src/app/[lang]/app/settings/connections/page.tsx",
  "src/app/[lang]/app/mcp/page.tsx",
  "src/app/[lang]/app/settings/governance/page.tsx",
  "src/app/[lang]/app/reports/page.tsx",
  "src/app/[lang]/app/activity/page.tsx",
  "src/app/[lang]/app/help/page.tsx",
  "src/app/[lang]/app/admin/page.tsx",
  "src/app/[lang]/admin/layout.tsx",
  "src/components/admin/AdminNav.tsx",
  "src/components/admin/Billing.tsx",
  "src/components/admin/Log.tsx",
  "src/components/admin/Overview.tsx",
  "src/components/admin/Quality.tsx",
  "src/components/admin/Usage.tsx",
  "src/components/admin/Users.tsx",
  "src/components/admin/shared.tsx",
  "src/components/app/ActivityPanel.tsx",
  "src/components/app/AdminLogin.tsx",
  "src/components/app/BillingOffer.tsx",
  "src/components/app/GoldenPanel.tsx",
  "src/components/app/GovernancePanel.tsx",
  "src/components/app/IntegrationsPanel.tsx",
  "src/components/app/LeadsPanel.tsx",
  "src/components/app/LogoutButton.tsx",
  "src/components/app/McpPanel.tsx",
  "src/components/app/NotificationsPanel.tsx",
  "src/components/app/PartnerCodeForm.tsx",
  "src/components/app/PartnerPanel.tsx",
  "src/components/app/PartnersPanel.tsx",
  "src/components/app/PaymentsPanel.tsx",
  "src/components/app/PerformanceImport.tsx",
  "src/components/app/settings/CreditUsageCard.tsx",
  "src/components/app/ReferPanel.tsx",
  "src/components/app/ReportsPanel.tsx",
  "src/components/app/TeamPanel.tsx",
  "src/components/app/TopupCard.tsx",
  "src/components/app/WishlistPanel.tsx",
  "src/app/oauth/authorize/page.tsx",
  // Email verification (rule 754).
  "src/app/[lang]/app/verify/page.tsx",
  "src/components/app/VerifyForm.tsx",
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
      // Lemon reads only on ink: an icon in lemon must sit on a line that sets the ink ground.
      const lemonOnLight = src.split("\n").filter((l) => /<Icon [^>]*text-lemon/.test(l) && !/\bbg-ink\b/.test(l));
      expect(lemonOnLight, `${file}: lemon is never an icon colour on a light ground`).toEqual([]);
      // The app's main column is a flex column and these wrappers centre with auto margins, which turns off stretch: without
      // w-full a long command or URL inside sizes the wrapper past a 360px screen.
      expect(src, `${file}: a centred page wrapper takes the full column width`).not.toMatch(/<div className="mx-auto max-w-\w+">/);
      expect(src, `${file}: no drop shadows`).not.toMatch(/\bshadow-(?:sm|md|lg|xl|2xl)\b/);
    });
  }

  it("the sign-in, sign-up, reset and join screens lead with the ink pill", () => {
    for (const file of ["src/components/app/AuthForm.tsx", "src/components/app/JoinForm.tsx", "src/components/app/AdminLogin.tsx", "src/components/app/VerifyForm.tsx"]) {
      const src = read(file);
      expect(src, file).not.toMatch(/<button\b[^>]*className="btn btn-primary"/);
      // Written out, or through the Button primitive's pill (rule 1082), which renders the same `s-btn` with the same scribble.
      expect(src.match(/className="s-btn"><Scribble kind="pill" seed="[^"]+" fill="ink" shadow ring \/>|<Button type="submit" variant="pill" seed="[^"]+"/g)?.length ?? 0, file).toBeGreaterThan(0);
    }
  });

  it("the OAuth consent screen, outside the [lang] layout, loads the D tokens and writes no colour value", () => {
    const src = read("src/app/oauth/authorize/page.tsx");
    expect(src).toMatch(/^import "\.\.\/\.\.\/tokens\.css";$/m);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).toMatch(/background: "var\(--color-ink\)", color: "var\(--color-paper\)"/);
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
