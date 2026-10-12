import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

// Rule 750: the way out can be seen and found. The sidebar's button was lilac on paper (#efe7f7 on white), so the
// founder could not find it on 2026-10-08; the profile page now carries a second one.
describe("log out is visible (rule 750)", () => {
  it("the button's default colour is ink (the foreground role since rule 1200), never a lilac tint", () => {
    const src = read("src/components/app/LogoutButton.tsx");
    expect(src).not.toMatch(/text-lilac/);
    expect(src).not.toMatch(/text-inverse-muted/);
    expect(src).toMatch(/className = "[^"]*\btext-foreground\b[^"]*"/);
  });

  it("the settings danger zone offers log out (it moved there from the old profile page, rule 1149)", () => {
    const src = read("src/components/app/settings/DangerZone.tsx");
    expect(src).toMatch(/import LogoutButton from "\.\.\/LogoutButton";/);
    expect(src).toMatch(/<LogoutButton label=\{logoutLabel\} lang=\{lang\} className=\{buttonClass\(\{ variant: "secondary", size: "sm" \}\)\} \/>/);
    expect(read("src/app/[lang]/app/settings/danger/page.tsx")).toContain("logoutLabel={t.nav.logout}");
  });

  it("the sidebar menu keeps its log out button", () => {
    expect(read("src/components/app/Sidebar.tsx")).toMatch(/<LogoutButton label=\{N\.logout\} lang=\{lang\} \/>/);
  });
});
