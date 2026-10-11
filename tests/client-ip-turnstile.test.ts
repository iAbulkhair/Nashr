import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { signOut } from "./helpers/session";
import { clientIp, clientIpReport, MAX_PROXY_HOPS, trustedProxyHops } from "@/lib/rate";

/**
 * Client address behind Hostinger and Turnstile that fails closed (rules 978, 979, 908, 909;
 * docs/system/tests/0908-client-ip-turnstile.md). Rule 773 (tests/client-ip.test.ts) still holds: off Vercel only
 * `x-forwarded-for` counts, read in src/lib/rate.ts alone.
 */

const req = (headers: Record<string, string>) => new Request("https://thakeen.test/api/health", { headers });
const hostinger = () => { vi.stubEnv("VERCEL", ""); vi.stubEnv("VERCEL_ENV", "production"); };
const SITE = "0x4AAAAAAAtestsitekey", SECRET = "0x4AAAAAAAtestsecret";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("TRUSTED_PROXY_HOPS (rule 979)", () => {
  it("unset, empty or anything but a whole number from 1 to MAX_PROXY_HOPS is 1", () => {
    expect(MAX_PROXY_HOPS).toBe(3);
    for (const v of ["", "0", "-1", "4", "9", "10", "1.5", "two", "2,3", "0x2", "1e0"]) {
      vi.stubEnv("TRUSTED_PROXY_HOPS", v);
      expect(trustedProxyHops(), `TRUSTED_PROXY_HOPS=${JSON.stringify(v)}`).toBe(1);
    }
    for (const n of [1, 2, 3]) { vi.stubEnv("TRUSTED_PROXY_HOPS", ` ${n} `); expect(trustedProxyHops()).toBe(n); }
  });

  it("1 (the default) keeps today's bucket: the last hop", () => {
    hostinger();
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.5, 10.1.2.3" }))).toBe("10.1.2.3");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.5, 10.1.2.3" }))).toBe("10.1.2.3");
  });

  it("2 reads the hop the outer proxy appended, so callers behind one CDN edge get their own buckets", () => {
    hostinger();
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    // client -> CDN (appends the client) -> origin proxy (appends the CDN edge) -> app
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.5, 10.1.2.3" }))).toBe("203.0.113.5");
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.6, 10.1.2.3" }))).toBe("203.0.113.6");
    // what the caller wrote itself stays to the left and is never read
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 203.0.113.5, 10.1.2.3" }))).toBe("203.0.113.5");
  });

  it("a list shorter than the hop count reads its first entry; empty still falls to the shared unknown bucket", () => {
    hostinger();
    vi.stubEnv("TRUSTED_PROXY_HOPS", "3");
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.5" }))).toBe("203.0.113.5");
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.5, 10.1.2.3" }))).toBe("203.0.113.5");
    expect(clientIp(req({}))).toBe("unknown");
    expect(clientIp(req({ "x-forwarded-for": " , 10.1.2.3, 10.9.9.9" }))).toBe("unknown");
  });

  it("never turns on Vercel's own headers off Vercel, whatever the hop count", () => {
    hostinger();
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(clientIp(req({ "x-vercel-forwarded-for": "198.51.100.91", "x-real-ip": "198.51.100.92", "x-forwarded-for": "203.0.113.5, 10.1.2.3" }))).toBe("203.0.113.5");
  });

  it("on Vercel, Vercel's header still comes first", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(clientIp(req({ "x-vercel-forwarded-for": "203.0.113.8", "x-forwarded-for": "203.0.113.5, 10.1.2.3" }))).toBe("203.0.113.8");
  });
});

describe("GET /api/admin/client-ip (rule 908)", () => {
  const KEY = "client-ip-admin-key-0123456789";
  beforeEach(() => { vi.stubEnv("WAITLIST_ADMIN_KEY", KEY); signOut(); });

  it("is 401 without the admin key and tells nothing", async () => {
    const { GET } = await import("@/app/api/admin/client-ip/route");
    const res = await GET(req({ "x-forwarded-for": "203.0.113.5" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false });
    const wrong = await GET(req({ "x-admin-key": "not-the-key", "x-forwarded-for": "203.0.113.5" }));
    expect(wrong.status).toBe(401);
  });

  it("shows the founder the list the app received, the single-value headers, the hop count and the bucket; never cached", async () => {
    hostinger();
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    const { GET } = await import("@/app/api/admin/client-ip/route");
    const res = await GET(req({ "x-admin-key": KEY, "x-forwarded-for": "6.6.6.6,203.0.113.5, 10.1.2.3", "x-real-ip": "198.51.100.92", "cf-connecting-ip": "203.0.113.5" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      ok: true,
      forwardedFor: ["6.6.6.6", "203.0.113.5", "10.1.2.3"],
      realIp: "198.51.100.92",
      vercelForwardedFor: null,
      cfConnectingIp: "203.0.113.5",
      trueClientIp: null,
      onVercel: false,
      trustedProxyHops: 2,
      bucket: "203.0.113.5",
    });
  });

  it("an absent header is an empty list, not one empty hop", () => {
    hostinger();
    expect(clientIpReport(req({})).forwardedFor).toEqual([]);
    expect(clientIpReport(req({})).bucket).toBe("unknown");
  });

  it("is documented with its gate in permissions.md", () => {
    expect(readFileSync("docs/system/permissions.md", "utf8")).toContain("`/api/admin/client-ip`");
  });
});

describe("Turnstile fails closed when half-configured in production (rules 978, 909)", () => {
  const production = () => vi.stubEnv("APP_ENV", "production");
  const half = [[SITE, ""], ["", SECRET]] as const;

  it("978: exactly one key in a production deploy refuses every check with unavailable and calls nobody", async () => {
    const { turnstileSiteKey, turnstileState, verifyTurnstile, captchaRefusal } = await import("@/lib/turnstile");
    const f = vi.spyOn(globalThis, "fetch");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    production();
    for (const [site, secret] of half) {
      vi.stubEnv("TURNSTILE_SITE_KEY", site);
      vi.stubEnv("TURNSTILE_SECRET_KEY", secret);
      expect(turnstileState()).toBe("half");
      expect(turnstileSiteKey()).toBeNull();
      expect(await verifyTurnstile("any-token", "203.0.113.5")).toBe("unavailable");
      expect(await verifyTurnstile(undefined, "203.0.113.5")).toBe("unavailable");
      const res = await captchaRefusal(req({ "x-forwarded-for": "203.0.113.5" }), "tok");
      expect(res?.status).toBe(503);
      expect(await res?.json()).toEqual({ ok: false, error: "captcha_unavailable" });
    }
    expect(f).not.toHaveBeenCalled();
    // The missing NAME is logged, once per name, never a value.
    const lines = err.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes("TURNSTILE_SECRET_KEY is unset"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("TURNSTILE_SITE_KEY is unset"))).toHaveLength(1);
    for (const l of lines) { expect(l).not.toContain(SITE); expect(l).not.toContain(SECRET); }
  });

  it("978: staging counts as production too (APP_ENV=staging)", async () => {
    const { verifyTurnstile } = await import("@/lib/turnstile");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("TURNSTILE_SITE_KEY", SITE);
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    expect(await verifyTurnstile("tok", "203.0.113.5")).toBe("unavailable");
  });

  it("978: outside production a half-configured deploy stays off, as rule 426 says", async () => {
    const { verifyTurnstile } = await import("@/lib/turnstile");
    vi.stubEnv("APP_ENV", "development");
    for (const [site, secret] of half) {
      vi.stubEnv("TURNSTILE_SITE_KEY", site);
      vi.stubEnv("TURNSTILE_SECRET_KEY", secret);
      expect(await verifyTurnstile(undefined, "203.0.113.5")).toBe("ok");
    }
  });

  it("909: both keys unset in production stays open (the founder's switch) and says so once in the log, names only", async () => {
    const { turnstileState, verifyTurnstile } = await import("@/lib/turnstile");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    production();
    vi.stubEnv("TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    expect(turnstileState()).toBe("off");
    expect(await verifyTurnstile(undefined, "203.0.113.5")).toBe("ok");
    expect(await verifyTurnstile(undefined, "203.0.113.6")).toBe("ok");
    const off = err.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("turnstile off"));
    expect(off).toEqual(["turnstile off: TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are unset"]); // once, for two checks
  });

  it("978: both keys in production still verify at Cloudflare as before", async () => {
    const { turnstileState, verifyTurnstile } = await import("@/lib/turnstile");
    production();
    vi.stubEnv("TURNSTILE_SITE_KEY", SITE);
    vi.stubEnv("TURNSTILE_SECRET_KEY", SECRET);
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    expect(turnstileState()).toBe("on");
    expect(await verifyTurnstile("tok", "203.0.113.5")).toBe("ok");
    expect(f).toHaveBeenCalledOnce();
  });
});
