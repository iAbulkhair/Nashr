import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

afterEach(() => vi.unstubAllEnvs());

describe("the staging access token (rules 674-675)", () => {
  it("isStaging is APP_ENV=staging only", async () => {
    const { isStaging } = await import("@/lib/deploy-env");
    for (const [v, want] of [["staging", true], ["", false], ["production", false], ["preview", false], ["Staging", false]] as const) {
      vi.stubEnv("APP_ENV", v); expect(isStaging(), v).toBe(want);
    }
  });
  it("token is the HMAC of the fixed label, never the key, and null without a key", async () => {
    const { accessToken } = await import("@/lib/staging-access");
    const { createHmac } = await import("node:crypto");
    expect(accessToken("k".repeat(40))).toBe(createHmac("sha256", "k".repeat(40)).update("staging-access-v1").digest("hex"));
    expect(accessToken("")).toBeNull();
    expect(accessToken(undefined)).toBeNull();
  });
  it("hasAccess: right token yes; raw code, old-key token, empty and missing key no", async () => {
    const { accessToken, hasAccess } = await import("@/lib/staging-access");
    const key = "staging-key-" + "x".repeat(30);
    vi.stubEnv("STAGING_ACCESS_KEY", key);
    expect(hasAccess(accessToken(key)!)).toBe(true);
    expect(hasAccess(key)).toBe(false);
    expect(hasAccess(accessToken("old-" + key)!)).toBe(false);
    expect(hasAccess(undefined)).toBe(false);
    vi.stubEnv("STAGING_ACCESS_KEY", "");
    expect(hasAccess(accessToken(key)!)).toBe(false);
  });
});
