import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

// Rule 661: Hostinger's shared hosting cannot run Turbopack's PostCSS worker process, so thakeen.com builds with webpack,
// and webpack refuses any page without a root layout.
describe("the Hostinger build (rule 661)", () => {
  it("has a webpack build script, and the Vercel build stays as it is", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["build:hostinger"]).toBe("next build --webpack");
    expect(pkg.scripts.build).toBe("next build");
  });

  it("every top-level app route with pages has a root layout", () => {
    // [lang] holds the site and the app; oauth holds the consent screen, which renders its own document.
    expect(existsSync("src/app/[lang]/layout.tsx")).toBe(true);
    expect(existsSync("src/app/oauth/layout.tsx")).toBe(true);
    expect(existsSync("src/app/layout.tsx")).toBe(false);
  });
});
