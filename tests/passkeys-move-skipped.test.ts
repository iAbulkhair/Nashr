import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { newMember, newUser, signIn, signOut } from "./helpers/session";
import { enrolPasskeys, passkeyResidue } from "./helpers/passkeys";
import { acct, currentUserUnverified, getLogin } from "@/lib/auth";
import { db } from "@/lib/db";
import { personKey, storedPersonId } from "@/lib/keys";
import { log } from "@/lib/log";
import { getPerson } from "@/lib/person";
import { wipeAccount } from "@/lib/account";
import { moveMemberLogin } from "@/lib/team";
import { moveUnverifiedAccount } from "@/lib/verify-email";

/**
 * Customer passkeys, Task 6 fix round 1 (review minor 3): what the two address moves do when `movePasskeys` answers
 * `skipped` (a person could not be read; unreachable through real data, so the store function is replaced here), and
 * `wipeAccount`'s `keepPasskeys`. Both moves log `passkey_move_skipped`, finish, and keep every passkey key of the old
 * pid (inert under rules 2402 and 2405); nothing else of the old person stays. Legacy fixtures: only a legacy person's
 * address moves before release M2.
 */

const forced = vi.hoisted(() => ({ skip: false }));
vi.mock("@/lib/passkeys", async (orig) => {
  const real = await orig<typeof import("@/lib/passkeys")>();
  return { ...real, movePasskeys: async (...a: Parameters<typeof real.movePasskeys>) => (forced.skip ? "skipped" : real.movePasskeys(...a)) };
});

const addr = (p: string) => `${p}-${randomBytes(4).toString("hex")}@test.example`;
const rawSet = (pid: string) => db.get(personKey.passkeys(storedPersonId(pid)));
const ownerUser = async (email: string) => {
  await signIn(email);
  const u = await currentUserUnverified();
  signOut();
  return u!;
};

afterEach(() => {
  forced.skip = false;
  signOut();
  vi.restoreAllMocks();
});

describe("Task 6 fix round 1: keepPasskeys and the skipped branches", () => {
  it("wipeAccount with keepPasskeys on an owner alone deletes the person but keeps its set, entries and open registration", async () => {
    const u = await newUser("pkkeep", { shadow: false });
    const e = await enrolPasskeys(u.email);
    const residue = passkeyResidue(e.pid);
    expect(residue).toHaveLength(4);
    await wipeAccount(acct(u), { keepPasskeys: true });
    expect(await getPerson(e.pid)).toBeNull();
    expect(passkeyResidue(e.pid)).toEqual(residue);
  });

  it("the owner move: a skipped passkey step is logged, the move finishes and the old pid keeps every passkey key", async () => {
    const u = await newUser("pkskipo", { legacy: true, shadow: false, verified: false });
    const e = await enrolPasskeys(u.email);
    const residue = passkeyResidue(e.pid);
    const warn = vi.spyOn(log, "warn");
    forced.skip = true;
    const to = addr("pkskiponew");
    expect(await moveUnverifiedAccount(await ownerUser(u.email), to)).toBe("ok");
    expect(warn).toHaveBeenCalledWith("owner move kept passkeys", { reason: "passkey_move_skipped" });
    // The move finished: the old account and person are gone, the new address signs in.
    expect(await getLogin(u.email)).toBeNull();
    expect((await getLogin(to))?.pid).toBe(storedPersonId(to));
    expect(await db.get(personKey.person(e.pid))).toBeNull();
    // Only the passkey keys stay under the old pid; nothing was written at the new one.
    expect(passkeyResidue(e.pid)).toEqual(residue);
    expect(await rawSet(to)).toBeNull();
  });

  it("the owner move control: not skipped, the old pid keeps nothing", async () => {
    const u = await newUser("pkskipc", { legacy: true, shadow: false, verified: false });
    const e = await enrolPasskeys(u.email);
    const warn = vi.spyOn(log, "warn");
    const to = addr("pkskipcnew");
    expect(await moveUnverifiedAccount(await ownerUser(u.email), to)).toBe("ok");
    expect(warn).not.toHaveBeenCalledWith("owner move kept passkeys", expect.anything());
    expect(passkeyResidue(e.pid)).toEqual([]);
    expect(await rawSet(to)).not.toBeNull();
  });

  it("the member move: a skipped passkey step is logged, the move finishes and the old pid keeps every passkey key", async () => {
    const owner = await newUser("pkskipm");
    const m = await newMember(owner, "member", "m", { legacy: true, shadow: false });
    const e = await enrolPasskeys(m.email);
    const residue = passkeyResidue(e.pid);
    const warn = vi.spyOn(log, "warn");
    forced.skip = true;
    const to = addr("pkskipmnew");
    expect(await moveMemberLogin(acct(owner), m.email, to)).toBe("ok");
    expect(warn).toHaveBeenCalledWith("member move kept passkeys", { reason: "passkey_move_skipped" });
    expect(await getLogin(m.email)).toBeNull();
    expect((await getLogin(to))?.pid).toBe(storedPersonId(to));
    expect(await db.get(personKey.person(e.pid))).toBeNull();
    expect(passkeyResidue(e.pid)).toEqual(residue);
    expect(await rawSet(to)).toBeNull();
  });

  it("the member move control: not skipped, the old pid keeps nothing (an open registration included)", async () => {
    const owner = await newUser("pkskipn");
    const m = await newMember(owner, "member", "m", { legacy: true, shadow: false });
    const e = await enrolPasskeys(m.email);
    const to = addr("pkskipnnew");
    expect(await moveMemberLogin(acct(owner), m.email, to)).toBe("ok");
    expect(passkeyResidue(e.pid)).toEqual([]);
    expect(await rawSet(to)).not.toBeNull();
  });
});
