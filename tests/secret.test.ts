import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("sameSecret lives in a module with no store behind it", () => {
  it("is the same function from secret.ts and rate.ts", async () => {
    const a = await import("@/lib/secret"), b = await import("@/lib/rate");
    expect(a.sameSecret).toBe(b.sameSecret);
    expect(a.sameSecret("k1", "k1")).toBe(true);
    expect(a.sameSecret("k1", "k2")).toBe(false);
    expect(a.sameSecret("", "")).toBe(false);
    expect(a.sameSecret(undefined, undefined)).toBe(false);
  });
  it("secret.ts imports only crypto", () => {
    const src = readFileSync("src/lib/secret.ts", "utf8");
    expect(src.match(/from\s+["'][^"']+["']/g)).toEqual(['from "crypto"']);
  });
});
