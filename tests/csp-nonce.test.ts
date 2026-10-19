import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The enforced, nonce-based script policy (rules 2320-2329, docs/system/tests/2320-csp-nonce.md). The proxy builds a
 * fresh nonce for every page request and sends it on the request (Next puts it on its scripts) and the response.
 */

afterEach(() => vi.unstubAllEnvs());

const req = (path: string, headers?: Record<string, string>) => new NextRequest("https://thakeen.example" + path, { headers });
const directive = (csp: string, name: string) => csp.split(";").map((x) => x.trim()).find((x) => x.startsWith(`${name} `)) ?? "";
const NONCE = /'nonce-([A-Za-z0-9+/]{22}==)'/;

describe("rule 2320: pages enforce a nonce-based script policy", () => {
  it("script-src is self, the nonce, strict-dynamic and Turnstile; never unsafe-inline, never unsafe-eval in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { proxy } = await import("@/proxy");
    for (const p of ["/ar", "/en/pricing", "/ar/app/login", "/ar/app/chat", "/en/admin", "/oauth/authorize", "/ar/blog/x"]) {
      const csp = proxy(req(p)).headers.get("content-security-policy") ?? "";
      const s = directive(csp, "script-src");
      expect(s, p).toMatch(new RegExp(`^script-src 'self' ${NONCE.source} 'strict-dynamic' https://challenges\\.cloudflare\\.com$`));
      expect(csp, p).not.toContain("'unsafe-inline'");
      expect(csp, p).not.toContain("'unsafe-eval'");
    }
  });
  it("the four directives of rule 428 stay, form-action 'self' included (the OAuth consent page, rule 2305)", async () => {
    const { pageCsp } = await import("@/lib/csp");
    const csp = pageCsp("bm9uY2Vub25jZW5vbmNlMQ==", false);
    for (const d of ["frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"]) expect(csp).toContain(d);
    expect(csp.split("; ")).toHaveLength(5);
  });
});

describe("rule 2321: one fresh nonce per page request, on the request and the response", () => {
  it("16 random bytes, base64, different every time", async () => {
    const { cspNonce } = await import("@/lib/csp");
    const seen = new Set(Array.from({ length: 200 }, cspNonce));
    expect(seen.size).toBe(200);
    for (const n of seen) expect(Buffer.from(n, "base64")).toHaveLength(16);
  });
  it("the request carries the same nonce in x-nonce and in its policy, so Next nonces its own scripts", async () => {
    const { proxy } = await import("@/proxy");
    const r = proxy(req("/ar/pricing"));
    const nonce = NONCE.exec(r.headers.get("content-security-policy") ?? "")?.[1];
    expect(nonce).toBeTruthy();
    expect(r.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(r.headers.get("x-middleware-request-content-security-policy")).toBe(r.headers.get("content-security-policy"));
    expect(NONCE.exec(proxy(req("/ar/pricing")).headers.get("content-security-policy") ?? "")?.[1]).not.toBe(nonce);
  });
  it("a nonce or a policy the browser sends is never kept", async () => {
    const { proxy } = await import("@/proxy");
    const sent = { "x-nonce": "AAAAAAAAAAAAAAAAAAAAAA==", "content-security-policy": "script-src 'nonce-AAAAAAAAAAAAAAAAAAAAAA=='" };
    const page = proxy(req("/ar", sent));
    expect(page.headers.get("x-middleware-request-x-nonce")).not.toBe(sent["x-nonce"]);
    expect(page.headers.get("x-middleware-request-content-security-policy")).not.toContain("AAAAAAAA");
    const api = proxy(req("/api/health", sent));
    expect(api.headers.get("x-middleware-request-x-nonce")).toBeNull();
    expect(api.headers.get("x-middleware-request-content-security-policy")).toBeNull();
  });
  it("the redirects and the stray-path rewrite carry the policy too", async () => {
    const { proxy } = await import("@/proxy");
    for (const p of ["/", "/pricing", "/xyz"]) expect(proxy(req(p)).headers.get("content-security-policy"), p).toMatch(NONCE);
  });
  it("the stray-path rewrite hands the nonce on to the page it is served from", async () => {
    const { proxy } = await import("@/proxy");
    const r = proxy(req("/xyz"));
    expect(r.headers.get("x-middleware-rewrite")).toContain("/__missing");
    expect(r.headers.get("x-middleware-request-x-nonce")).toBe(NONCE.exec(r.headers.get("content-security-policy") ?? "")?.[1]);
  });
});

describe("rule 2322: every page renders per request, so the nonce reaches every script", () => {
  it("the language layout reads x-nonce and puts it on the theme script", () => {
    const src = readFileSync("src/app/[lang]/layout.tsx", "utf8");
    expect(src).toMatch(/const nonce = \(await headers\(\)\)\.get\(NONCE_HEADER\)/);
    expect(src).toContain("<script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />");
  });
  it("the pages outside the language tree render per request as well", () => {
    expect(readFileSync("src/app/global-not-found.tsx", "utf8")).toMatch(/await connection\(\);/);
    expect(readFileSync("src/app/oauth/authorize/page.tsx", "utf8")).toContain('export const dynamic = "force-dynamic";');
    expect(readFileSync("src/app/[lang]/[...rest]/page.tsx", "utf8")).toContain('export const dynamic = "force-dynamic";');
  });
  it("no page or layout is forced static", () => {
    const pages = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? pages(join(dir, f)) : /^(page|layout|not-found|global-not-found)\.tsx$/.test(f) ? [join(dir, f)] : []));
    for (const f of pages("src/app")) expect(readFileSync(f, "utf8"), f).not.toMatch(/dynamic = "force-static"|export const revalidate/);
  });
});

describe("rule 2323: the API, the media files and the short links keep the base policy", () => {
  it("no page policy and no nonce from the proxy; next.config sends the four directives there", async () => {
    const { proxy } = await import("@/proxy");
    for (const p of ["/api/health", "/m/abc.png", "/p/xyz"]) {
      const r = proxy(req(p));
      expect(r.headers.get("content-security-policy"), p).toBeNull();
      expect(r.headers.get("content-security-policy-report-only"), p).toBeNull();
    }
    const { pagePath } = await import("@/lib/csp");
    for (const p of ["/ar", "/ar/app", "/oauth/authorize", "/mcp", "/pricing", "/apix"]) expect(pagePath(p), p).toBe(true);
    for (const p of ["/api", "/api/x", "/m/x", "/p/x"]) expect(pagePath(p), p).toBe(false);
  });
});

describe("rule 2324: styles stay out of the enforced policy; the report-only twin keeps the full one", () => {
  it("no enforced style-src; the twin has the same script-src as the enforced policy", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { proxy } = await import("@/proxy");
    const r = proxy(req("/ar"));
    const enforced = r.headers.get("content-security-policy") ?? "";
    const ro = r.headers.get("content-security-policy-report-only") ?? "";
    expect(directive(enforced, "style-src")).toBe("");
    expect(directive(enforced, "default-src")).toBe("");
    expect(directive(ro, "script-src")).toBe(directive(enforced, "script-src"));
    expect(directive(ro, "default-src")).toBe("default-src 'self'");
  });
});

describe("rule 2325: development alone adds 'unsafe-eval'", () => {
  it("React's dev error stacks need eval; production never gets it", async () => {
    const { scriptSrc } = await import("@/lib/csp");
    expect(scriptSrc("bm9uY2U=", true)).toMatch(/ 'unsafe-eval'$/);
    expect(scriptSrc("bm9uY2U=", false)).not.toContain("unsafe-eval");
    expect(readFileSync("src/proxy.ts", "utf8")).toContain('const dev = process.env.NODE_ENV === "development";');
  });
});

describe("rule 2326: no script the policy would block is written into the app", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.(tsx?|css)$/.test(f) ? [join(dir, f)] : []));
  const all = [...files("src/app"), ...files("src/components")].map((f) => [f, readFileSync(f, "utf8")] as const);
  it("every <script> is the nonced theme script or a JSON-LD data block, which the browser never runs", () => {
    for (const [f, src] of all)
      for (const m of src.matchAll(/<script\b[^>]*>/g)) expect(m[0], f).toMatch(/nonce=\{nonce\}|type="application\/ld\+json"/);
  });
  it("no inline event-handler attribute and no javascript: link in markup the app writes", () => {
    for (const [f, src] of all) expect(src, f).not.toMatch(/\son(?:click|load|error|submit|change|mouseover|focus)=["']|href=["']javascript:/i);
  });
  it("no next/script tag without the nonce", () => {
    for (const [f, src] of all) if (src.includes('from "next/script"')) expect(src, f).toMatch(/<Script[^>]*nonce=/);
  });
});
