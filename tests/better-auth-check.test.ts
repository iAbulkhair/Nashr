import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { BetterAuthOptions } from "better-auth";
import { jar, json, newMember, newUser, signIn, signOut, withHeaders } from "./helpers/session";
import { getLogin, sessionKey, type Login } from "@/lib/auth";
import { db } from "@/lib/db";
import { deviceId, devicesKey } from "@/lib/devices";
import { accountKey, globalKey } from "@/lib/keys";
import { linkKey, subKey } from "@/lib/google-signin";
import { redisAdapter, twoWayGoogle } from "@/lib/better-auth/adapter";
import { BA_ROUTES } from "@/lib/better-auth/handler";
import { BA_GOOGLE, baOptions } from "@/lib/better-auth/server";
import * as baRoute from "@/app/api/better-auth/[...all]/route";
import * as loginRoute from "@/app/api/auth/login/route";
import { cli, exitCodeOf, judgeLogin, NOTHING_TO_APPLY, reportLines, run, sessionKind, type CheckReport } from "../scripts/better-auth-check";

/**
 * better-auth behind AUTH_ENGINE, step (f): Google through better-auth stays off (rule 3425) and the read-only readiness
 * check scripts/better-auth-check.ts (rule 3426). docs/superpowers/specs/2026-10-23-better-auth-orpc-migration.md
 * sections 9-10; docs/system/tests/3400-better-auth-orpc.md.
 */
const SECRET = "s".repeat(40);
const ORIGIN = "https://thakeen.com";
const PASSWORD = "abc12345";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
afterEach(() => { signOut(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const read = (f: string) => readFileSync(f, "utf8");
const hex = () => randomBytes(5).toString("hex");
const adapter = () => redisAdapter()({} as BetterAuthOptions);
let ipN = 0;
/** Never repeats within a run, and never meets the addresses other test files use. */
const freshIp = () => { ipN++; return `100.66.${Math.floor(ipN / 250) % 250}.${(ipN % 250) + 1}`; };
/** Sign in through the real login route, so the device index names the session; the cookie token. */
async function loginFrom(email: string, password = PASSWORD): Promise<string> {
  const addr = freshIp();
  const r = await withHeaders({ "user-agent": CHROME, "x-forwarded-for": addr }, () => loginRoute.POST(json("/api/auth/login", "POST", { email, password }, { "x-forwarded-for": addr })));
  expect(r.status).toBe(200);
  return jar().get("thakeen_session")!;
}
/** The device index entry `createSession` writes, for a session the `signIn` helper wrote (it writes the record only). */
const index = (email: string, token: string) => db.hset(devicesKey(email), deviceId(sessionKey(token)), { k: sessionKey(token), ua: "", ip: "", at: Date.now() });
/** A Google link that holds both ways, as the legacy Google routes write it. */
const link = async (email: string, sub: string) => { await db.set(subKey(email), sub); await db.set(linkKey(sub), email); };
const ZERO: CheckReport = { accounts: 0, missing: 0, addresses: 0, logins: 0, noLogin: 0, password: 0, google: 0, neither: 0, addressMismatch: 0, idMismatch: 0, sessions: 0, sessionsNoPid: 0, sessionsImp: 0, sessionsGone: 0 };
const delta = (a: CheckReport, b: CheckReport) => Object.fromEntries((Object.keys(ZERO) as (keyof CheckReport)[]).map((k) => [k, b[k] - a[k]]));
const storeVars = () => { vi.stubEnv("KV_REST_API_URL", "https://kv.invalid"); vi.stubEnv("KV_REST_API_TOKEN", "t".repeat(32)); };
const ba = (path: string, method: "GET" | "POST") => {
  const req = json(`/api/better-auth${path}`, method, method === "POST" ? {} : undefined, { origin: ORIGIN, "x-forwarded-for": freshIp() });
  return method === "GET" ? baRoute.GET(req) : baRoute.POST(req);
};

describe("rule 3425: better-auth's Google stays off; the legacy Google routes are the only Google sign-in", () => {
  it("BA_GOOGLE is false and no social provider is configured, even with Google's credentials set", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "client.apps.invalid");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "x".repeat(24));
    expect(BA_GOOGLE).toBe(false);
    const o = baOptions(SECRET);
    expect("socialProviders" in o).toBe(false);
    expect(o.account.accountLinking.enabled).toBe(false);
    expect(o.plugins.map((p) => p.id)).toEqual(["magic-link"]);
    expect(Object.keys(BA_ROUTES).filter((p) => /social|callback|link-|google|oauth/i.test(p))).toEqual([]);
  });

  it("better-auth's Google start, callback and link answer 404 with the switch on or off", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "client.apps.invalid");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "x".repeat(24));
    vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
    for (const engine of ["", "better-auth"]) {
      vi.stubEnv("AUTH_ENGINE", engine);
      for (const [p, m] of [["/sign-in/social", "POST"], ["/callback/google", "GET"], ["/callback/google", "POST"], ["/link-social", "POST"], ["/sign-in/oauth2", "POST"]] as const) {
        const res = await ba(p, m);
        expect([engine, p, m, res.status]).toEqual([engine, p, m, 404]);
      }
    }
  });

  it("the adapter answers nothing to a lookup by provider and account id (the callback's read), even for a linked login", async () => {
    const u = await newUser("bg");
    const sub = `sub-${hex()}`;
    await link(u.email, sub);
    const where = [{ field: "providerId", value: "google" }, { field: "accountId", value: sub }] as never;
    expect(await adapter().findMany({ model: "account", where, limit: 10 })).toEqual([]);
    expect(await adapter().findOne({ model: "account", where })).toBeNull();
  });

  it("the legacy Google routes stay and end in the shared createSession; twoWayGoogle is the adapter's own rule", () => {
    for (const f of ["src/app/api/auth/google/start/route.ts", "src/app/api/auth/google/callback/route.ts"]) expect(existsSync(f), f).toBe(true);
    expect(read("src/app/api/auth/google/callback/route.ts")).toMatch(/\bcreateSession\b/);
    expect(read("src/lib/better-auth/adapter.ts")).toMatch(/return twoWayGoogle\(login, sub, await db\.get<string>\(linkKey\(sub\)\)\);/);
    expect(twoWayGoogle("a@test.example", "sub-1", "A@Test.example")).toBe("sub-1");
    expect(twoWayGoogle("a@test.example", "sub-1", "b@test.example")).toBeNull();
    expect(twoWayGoogle("a@test.example", "sub-1", null)).toBeNull();
    expect(twoWayGoogle("a@test.example", "", "a@test.example")).toBeNull();
    expect(twoWayGoogle("a@test.example", 7, "a@test.example")).toBeNull();
  });
});

describe("rule 3426: the readiness check only reads and prints counts", () => {
  it("--apply is refused before the variables or the store are read", async () => {
    storeVars();
    const spies = [vi.spyOn(db, "get"), vi.spyOn(db, "mget"), vi.spyOn(db, "smembers"), vi.spyOn(db, "hgetall")];
    expect(await cli(["--apply"])).toEqual({ code: 2, lines: [NOTHING_TO_APPLY] });
    expect(await cli(["--dry-run", "--apply"])).toEqual({ code: 2, lines: [NOTHING_TO_APPLY] });
    vi.stubEnv("KV_REST_API_URL", "");
    expect(await cli(["--apply"])).toEqual({ code: 2, lines: [NOTHING_TO_APPLY] });
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("without the store's variables it does not run", async () => {
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    const spy = vi.spyOn(db, "smembers");
    const { code, lines } = await cli([]);
    expect([code, lines.length]).toEqual([2, 1]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("counts the logins by their ways in (two-way Google links only) and the indexed sessions by shape", async () => {
    const before = await run();
    const owner = await newUser("bk");
    const m = await newMember(owner, "member", "bkm");
    const g = await newUser("bk");
    await link(g.email, `sub-${hex()}`);
    const oneWay = await newUser("bk");
    await db.set(subKey(oneWay.email), `sub-${hex()}`);
    // Sessions: two real sign-ins (indexed), one from before R1, an impersonation, and an entry whose record expired.
    await loginFrom(owner.email);
    await loginFrom(m.email, m.password);
    await index(owner.email, await signIn(owner.email, { legacyShape: true }));
    await index(g.email, await signIn(g.email, { imp: "founder@test.example" }));
    await db.hset(devicesKey(oneWay.email), "e".repeat(20), { k: sessionKey("f".repeat(64)), ua: "", ip: "", at: Date.now() });
    const after = await run();
    expect(delta(before, after)).toEqual({ ...ZERO, accounts: 3, addresses: 4, logins: 4, password: 4, google: 1, sessions: 4, sessionsNoPid: 1, sessionsImp: 1, sessionsGone: 1 });
    // Every fixture survives the switch: no mismatch, so a dry run exits 0.
    expect([after.addressMismatch, after.idMismatch, exitCodeOf(after)]).toEqual([0, 0, 0]);
  });

  it("a listed account with no record is missing; an address that signs in as nobody is counted and blocks nothing", async () => {
    const before = await run();
    const gone = `a_${hex()}`;
    const stray = `a_${hex()}`;
    await db.sadd(globalKey.usersAll(), gone);
    await db.sadd(globalKey.usersAll(), stray);
    await db.set(accountKey.user(stray), { id: stray, email: `stray-${hex()}@test.example`, name: "", phone: "" });
    try {
      const after = await run();
      expect(delta(before, after)).toEqual({ ...ZERO, accounts: 2, missing: 1, addresses: 1, noLogin: 1 });
      expect(exitCodeOf(after)).toBe(exitCodeOf(before));
    } finally {
      await Promise.all([db.srem(globalKey.usersAll(), gone), db.srem(globalKey.usersAll(), stray), db.del(accountKey.user(stray))]);
    }
  });

  it("judges a login as better-auth would: neither way in is counted, a broken way back or another address is a mismatch", async () => {
    const u = await newUser("bk");
    const l = (await getLogin(u.email))!;
    expect(judgeLogin(u.email, l, l, null)).toEqual({ password: true, google: false, addressMismatch: false, idMismatch: false });
    const bare = { ...l, person: { ...l.person, passHash: undefined } } as Login;
    expect(judgeLogin(u.email, bare, bare, null)).toMatchObject({ password: false, google: false });
    expect(judgeLogin(u.email, bare, bare, "sub-1")).toMatchObject({ password: false, google: true });
    expect(judgeLogin(u.email, l, null, null).idMismatch).toBe(true);
    expect(judgeLogin(u.email, l, { ...l, pid: "p_other" } as Login, null).idMismatch).toBe(true);
    expect(judgeLogin(`other-${hex()}@test.example`, l, l, null).addressMismatch).toBe(true);
    expect(judgeLogin(u.email.toUpperCase(), l, l, null).addressMismatch).toBe(false);
    // Only a mismatch blocks: a login with no way in, a stray address or an old session is for reading.
    expect(exitCodeOf({ ...ZERO, idMismatch: 1 })).toBe(1);
    expect(exitCodeOf({ ...ZERO, addressMismatch: 1 })).toBe(1);
    expect(exitCodeOf({ ...ZERO, neither: 5, noLogin: 2, missing: 1, sessionsNoPid: 9, sessionsImp: 1, sessionsGone: 3 })).toBe(0);
  });

  it("reads a session record's shape as the new engine does", () => {
    expect(sessionKind(null)).toBe("gone");
    expect(sessionKind(7)).toBe("gone");
    expect(sessionKind("")).toBe("gone");
    expect(sessionKind("a@test.example")).toBe("noPid");
    expect(sessionKind({ email: "a@test.example", at: 1 })).toBe("noPid");
    expect(sessionKind({ email: "a@test.example", at: 1, pid: "p_1", acct: "a_1" })).toBe("ok");
    expect(sessionKind({ email: "a@test.example", at: 1, pid: "p_1", imp: "founder@test.example" })).toBe("imp");
  });

  it("prints counts only: no address, Google id, token or key", async () => {
    const u = await newUser("bk");
    const sub = `sub-${hex()}`;
    await link(u.email, sub);
    const token = await loginFrom(u.email);
    storeVars();
    const { code, lines } = await cli([]);
    expect(code).toBe(0);
    const text = lines.join("\n");
    for (const s of [u.email, sub, token, sessionKey(token), "@", "session:", "googlesub:", "devs:", "p_", "a_"]) expect(text, s).not.toContain(s);
    expect(text.replace(/\d+/g, "N")).toBe(reportLines(ZERO).join("\n").replace(/\d+/g, "N"));
  });

  it("runs under the documented command (jiti, no `@/` alias on its import chain) and refuses as cli() does", () => {
    const env = { ...process.env, KV_REST_API_URL: "", KV_REST_API_TOKEN: "", UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" };
    const jiti = (args: string[]) => spawnSync(process.execPath, ["node_modules/jiti/lib/jiti-cli.mjs", "scripts/better-auth-check.ts", ...args], { env, encoding: "utf8", timeout: 60_000 });
    const apply = jiti(["--apply"]);
    expect([apply.status, apply.stderr.trim(), apply.stdout]).toEqual([2, NOTHING_TO_APPLY, ""]);
    const bare = jiti([]);
    expect([bare.status, bare.stderr.trim()]).toEqual([2, "KV_REST_API_URL and KV_REST_API_TOKEN must be set (the app's own store)."]);
  }, 120_000);

  it("the script writes nothing, reuses the adapter's projections, and is not part of the build or the check", () => {
    const src = read("scripts/better-auth-check.ts");
    expect(src).not.toMatch(/\bdb\.(set|del|hset|hdel|sadd|srem|expire|incr\w*|getdel|eval\w*|mset|setnx|rpush|lpush|zadd)\(/);
    expect(src).toMatch(/import \{ loginOfPerson, projectAccounts, projectUser, twoWayGoogle \} from "\.\.\/src\/lib\/better-auth\/adapter";/);
    // `--apply` is refused before the variables are read; no `await db.*` inside a loop.
    expect(src.indexOf('argv.includes("--apply")')).toBeGreaterThan(-1);
    expect(src.indexOf('argv.includes("--apply")')).toBeLessThan(src.indexOf("process.env.KV_REST_API_URL"));
    expect(src).not.toMatch(/\b(for|while)\s*\([^)]*\)\s*\{?[^\n]*await db\./);
    expect(read("package.json")).not.toContain("better-auth-check");
  });
});
