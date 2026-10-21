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
  it("rule 1760: /m/ passes the lock without a cookie (the route checks its own session or signature); look-alikes stay locked", async () => {
    vi.stubEnv("APP_ENV", "staging"); vi.stubEnv("STAGING_ACCESS_KEY", key);
    const { proxy } = await import("@/proxy");
    const { stagingOpen } = await import("@/lib/staging-access");
    const file = `/m/${"a".repeat(32)}.jpg`;
    expect(stagingOpen(file)).toBe(true);
    const r = proxy(req(file));
    expect(r.status).not.toBe(404);
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    for (const p of ["/m", "/mx/a.jpg", "/M/a.jpg", "/ar/m/a.jpg", "/api/m/a.jpg"]) {
      expect(stagingOpen(p), p).toBe(false);
      expect(proxy(req(p)).status, p).toBe(404);
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
    // require(). A word after a slash is a path (the route `/api/instructions/refs/import` in the brand guard's list), never a statement. Comments are not stripped on purpose: a comment that looks like an import fails, the safe direction.
    const specs = (src: string) =>
      [...new Set([...src.matchAll(/(?<![/\w])(?:from|import|require)\s*\(?\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]))].sort();
    // A closed list: proxy -> {cookie-names, csrf, deploy-env, staging-access}; cookie-names -> nothing; csrf -> origin; staging-access -> {secret, deploy-env};
    // secret -> crypto; origin and deploy-env -> nothing. Anything else fails, so "./lib/rate", "@/lib/rate.ts" and import("@/lib/db") cannot slip by.
    const allowed: Record<string, string[]> = {
      "src/proxy.ts": ["@/lib/brand-path", "@/lib/brand-guard", "@/lib/cookie-names", "@/lib/csp", "@/lib/csrf", "@/lib/deploy-env", "@/lib/multi-org", "@/lib/request-id", "@/lib/settings-nav", "@/lib/staging-access", "@/lib/ws-path", "next/server"],
      // Multi-workspace M2: the switch and the link's handle (rule 2113). The handle's shape only; no store, no secret.
      "src/lib/multi-org.ts": ["crypto", "./account-id"],
      // The one link builder: the handle on top of the pure brand path helpers (a type import, erased at build).
      "src/lib/ws-path.ts": ["./brand-path", "./i18n"],
      // The settings redirect map (rule 1141): plain data; a type import, erased at build, the pure brand path helpers
      // (rule 885: a brand settings section is linked under /b/{id}) and the link builder, all import-free but for a type
      // and each other (pinned below).
      "src/lib/settings-nav.ts": ["./i18n", "./brand-path"],
      "src/lib/csrf.ts": ["@/lib/origin", "next/server"],
      "src/lib/origin.ts": [],
      "src/lib/staging-access.ts": ["@/lib/deploy-env", "@/lib/secret", "node:crypto"],
      "src/lib/deploy-env.ts": [],
      "src/lib/secret.ts": ["crypto"],
      // Cookie names and jar helpers (rules 1810-1813): import-free, so the language cookie read adds nothing behind it.
      "src/lib/cookie-names.ts": [],
      // The brand in the URL (rules 887-888): the header name and path reader (its one import is a type, erased at build, pinned below)
      // and the guard, which reads the cookie names and the method set and writes one log line; the logger reads the deploy name and the request id.
      "src/lib/brand-path.ts": ["./i18n"],
      "src/lib/brand-guard.ts": ["@/lib/brand-path", "@/lib/cookie-names", "@/lib/csrf", "@/lib/log", "next/server"],
      "src/lib/log.ts": ["./deploy-env", "./log-safe", "./request-id"],
      "src/lib/log-safe.ts": [],
      // The request id (rule 1975): import-free.
      "src/lib/request-id.ts": [],
      // The Content-Security-Policy and its nonce (rule 2320): import-free.
      "src/lib/csp.ts": [],
    };
    for (const [f, ok] of Object.entries(allowed))
      expect(specs(readFileSync(f, "utf8")).filter((s) => !ok.includes(s)), f).toEqual([]);
    expect(readFileSync("src/lib/settings-nav.ts", "utf8")).toMatch(/^import type \{ Lang \} from "\.\/i18n";$/m);
    expect(readFileSync("src/lib/settings-nav.ts", "utf8").match(/^import /gm)).toHaveLength(2);
    // The proxy reaches account-id.ts through multi-org.ts: crypto and zod only (its prose names `sc(u)`, which the spec reader would take for an import).
    expect(readFileSync("src/lib/account-id.ts", "utf8").match(/^import .*$/gm)).toEqual(['import { randomBytes } from "crypto";', 'import { z } from "zod";']);
    expect(readFileSync("src/lib/settings-nav.ts", "utf8")).toMatch(/^import \{ appHref, isBrandPath \} from "\.\/brand-path";$/m);
    expect(readFileSync("src/lib/ws-path.ts", "utf8").match(/^import .*$/gm)).toEqual(['import { appHref as brandHref, brandSectionOf } from "./brand-path";', 'import type { Lang } from "./i18n";']);
    expect(readFileSync("src/lib/brand-path.ts", "utf8")).toMatch(/^import type \{ Lang \} from "\.\/i18n";$/m);
    expect(readFileSync("src/lib/brand-path.ts", "utf8").match(/^import /gm)).toHaveLength(1);
    // And the lock gets sameSecret from the module with no store behind it, through no other path.
    expect(specs(readFileSync("src/lib/staging-access.ts", "utf8"))).toContain("@/lib/secret");
    expect(specs(readFileSync("src/proxy.ts", "utf8"))).toContain("@/lib/staging-access");
  });

  it("the proxy runs on every path but Next's static assets and the favicon, so nothing slips past the lock", async () => {
    const { unstable_doesMiddlewareMatch: runs } = await import("next/experimental/testing/server");
    const { config } = await import("@/proxy");
    for (const url of ["/", "/app", "/ar", "/en/pricing", "/ar/app/chat", "/api/health", "/api/chat", "/robots.txt", "/sitemap.xml", "/manifest.webmanifest", "/icon-192.png"])
      expect(runs({ config, url }), url).toBe(true);
    for (const url of ["/_next/static/chunks/main.js", "/_next/static/a", "/_next/image", "/_next/image?url=%2Fa.png&w=64&q=75", "/favicon.ico"]) expect(runs({ config, url }), url).toBe(false);
  });
  it("the exclusions are anchored: look-alikes of the static paths still meet the lock", async () => {
    const { unstable_doesMiddlewareMatch: runs } = await import("next/experimental/testing/server");
    const { config } = await import("@/proxy");
    for (const url of ["/favicon.icox", "/faviconXico/pricing", "/_next/staticx/a", "/_next/staticx", "/_next/imagex", "/_next/image/ar", "/favicon.ico/x"])
      expect(runs({ config, url }), url).toBe(true);
  });
});

describe("the proxy buffers at most 6 MB of a request body (rule 774)", () => {
  it("next.config caps it under Next's 10 MB default and above the largest body a route takes", async () => {
    const cap = (await import("../next.config")).default.experimental?.proxyClientMaxBodySize;
    expect(cap).toBe(6 * 1024 * 1024);
    // The largest: POST /api/performance with the longest CSV it accepts, every character three bytes in UTF-8 (U+FFFD,
    // what a byte that is not UTF-8 becomes when the page reads the file), and a long file name.
    const { MAX_CSV_CHARS, METRICS } = await import("@/lib/perf-import");
    const worst = JSON.stringify({ csv: "�".repeat(MAX_CSV_CHARS), file: "ت".repeat(255) + ".csv", metric: Object.keys(METRICS)[0] });
    expect(Buffer.byteLength(worst)).toBeLessThan(cap as number);
    expect(cap as number).toBeLessThan(10 * 1024 * 1024);
  });
});

describe("the staging access route (rule 675)", () => {
  const key = "staging-key-" + "z".repeat(30);
  const post = async (code: string | null, ip: string, url = "http://localhost:3000/api/staging-access") => {
    const { POST } = await import("@/app/api/staging-access/route");
    const body = new URLSearchParams(code === null ? { lang: "ar" } : { code, lang: "ar" });
    return POST(new Request(url, { method: "POST", body, headers: { "x-forwarded-for": ip, "content-type": "application/x-www-form-urlencoded" } }));
  };
  beforeEach(async () => {
    // The store is chosen when `db` first loads, and staging counts as production (rule 430): load it before the stub
    // so the limiter gets the memory store, not the one that refuses.
    await import("@/lib/db");
    vi.stubEnv("APP_ENV", "staging"); vi.stubEnv("STAGING_ACCESS_KEY", key); vi.stubEnv("APP_ORIGIN", "https://staging.example");
  });

  it("right code: 303 to APP_ORIGIN (never req.url's host) with the token cookie, flags set, code absent", async () => {
    const { accessToken } = await import("@/lib/staging-access");
    const r = await post(key, "10.0.0.1");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("https://staging.example/ar");
    const c = r.headers.get("set-cookie") ?? "";
    expect(c).toContain(`thakeen_staging=${accessToken(key)}`);
    expect(c).toMatch(/HttpOnly/i); expect(c).toMatch(/Secure/i); expect(c).toMatch(/SameSite=lax/i);
    expect(c).not.toContain(key);
  });
  it("Secure follows the https APP_ORIGIN, whatever Host and x-forwarded-proto the proxy forwards (rule 675)", async () => {
    // The worst case for `sessionCookie`: a loopback Host and no x-forwarded-proto reads as plain http to localhost, and
    // its own rule then drops Secure. Behind Hostinger the request can look like that, so the route must not rely on it.
    const seen: Record<string, string>[] = [
      {}, { host: "localhost:3000" }, { host: "127.0.0.1:3000" }, { host: "[::1]:3000" },
      { host: "localhost:3000", "x-forwarded-proto": "http" }, { host: "staging.example", "x-forwarded-proto": "https" },
    ];
    const { withHeaders } = await import("./helpers/session");
    for (const [i, h] of seen.entries()) {
      const c = (await withHeaders(h, () => post(key, `10.0.1.${i}`))).headers.get("set-cookie") ?? "";
      expect(c, JSON.stringify(h)).toMatch(/;\s*Secure(;|$)/i);
      expect(c, JSON.stringify(h)).toMatch(/HttpOnly/i);
    }
  });
  it("over an http APP_ORIGIN (local development) the helper's rule stays: no Secure on plain http to loopback", async () => {
    vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
    const { withHeaders } = await import("./helpers/session");
    const local = await withHeaders({ host: "localhost:3000" }, () => post(key, "10.0.1.20"));
    expect(local.headers.get("location")).toBe("http://localhost:3000/ar");
    expect(local.headers.get("set-cookie") ?? "").not.toMatch(/Secure/i);
    // A real host over plain http keeps the flag, so that mistake fails loudly instead of quietly dropping it.
    const real = await withHeaders({ host: "staging.example" }, () => post(key, "10.0.1.21"));
    expect(real.headers.get("set-cookie") ?? "").toMatch(/;\s*Secure(;|$)/i);
  });
  it("wrong code, a code only in the URL, and a missing key: back to the page with e=1, no cookie", async () => {
    for (const [code, url] of [["nope", undefined], [null, `http://localhost:3000/api/staging-access?code=${key}`]] as const) {
      const r = await post(code, "10.0.0.2", url);
      expect(r.headers.get("location")).toBe("https://staging.example/ar/staging-access?e=1");
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    vi.stubEnv("STAGING_ACCESS_KEY", "");
    expect((await post("", "10.0.0.3")).headers.get("set-cookie")).toBeNull();
  });
  it("five tries per IP per 15 minutes, then 429 even with the right code", async () => {
    for (let i = 0; i < 5; i++) await post("nope", "10.0.0.4");
    const r = await post(key, "10.0.0.4");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("900");
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(await r.json()).toEqual({ ok: false, error: "slow_down" });
  });
  it("the bucket is per client address: the last x-forwarded-for hop gets its own five tries, a spoofed header none (rule 773)", async () => {
    vi.stubEnv("VERCEL", ""); // Hostinger: no VERCEL
    const { POST } = await import("@/app/api/staging-access/route");
    const from = (h: Record<string, string>) => POST(new Request("http://localhost:3000/api/staging-access", {
      method: "POST", body: new URLSearchParams({ code: "nope", lang: "ar" }), headers: { ...h, "content-type": "application/x-www-form-urlencoded" },
    }));
    const clients: Record<string, string>[][] = [
      [{ "x-forwarded-for": "10.0.2.1" }, { "x-forwarded-for": "10.0.2.2" }],
      // A proxy that only appends to x-forwarded-for: the caller's own earlier hops do not matter, the last one does.
      [{ "x-forwarded-for": "9.9.9.9, 10.0.2.3" }, { "x-forwarded-for": "9.9.9.9, 10.0.2.4" }],
    ];
    for (const [a, b] of clients) {
      for (let i = 0; i < 5; i++) expect((await from(a)).status).toBe(303);
      expect((await from(a)).status, "the sixth try of the first client").toBe(429);
      expect((await from(b)).status, "a second client is not locked out by the first").toBe(303);
    }
    // Off Vercel, x-vercel-forwarded-for and x-real-ip come from the caller: a new value of either is not a new client.
    for (const spoof of [{ "x-vercel-forwarded-for": "198.51.100.1" }, { "x-real-ip": "198.51.100.2" }] as Record<string, string>[]) {
      expect((await from({ ...spoof, "x-forwarded-for": "9.9.9.9, 10.0.2.3" })).status, JSON.stringify(spoof)).toBe(429);
    }
  });
  it("with no address header at all every caller shares one bucket: the case the staging check rules out", async () => {
    // Pins the known limit so a change is deliberate: if the host forwarded no client address, five tries from anyone
    // would lock everyone out for 15 minutes. flows.md section 51 (item 7) has the check that Hostinger does forward one.
    const { POST } = await import("@/app/api/staging-access/route");
    const blind = () => POST(new Request("http://localhost:3000/api/staging-access", {
      method: "POST", body: new URLSearchParams({ code: key, lang: "ar" }), headers: { "content-type": "application/x-www-form-urlencoded" },
    }));
    for (let i = 0; i < 5; i++) expect((await blind()).status).toBe(303);
    expect((await blind()).status).toBe(429);
  });
  it("off staging the route and the page are 404", async () => {
    vi.stubEnv("APP_ENV", "");
    expect((await post(key, "10.0.0.5")).status).toBe(404);
    const Page = (await import("@/app/[lang]/staging-access/page")).default;
    await expect(Page({ params: Promise.resolve({ lang: "ar" }), searchParams: Promise.resolve({}) })).rejects.toThrow();
  });
  it("every method but POST is a bare 404, off staging and on it: no 405, no OPTIONS that lists the route's methods", async () => {
    const route: Record<string, unknown> = await import("@/app/api/staging-access/route");
    const { HTTP_METHODS } = await import("next/dist/server/web/http");
    // Each method Next routes must be exported here, or Next fills it in (405, or 204 with `Allow`) and shows the route.
    const others = HTTP_METHODS.filter((m) => m !== "POST");
    expect(others.length).toBe(6);
    for (const env of ["", "staging"]) {
      vi.stubEnv("APP_ENV", env);
      for (const m of others) {
        const handler = route[m] as (req: Request) => Response | Promise<Response>;
        expect(typeof handler, m).toBe("function");
        const r = await handler(new Request("http://localhost:3000/api/staging-access", { method: m }));
        expect(r.status, `${env || "live"} ${m}`).toBe(404);
        expect(r.headers.get("allow"), m).toBeNull();
        expect(await r.text(), m).toBe("");
      }
    }
  });
  it("never logs the code", () => {
    expect(readFileSync("src/app/api/staging-access/route.ts", "utf8")).not.toMatch(/console\.\w+\([^)]*code/);
  });
});

describe("staging is never indexed (rule 677)", () => {
  it("robots disallows everything with no sitemap line; the sitemap is empty", async () => {
    vi.stubEnv("APP_ENV", "staging");
    expect((await import("@/app/robots")).default()).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
    expect((await import("@/app/sitemap")).default()).toEqual([]);
  });
  it("off staging robots is unchanged", async () => {
    vi.stubEnv("APP_ENV", "");
    expect((await import("@/app/robots")).default().rules).toEqual([{ userAgent: "*", allow: "/", disallow: ["/api/", "/ar/app/", "/en/app/"] }]);
  });
});
