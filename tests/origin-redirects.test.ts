import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { jar, params } from "./helpers/session";
import { runCronBatch } from "@/lib/cron-batch";
import * as plink from "@/app/p/[code]/route";
import * as impersonate from "@/app/api/admin/impersonate/route";

/**
 * Rule 902: redirects and server-side self-calls are built on `appOrigin()`, never on the request URL. Behind the
 * Hostinger proxy `req.url` is the internal address (`https://0.0.0.0:3000`): on 2026-10-10 every partner link on
 * thakeen.com answered 307 to `https://0.0.0.0:3000/ar/app/signup`, and the cron hops (the batch chain, daily into
 * weekly, the secretary's evening kick) went to the same dead host without a sound.
 */

const ORIGIN = "https://thakeen.example";
const INTERNAL = "https://0.0.0.0:3000";
const ip = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
let calls: string[] = [];

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", ORIGIN);
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (u: string) => { calls.push(String(u)); return new Response("{}"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); jar().clear(); });

describe("rule 902: redirects and cron hops use the app origin, not the request URL", () => {
  it("a partner link behind the proxy sends the visitor to signup on the app origin", async () => {
    const res = await plink.GET(new Request(`${INTERNAL}/p/NOSUCHCODE?lang=en`, { headers: { "x-forwarded-for": ip() } }), params({ code: "NOSUCHCODE" }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/en/app/signup`);
  });

  it("the end of an impersonation returns the founder to the console on the app origin", async () => {
    const form = new FormData();
    form.set("lang", "en");
    const res = await impersonate.POST(new Request(`${INTERNAL}/api/admin/impersonate`, { method: "POST", body: form, headers: { "x-forwarded-for": ip() } }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/en/admin/users`);
  });

  it("a cron batch that runs out of time hands the rest to the app origin, path and chain kept", async () => {
    const req = new Request(`${INTERNAL}/api/cron/daily`, { headers: { authorization: "Bearer test" } });
    const items = Array.from({ length: 4 }, (_, i) => `u${i}`);
    const r = await runCronBatch({ job: "o902", period: `p${randomBytes(4).toString("hex")}`, items, id: (x) => x, run: async () => "ok", concurrency: 1, startBudgetMs: 0, markerTtlSeconds: 60, req });
    expect(r.chained).toBe(true);
    await new Promise((ok) => setTimeout(ok, 10));
    expect(calls).toEqual([`${ORIGIN}/api/cron/daily?chain=1`]);
  });

  it("no route or library builds a URL on the request URL (the daily-to-weekly and evening kicks included)", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f)) files.push(p);
      }
    };
    walk("src");
    // `new URL(req.url)` alone (reading the query) is fine; a second argument of `req.url` makes the request host the base.
    const base = /new URL\([^;]*,\s*(req|request)\.url\s*\)/;
    expect(files.filter((f) => base.test(readFileSync(f, "utf8")))).toEqual([]);
    for (const f of ["src/app/api/cron/daily/route.ts", "src/app/api/cron/secretary/route.ts"]) {
      expect(readFileSync(f, "utf8"), f).toMatch(/\$\{appOrigin\(\)\}\/api\/cron\/(weekly|evening)/);
    }
  });
});
