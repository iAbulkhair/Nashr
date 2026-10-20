import { afterEach, describe, expect, it, vi } from "vitest";
import { newMember, newUser, PERSONS, readActiveBrand, seedActiveBrand, signIn, signOut, withHeaders } from "./helpers/session";
import { trackRounds } from "./helpers/rounds";
import { acct, currentPerson, currentUser, currentUserUnverified, sc, type User } from "@/lib/auth";
import { BRAND_HEADER } from "@/lib/brand-path";
import { saveBrands, scopeFor, type BrandMeta } from "@/lib/brands";
import { db } from "@/lib/db";
import { accountKey, personKey, storedAccountId } from "@/lib/keys";
import { ownerOf } from "@/lib/membership";

/**
 * Rule 886 (brand id in the URL, Part C; plan docs/superpowers/plans/2026-10-20-brand-url.md Task 2, R-C3 and R-C7):
 * `currentUser()` and `currentUserUnverified()` read the page's brand from `x-thakeen-brand` and use it ONLY as a
 * selector among the session account's own active brands. A selector that is not one of them (archived, unknown,
 * another account's, malformed) is Next's 404, never a fallback; "default" always resolves; the stored choice
 * (`activebrand`) is neither read for the answer nor written. Without the header everything is as before (rule 2135's
 * rounds included). The member and owner fixtures follow `TEST_PERSONS` (`npm run check` runs both modes).
 */

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); signOut(); });

const T0 = "2026-10-01T00:00:00.000Z";
const NOT_FOUND = { digest: expect.stringMatching(/^NEXT_HTTP_ERROR_FALLBACK;404/) };

async function setBrands(aid: string, active: string[], archived: string[] = []) {
  const rows: BrandMeta[] = [
    ...active.map((id) => ({ id, name: id, createdAt: T0, status: "active" as const })),
    ...archived.map((id) => ({ id, name: id, createdAt: T0, status: "archived" as const })),
  ];
  await saveBrands(aid, rows);
}
const pick = (brand: string, fn: () => Promise<User | null> = currentUser) => withHeaders({ [BRAND_HEADER]: brand }, fn);
/** Both stored-choice keys of the owner of `u` in its own account, raw. */
const storedChoice = (u: User) => Promise.all([db.get(personKey.activeBrand(ownerOf(u), storedAccountId(acct(u)))), db.get(accountKey.activeBrand(u.email))]);

/**
 * An owner with active b1, b2, archived old, the stored choice on default, signed in on an R1 session. `legacyShape`
 * signs in with a session written before R1, which only a legacy owner can hold, so the fixture is a legacy one then.
 */
async function ownerWithBrands(prefix: string, opts: { legacyShape?: boolean } = {}) {
  const owner = await newUser(prefix, { legacy: !!opts.legacyShape });
  await setBrands(acct(owner), ["b1", "b2"], ["old"]);
  await seedActiveBrand(owner.email, "default");
  await signIn(owner.email, opts);
  return owner;
}

describe("rule 886: the brand header is a selector among the session account's own active brands", () => {
  it("an owner on an R1 session: header b2 resolves b2 while the stored choice says default, and the choice is not written", async () => {
    const owner = await ownerWithBrands("bo");
    const before = await storedChoice(owner);
    expect(await readActiveBrand(owner.email)).toBe("default");
    const t = trackRounds();
    const u = (await pick("b2"))!;
    t.stop();
    expect(u.brandId).toBe("b2");
    expect(sc(u)).toBe(scopeFor(acct(owner), "b2"));
    expect(acct(u)).toBe(acct(owner));
    expect(u.actor?.kind).toBe("owner");
    // Nothing written on the way: no set, del or any other write command.
    expect(t.calls.filter((c) => !["get", "sismember", "mget", "smembers", "exists", "ttl"].includes(c.op))).toEqual([]);
    expect(await storedChoice(owner)).toEqual(before);
    expect(await readActiveBrand(owner.email)).toBe("default");
    // Without the header: the stored choice, as before.
    expect((await currentUser())!.brandId).toBe("default");
  });

  it("an archived brand, an unknown id, another account's brand or a malformed value is Next's 404", async () => {
    const other = await newUser("bx");
    await setBrands(acct(other), ["theirs"]);
    const owner = await ownerWithBrands("bo4");
    for (const bad of ["old", "zz99zz99", "theirs", "../x", "a".repeat(300), "", "b1/..", "%2e%2e", "b1#x"]) {
      await expect(pick(bad), JSON.stringify(bad)).rejects.toMatchObject(NOT_FOUND);
    }
    // The account and its own brands still resolve.
    expect((await pick("b1"))!.brandId).toBe("b1");
    expect(acct((await currentUser())!)).toBe(acct(owner));
  });

  it("a malformed value is refused before any store read", async () => {
    await ownerWithBrands("bo5");
    for (const bad of ["../x", "a".repeat(300), "b#1", "b:1"]) {
      const t = trackRounds();
      await expect(pick(bad)).rejects.toMatchObject(NOT_FOUND);
      t.stop();
      expect(t.rounds(), bad).toBe(0);
    }
  });

  it("a brand id two accounts both hold selects the caller's own: the scope is always built on the session account", async () => {
    const other = await newUser("bsx");
    await setBrands(acct(other), ["shared"]);
    const owner = await newUser("bso");
    await setBrands(acct(owner), ["shared"]);
    await signIn(owner.email);
    const u = (await pick("shared"))!;
    expect(acct(u)).toBe(acct(owner));
    expect(sc(u)).toBe(scopeFor(acct(owner), "shared"));
    expect(sc(u)).not.toBe(scopeFor(acct(other), "shared"));
  });

  it(`a member (${PERSONS} persons, R1 session): an own-account brand resolves, another account's is 404`, async () => {
    const owner = await newUser("bmo");
    const stranger = await newUser("bms");
    await Promise.all([setBrands(acct(owner), ["mb1"], ["mold"]), setBrands(acct(stranger), ["sb1"])]);
    const m = await newMember(owner, "member", "bmm");
    await signIn(m.email);
    const u = (await pick("mb1"))!;
    expect(u.actor?.kind).toBe("member");
    expect(acct(u)).toBe(acct(owner));
    expect(sc(u)).toBe(scopeFor(acct(owner), "mb1"));
    await expect(pick("sb1")).rejects.toMatchObject(NOT_FOUND);
    await expect(pick("mold")).rejects.toMatchObject(NOT_FOUND);
    expect((await currentUser())!.brandId).toBe("default");
  });

  it("sessions written before R1: the owner and the member branch check the selector the same way", async () => {
    const owner = await ownerWithBrands("blo", { legacyShape: true });
    const stranger = await newUser("bls");
    await setBrands(acct(stranger), ["sb2"]);
    const u = (await pick("b1"))!;
    expect(u.actor?.kind).toBe("owner");
    expect(sc(u)).toBe(scopeFor(acct(owner), "b1"));
    for (const bad of ["sb2", "old", "nope"]) await expect(pick(bad), bad).rejects.toMatchObject(NOT_FOUND);

    const m = await newMember(owner, "admin", "blm", { legacy: true });
    await signIn(m.email, { legacyShape: true });
    const mu = (await pick("b2"))!;
    expect(mu.actor?.kind).toBe("member");
    expect(sc(mu)).toBe(scopeFor(acct(owner), "b2"));
    for (const bad of ["sb2", "old", "nope"]) await expect(pick(bad), bad).rejects.toMatchObject(NOT_FOUND);
  });

  it("an impersonation resolves only the impersonated account's brands", async () => {
    const stranger = await newUser("bis");
    await setBrands(acct(stranger), ["sb3"]);
    for (const legacyShape of [false, true]) {
      const owner = await ownerWithBrands(`bio${legacyShape ? "l" : ""}`, { legacyShape });
      await signIn(owner.email, { imp: "founder-bi@test.example", legacyShape });
      const u = (await pick("b2"))!;
      expect(u.actor?.kind, String(legacyShape)).toBe("founder");
      expect(sc(u)).toBe(scopeFor(acct(owner), "b2"));
      await expect(pick("sb3"), String(legacyShape)).rejects.toMatchObject(NOT_FOUND);
      await expect(pick("old"), String(legacyShape)).rejects.toMatchObject(NOT_FOUND);
    }
  });

  it('"default" always resolves: an owner, a member, both session shapes, an account with no brand list at all', async () => {
    const bare = await newUser("bdb");
    await signIn(bare.email);
    expect(await db.get(accountKey.brands(acct(bare)))).toBeNull();
    const a = (await pick("default"))!;
    expect(sc(a)).toBe(scopeFor(acct(bare), "default"));
    const bareLegacy = await newUser("bdl", { legacy: true });
    await signIn(bareLegacy.email, { legacyShape: true });
    expect((await pick("default"))!.brandId).toBe("default");

    const owner = await newUser("bdo");
    await setBrands(acct(owner), ["d1"]);
    await seedActiveBrand(owner.email, "d1");
    await signIn(owner.email);
    expect((await currentUser())!.brandId).toBe("d1");
    expect((await pick("default"))!.brandId).toBe("default");
    const m = await newMember(owner, "member", "bdm");
    await signIn(m.email);
    expect(sc((await pick("default"))!)).toBe(scopeFor(acct(owner), "default"));
  });

  it("currentUserUnverified reads the selector too; currentPerson ignores it", async () => {
    const owner = await newUser("buo", { verified: false });
    await setBrands(acct(owner), ["u1"]);
    await signIn(owner.email);
    expect(await currentUser()).toBeNull();
    expect((await pick("u1", currentUserUnverified))!.brandId).toBe("u1");
    await expect(pick("nope", currentUserUnverified)).rejects.toMatchObject(NOT_FOUND);

    const v = await ownerWithBrands("bpo");
    const p = await withHeaders({ [BRAND_HEADER]: "nope" }, () => currentPerson());
    expect(p?.acct).toBe(acct(v));
  });

  it("a brand list the store cannot read: a selector fails closed (404); without one the stored choice is kept", async () => {
    const owner = await ownerWithBrands("buf");
    await seedActiveBrand(owner.email, "b1");
    const real = db.get.bind(db);
    vi.spyOn(db, "get").mockImplementation(((k: string) => (k === accountKey.brands(acct(owner)) ? Promise.reject(new Error("down")) : real(k))) as typeof db.get);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(pick("b2")).rejects.toMatchObject(NOT_FOUND);
    expect((await currentUser())!.brandId).toBe("b1");
    // A session written before R1 (owner branch) fails closed the same way.
    const legacy = await ownerWithBrands("bufl", { legacyShape: true });
    vi.spyOn(db, "get").mockImplementation(((k: string) => (k === accountKey.brands(acct(legacy)) ? Promise.reject(new Error("down")) : real(k))) as typeof db.get);
    await expect(pick("b2")).rejects.toMatchObject(NOT_FOUND);
    expect((await currentUser())!.brandId).toBe("default");
  });
});

describe("rule 886 with rule 2135: the selector costs no round on an R1 session, one on a pre-R1 owner session (R-C7)", () => {
  const rounds = async (fn: () => Promise<User | null>) => {
    const t = trackRounds();
    const u = await fn();
    t.stop();
    return { u, rounds: t.rounds() };
  };

  it("an R1 owner and an R1 member with a header: the session read plus ONE round", async () => {
    const owner = await ownerWithBrands("rbo");
    const o = await rounds(() => pick("b1"));
    expect(o.u?.brandId).toBe("b1");
    expect(o.rounds).toBe(2);
    expect((await rounds(() => currentUser())).rounds).toBe(2);
    const m = await newMember(owner, "member", "rbm");
    await signIn(m.email);
    const r = await rounds(() => pick("b2"));
    expect(r.u?.brandId).toBe("b2");
    expect(r.rounds).toBe(2);
    expect((await rounds(() => currentUser())).rounds).toBe(2);
  });

  it("a pre-R1 owner: one more round with a header than without; a pre-R1 member: as before", async () => {
    const owner = await ownerWithBrands("rlo", { legacyShape: true });
    const without = await rounds(() => currentUser());
    const withSel = await rounds(() => pick("b1"));
    expect(without.rounds).toBe(2);
    expect(withSel.u?.brandId).toBe("b1");
    expect(withSel.rounds).toBe(without.rounds + 1);
    const m = await newMember(owner, "member", "rlm", { legacy: true });
    await signIn(m.email, { legacyShape: true });
    expect((await rounds(() => currentUser())).rounds).toBe(3);
    const ms = await rounds(() => pick("b2"));
    expect(ms.u?.brandId).toBe("b2");
    expect(ms.rounds).toBe(3);
  });
});
