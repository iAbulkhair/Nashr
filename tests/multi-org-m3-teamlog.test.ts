import { describe, expect, it, vi } from "vitest";
import * as logRoute from "@/app/api/team/log/route";
import { acct, currentUser, getUser, saveUser, type User } from "@/lib/auth";
import { can } from "@/lib/roles";
import { createInvite } from "@/lib/team";
import { teamPerms } from "@/components/app/teamPerms";
import { newMember, newUser, signIn, signOut } from "./helpers/session";

vi.mock("@/lib/multi-org", async (orig) => ({ ...(await orig<typeof import("@/lib/multi-org")>()), MULTI_ORG: true }));

/**
 * Multi-workspace M3, the Team log tab (docs/specs/2026-10-18-multi-org.md section 13; rule 2129, read half), with
 * `MULTI_ORG` on for this file. GET /api/team/log is the account's own `teamlog:` for its owner and admins
 * (`team.log.view`), newest first, people named by address only: never a person id, a token or an invite id.
 */

const pro = async (u: User) => { const x = { ...(await getUser(acct(u)))!, plan: "pro" as const, seats: 10 }; await saveUser(x); return x; };
const PID = /\bp_[a-z2-7]{24}\b/;
const HEX64 = /[a-f0-9]{64}/;
const read = async () => {
  const r = await logRoute.GET();
  return { status: r.status, text: await r.clone().text(), body: (await r.json()) as { ok: boolean; rows?: { at: string; kind: string; actor: { email: string }; target: { email: string }; role?: string; via: string }[] } };
};

describe("rule 2129: the Team log is read by the owner and admins, by address only", () => {
  it("the owner reads the account's own rows, newest first, with no person id, token or invite id", async () => {
    const u = await pro(await newUser("tlo", { shadow: false }));
    await signIn(u.email);
    const me = (await currentUser())!;
    const a = await createInvite(me, me.actor!, `first-${Date.now()}@test.example`, "member", "ar");
    const b = await createInvite(me, me.actor!, `second-${Date.now()}@test.example`, "admin", "en");
    if (!a.ok || !b.ok) throw new Error("invite");
    const r = await read();
    expect(r.status).toBe(200);
    expect(r.body.rows!.map((x) => x.kind)).toEqual(["invited", "invited"]);
    expect(r.body.rows![0].target.email).toBe(b.invite.email);
    expect(r.body.rows![0].role).toBe("admin");
    for (const row of r.body.rows!) expect(Object.keys(row).sort()).toEqual(["actor", "at", "kind", "role", "target", "via"]);
    for (const row of r.body.rows!) expect(Object.keys(row.actor)).toEqual(["email"]);
    expect(r.text).not.toMatch(PID);
    expect(r.text).not.toMatch(HEX64);
    for (const s of [a.id, b.id, a.token, b.token]) expect(r.text).not.toContain(s);
  });

  it("an admin reads it; a member is refused 403; signed out 401", async () => {
    const u = await pro(await newUser("tla", { shadow: false }));
    const admin = await newMember(u, "admin", "tlad", { shadow: false });
    const member = await newMember(u, "member", "tlme", { shadow: false });
    await signIn(admin.email);
    expect((await read()).status).toBe(200);
    expect(teamPerms((await currentUser())!).viewLog).toBe(true);
    await signIn(member.email);
    expect((await logRoute.GET()).status).toBe(403);
    expect(teamPerms((await currentUser())!).viewLog).toBe(false);
    signOut();
    expect((await logRoute.GET()).status).toBe(401);
  });

  it("another account's rows never show: the account is the session's own", async () => {
    const one = await pro(await newUser("tl1", { shadow: false }));
    const two = await pro(await newUser("tl2", { shadow: false }));
    await signIn(one.email);
    const me = (await currentUser())!;
    const r = await createInvite(me, me.actor!, `only-one-${Date.now()}@test.example`, "member", "ar");
    if (!r.ok) throw new Error(r.error);
    await signIn(two.email);
    expect((await read()).body.rows).toEqual([]);
  });

  it("an impersonation may read it (view), the role table says so", async () => {
    const u = await newUser("tli", { shadow: false });
    await signIn(u.email, { imp: "support-founder@test.example" });
    const v = (await currentUser())!;
    expect(can(v, "team.log.view")).toBe(true);
    expect((await logRoute.GET()).status).toBe(200);
  });
});
