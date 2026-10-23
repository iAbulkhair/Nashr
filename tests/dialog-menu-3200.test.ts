// Dialog scroll lock and Menu typeahead, rules 3200-3201 in docs/system/tests/3200-dialog-scroll-menu-typeahead.md.
// Source-reading checks (no DOM in this suite) and the pure helper.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { menuMatch } from "@/components/ui/Menu";

const read = (f: string) => readFileSync(f, "utf8");

describe("rule 3200: the page behind a Dialog does not scroll while it is open", () => {
  const src = read("src/components/ui/Dialog.tsx");
  it("opening sets the root's overflow to hidden and closing puts back what was there, before focus returns", () => {
    expect(src).toMatch(/const before = root\.style\.overflow;\s*root\.style\.overflow = "hidden";/);
    expect(src).toMatch(/return \(\) => \{\s*root\.style\.overflow = before;\s*if \(opener\?\.isConnected\) opener\.focus\(\);/);
  });
  it("the lock lives in the one effect that opens the dialog, so FormDialog and usePrompt get it too", () => {
    expect(src.match(/root\.style\.overflow = "hidden"/g)).toHaveLength(1);
    expect(src).toMatch(/d\.showModal\(\);[\s\S]{0,200}root\.style\.overflow = "hidden"/);
  });
});

describe("rule 3201: typing a letter in an open Menu jumps to the next row that starts with it", () => {
  const rows = ["Settings", "Sign out", "Billing", "Help"];
  it("finds the next match after the focused row and wraps, so typing again moves on", () => {
    expect(menuMatch("s", -1, rows)).toBe(0);
    expect(menuMatch("s", 0, rows)).toBe(1);
    expect(menuMatch("s", 1, rows)).toBe(0);
    expect(menuMatch("h", 0, rows)).toBe(3);
    expect(menuMatch("b", 3, rows)).toBe(2);
  });
  it("ignores case and outer spaces", () => {
    expect(menuMatch("S", 3, ["  settings"])).toBe(0);
    expect(menuMatch("h", 0, ["Billing", " HELP "])).toBe(1);
  });
  it("matches Arabic rows, an alef also finding its hamza and madda forms", () => {
    const ar = ["الإعدادات", "تسجيل الخروج", "إدارة الفريق", "آخر النشاط", "أرشيف"];
    expect(menuMatch("ت", 0, ar)).toBe(1);
    expect(menuMatch("ا", 0, ar)).toBe(2);
    expect(menuMatch("ا", 2, ar)).toBe(3);
    expect(menuMatch("ا", 3, ar)).toBe(4);
    expect(menuMatch("ا", 4, ar)).toBe(0);
    expect(menuMatch("إ", 4, ar)).toBe(0);
  });
  it("a key that is not one printable character, or matches nothing, is not a jump", () => {
    for (const k of ["ArrowDown", "Enter", "Tab", " ", "", "Shift"]) expect(menuMatch(k, 0, rows), k).toBeNull();
    expect(menuMatch("z", 0, rows)).toBeNull();
    expect(menuMatch("a", -1, [])).toBeNull();
  });
  it("the menu reads each row's text, keeps the arrows first, and leaves Ctrl, Cmd and Alt shortcuts alone", () => {
    const src = read("src/components/ui/Menu.tsx");
    expect(src).toMatch(/menuIndex\(e\.key, at, items\.length\)\s*\?\? \(e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey \? null : menuMatch\(e\.key, at, items\.map\(\(_, i\) => rows\.current\[i\]\?\.textContent \?\? ""\)\)\)/);
  });
});
