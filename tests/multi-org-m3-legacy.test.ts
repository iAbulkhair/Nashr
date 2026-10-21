import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import * as loginRoute from "@/app/api/auth/login/route";
import * as memberRoute from "@/app/api/team/member/route";
import * as workspacesRoute from "@/app/api/workspaces/route";
import { acct, createUser, currentPerson, currentUser, getLogin, getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { personKey, storedAccountId, storedPersonId, type AccountId, type PersonId } from "@/lib/keys";
import { getMembership, ownerOf } from "@/lib/membership";
import { newPersonId } from "@/lib/multi-org";
import { getPerson, updatePerson } from "@/lib/person";
import { createMember } from "@/lib/team";
import { json, markVerified, newMember, newUser, signIn, signOut } from "./helpers/session";

// The switch per test: rule 2131's pre-R1 half is production behaviour (flag off); rule 2124's M3 half needs it on.
const flag = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/multi-org", async (orig) => {
  const real = await orig<typeof import("@/lib/multi-org")>();
  return { ...real, get MULTI_ORG() { return flag.on; } };
});

/**
 * Multi-workspace M3 (docs/superpowers/plans/2026-10-21-multi-org-m3.md Task 7):
 * - rule 2131, the pre-R1 half: a session written before R1 (no `pid`, no `acct`) resolves through `resolveLegacy`, which
 *   now reads the session person's `person:` row in its first round and refuses a suspended person, owner or member, as
 *   `resolveIds` does. The fixtures are legacy persons whatever `TEST_PERSONS` says: only they hold pre-R1 sessions.
 * - rule 2124, the M3 half (`MULTI_ORG` on): a `p_` person removed from its last membership keeps its person and login,
 *   signs in to no account, and creates a workspace of its own.
 */

afterEach(() => { flag.on = false; signOut(); vi.unstubAllEnvs(); });

const T0 = "2026-10-01T00:00:00.000Z";
/** Suspend the legacy person `email` on its `person:` row (written when R1 left none), as the console's person suspension does. */
async function suspendPerson(email: string, suspended: unknown) {
  const pid = storedPersonId(email);
  const row = (await db.get<Record<string, unknown>>(personKey.person(pid))) ?? { pid, email, name: "Test", lang: "ar", passHash: "", emailVerifiedAt: T0, createdAt: T0 };
  await db.set(personKey.person(pid), { ...row, suspended });
}

describe("rule 2131 (pre-R1 half): person suspension refuses a session written before R1", () => {
  it("a legacy owner's pre-R1 session is refused while the person is suspended, and resolves again when the suspension ends", async () => {
    const owner = await newUser("sp", { legacy: true, shadow: false });
    await signIn(owner.email, { legacyShape: true });
    expect(acct((await currentUser())!)).toBe(acct(owner));
    await suspendPerson(owner.email, true);
    expect(await currentUser()).toBeNull();
    // A timed suspension in the future blocks; one that has ended does not (read time, rule 2072).
    await suspendPerson(owner.email, { until: new Date(Date.now() + 864e5).toISOString() });
    expect(await currentUser()).toBeNull();
    await suspendPerson(owner.email, { until: new Date(Date.now() - 1000).toISOString() });
    expect(acct((await currentUser())!)).toBe(acct(owner));
    // A value this code does not know fails closed, as the account field does.
    await suspendPerson(owner.email, "soon");
    expect(await currentUser()).toBeNull();
  });

  it("a legacy member's pre-R1 session is refused while the member's person is suspended; the owner is untouched", async () => {
    const owner = await newUser("spo", { legacy: true, shadow: false });
    const m = await newMember(owner, "member", "spm", { legacy: true, shadow: false });
    await signIn(m.email, { legacyShape: true });
    expect(acct((await currentUser())!)).toBe(acct(owner));
    await suspendPerson(m.email, true);
    expect(await currentUser()).toBeNull();
    signOut();
    await signIn(owner.email, { legacyShape: true });
    expect(acct((await currentUser())!)).toBe(acct(owner));
  });

  it("an owner's person suspension does not refuse the member's pre-R1 session (it is the member's person that counts)", async () => {
    const owner = await newUser("spx", { legacy: true, shadow: false });
    const m = await newMember(owner, "member", "spxm", { legacy: true, shadow: false });
    await suspendPerson(owner.email, true);
    await signIn(m.email, { legacyShape: true });
    expect(acct((await currentUser())!)).toBe(acct(owner));
  });
});

let n = 0;
const address = (prefix: string) => `${prefix}${++n}-${randomBytes(3).toString("hex")}@test.example`;
const PASSWORD = "abc12345";
async function pOwner(prefix: string): Promise<{ u: User; aid: AccountId; pid: PersonId }> {
  const made = await createUser({ email: address(prefix), name: "Owner", phone: "", password: PASSWORD, lang: "ar" }, { opaque: true, person: "p" });
  await markVerified(made.email);
  const aid = storedAccountId(acct(made));
  const x = { ...(await getUser(aid))!, plan: "pro" as const, seats: 10 };
  await saveUser(x);
  return { u: x, aid, pid: storedPersonId(ownerOf(x)) };
}

describe("rule 2124 (M3 half): a person removed from its last membership survives, signs in to no account and creates one", () => {
  it("removed by the owner: the person and login stay; sign-in opens no account; creating a workspace opens it as owner", async () => {
    flag.on = true;
    const o = await pOwner("rm");
    const email = address("rmm");
    const pid = storedPersonId(newPersonId());
    await createMember(acct(o.u), { email, name: "Member", password: PASSWORD, lang: "en", role: "member", invitedBy: o.u.email, invitedByPid: o.pid }, { pid });
    await updatePerson(pid, { emailVerifiedAt: new Date().toISOString() });
    // The owner removes the member: the membership goes, the person does not.
    await signIn(o.u.email);
    expect((await memberRoute.DELETE(json("/api/team/member", "DELETE", { email }))).status).toBe(200);
    expect(await getMembership(o.aid, pid)).toBeNull();
    expect((await getPerson(pid))?.email).toBe(email);
    expect((await getLogin(email))?.pid).toBe(pid);
    // Signed in through the form: a person, no account.
    signOut();
    const r = await loginRoute.POST(json("/api/auth/login", "POST", { email, password: PASSWORD }, { "x-forwarded-for": "10.27.3.9" }));
    expect(r.status).toBe(200);
    expect(await currentUser()).toBeNull();
    expect((await currentPerson())?.person.pid).toBe(pid);
    // A workspace of its own: the session now opens it, owned by this person.
    const c = await workspacesRoute.POST(json("/api/workspaces", "POST", { name: "My own", lang: "en" }));
    expect(c.status).toBe(200);
    const mine = (await currentUser())!;
    expect(mine).not.toBeNull();
    expect(ownerOf(mine)).toBe(pid);
    expect(mine.actor?.kind).toBe("owner");
    expect(acct(mine)).not.toBe(acct(o.u));
  });

  it("with the switch off the same removal deletes the person (plan reconciliation 7), so this path is M3's only", async () => {
    const o = await pOwner("rf");
    const email = address("rfm");
    const pid = storedPersonId(newPersonId());
    await createMember(acct(o.u), { email, name: "Member", password: PASSWORD, lang: "en", role: "member", invitedBy: o.u.email, invitedByPid: o.pid }, { pid });
    await signIn(o.u.email);
    expect((await memberRoute.DELETE(json("/api/team/member", "DELETE", { email }))).status).toBe(200);
    expect(await getPerson(pid)).toBeNull();
    expect(await getLogin(email)).toBeNull();
  });
});
