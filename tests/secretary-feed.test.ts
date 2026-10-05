import { beforeAll, describe, expect, it, vi } from "vitest";
import { newMember, newUser, signIn } from "./helpers/session";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { can, MIN_ROLE } from "@/lib/roles";
import { createFeed, FEED_KEYS, FEED_TOKEN, getFeedStatus, hashFeedToken, resolveFeed, revokeFeed, revokeFeeds } from "@/lib/feed-token";

const FOUNDER = "founder-feed@test.example";
type Mem = { kv: Map<string, unknown>; lists: Map<string, unknown>; sets: Map<string, unknown>; hashes?: Map<string, unknown>; zsets?: Map<string, unknown> };
const mem = () => (globalThis as unknown as { __nashrMem: Mem }).__nashrMem;
/** Every key in the fake store, whatever its type. */
const memKeys = () => { const m = mem(); return [...m.kv.keys(), ...m.lists.keys(), ...m.sets.keys(), ...(m.hashes?.keys() ?? []), ...(m.zsets?.keys() ?? [])]; };
/** Every stored value in the fake store, serialised (sets and maps spread so their members are visible). */
const memValues = () => {
  const m = mem();
  const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (x instanceof Set ? [...x] : x instanceof Map ? [...x.entries()] : x));
  return [...m.kv.values(), ...m.lists.values(), ...m.sets.values(), ...(m.hashes?.values() ?? []), ...(m.zsets?.values() ?? [])].map(ser);
};
/** The `sec:feed:*` records that belong to this login. */
const recordsOf = (login: string) => [...mem().kv.entries()].filter(([k, v]) => k.startsWith("sec:feed:") && (v as { login?: string }).login === login);
const resolveAs = async (email: string, opts: { imp?: string } = {}) => { await signIn(email, opts); return currentUser(); };

beforeAll(() => {
  vi.stubEnv("ADMIN_EMAILS", FOUNDER);
});

describe("feed token (rules 530-533)", () => {
  it("rule 530: only the SHA-256 of the token is stored, the plain token never", async () => {
    const login = (await newUser("feed")).email;
    const token = await createFeed(login, login, "ar");
    expect(token).toMatch(FEED_TOKEN);
    expect(hashFeedToken(token)).toMatch(/^[0-9a-f]{64}$/);
    const rec = await db.get(FEED_KEYS.rec(hashFeedToken(token)));
    expect(rec).toEqual({ login, scope: login, lang: "ar", createdAt: expect.any(String) });
    expect(Number.isNaN(Date.parse((rec as { createdAt: string }).createdAt))).toBe(false);
    expect(memKeys().filter((k) => k.includes(token))).toEqual([]);
    expect(memValues().filter((v) => v.includes(token))).toEqual([]);
    expect(await resolveFeed(token)).toEqual({ hash: hashFeedToken(token), rec });
    expect(await getFeedStatus(login)).toEqual({ exists: true, createdAt: (rec as { createdAt: string }).createdAt });
  });

  it("rule 530: a malformed token is refused without reading the store", async () => {
    const spy = vi.spyOn(db, "get");
    try {
      for (const bad of ["", "short", "x".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}/`]) expect(await resolveFeed(bad)).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("rule 531: renewing deletes the old record and sec:feedof keeps one per login", async () => {
    const login = (await newUser("feed")).email;
    const first = await createFeed(login, login, "en");
    const second = await createFeed(login, login, "en");
    expect(first).not.toBe(second);
    expect(await resolveFeed(first)).toBeNull();
    expect(await resolveFeed(second)).not.toBeNull();
    expect(await db.get(FEED_KEYS.of(login))).toBe(hashFeedToken(second));
    expect(await db.get(FEED_KEYS.rec(hashFeedToken(first)))).toBeNull();
    expect(recordsOf(login)).toHaveLength(1);
  });

  it("rule 532: two creates at once leave exactly one working link; revoke is idempotent", async () => {
    const login = (await newUser("feed")).email;
    const out = await Promise.all([createFeed(login, login, "ar"), createFeed(login, login, "ar")]);
    expect(out.filter((x) => x === "busy").length).toBeLessThanOrEqual(1);
    expect(recordsOf(login)).toHaveLength(1);
    const working = await Promise.all(out.filter((x) => x !== "busy").map((t) => resolveFeed(t)));
    expect(working.filter((r) => r !== null)).toHaveLength(1);

    await revokeFeed(login);
    await revokeFeed(login);
    expect(recordsOf(login)).toEqual([]);
    expect(memKeys().filter((k) => k === FEED_KEYS.of(login))).toEqual([]);
    expect(await getFeedStatus(login)).toEqual({ exists: false, createdAt: null });
  });

  it("rule 532: a held lock never keeps a link alive, and revokeFeeds revokes every login given", async () => {
    const a = (await newUser("feed")).email;
    const b = (await newUser("feed")).email;
    const ta = await createFeed(a, a, "ar");
    const tb = await createFeed(b, b, "en");
    const held = await db.lockOwned(`lock:feed:${a}`, 10);
    expect(held).not.toBeNull();
    expect(await createFeed(a, a, "ar")).toBe("busy");
    await revokeFeeds([a, b]);
    expect(await resolveFeed(ta)).toBeNull();
    expect(await resolveFeed(tb)).toBeNull();
    expect(recordsOf(a)).toEqual([]);
    expect(recordsOf(b)).toEqual([]);
    await db.unlockOwned(`lock:feed:${a}`, held!);
  });

  it("rule 533: feed.manage is member-level and blocked while a founder impersonates", async () => {
    expect(MIN_ROLE["feed.manage"]).toBe("member");
    const owner = await newUser("feedown");
    const admin = await newMember(owner, "admin");
    const member = await newMember(owner, "member");
    expect(can(await resolveAs(owner.email), "feed.manage")).toBe(true);
    expect(can(await resolveAs(admin.email), "feed.manage")).toBe(true);
    expect(can(await resolveAs(member.email), "feed.manage")).toBe(true);
    const founder = await resolveAs(owner.email, { imp: FOUNDER });
    expect(founder!.actor).toMatchObject({ kind: "founder" });
    expect(can(founder, "feed.manage")).toBe(false);
  });
});
