import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Rules 356-358 (#8, #169). One canonical app origin: `appOrigin()` in src/lib/origin.ts reads APP_ORIGIN and holds the
 * only copy of the production fallback. Moving to the owned domain must be one environment change, so the old Vercel
 * host may not appear anywhere else in src/, no other file reads APP_ORIGIN or builds a link from the Host header, and a
 * malformed APP_ORIGIN falls back instead of making every page's metadata throw.
 */

const safeFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response("<html><title>x</title><body>" + "word ".repeat(40) + "</body></html>", { status: 200 }));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));
vi.mock("next/font/google", () => {
  const font = () => ({ variable: "", className: "", style: {} });
  return { IBM_Plex_Mono: font, IBM_Plex_Sans_Arabic: font };
});
vi.mock("next/font/local", () => ({ default: () => ({ variable: "", className: "", style: {} }) }));

afterEach(() => {
  vi.unstubAllEnvs();
  safeFetch.mockClear();
});

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|js|mjs|json|md|txt)$/.test(n) ? [p] : [];
});

describe("rule 356: the Vercel host lives in one place", () => {
  it("no file under src/ names vercel.app except src/lib/origin.ts", () => {
    const hits = files("src").filter((p) => p !== join("src", "lib", "origin.ts") && /vercel\.app/.test(readFileSync(p, "utf8")));
    expect(hits, `hard-coded host in: ${hits.join(", ")}`).toEqual([]);
  });

  it("no file builds its own APP_ORIGIN fallback", () => {
    const hits = files("src").filter((p) => /process\.env\.APP_ORIGIN\s*\?\?\s*["'`]https?:/.test(readFileSync(p, "utf8")));
    expect(hits).toEqual([]);
  });

  it("the referral page does not trust the Host header", () => {
    const src = readFileSync("src/app/[lang]/app/refer/page.tsx", "utf8");
    expect(src).not.toMatch(/get\("host"\)/);
    expect(src).toMatch(/appOrigin\(\)/);
  });

  it("only origin.ts reads APP_ORIGIN (media/config.ts reads it for webhooks, with no fallback by design)", () => {
    const allowed = [join("src", "lib", "origin.ts"), join("src", "lib", "media", "config.ts")];
    const hits = files("src").filter((p) => !allowed.includes(p) && /process\.env\.APP_ORIGIN|process\.env\[["']APP_ORIGIN["']\]/.test(readFileSync(p, "utf8")));
    expect(hits, `direct APP_ORIGIN readers: ${hits.join(", ")}`).toEqual([]);
  });

  it("no link is built from the request's Host header", () => {
    // auth.ts reads Host only to decide the session cookie's Secure flag on loopback, never to build a URL. csrf.ts reads
    // Host and X-Forwarded-Host only to compare them with the request's Origin (rules 690-693), never to build a link.
    const exempt = new Set([join("src", "lib", "auth.ts"), join("src", "lib", "csrf.ts")]);
    const hits = files("src").filter((p) => !exempt.has(p) && /get\(["']host["']\)|x-forwarded-host|\$\{[^}]*\.host\}/.test(readFileSync(p, "utf8")));
    expect(hits, `Host-derived origin in: ${hits.join(", ")}`).toEqual([]);
    for (const p of ["src/app/[lang]/app/mcp/page.tsx", "src/app/api/connect/[provider]/callback/route.ts"]) expect(readFileSync(p, "utf8")).toMatch(/appOrigin\(\)/);
  });
});

describe("rule 357: appOrigin() reads APP_ORIGIN, with the old behaviour while it is unset", () => {
  it("falls back to the production host when unset or empty, and trims a trailing slash", async () => {
    const { appOrigin, appHost, FALLBACK_ORIGIN } = await import("@/lib/origin");
    vi.stubEnv("APP_ORIGIN", undefined);
    expect(appOrigin()).toBe(FALLBACK_ORIGIN);
    expect(FALLBACK_ORIGIN).toBe("https://nashr-tau.vercel.app");
    vi.stubEnv("APP_ORIGIN", "");
    expect(appOrigin()).toBe(FALLBACK_ORIGIN);
    vi.stubEnv("APP_ORIGIN", "https://thakeen.example/");
    expect(appOrigin()).toBe("https://thakeen.example");
    expect(appHost()).toBe("thakeen.example");
  });

  it("a value that is not an absolute http(s) origin falls back instead of breaking every page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { appOrigin, appHost, FALLBACK_ORIGIN } = await import("@/lib/origin");
    for (const bad of ["thakeen.com", "localhost:3000", "htps//thakeen.com", "ftp://thakeen.com", "https://thakeen.com/ar", "https://thakeen.com?x=1", "https://user:pw@thakeen.com", "not a url"]) {
      vi.stubEnv("APP_ORIGIN", bad);
      expect(appOrigin(), bad).toBe(FALLBACK_ORIGIN);
      expect(() => appHost(), bad).not.toThrow();
    }
    vi.stubEnv("APP_ORIGIN", " HTTPS://Thakeen.Example ");
    expect(appOrigin()).toBe("https://thakeen.example");
    const printed = warn.mock.calls.map((c) => c.join(" ")).join(" ");
    warn.mockRestore();
    expect(printed, "the warning names the variable").toContain("APP_ORIGIN");
    expect(printed, "and never its value").not.toMatch(/thakeen/);
  });

  it("the [lang] layout's metadata does not throw on a bad APP_ORIGIN", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("APP_ORIGIN", "thakeen.com");
    const { generateMetadata } = await import("@/app/[lang]/layout");
    const meta = await generateMetadata({ params: Promise.resolve({ lang: "ar" }) });
    const { FALLBACK_ORIGIN } = await import("@/lib/origin");
    expect(String(meta.metadataBase)).toBe(`${FALLBACK_ORIGIN}/`);
    vi.restoreAllMocks();
  });
});

describe("rule 358: every link the app builds follows APP_ORIGIN", () => {
  it("the MCP help answer, the crawler's user agent, OAuth metadata and connector redirects", async () => {
    vi.stubEnv("APP_ORIGIN", "https://example.test");
    const { helpTopics } = await import("@/lib/help");
    const { appOrigin } = await import("@/lib/origin");
    const mcp = helpTopics(appOrigin()).flatMap((t) => t.items).find((i) => i.q.en === "How do I use Noor inside my AI assistant?")!;
    expect(mcp.a.en).toContain("https://example.test/api/mcp");
    expect(mcp.a.ar).toContain("https://example.test/api/mcp");
    expect(mcp.a.en).not.toContain("{origin}");

    const { crawl } = await import("@/lib/crawl");
    await crawl("https://shop.example");
    const ua = new Headers(safeFetch.mock.calls[0][1]?.headers).get("user-agent");
    expect(ua).toContain("+https://example.test");

    const { metadata, resourceMetadata } = await import("@/lib/oauth");
    expect(metadata().issuer).toBe("https://example.test");
    expect(resourceMetadata().resource).toBe("https://example.test/api/mcp");
    const { REDIRECT } = await import("@/lib/connectors/oauth");
    expect(REDIRECT("meta")).toBe("https://example.test/api/connect/meta/callback");
  });

  it("robots and the sitemap name the configured origin", async () => {
    vi.stubEnv("APP_ORIGIN", "https://example.test");
    vi.resetModules();
    const robots = (await import("@/app/robots")).default();
    expect(robots.sitemap).toBe("https://example.test/sitemap.xml");
    const map = (await import("@/app/sitemap")).default();
    expect(map.length).toBeGreaterThan(0);
    expect(map.every((e) => e.url.startsWith("https://example.test/"))).toBe(true);
  });

  it("the help centre shows the MCP URL the server passes in", () => {
    const comp = readFileSync("src/components/HelpCenter.tsx", "utf8");
    expect(comp).toMatch(/helpTopics\(origin\)/);
    for (const p of ["src/app/[lang]/help/page.tsx", "src/app/[lang]/app/help/page.tsx"]) expect(readFileSync(p, "utf8")).toMatch(/origin=\{appOrigin\(\)\}/);
  });
});
