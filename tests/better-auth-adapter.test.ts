import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { readFileSync } from "node:fs";
import type { BetterAuthOptions } from "better-auth";
import { jar, newMember, newUser, signIn, signOut } from "./helpers/session";
import { createSession, currentUser, getLogin, issueSession, sessionKey, sessionRecord, SESSION_TOKEN } from "@/lib/auth";
import { authEngine, baOn, baSecret } from "@/lib/auth-engine";
import { db } from "@/lib/db";
import { globalKey } from "@/lib/keys";
import { devicesKey, deviceId } from "@/lib/devices";
import { ownerOf } from "@/lib/membership";
import { updatePerson } from "@/lib/person";
import { linkKey, subKey } from "@/lib/google-signin";
import { matches, projectAccounts, projectSession, projectUser, redisAdapter } from "@/lib/better-auth/adapter";
import { approveSession, pendingApprovals, takeApproval, APPROVAL_MS } from "@/lib/better-auth/approvals";

/**
 * better-auth behind AUTH_ENGINE, step (a): the switch and the Redis projection adapter
 * (docs/superpowers/specs/2026-10-23-better-auth-orpc-migration.md, rules 3400-3409; docs/system/tests/3400-better-auth-orpc.md).
 */
const SECRET = "s".repeat(40);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const adapter = () => redisAdapter()({} as BetterAuthOptions);
type W = { field: string; value: string; operator?: "eq"; connector?: "AND" };
const where = (...w: W[]) => w;
afterEach(() => { signOut(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("rule 3400: AUTH_ENGINE=better-auth turns the engine on, read at call time", () => {
  it("is off by default and with any other value", () => {
    vi.stubEnv("AUTH_ENGINE", "");
    vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
    expect(authEngine()).toBe("legacy");
    vi.stubEnv("AUTH_ENGINE", "betterauth");
    expect(baOn()).toBe(false);
    vi.stubEnv("AUTH_ENGINE", "better-auth");
    expect(baOn()).toBe(true);
    vi.stubEnv("AUTH_ENGINE", "legacy");
    expect(baOn()).toBe(false);
  });
});

describe("rule 3401: the engine needs BETTER_AUTH_SECRET of 32 characters or more, else it fails closed", () => {
  it("a missing or short secret keeps the legacy engine", () => {
    vi.stubEnv("AUTH_ENGINE", "better-auth");
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    expect(baSecret()).toBeNull();
    expect(authEngine()).toBe("legacy");
    vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(31));
    expect(authEngine()).toBe("legacy");
    vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(32));
    expect(authEngine()).toBe("better-auth");
  });
});

describe("rule 3402: the five new packages are pinned exactly and the lockfile keeps the Linux bindings", () => {
  it("package.json and package-lock.json agree on exact versions", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, { version: string }> };
    const pins = { "better-auth": "1.7.10", "@orpc/server": "1.15.7", "@orpc/client": "1.15.7", "@orpc/tanstack-query": "1.15.7", "@tanstack/react-query": "5.104.3" };
    for (const [name, v] of Object.entries(pins)) {
      expect(pkg.dependencies[name]).toBe(v);
      expect(lock.packages[`node_modules/${name}`].version).toBe(v);
    }
    expect(Object.keys(lock.packages).some((k) => k.startsWith("node_modules/@rolldown/binding-linux-"))).toBe(true);
  });
});

describe("rule 3403: better-auth's user is the login, projected; nothing is written", () => {
  it("by email and by person id, an owner and a member, with emailVerified true", async () => {
    const owner = await newUser("bau");
    const m = await newMember(owner);
    const a = adapter();
    const byEmail = await a.findOne<{ id: string; email: string; emailVerified: boolean }>({ model: "user", where: where({ field: "email", value: owner.email }) });
    expect(byEmail).toMatchObject({ id: ownerOf(owner), email: owner.email, emailVerified: true });
    const byId = await a.findOne<{ email: string }>({ model: "user", where: where({ field: "id", value: ownerOf(owner) }) });
    expect(byId?.email).toBe(owner.email);
    const member = await a.findOne<{ id: string; email: string }>({ model: "user", where: where({ field: "email", value: m.email }) });
    expect(member).toMatchObject({ id: m.pid, email: m.email });
    // better-auth lowercases an address before it asks (findUserByEmail); any other spelling fails closed.
    expect(await a.findOne({ model: "user", where: where({ field: "email", value: m.email.toUpperCase() }) })).toBeNull();
  });

  it("an unknown address or id is nobody; a query without email or id never scans", async () => {
    const a = adapter();
    expect(await a.findOne({ model: "user", where: where({ field: "email", value: "nobody@test.example" }) })).toBeNull();
    expect(await a.findOne({ model: "user", where: where({ field: "id", value: "p_aaaaaaaaaaaaaaaaaaaaaaaa" }) })).toBeNull();
    expect(await a.findOne({ model: "user", where: where({ field: "name", value: "Test" }) })).toBeNull();
  });

  it("the projection never carries the password hash", async () => {
    const u = await newUser("bau");
    const l = (await getLogin(u.email))!;
    expect(JSON.stringify(projectUser(l))).not.toContain("$2");
  });
});

describe("rule 3404: accounts are the password hash and a two-way Google link", () => {
  it("credential with the person's bcrypt hash", async () => {
    const u = await newUser("bac");
    const rows = await adapter().findMany<{ providerId: string; accountId: string; password: string | null }>({ model: "account", where: where({ field: "userId", value: ownerOf(u) }), limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ providerId: "credential", accountId: ownerOf(u) });
    expect(rows[0].password).toMatch(/^\$2[aby]\$/);
  });

  it("google only when google:{sub} names the login back", async () => {
    const u = await newUser("bac");
    await db.set(subKey(u.email), "sub-123");
    expect((await adapter().findMany<{ providerId: string }>({ model: "account", where: where({ field: "userId", value: ownerOf(u) }), limit: 10 })).map((r) => r.providerId)).toEqual(["credential"]);
    await db.set(linkKey("sub-123"), u.email);
    const rows = await adapter().findMany<{ providerId: string; accountId: string }>({ model: "account", where: where({ field: "userId", value: ownerOf(u) }), limit: 10 });
    expect(rows.find((r) => r.providerId === "google")?.accountId).toBe("sub-123");
  });

  it("no hash, no credential row; a query without userId answers nothing", async () => {
    const u = await newUser("bac");
    const l = (await getLogin(u.email))!;
    expect(projectAccounts({ ...l, person: { ...l.person, passHash: undefined } } as typeof l, null)).toEqual([]);
    expect(await adapter().findMany({ model: "account", where: where({ field: "providerId", value: "credential" }), limit: 10 })).toEqual([]);
  });
});

describe("rule 3405: verification rows live under ba:verify:{sha256(identifier)} with a TTL, taken once", () => {
  it("create, find, consume once", async () => {
    const a = adapter();
    const identifier = "magic-link:hashed-token-1";
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await a.create({ model: "verification", data: { identifier, value: '{"type":"magic-link","email":"x@test.example"}', expiresAt, createdAt: new Date(), updatedAt: new Date() } });
    const k = globalKey.baVerify(sha(identifier));
    expect(k).toBe(`ba:verify:${sha(identifier)}`);
    expect(await db.ttl(k)).toBeGreaterThan(800);
    expect(await db.ttl(k)).toBeLessThanOrEqual(900);
    const found = await a.findMany<{ id: string; value: string }>({ model: "verification", where: where({ field: "identifier", value: identifier }), limit: 1 });
    expect(found).toHaveLength(1);
    const first = await a.consumeOne!<{ value: string }>({ model: "verification", where: where({ field: "id", value: found[0].id }) });
    const second = await a.consumeOne!({ model: "verification", where: where({ field: "id", value: found[0].id }) });
    expect(first?.value).toContain("magic-link");
    expect(second).toBeNull();
    expect(await db.get(k)).toBeNull();
  });

  it("an expired row is never written; an id that is not a hash builds no key", async () => {
    const a = adapter();
    await expect(a.create({ model: "verification", data: { identifier: "magic-link:old", value: "{}", expiresAt: new Date(Date.now() - 1000) } })).rejects.toThrow();
    expect(await a.consumeOne!({ model: "verification", where: where({ field: "id", value: "../user:x" }) })).toBeNull();
  });
});

describe("rule 3406: a session reads only when it resolves as currentUser resolves it", () => {
  it("a live session projects with the person id and the device id", async () => {
    const u = await newUser("bas");
    const token = await signIn(u.email);
    const s = await adapter().findOne<{ id: string; token: string; userId: string; expiresAt: Date }>({ model: "session", where: where({ field: "token", value: token }) });
    expect(s).toMatchObject({ id: deviceId(sessionKey(token)), token, userId: ownerOf(u) });
    expect(s!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("with the user joined, as get-session asks", async () => {
    const u = await newUser("bas");
    const token = await signIn(u.email);
    const s = await adapter().findOne<{ user: { email: string } }>({ model: "session", where: where({ field: "token", value: token }), join: { user: true } });
    expect(s?.user.email).toBe(u.email);
  });

  it("an impersonation, a revoked session and an unverified owner read as nobody", async () => {
    const u = await newUser("bas");
    const imp = await signIn(u.email, { imp: "founder@test.example" });
    expect(await adapter().findOne({ model: "session", where: where({ field: "token", value: imp }) })).toBeNull();
    const t = await signIn(u.email);
    await updatePerson(ownerOf(u), { sessionsAfter: new Date(Date.now() + 1000).toISOString() });
    expect(await adapter().findOne({ model: "session", where: where({ field: "token", value: t }) })).toBeNull();
    const fresh = await newUser("bas", { verified: false });
    const ut = await signIn(fresh.email);
    expect(await adapter().findOne({ model: "session", where: where({ field: "token", value: ut }) })).toBeNull();
  });

  it("a projected expiry in the past moves a minute ahead: the record's TTL is the authority", () => {
    const now = Date.now();
    expect(new Date(projectSession("t".repeat(64), 0, "p", now).expiresAt).getTime()).toBe(now + 60_000);
  });
});

describe("rule 3407: better-auth writes a session only for a token the gate approved, as createSession writes one", () => {
  const token = () => createHash("sha256").update(String(Math.random())).digest("hex");

  it("refuses an unapproved token and a token of another shape", async () => {
    const u = await newUser("baw");
    const a = adapter();
    await expect(a.create({ model: "session", data: { token: token(), userId: ownerOf(u), expiresAt: new Date(Date.now() + 86400e3) } })).rejects.toThrow();
    approveSession("short", u.email);
    await expect(a.create({ model: "session", data: { token: "short", userId: ownerOf(u), expiresAt: new Date(Date.now() + 86400e3) } })).rejects.toThrow();
    await expect(issueSession("short", u.email)).rejects.toThrow("session_token_shape");
  });

  it("an approved token becomes the legacy record, cookie and device entry; the approval is used up", async () => {
    const u = await newUser("baw");
    const t = token();
    approveSession(t, u.email);
    const created = await adapter().create<{ token: string; userId: string; expiresAt: Date }>({ model: "session", data: { token: t, userId: ownerOf(u), expiresAt: new Date(Date.now() + 30 * 86400e3) } });
    expect(created).toMatchObject({ token: t, userId: ownerOf(u) });
    expect(jar().get("thakeen_session")).toBe(t);
    const rec = (await sessionRecord(t)) as Record<string, unknown>;
    // Exactly the keys createSession writes: a better-auth session is a legacy session in every byte (rollback safe).
    signOut();
    await createSession(u.email);
    const legacy = (await sessionRecord(jar().get("thakeen_session")!)) as Record<string, unknown>;
    expect(Object.keys(rec).sort()).toEqual(Object.keys(legacy).sort());
    expect(Object.keys(await db.hgetall(devicesKey(u.email)))).toContain(deviceId(sessionKey(t)));
    jar().set("thakeen_session", t);
    expect((await currentUser())?.email).toBe(u.email);
    approveSession(t, u.email);
    expect(takeApproval(t)).toBe(u.email);
    expect(takeApproval(t)).toBeNull();
  });

  it("an approval lasts APPROVAL_MS at most", () => {
    vi.useFakeTimers();
    approveSession("a".repeat(64), "x@test.example");
    vi.advanceTimersByTime(APPROVAL_MS + 1);
    expect(takeApproval("a".repeat(64))).toBeNull();
    expect(pendingApprovals()).toBeGreaterThanOrEqual(0);
    expect(SESSION_TOKEN.test("a".repeat(64))).toBe(true);
  });
});

describe("rule 3408: writes better-auth has no business making are refused loudly", () => {
  it("users and accounts are never created or edited; sessions are never refreshed", async () => {
    const a = adapter();
    await expect(a.create({ model: "user", data: { email: "new@test.example", name: "n", emailVerified: true } })).rejects.toThrow();
    await expect(a.create({ model: "account", data: { userId: "x", providerId: "credential", accountId: "x" } })).rejects.toThrow();
    await expect(a.update({ model: "session", where: where({ field: "token", value: "x" }), update: { expiresAt: new Date() } })).rejects.toThrow();
    await expect(a.update({ model: "user", where: where({ field: "id", value: "x" }), update: { name: "y" } })).rejects.toThrow();
  });
});

describe("rule 3409: a better-auth sign-out deletes the record under both keys and its device entry", () => {
  it("delete by token", async () => {
    const u = await newUser("bad");
    await createSession(u.email);
    const t = jar().get("thakeen_session")!;
    expect(Object.keys(await db.hgetall(devicesKey(u.email)))).toHaveLength(1);
    await adapter().delete({ model: "session", where: where({ field: "token", value: t }) });
    expect(await sessionRecord(t)).toBeNull();
    expect(await db.hgetall(devicesKey(u.email))).toEqual({});
  });
});

describe("the where matcher fails closed", () => {
  it("unknown operators never match; OR and AND chain left to right", () => {
    const row = { a: "1", b: "2" };
    expect(matches(row, [{ field: "a", value: "1", operator: "eq", connector: "AND" }])).toBe(true);
    expect(matches(row, [{ field: "a", value: "1", operator: "starts_with", connector: "AND" }])).toBe(false);
    expect(matches(row, [{ field: "a", value: "9", operator: "eq", connector: "AND" }, { field: "b", value: "2", operator: "eq", connector: "OR" }])).toBe(true);
  });
});
