import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Source scans for five small client-side defects (P2): a double tap, a shared in-flight flag, raw JSON-LD, physical
// direction classes and a prototype-chain lookup. They read the files, so a revert fails here without a browser.
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("UI P2 fixes (rule 2934)", () => {
  it("Sidebar newThread has a pending guard, disables the buttons and survives a failed request", () => {
    const s = src("src/components/app/Sidebar.tsx");
    const fn = s.slice(s.indexOf("async function newThread"), s.indexOf("// The brand switcher's list"));
    expect(fn).toMatch(/if \(creating\) return;/);
    expect(fn).toContain("setCreating(true)");
    expect(fn).toMatch(/\.catch\(\(\) => null\)/);
    expect(fn).toContain("setCreating(false)");
    expect(fn).toContain("j?.ok");
    expect(s.match(/disabled=\{creating\} onClick=\{\(\) => newThread\(/g)?.length).toBe(2);
  });

  it("Inbox keeps a Set of in-flight publishes and each button reads its own key", () => {
    const s = src("src/components/app/Inbox.tsx");
    expect(s).toMatch(/useState<ReadonlySet<string>>\(new Set\(\)\)/);
    expect(s).toMatch(/setPublishing\(\(p\) => new Set\(p\)\.add\(key\)\)/);
    expect(s).toMatch(/next\.delete\(key\)/);
    expect(s).not.toMatch(/setPublishing\(null\)/);
    expect(s).not.toMatch(/publishing === /);
    expect(s.match(/publishing\.has\(/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("the ai-marketing-agent page writes its JSON-LD through ldJson", () => {
    const s = src("src/app/[lang]/ai-marketing-agent/page.tsx");
    expect(s).toContain('import { ldJson } from "@/lib/home-ld"');
    expect(s).toContain("ldJson(faqLd)");
    expect(s).toContain("ldJson(artLd)");
    expect(s).not.toMatch(/__html: JSON\.stringify/);
  });

  it("the three components use no text-left and no space-x classes", () => {
    for (const f of ["src/components/admin/Quality.tsx", "src/components/admin/AgentScopePanel.tsx", "src/components/app/DictionaryStart.tsx"]) {
      const s = src(f);
      expect(s, f).not.toMatch(/text-left/);
      expect(s, f).not.toMatch(/space-x-/);
    }
  });

  it("WorkspacesPanel looks an error code up with Object.hasOwn, not the prototype chain", () => {
    const s = src("src/components/app/WorkspacesPanel.tsx");
    expect(s).toContain("Object.hasOwn(t.errors, code)");
    expect(s).not.toMatch(/code in t\.errors/);
  });
});
