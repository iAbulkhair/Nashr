import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Rules 3007-3008 (docs/system/tests/3000-e2e-journeys.md): two faults the new end-to-end journeys found. The browser
 * halves are `e2e/brands.spec.ts` and `e2e/account-2fa.spec.ts`; these pin the code so a change is caught without a build.
 */
describe("the sidebar's brand menu refreshes the shell after the push (rule 3007)", () => {
  it("BrandSwitcher pushes the brand's path and then refreshes, as the brands page does", () => {
    const src = readFileSync("src/components/app/BrandSwitcher.tsx", "utf8");
    expect(src).toMatch(/pickBrand\(id, path, \(h\) => \{ r\.push\(h\); r\.refresh\(\); \}\)/);
    expect(readFileSync("src/components/app/BrandsPanel.tsx", "utf8")).toMatch(/r\.push\(switchBrandPath\(path, body\.id\)\); r\.refresh\(\);/);
  });
});

describe("the end-to-end server has its own CONNECT_SECRET (rule 3008)", () => {
  it("made fresh per run in e2e/web-server.ts and passed to the web server, never a literal", () => {
    const ws = readFileSync("e2e/web-server.ts", "utf8");
    expect(ws).toMatch(/export const E2E_CONNECT_SECRET = \(process\.env\.E2E_CONNECT_SECRET \?\?= randomBytes\(32\)\.toString\("base64url"\)\);/);
    const config = readFileSync("playwright.config.ts", "utf8");
    expect(config).toMatch(/CONNECT_SECRET: E2E_CONNECT_SECRET/);
  });
});
