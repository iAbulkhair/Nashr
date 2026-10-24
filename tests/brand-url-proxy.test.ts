import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BRAND_HEADER } from "@/lib/brand-path";
import { ACCOUNT_SC_API, BRAND_API, BRAND_GUARD_MODE, brandMissingRefusal } from "@/lib/brand-guard";
import { CROSS_SITE_METHODS } from "@/lib/csrf";
import { proxy } from "@/proxy";

/**
 * The proxy and the brand guard (rules 887-888, docs/system/tests/0885-brand-url.md, plan
 * docs/superpowers/plans/2026-10-20-brand-url.md Task 3). A page request carries only the brand its path names; a browser
 * mutation to a brand route without `x-thakeen-brand` is noticed (logged in this release, refused with 409 in the next).
 */

afterEach(() => vi.restoreAllMocks());

const FORWARDED = `x-middleware-request-${BRAND_HEADER}`;
const SESSION = { cookie: "thakeen_session=abc123" };
const req = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`https://thakeen.example${path}`, { method: init.method ?? "GET", headers: init.headers });

describe("rule 887: a page request carries only the brand its path names", () => {
  it("drops a brand header the browser sent on a page that names no brand", () => {
    const res = proxy(req("/ar/app/settings/billing", { headers: { [BRAND_HEADER]: "evil" } }));
    expect(res.headers.get(FORWARDED)).toBeNull();
    expect(res.headers.get("x-middleware-override-headers") ?? "").not.toContain(BRAND_HEADER);
  });

  it("sets it from the path, whatever the browser sent", () => {
    expect(proxy(req("/ar/app/b/b2/tasks", { headers: { [BRAND_HEADER]: "evil" } })).headers.get(FORWARDED)).toBe("b2");
    expect(proxy(req("/en/app/b/default", { headers: {} })).headers.get(FORWARDED)).toBe("default");
    expect(proxy(req("/en/app/b/b2/settings/brand?x=1")).headers.get(FORWARDED)).toBe("b2");
  });

  it("sends none for a malformed brand segment, even when the browser sent one", () => {
    expect(proxy(req("/ar/app/b/..bad/tasks", { headers: { [BRAND_HEADER]: "b2" } })).headers.get(FORWARDED)).toBeNull();
    expect(proxy(req("/ar/app/b/%2e%2e/tasks")).headers.get(FORWARDED)).toBeNull();
  });

  it("also clears it on a public page, the root redirect and the stray-path rewrite", () => {
    for (const p of ["/ar/pricing", "/ar", "/xyz/abc"]) {
      const res = proxy(req(p, { headers: { [BRAND_HEADER]: "evil" } }));
      expect(res.headers.get(FORWARDED), p).toBeNull();
    }
  });

  it("the stray-path rewrite and a public page really override the request headers without the brand (fix round item 9)", () => {
    // Without x-middleware-override-headers Next forwards the browser's headers as they came, the forged one included;
    // with it, only the listed headers reach the page, and the brand header is not among them.
    for (const p of ["/xyz/abc", "/ar/pricing"]) {
      const res = proxy(req(p, { headers: { [BRAND_HEADER]: "evil", "x-other": "kept" } }));
      const override = res.headers.get("x-middleware-override-headers");
      expect(override, p).not.toBeNull();
      const names = override!.split(",").map((h) => h.trim());
      expect(names, p).toContain("x-other");
      expect(names, p).not.toContain(BRAND_HEADER);
      expect(res.headers.get("x-middleware-request-x-other"), p).toBe("kept");
    }
    expect(proxy(req("/xyz/abc")).headers.get("x-middleware-rewrite")).not.toBeNull();
  });

  it("leaves a header on an /api/ request untouched", () => {
    expect(proxy(req("/api/tasks", { headers: { [BRAND_HEADER]: "b2" } })).headers.get(FORWARDED)).toBe("b2");
    expect(proxy(req("/api/tasks", { method: "POST", headers: { [BRAND_HEADER]: "b2", ...SESSION } })).headers.get(FORWARDED)).toBe("b2");
  });
});

describe("rule 887: a brand query value is the header for a GET or HEAD /api/ request that has none (R-C13)", () => {
  it("copies it for GET and HEAD", () => {
    expect(proxy(req("/api/activity/export?brand=b2")).headers.get(FORWARDED)).toBe("b2");
    expect(proxy(req("/api/activity/export?brand=b2", { method: "HEAD" })).headers.get(FORWARDED)).toBe("b2");
  });

  it("never overrides a header the request carries", () => {
    expect(proxy(req("/api/activity/export?brand=b2", { headers: { [BRAND_HEADER]: "b3" } })).headers.get(FORWARDED)).toBe("b3");
  });

  it("is never taken from the query for a mutation", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(proxy(req("/api/tasks?brand=b2", { method, headers: { "content-type": "application/json" } })).headers.get(FORWARDED), method).toBeNull();
    }
  });

  it("copies a malformed value too: resolveSession answers 404 for it", () => {
    expect(proxy(req("/api/activity/export?brand=..bad")).headers.get(FORWARDED)).toBe("..bad");
  });

  it("copies a value no header can hold as one that is no brand id, so the session answers 404 and never falls back", () => {
    expect(proxy(req("/api/activity/export?brand=b%0A2")).headers.get(FORWARDED)).toBe("?");
    expect(proxy(req("/api/activity/export?brand=%E2%82%AC")).headers.get(FORWARDED)).toBe("?");
  });

  it("an empty brand header counts as none: the query value is copied (fix round item 11)", () => {
    expect(proxy(req("/api/activity/export?brand=b2", { headers: { [BRAND_HEADER]: "" } })).headers.get(FORWARDED)).toBe("b2");
  });

  it("does nothing without a query value, and never on a page", () => {
    expect(proxy(req("/api/activity/export")).headers.get(FORWARDED)).toBeNull();
    expect(proxy(req("/api/activity/export?brand=")).headers.get(FORWARDED)).toBeNull();
    expect(proxy(req("/ar/app/settings/billing?brand=b2")).headers.get(FORWARDED)).toBeNull();
  });
});

describe("rule 888: a browser mutation to a brand route without the brand header is noticed", () => {
  const post = (path: string, headers: Record<string, string> = SESSION, method = "POST") => req(path, { method, headers });

  it("enforce mode refuses it with 409 brand_missing", async () => {
    const res = brandMissingRefusal(post("/api/tasks"), "enforce");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(409);
    expect(res!.headers.get("cache-control")).toBe("no-store");
    expect(await res!.json()).toEqual({ ok: false, error: "brand_missing" });
  });

  it("covers every state-changing method, and a segment in brackets matches one segment", () => {
    for (const method of CROSS_SITE_METHODS) expect(brandMissingRefusal(post("/api/conversations", SESSION, method), "enforce")?.status, method).toBe(409);
    expect(brandMissingRefusal(post("/api/tasks/abc123", SESSION, "PATCH"), "enforce")?.status).toBe(409);
    expect(brandMissingRefusal(post("/api/tasks/abc/image"), "enforce")?.status).toBe(409);
    expect(brandMissingRefusal(post("/api/tasks/abc/extra/deep", SESSION, "PATCH"), "enforce")).toBeNull();
    expect(brandMissingRefusal(post("/api/tasks/abc/image/"), "enforce")?.status).toBe(409);
  });

  it("lets a request with the header through", () => {
    expect(brandMissingRefusal(post("/api/tasks", { ...SESSION, [BRAND_HEADER]: "b2" }), "enforce")).toBeNull();
  });

  it("an empty header is no header: refused in enforce mode, logged in log mode (fix round item 11)", () => {
    expect(brandMissingRefusal(post("/api/tasks", { ...SESSION, [BRAND_HEADER]: "" }), "enforce")?.status).toBe(409);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(brandMissingRefusal(post("/api/tasks", { ...SESSION, [BRAND_HEADER]: "" }), "log")).toBeNull();
    expect(warn.mock.calls.filter((c) => c[0] === "brand_missing")).toHaveLength(1);
  });

  it("lets a read through", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(brandMissingRefusal(post("/api/conversations", SESSION, method), "enforce"), method).toBeNull();
  });

  it("lets a request without a session cookie through (MCP, cron, webhooks, curl with a token)", () => {
    expect(brandMissingRefusal(post("/api/tasks", {}), "enforce")).toBeNull();
    expect(brandMissingRefusal(post("/api/tasks", { authorization: "Bearer t" }), "enforce")).toBeNull();
    expect(brandMissingRefusal(post("/api/tasks", { cookie: "thakeen_lang=ar" }), "enforce")).toBeNull();
  });

  it("counts the session cookie's old name too (rule 679)", () => {
    expect(brandMissingRefusal(post("/api/tasks", { cookie: "nashr_session=abc" }), "enforce")?.status).toBe(409);
  });

  it("lets an account route and an unknown path through", () => {
    for (const p of ["/api/account", "/api/billing/checkout", "/api/brands", "/api/auth/logout", "/api/team/invite", "/api/nope", "/api/tasksx", "/api"]) {
      expect(brandMissingRefusal(post(p), "enforce"), p).toBeNull();
    }
  });

  it("log mode lets the request through and logs one brand_missing warning with the path only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = brandMissingRefusal(post("/api/conversations?q=secret-search", { ...SESSION, authorization: "Bearer s3cret" }), "log");
    expect(res).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual(["brand_missing", { path: "/api/conversations" }]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/abc123|s3cret|secret-search/);
  });

  it("log mode is quiet when nothing is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    brandMissingRefusal(post("/api/conversations", { ...SESSION, [BRAND_HEADER]: "b2" }), "log");
    brandMissingRefusal(post("/api/conversations", SESSION, "GET"), "log");
    brandMissingRefusal(post("/api/conversations", {}), "log");
    brandMissingRefusal(post("/api/account"), "log");
    expect(warn).not.toHaveBeenCalled();
  });

  it("this release runs in log mode (R-C4): the proxy lets the mutation through, warns once, and the other checks still run first", async () => {
    expect(BRAND_GUARD_MODE).toBe("log");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const same = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
    const res = proxy(req("/api/tasks/abc", { method: "PATCH", headers: { ...same, ...SESSION } }));
    expect(res.status).toBe(200);
    expect(warn.mock.calls.filter((c) => c[0] === "brand_missing")).toHaveLength(1);
    // A cross-site post is still the 403 of rule 690, and is not also counted as a missing brand.
    warn.mockClear();
    const cross = proxy(req("/api/tasks/abc", { method: "PATCH", headers: { "sec-fetch-site": "cross-site", "content-type": "application/json", ...SESSION } }));
    expect(cross.status).toBe(403);
    expect(warn).not.toHaveBeenCalled();
  });
});

// The coverage test: the guarded list is held to the route files on disk (R-C2, R-C11).
const API_DIR = join(process.cwd(), "src/app/api");
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === "route.ts" ? [p] : [];
  });
}
/** The source without comments, so a comment that names `sc(` or `handler(` does not count as a call. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const routePath = (file: string) => "/api/" + relative(API_DIR, file).replace(/\/?route\.ts$/, "");
const MUTATING = /export\s+(?:async\s+function|function|const)\s+(?:POST|PUT|PATCH|DELETE)\b|export\s*\{[^}]*\b(?:POST|PUT|PATCH|DELETE)\b/;
const CALLS_SC = /\bsc\(/;
const HANDLER_USER = /\bhandler\s*(?:<[^>]*>)?\s*\(\s*\{\s*auth:\s*"user"/;

const ROUTES = routeFiles(API_DIR).map((f) => ({ path: routePath(f), src: code(readFileSync(f, "utf8")) }));

describe("rule 888: the guarded list is held to the routes on disk", () => {
  it("every route that scopes through sc(u) or handler({ auth: \"user\" }) and changes state is in BRAND_API or ACCOUNT_SC_API", () => {
    const scoped = ROUTES.filter((r) => MUTATING.test(r.src) && (CALLS_SC.test(r.src) || HANDLER_USER.test(r.src))).map((r) => r.path);
    expect(scoped.length).toBeGreaterThan(40);
    const unlisted = scoped.filter((p) => !BRAND_API.includes(p) && !(p in ACCOUNT_SC_API));
    expect(unlisted, "add the route to BRAND_API, or to ACCOUNT_SC_API with its reason").toEqual([]);
  });

  it("every mutating route that calls currentUser() but has no sc( literal is classified (fix round item 8)", () => {
    // These routes read the session but scope no data through `sc(u)` in their own file: either their data is the
    // account's (or the login's, or nobody's), or they reach the brand through a helper. A new such route fails here until
    // it is put in BRAND_API, in ACCOUNT_SC_API, or below with its reason.
    const EXEMPT: Readonly<Record<string, string>> = {
      "/api/account": "the account record itself (name, language, deletion), not a brand",
      "/api/account/2fa": "the login's second factor",
      "/api/account/passkeys": "the person's passkeys (personKey), not a brand",
      "/api/account/email": "the login's address change",
      "/api/account/google": "the login's Google sign-in link",
      "/api/account/avatar": "the person's picture (personKey), not a brand (rule 3502)",
      "/api/account/avatar/upload": "plans the person's picture upload, not a brand (rule 3501)",
      "/api/account/logo": "the workspace's logo (accountKey of the session's account), not a brand (rule 3610)",
      "/api/account/logo/upload": "plans the workspace logo upload under the session's account, not a brand (rule 3611)",
      "/api/account/sessions": "the login's sessions",
      "/api/auth/verify/check": "the owner's address verification",
      "/api/auth/verify/email": "the owner's address verification",
      "/api/auth/verify/send": "the owner's address verification",
      "/api/billing/chat-overflow": "the account's plan and credits",
      "/api/billing/checkout": "the account's plan and payment",
      "/api/billing/renewal": "the account's plan renewal",
      "/api/brands": "the account's brand list and the switch itself (rule 892); the brand is the body's id, checked against the list",
      "/api/integrations": "a request for a new integration, logged with the login's address, no brand data",
      "/api/mcp/grants": "the account's MCP grants (acct(u))",
      "/api/mcp/token": "the account's MCP token (acct(u))",
      "/api/notifications": "the account's bell, keyed by the account's address",
      "/api/notifications/digest": "the account's digest setting (acct(u))",
      "/api/oauth/approve": "an OAuth grant for the account",
      "/api/partner": "the account's partner record",
      "/api/partner/code": "the account's partner code",
      "/api/push/seen": "the login's away mark (pushLogin), no brand data",
      "/api/referral/share": "the account's share credits (acct(u))",
      "/api/support": "a support ticket with the login's address, no brand data",
      "/api/team": "the account's approval policy, written on acct(u) under its lock (rule 3762), no brand data",
      "/api/team/invite": "the account's team",
      "/api/team/leave": "the account's team",
      "/api/team/member": "the account's team",
      "/api/team/transfer": "the account's ownership offer (aidOf(u)), no brand data",
      "/api/tools/[tool]": "a public tool, rate-limited by the login's address, no brand data",
    };
    const CALLS_CURRENT_USER = /\bcurrentUser(?:Unverified)?\(/;
    const found = ROUTES.filter((r) => MUTATING.test(r.src) && CALLS_CURRENT_USER.test(r.src) && !CALLS_SC.test(r.src) && !HANDLER_USER.test(r.src)).map((r) => r.path).sort();
    expect(found.length).toBeGreaterThan(20);
    const unclassified = found.filter((p) => !BRAND_API.includes(p) && !(p in ACCOUNT_SC_API) && !(p in EXEMPT));
    expect(unclassified, "put the route in BRAND_API, ACCOUNT_SC_API, or EXEMPT with its reason").toEqual([]);
    // The list stays exact: an exempt entry that no longer matches (gone, or now calls sc() and is held by the test above) goes.
    expect(Object.keys(EXEMPT).filter((p) => !found.includes(p))).toEqual([]);
    expect(Object.keys(EXEMPT).filter((p) => BRAND_API.includes(p) || p in ACCOUNT_SC_API)).toEqual([]);
    for (const [p, why] of Object.entries(EXEMPT)) expect(why.length, p).toBeGreaterThan(10);
    // The one brand route found this way (scoped through a helper) is guarded.
    expect(found.filter((p) => BRAND_API.includes(p))).toEqual(["/api/secretary/calendar-link"]);
  });

  it("the handler-only routes of R-C11 and the mixed profile route (R-C12), a per-brand preference route and a helper-scoped route are guarded", () => {
    for (const p of ["/api/brand", "/api/brand/proposals/[id]", "/api/conversations", "/api/files", "/api/tasks", "/api/profile", "/api/notifications/prefs", "/api/secretary/calendar-link"]) {
      expect(BRAND_API, p).toContain(p);
    }
  });

  it("every entry names a route on disk, and no path is in both lists", () => {
    const onDisk = new Set(ROUTES.map((r) => r.path));
    for (const p of [...BRAND_API, ...Object.keys(ACCOUNT_SC_API)]) expect(onDisk.has(p), `${p} is not a route`).toBe(true);
    expect(BRAND_API.filter((p) => p in ACCOUNT_SC_API)).toEqual([]);
    expect(new Set(BRAND_API).size).toBe(BRAND_API.length);
  });

  it("every ACCOUNT_SC_API entry carries a one-line reason, and BRAND_API holds only routes that change state (or may soon)", () => {
    for (const [p, why] of Object.entries(ACCOUNT_SC_API)) {
      expect(why.trim().length, p).toBeGreaterThan(10);
      expect(why, p).not.toContain("\n");
    }
    const byPath = new Map(ROUTES.map((r) => [r.path, r.src]));
    // /api/tasks exports GET only today; it is listed on purpose so a mutating export added later is guarded.
    const readOnly = BRAND_API.filter((p) => !MUTATING.test(byPath.get(p) ?? ""));
    expect(readOnly).toEqual(["/api/tasks"]);
  });

  it("the routes MCP, cron and webhooks use are never guarded: they hold no session cookie and no brand route is theirs", () => {
    for (const p of BRAND_API) expect(p).not.toMatch(/^\/api\/(mcp|cron|oauth|admin|auth|billing)\b/);
  });
});
