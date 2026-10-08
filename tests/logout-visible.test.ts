import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

// Rule 730: the way out can be seen and found. The sidebar's button was lilac on paper (#efe7f7 on white), so the
// founder could not find it on 2026-10-08; the profile page now carries a second one.
describe("log out is visible (rule 730)", () => {
  it("the button's default colour is ink, never a lilac tint", () => {
    const src = read("src/components/app/LogoutButton.tsx");
    expect(src).not.toMatch(/text-lilac/);
    expect(src).toMatch(/className = "[^"]*\btext-ink\b[^"]*"/);
  });

  it("the profile page offers log out next to the account settings", () => {
    const src = read("src/components/app/ProfilePanel.tsx");
    expect(src).toMatch(/import LogoutButton from "\.\/LogoutButton";/);
    expect(src).toMatch(/<LogoutButton label=\{t\.nav\.logout\} lang=\{lang\} className="btn btn-secondary btn-sm" \/>/);
  });

  it("the sidebar menu keeps its log out button", () => {
    expect(read("src/components/app/Sidebar.tsx")).toMatch(/<LogoutButton label=\{N\.logout\} lang=\{lang\} \/>/);
  });
});
