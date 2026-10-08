import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIp } from "@/lib/rate";
import { onVercel } from "@/lib/deploy-env";

// Rule 773: the rate-limit bucket comes only from a header the host's own front proxy sets or overwrites. On live
// Hostinger (2026-10-08) a client rotating `x-vercel-forwarded-for` got a fresh bucket per value on every per-IP limit.
const req = (headers: Record<string, string>) => new Request("https://thakeen.test/api/health", { headers });

// Live Hostinger as configured on 2026-10-08: VERCEL_ENV=production by hand, no VERCEL.
const hostinger = () => { vi.stubEnv("VERCEL", ""); vi.stubEnv("VERCEL_ENV", "production"); };
const vercel = () => { vi.stubEnv("VERCEL", "1"); vi.stubEnv("VERCEL_ENV", "production"); };

afterEach(() => { vi.unstubAllEnvs(); });

describe("onVercel (rule 773)", () => {
  it("is exactly VERCEL=1, never VERCEL_ENV", () => {
    hostinger();
    expect(onVercel()).toBe(false);
    for (const v of ["true", "0", " 1", "yes"]) { vi.stubEnv("VERCEL", v); expect(onVercel(), `VERCEL=${JSON.stringify(v)}`).toBe(false); }
    vi.stubEnv("VERCEL", "1");
    expect(onVercel()).toBe(true);
  });
});

describe("clientIp off Vercel (rule 773)", () => {
  it("ignores a spoofed x-vercel-forwarded-for and x-real-ip and reads the last x-forwarded-for hop", () => {
    hostinger();
    expect(clientIp(req({ "x-vercel-forwarded-for": "198.51.100.91", "x-forwarded-for": "203.0.113.5" }))).toBe("203.0.113.5");
    expect(clientIp(req({ "x-real-ip": "198.51.100.92", "x-forwarded-for": "203.0.113.5" }))).toBe("203.0.113.5");
    expect(clientIp(req({ "x-vercel-forwarded-for": "198.51.100.91", "x-real-ip": "198.51.100.92", "x-forwarded-for": "203.0.113.5" }))).toBe("203.0.113.5");
  });

  it("the caller's own earlier x-forwarded-for hops do not matter: the proxy appends the real one last", () => {
    hostinger();
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 7.7.7.7,203.0.113.5" }))).toBe("203.0.113.5");
    expect(clientIp(req({ "x-forwarded-for": "  203.0.113.6  " }))).toBe("203.0.113.6");
  });

  it("with only the spoofable headers every caller shares the one unknown bucket", () => {
    hostinger();
    expect(clientIp(req({ "x-vercel-forwarded-for": "198.51.100.91" }))).toBe("unknown");
    expect(clientIp(req({ "x-real-ip": "198.51.100.92" }))).toBe("unknown");
    expect(clientIp(req({}))).toBe("unknown");
    expect(clientIp(req({ "x-forwarded-for": "" }))).toBe("unknown");
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, " }))).toBe("unknown");
  });

  it("holds with VERCEL_ENV unset too (any host other than Vercel)", () => {
    vi.stubEnv("VERCEL", ""); vi.stubEnv("VERCEL_ENV", "");
    expect(clientIp(req({ "x-vercel-forwarded-for": "198.51.100.91", "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("rotating x-vercel-forwarded-for no longer resets the health limit: the 61st call is 429 (the live probe of 2026-10-08)", async () => {
    hostinger();
    const { GET } = await import("@/app/api/health/route");
    const call = (n: number) => GET(new Request("https://thakeen.test/api/health", {
      headers: { "x-vercel-forwarded-for": `198.51.100.${n % 250}`, "x-real-ip": `198.18.0.${n % 250}`, "x-forwarded-for": "203.0.113.77" },
    }));
    for (let i = 0; i < 60; i++) expect((await call(i)).status).toBe(200);
    const r = await call(60);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
  });
});

describe("clientIp on Vercel (rule 773)", () => {
  it("reads Vercel's own headers first, the first entry of each", () => {
    vercel();
    expect(clientIp(req({ "x-vercel-forwarded-for": "203.0.113.8, 10.0.0.1", "x-real-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.10" }))).toBe("203.0.113.8");
    expect(clientIp(req({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.10" }))).toBe("203.0.113.9");
  });

  it("falls back to the last x-forwarded-for hop, then unknown", () => {
    vercel();
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.10" }))).toBe("203.0.113.10");
    expect(clientIp(req({}))).toBe("unknown");
  });
});

describe("no route reads an address header itself (rule 773)", () => {
  it("only src/lib/rate.ts names x-vercel-forwarded-for, x-real-ip or x-forwarded-for", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    walk(join(process.cwd(), "src"));
    const readers = files.filter((f) => /x-vercel-forwarded-for|x-real-ip|x-forwarded-for/i.test(readFileSync(f, "utf8")));
    expect(readers.map((f) => f.slice(process.cwd().length + 1))).toEqual(["src/lib/rate.ts"]);
  });
});
