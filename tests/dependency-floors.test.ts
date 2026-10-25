import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Rule 662: no installed version below a known security fix.
// - next < 16.3.6: GHSA-vcvr-r3jv-pc5j, remote code execution in the Node.js ImageResponse from next/og.
// - next < 16.4.1 (rule 3190): GHSA-673q-mjm6-r5xr and GHSA-2464-fhr4-w9xw, unauthenticated remote code execution in
//   `use cache` functions returning typed arrays and in the Image Optimization API with SVG files;
//   GHSA-p3m5-59mp-jv5r, denial of service in the App Router through Server Actions.
// - image-size < 2.0.3: CVE-2025-71329 and CVE-2025-71330, infinite loops in the JXL, HEIF and ICNS parsers. It
//   arrives through pptxgenjs, which still asks for ^1.2.1, so an override lifts it.
const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, { version?: string }> };
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { overrides?: Record<string, string> };

function atLeast(version: string, floor: string): boolean {
  const a = version.split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

function installed(name: string): string[] {
  return Object.entries(lock.packages)
    .filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
    .map(([, p]) => p.version!);
}

describe("dependencies stay above their security fixes", () => {
  it("every copy of next is 16.4.1 or later", () => {
    const versions = installed("next");
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) expect(atLeast(v, "16.4.1"), `next ${v}`).toBe(true);
  });

  it("every copy of image-size is 2.0.3 or later, held there by an override", () => {
    expect(pkg.overrides?.["image-size"]).toBe("^2.0.3");
    const versions = installed("image-size");
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) expect(atLeast(v, "2.0.3"), `image-size ${v}`).toBe(true);
  });
});
