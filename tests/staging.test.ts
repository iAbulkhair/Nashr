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

const req = (path: string, cookie?: string) =>
  new NextRequest("https://staging.example" + path, cookie ? { headers: { cookie: `thakeen_staging=${cookie}` } } : undefined);

describe("the proxy off staging behaves as before (rule 674)", () => {
  it("/ redirects, app paths get x-pathname, others pass untouched, no robots header", async () => {
    vi.stubEnv("APP_ENV", "");
    const { proxy } = await import("@/proxy");
    expect(proxy(req("/")).status).toBe(307);
    expect(proxy(req("/ar/app/tasks")).headers.get("x-middleware-request-x-pathname")).toBe("/ar/app/tasks");
    const page = proxy(req("/ar/pricing"));
    expect(page.headers.get("x-middleware-next")).toBe("1");
    expect(page.headers.get("x-middleware-request-x-pathname")).toBeNull();
    for (const p of ["/", "/ar/pricing", "/api/health"]) expect(proxy(req(p)).headers.get("x-robots-tag")).toBeNull();
  });
});

describe("the staging lock (rules 674, 677)", () => {
  const key = "staging-key-" + "y".repeat(30);
  it("no cookie: 404 everywhere but the four open paths, all noindex", async () => {
    vi.stubEnv("APP_ENV", "staging"); vi.stubEnv("STAGING_ACCESS_KEY", key);
    const { proxy } = await import("@/proxy");
    for (const p of ["/", "/ar", "/ar/app/tasks", "/api/health", "/api/cron/weekly", "/sitemap.xml",
      "/ar/staging-access/", "/AR/staging-access", "/ar/staging-access/x", "/en/staging-accessx", "/robots.txt/x"]) {
      const r = proxy(req(p)); expect(r.status, p).toBe(404); expect(r.headers.get("x-robots-tag"), p).toBe("noindex, nofollow");
    }
    for (const p of ["/ar/staging-access", "/en/staging-access", "/api/staging-access", "/robots.txt"]) {
      const r = proxy(req(p)); expect(r.status, p).not.toBe(404); expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });
  it("valid cookie passes with noindex; a wrong cookie or a missing key stays locked", async () => {
    vi.stubEnv("APP_ENV", "staging"); vi.stubEnv("STAGING_ACCESS_KEY", key);
    const { proxy } = await import("@/proxy");
    const { accessToken } = await import("@/lib/staging-access");
    const ok = proxy(req("/ar/pricing", accessToken(key)!));
    expect(ok.status).not.toBe(404); expect(ok.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(proxy(req("/", accessToken(key)!)).status).toBe(307);
    expect(proxy(req("/ar", "deadbeef")).status).toBe(404);
    vi.stubEnv("STAGING_ACCESS_KEY", "");
    expect(proxy(req("/ar", accessToken(key)!)).status).toBe(404);
  });
  it("the proxy and its lock never load the store", () => {
    // Every module a file names, however it spells the path: static and side-effect imports, re-exports, import() and
    // require(). Comments are not stripped on purpose: a comment that looks like an import fails, the safe direction.
    const specs = (src: string) =>
      [...new Set([...src.matchAll(/\b(?:from|import|require)\s*\(?\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]))].sort();
    // A closed list: proxy -> {deploy-env, staging-access}; staging-access -> {secret, deploy-env}; secret -> crypto;
    // deploy-env -> nothing. Anything else fails, so "./lib/rate", "@/lib/rate.ts" and import("@/lib/db") cannot slip by.
    const allowed: Record<string, string[]> = {
      "src/proxy.ts": ["@/lib/deploy-env", "@/lib/staging-access", "next/server"],
      "src/lib/staging-access.ts": ["@/lib/deploy-env", "@/lib/secret", "node:crypto"],
      "src/lib/deploy-env.ts": [],
      "src/lib/secret.ts": ["crypto"],
    };
    for (const [f, ok] of Object.entries(allowed))
      expect(specs(readFileSync(f, "utf8")).filter((s) => !ok.includes(s)), f).toEqual([]);
    // And the lock gets sameSecret from the module with no store behind it, through no other path.
    expect(specs(readFileSync("src/lib/staging-access.ts", "utf8"))).toContain("@/lib/secret");
    expect(specs(readFileSync("src/proxy.ts", "utf8"))).toContain("@/lib/staging-access");
  });
});
