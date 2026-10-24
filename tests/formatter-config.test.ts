import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pickFiles } from "../scripts/format-check.mjs";

describe("formatter settings (rule 3980)", () => {
  it("keeps the style the code already has", () => {
    const rc = JSON.parse(readFileSync(".prettierrc.json", "utf8"));
    expect(rc).toMatchObject({ printWidth: 120, semi: true, singleQuote: false, trailingComma: "all" });
  });

  it("checks only code files that changed, not data, docs, builds or the lockfile", () => {
    const picked = pickFiles([
      "src/lib/a.ts",
      "src/components/B.tsx",
      "scripts/x.mjs",
      "package.json",
      "package-lock.json",
      "docs/system/flows.md",
      "content/blog/post.md",
      "public/icon.png",
      "node_modules/x/index.js",
      "",
    ]);
    expect(picked).toEqual(["src/lib/a.ts", "src/components/B.tsx", "scripts/x.mjs", "package.json"]);
  });

  it("exposes format:check and format scripts and pins prettier exactly", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["format:check"]).toContain("format-check.mjs");
    expect(pkg.devDependencies.prettier).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
