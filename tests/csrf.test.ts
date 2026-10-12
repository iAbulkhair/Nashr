import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { NextRequest, type NextResponse } from "next/server";
import * as pageStaticInfo from "next/dist/build/analysis/get-page-static-info";
import type { ProxyMatcher } from "next/dist/build/analysis/get-page-static-info";
import { getMiddlewareRouteMatcher } from "next/dist/shared/lib/router/utils/middleware-route-matcher";
import { CROSS_SITE_EXEMPT, CROSS_SITE_METHODS, crossSiteRefusal, isCrossSiteExempt } from "@/lib/csrf";
import { appOrigin } from "@/lib/origin";
import { STAGING_COOKIE, accessToken } from "@/lib/staging-access";
import { config, proxy } from "@/proxy";

/**
 * The cross-site request check for `/api` (rules 690-693, src/lib/csrf.ts, spec
 * docs/superpowers/specs/2026-10-08-supastarter-adoption-design.md phase 1 item 2). `SameSite=Lax` leaves login and
 * logout CSRF, `text/plain` form JSON and posts from same-site siblings open; the browser's `Sec-Fetch-Site` and
 * `Origin` close them, and `src/proxy.ts` runs the check before every `/api` route.
 */

const SITE = "https://thakeen.com";
/** A public host that is neither SITE nor the fallback origin. */
const OTHER = "https://other-site.example";

/** A request as the browser sends it to production: TLS ended at the edge, the public host in Host and X-Forwarded-*. */
const req = (path: string, init: { method?: string; headers?: Record<string, string>; base?: string } = {}) =>
  new NextRequest(`${init.base ?? SITE}${path}`, {
    method: init.method ?? "POST",
    headers: { host: "thakeen.com", "x-forwarded-host": "thakeen.com", "x-forwarded-proto": "https", "content-type": "application/json", ...init.headers },
    ...((init.method ?? "POST") === "GET" || init.method === "HEAD" ? {} : { body: "{}" }),
  });

const CROSS = { "sec-fetch-site": "cross-site", origin: "https://evil.example" };
const SAME = { "sec-fetch-site": "same-origin", origin: SITE };

async function expectRefused(res: NextResponse | null) {
  expect(res, "expected a 403").not.toBeNull();
  expect(res!.status).toBe(403);
  expect(res!.headers.get("cache-control")).toBe("no-store");
  expect(await res!.json()).toEqual({ error: "cross_site" });
}

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", SITE);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("rule 690: a POST, PUT, PATCH or DELETE to /api that another site started (Sec-Fetch-Site cross-site, a foreign Origin, or Origin null) is refused with 403 cross_site", () => {
  const routes: [string, string][] = [
    ["POST", "/api/auth/login"],
    ["POST", "/api/auth/logout"],
    ["POST", "/api/auth/signup"],
    ["PUT", "/api/brand"],
    ["PATCH", "/api/tasks/abc"],
    ["DELETE", "/api/files"],
  ];

  it.each(routes)("%s %s with Sec-Fetch-Site cross-site", async (method, path) => {
    await expectRefused(crossSiteRefusal(req(path, { method, headers: CROSS })));
  });

  it.each(routes)("%s %s with a foreign Origin and no Sec-Fetch-Site (a browser that does not send it)", async (method, path) => {
    await expectRefused(crossSiteRefusal(req(path, { method, headers: { origin: "https://evil.example" } })));
  });

  it("Origin null is refused (a sandboxed frame, a data: page, a redirect across origins)", async () => {
    await expectRefused(crossSiteRefusal(req("/api/auth/login", { headers: { origin: "null" } })));
    await expectRefused(crossSiteRefusal(req("/api/brand", { method: "PUT", headers: { origin: "null" } })));
  });

  it("a cross-site <form enctype=\"text/plain\"> carrying JSON is refused before any route reads it", async () => {
    await expectRefused(crossSiteRefusal(req("/api/brand", { method: "PUT", headers: { ...CROSS, "content-type": "text/plain" } })));
  });

  it("an unknown Sec-Fetch-Site value is refused", async () => {
    await expectRefused(crossSiteRefusal(req("/api/auth/login", { headers: { "sec-fetch-site": "maybe", origin: SITE } })));
  });

  it("plain http on our host is refused when the request came over TLS (no downgrade)", async () => {
    await expectRefused(crossSiteRefusal(req("/api/auth/login", { headers: { origin: "http://thakeen.com" } })));
  });

  it("a host header shaped like a URL is not turned into an accepted origin", async () => {
    const r = req("/api/auth/login", { headers: { host: "thakeen.com@evil.example", "x-forwarded-host": "evil.example/x", origin: "https://evil.example" } });
    await expectRefused(crossSiteRefusal(r));
  });
});

describe("rule 691: a post from a same-site sibling such as staging.thakeen.com is refused, though SameSite=Lax would send the cookie", () => {
  it("Sec-Fetch-Site same-site from https://staging.thakeen.com to thakeen.com", async () => {
    await expectRefused(crossSiteRefusal(req("/api/auth/login", { headers: { "sec-fetch-site": "same-site", origin: "https://staging.thakeen.com" } })));
    await expectRefused(crossSiteRefusal(req("/api/tasks/abc", { method: "PATCH", headers: { "sec-fetch-site": "same-site", origin: "https://staging.thakeen.com" } })));
  });

  it("Sec-Fetch-Site same-site or cross-site is refused on its own, whatever Origin says", async () => {
    await expectRefused(crossSiteRefusal(req("/api/auth/login", { headers: { "sec-fetch-site": "same-site" } })));
    await expectRefused(crossSiteRefusal(req("/api/auth/login", { headers: { "sec-fetch-site": "same-site", origin: SITE } })));
    await expectRefused(crossSiteRefusal(req("/api/auth/login", { headers: { "sec-fetch-site": "cross-site", origin: SITE } })));
  });

  it("the sibling's Origin alone, from a browser that does not send Sec-Fetch-Site", async () => {
    expect(appOrigin()).toBe(SITE);
    await expectRefused(crossSiteRefusal(req("/api/auth/logout", { headers: { origin: "https://staging.thakeen.com" } })));
  });
});

describe("rule 692: same-origin requests, requests with neither header, GET, HEAD and OPTIONS, and the exempt paths pass", () => {
  it("Sec-Fetch-Site same-origin with our Origin passes", () => {
    for (const [method, path] of [["POST", "/api/auth/login"], ["POST", "/api/auth/logout"], ["PATCH", "/api/tasks/abc"], ["DELETE", "/api/files"]]) {
      expect(crossSiteRefusal(req(path, { method, headers: SAME }))).toBeNull();
    }
  });

  it("Sec-Fetch-Site same-origin decides alone: it passes when the server sees neither its public host nor APP_ORIGIN", () => {
    // Hostinger with no APP_ORIGIN, behind a proxy that rewrites Host and sends no X-Forwarded-Host: comparing Origin
    // here would refuse every login. A browser never pairs same-origin with a foreign Origin; a forged pair has no cookie.
    // The fallback origin is the live site (rule 987), so the public host here is another one: a host with no APP_ORIGIN.
    vi.stubEnv("APP_ORIGIN", "");
    expect(appOrigin()).not.toBe(OTHER);
    const r = new NextRequest("http://127.0.0.1:3000/api/auth/login", { method: "POST", headers: { host: "127.0.0.1:3000", "sec-fetch-site": "same-origin", origin: OTHER }, body: "{}" });
    expect(crossSiteRefusal(r)).toBeNull();
  });

  it("without Sec-Fetch-Site, an Origin that matches X-Forwarded-Host passes with no APP_ORIGIN (Hostinger behind its proxy)", () => {
    vi.stubEnv("APP_ORIGIN", "");
    expect(appOrigin()).not.toBe(OTHER);
    const r = req("/api/auth/login", { base: "http://localhost:3000", headers: { host: "localhost:3000", "x-forwarded-host": "other-site.example", "x-forwarded-proto": "https", origin: OTHER } });
    expect(crossSiteRefusal(r)).toBeNull();
  });

  it("without Sec-Fetch-Site, https on the request's own host passes when TLS ends upstream and no X-Forwarded-Proto arrives", () => {
    vi.stubEnv("APP_ORIGIN", "");
    const r = new NextRequest("http://thakeen.com/api/auth/login", { method: "POST", headers: { host: "thakeen.com", origin: SITE }, body: "{}" });
    expect(crossSiteRefusal(r)).toBeNull();
  });

  it("without Sec-Fetch-Site, plain http on localhost passes in development", () => {
    vi.stubEnv("APP_ORIGIN", "");
    const r = new NextRequest("http://localhost:3000/api/auth/login", { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000" }, body: "{}" });
    expect(crossSiteRefusal(r)).toBeNull();
  });

  it("an Origin equal to appOrigin() passes even when a proxy hands the server another host", () => {
    const r = req("/api/auth/login", { base: "http://internal.example", headers: { host: "internal.example", "x-forwarded-host": "", "x-forwarded-proto": "", origin: SITE } });
    expect(crossSiteRefusal(r)).toBeNull();
  });

  it("Sec-Fetch-Site none (the person started it) with no Origin passes", () => {
    expect(crossSiteRefusal(req("/api/auth/logout", { headers: { "sec-fetch-site": "none" } }))).toBeNull();
  });

  it("a request with neither header passes (cron, QStash, webhooks, MCP and OAuth clients hold no browser cookie)", () => {
    expect(crossSiteRefusal(req("/api/cron/secretary"))).toBeNull();
    expect(crossSiteRefusal(req("/api/auth/login"))).toBeNull();
  });

  it("GET, HEAD and OPTIONS are never checked", () => {
    expect([...CROSS_SITE_METHODS].sort()).toEqual(["DELETE", "PATCH", "POST", "PUT"]);
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(crossSiteRefusal(req("/api/tasks", { method, headers: CROSS }))).toBeNull();
  });

  it("the exempt paths pass a cross-site post", () => {
    for (const path of ["/api/mcp", "/api/mcp/", "/api/oauth/token", "/api/oauth/register", "/api/media/hook/kie", "/api/media/hook/higgsfield", "/api/secretary/booking/0123abcd", "/api/billing/paymob/webhook", "/api/cron/secretary"]) {
      expect(crossSiteRefusal(req(path, { headers: CROSS })), path).toBeNull();
    }
  });

  it("an exemption is one exact path or a prefix ending in /, so the cookie routes beside it stay checked", async () => {
    for (const path of ["/api/mcp/token", "/api/mcp/grants", "/api/oauth/approve", "/api/secretary/booking", "/api/secretary/booking/", "/api/media/hookx", "/api/billing/paymobx", "/api/cron", "/api/cron/", "/api/cronx"]) {
      await expectRefused(crossSiteRefusal(req(path, { method: path === "/api/mcp/grants" ? "DELETE" : "POST", headers: CROSS })));
    }
  });

  // What makes an exemption safe: the exempt handlers that change state never reach a session or a cookie, neither in
  // their own file nor in anything they import, so a cross-site post to them carries nothing a page could borrow.
  // Two modules read cookies and also export helpers that do not: src/lib/auth.ts (the session) and src/lib/partners.ts
  // (the partner link). The walk stops at them, and reachable code may import from each only the names listed here,
  // every one of which works from the email, record or string it is handed, never from the request. Anything else
  // (currentUser, isAdmin, sessionCookie, createAdminSession, keyImpBinding, partners.ts cookieRef or afterSignup...)
  // fails the test, and so does any other reachable module that reads a cookie (`cookies()`, `req.cookies`, a Cookie
  // header, next/headers) or names a session cookie. Naming another cookie, as partner-rules.ts and connectors/store.ts
  // do, is not reading it. A merge that makes an exempt route reach a new name adds it here once someone has read that
  // it touches no cookie: the Paymob webhook (#279) reaches auth.ts normalizePhone and the six partners.ts payment and
  // offer names through billing.ts, read on 2026-10-08 with everything they call (only getUser, normalizeEmail and
  // saveUser from auth.ts, no cookieRef, signupPartner, afterSignup or partnerCookie). Email verification (#286) made
  // the MCP route and the cron's schedule.ts reach auth.ts emailVerified, a test of the record it is handed.
  const COOKIE_MODULES: Record<string, ReadonlySet<string>> = {
    "src/lib/auth.ts": new Set(["emailVerified", "getLogin", "getUser", "normalizeEmail", "normalizePhone", "saveUser", "sc", "seatLimit", "strongPassword", "trialOver", "validEmail"]),
    "src/lib/partners.ts": new Set(["addPaidTopup", "openOffer", "paymentsKey", "recordPayment", "voidPaidTopup", "voidPayment"]),
  };
  const COOKIE_ACCESS = /cookies\(|\.cookies\b|\.get\(\s*["'`]cookie["'`]\s*\)|["']next\/headers["']|["'`]nashr_(session|admin|impersonate|return)["'`]/i;
  const STATEFUL = /export\s+(async\s+)?(function|const)\s+(POST|PUT|PATCH|DELETE)\b/;
  // Static imports and re-exports (group 1 marks a type-only one, group 2 the bindings), and dynamic import() (group 4).
  const IMPORTS = /\b(?:import|export)\s+(type\s+)?(?:([\w$*{},\s]+?)\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  const routeFiles = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((p) => p.endsWith("route.ts")).map((p) => join(dir, p)) : [];
  const filesFor = (entry: string): string[] =>
    entry.endsWith("/") ? routeFiles(join("src/app", entry)).filter((p) => p !== join("src/app", entry, "route.ts")) : [join("src/app", entry, "route.ts")];
  const resolveImport = (from: string, spec: string): string | null => {
    const base = spec.startsWith("@/") ? join("src", spec.slice(2)) : spec.startsWith(".") ? relative(process.cwd(), resolve(dirname(from), spec)) : null;
    if (base === null) return null;
    return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((c) => existsSync(c)) ?? null;
  };
  /** What a module and everything it imports at runtime would do with cookies: one line per problem. */
  function sessionReach(root: string): { modules: number; problems: string[] } {
    const seen = new Set<string>();
    const problems: string[] = [];
    const queue = [root];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      if (COOKIE_ACCESS.test(src)) problems.push(`${file} reads a cookie`);
      for (const m of src.matchAll(IMPORTS)) {
        if (m[1]) continue;
        const target = resolveImport(file, m[3] ?? m[4]);
        if (!target) continue;
        const allowed = COOKIE_MODULES[target];
        if (!allowed) {
          queue.push(target);
          continue;
        }
        const mod = target.split("/").pop();
        if (m[4] || !m[2] || m[2].replace(/\{[^}]*\}/, "").replace(/[\s,]/g, "") !== "") {
          problems.push(`${file} imports ${mod} as a whole`);
          continue;
        }
        for (const part of (/\{([^}]*)\}/.exec(m[2])?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
          if (part.startsWith("type ")) continue;
          const name = part.split(/\s+as\s+/)[0];
          if (!allowed.has(name)) problems.push(`${file} imports ${name} from ${mod}`);
        }
      }
    }
    return { modules: seen.size, problems };
  }

  it("no exempt route that changes state reaches the session or a cookie, in its own file or through its imports", () => {
    const checked: string[] = [];
    for (const entry of CROSS_SITE_EXEMPT) {
      for (const p of filesFor(entry)) {
        if (!STATEFUL.test(readFileSync(p, "utf8"))) continue;
        checked.push(p);
        expect(sessionReach(p).problems, `${p} is exempt from the cross-site check`).toEqual([]);
      }
    }
    expect(checked).toEqual(expect.arrayContaining([
      join("src/app/api/mcp/route.ts"),
      join("src/app/api/oauth/token/route.ts"),
      join("src/app/api/media/hook/[provider]/route.ts"),
      join("src/app/api/secretary/booking/[token]/route.ts"),
      join("src/app/api/billing/paymob/webhook/route.ts"),
      join("src/app/api/cron/secretary/route.ts"),
    ]));
  });

  it("the walk catches what a list of session names missed: auth.ts and partners.ts cookie helpers, req.cookies, a Cookie header", () => {
    const signup = sessionReach("src/app/api/auth/signup/route.ts").problems;
    expect(signup).toContain("src/app/api/auth/signup/route.ts imports createSession from auth.ts");
    expect(signup).toContain("src/app/api/auth/signup/route.ts imports afterSignup from partners.ts");
    expect(sessionReach("src/app/api/files/route.ts").problems).toContain("src/app/api/files/route.ts imports currentUser from auth.ts");
    expect(sessionReach("src/lib/partners.ts").problems).toContain("src/lib/partners.ts reads a cookie");
    expect(COOKIE_ACCESS.test('const c = req.cookies.get("x")')).toBe(true);
    expect(COOKIE_ACCESS.test('req.headers.get("Cookie")')).toBe(true);
    expect(sessionReach("src/app/api/mcp/route.ts").modules).toBeGreaterThan(10);
  });

  it("every route that grants a CORS preflight is exempt or changes nothing, so a cross-site page cannot set X-Forwarded-Host on a checked route", () => {
    for (const p of routeFiles("src/app/api")) {
      const src = readFileSync(p, "utf8");
      if (!/Access-Control-Allow-(Origin|Headers)/.test(src) || !STATEFUL.test(src)) continue;
      const path = "/" + p.replace(/^src\/app\//, "").replace(/\/route\.ts$/, "");
      expect(isCrossSiteExempt(path), `${p} grants CORS on a state-changing handler`).toBe(true);
    }
  });
});

describe("rule 693: proxy() runs the cross-site check for every /api/ path after the staging lock, and its matcher sends every /api path through it", () => {
  // Next's own build-time and run-time matcher code (the same calls next-server makes), so what is pinned is what runs.
  const { getMiddlewareMatchers } = pageStaticInfo as unknown as { getMiddlewareMatchers: (m: unknown, c: object) => ProxyMatcher[] };
  const proxyRuns = getMiddlewareRouteMatcher(getMiddlewareMatchers(config.matcher, {}));
  const runs = (path: string) => proxyRuns(path, {} as never, {});
  const routes = readdirSync("src/app/api", { recursive: true })
    .map(String)
    .filter((p) => p.endsWith("route.ts"))
    .map((p) => "/api/" + p.replace(/\/?route\.ts$/, "").replace(/\[[^\]]+\]/g, "x1"));
  const edges = ["/api/mcp/", "/api/mcp//", "/api/mcpx", "/api/oauth/token/", "/api/oauth/tokenx", "/api/media/hook", "/api/media/hook/", "/api/media/hookx/a", "/api/secretary/booking/", "/api/billing/paymobx", "/api/billing/paymob/webhook", "/api/cron", "/api/cron/", "/api/cronx/a"];

  it("the matcher sends every API route, the exempt ones included, and the pages through the proxy", () => {
    expect(routes.length).toBeGreaterThan(50);
    for (const path of [...routes, ...edges, "/api/%63ron/secretary", "/", "/app", "/ar/app/chat"]) expect(runs(path), path).toBe(true);
  });

  it("for every API route, and the edges beside each exemption, a cross-site POST is refused exactly when the path is not exempt", async () => {
    for (const path of [...routes, ...edges]) {
      const res = proxy(req(path, { headers: CROSS }));
      if (isCrossSiteExempt(path)) {
        expect(res.status, path).toBe(200);
        expect(res.headers.get("x-middleware-next"), path).toBe("1");
      } else await expectRefused(res);
    }
  });

  it("a capped webhook or cron post passes the proxy untouched; Next still buffers its body (up to 6 MB, rule 774) before the route's 64 KB check", () => {
    // Recorded, not wanted: the staging lock needs the proxy on every path (rule 674), so no matcher can leave these out.
    for (const path of ["/api/cron/secretary", "/api/media/hook/kie", "/api/secretary/booking/0123abcd", "/api/billing/paymob/webhook"]) {
      const res = proxy(req(path, { headers: CROSS }));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("x-middleware-override-headers"), path).toBeNull();
    }
  });

  it("a cross-site POST to /api gets the 403", async () => {
    await expectRefused(proxy(req("/api/auth/login", { headers: CROSS })));
    await expectRefused(proxy(req("/api/auth/logout", { headers: { "sec-fetch-site": "same-site", origin: "https://staging.thakeen.com" } })));
  });

  it("a same-origin POST, and any GET, pass on untouched: no x-pathname, no redirect", () => {
    for (const r of [req("/api/tasks/abc", { method: "PATCH", headers: SAME }), req("/api/tasks", { method: "GET", headers: CROSS })]) {
      const res = proxy(r);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(res.headers.get("x-middleware-override-headers")).toBeNull();
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("pages keep their behaviour: / redirects and app paths get x-pathname, cross-site or not", () => {
    expect(proxy(req("/", { method: "GET" })).status).toBe(307);
    const page = proxy(req("/ar/app/inbox", { headers: CROSS }));
    expect(page.status).toBe(200);
    expect(page.headers.get("x-middleware-request-x-pathname")).toBe("/ar/app/inbox");
  });

  it("on staging the lock comes first: no cookie is a 404 even for a cross-site post; with the cookie the check still refuses, with noindex", async () => {
    const key = "staging-key-" + "z".repeat(30);
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("STAGING_ACCESS_KEY", key);
    const locked = proxy(req("/api/auth/login", { headers: CROSS }));
    expect(locked.status).toBe(404);
    expect(locked.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const cookie = { cookie: `${STAGING_COOKIE}=${accessToken(key)}` };
    const refused = proxy(req("/api/auth/login", { headers: { ...CROSS, ...cookie } }));
    expect(refused.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    await expectRefused(refused);
    const same = proxy(req("/api/tasks/abc", { method: "PATCH", headers: { ...SAME, ...cookie } }));
    expect(same.status).toBe(200);
    expect(same.headers.get("x-middleware-next")).toBe("1");
    expect(same.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});
