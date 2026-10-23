import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import * as acceptRoute from "@/app/api/team/accept/route";
import { acct, currentUser, getLogin, getUser, saveUser, type User } from "@/lib/auth";
import { resolveGoogle } from "@/lib/google-signin";
import { cancelInvite, createInvite, verifiedAddressInvited } from "@/lib/team";
import { json, newUser, signIn, signOut } from "./helpers/session";

vi.mock("@/lib/multi-org", async (orig) => ({ ...(await orig<typeof import("@/lib/multi-org")>()), MULTI_ORG: true }));

/**
 * Invite-only sign-up with `MULTI_ORG` on (rules 3522, 3525, docs/system/tests/3520-invite-only-signup.md): the invite
 * inbox `invitesfor:{email}` is written, so a Google sign-up whose verified address holds a standing invite is let in.
 */

const freshEmail = (p = "iom") => `${p}-${randomBytes(4).toString("hex")}@test.example`;
let ipN = 0;
const accept = (body: Record<string, unknown>) => acceptRoute.POST(json("/api/team/accept", "POST", body, { "x-forwarded-for": `198.18.0.${(++ipN % 250) + 1}` }));
const google = (email: string) => resolveGoogle({ sub: `g${randomBytes(6).toString("hex")}`, email, name: "G" }, "signup", "en");
const pro = async (u: User) => { const x = { ...(await getUser(acct(u)))!, plan: "pro" as const, seats: 10 }; await saveUser(x); return x; };
async function ownerSession(prefix: string) {
  const u = await pro(await newUser(prefix, { shadow: false }));
  await signIn(u.email);
  const me = (await currentUser())!;
  signOut();
  return { u, me, actor: me.actor! };
}

afterEach(() => { vi.unstubAllEnvs(); signOut(); });

describe("rule 3522 with MULTI_ORG on: Google sign-up of an invited address", () => {
  it("invite: a standing invite to the verified address lets it in; a cancelled one does not", async () => {
    vi.stubEnv("SIGNUP_MODE", "invite");
    const A = await ownerSession("gma");
    const e = freshEmail();
    const inv = await createInvite(A.me, A.actor, e, "member", "ar");
    if (!inv.ok) throw new Error(inv.error);
    expect(await verifiedAddressInvited(e)).toBe(true);
    const e2 = freshEmail();
    const inv2 = await createInvite(A.me, A.actor, e2, "member", "ar");
    if (!inv2.ok) throw new Error(inv2.error);
    expect((await cancelInvite(A.me, A.actor, inv2.id)).ok).toBe(true);
    expect(await verifiedAddressInvited(e2)).toBe(false);
    expect(await google(e2)).toEqual({ kind: "refused", error: "google_invite_only" });
    expect(await getLogin(e2)).toBeNull();
    const r = await google(e);
    expect(r.kind).toBe("created");
    // An invite to someone else never opens this address.
    expect(await google(freshEmail())).toEqual({ kind: "refused", error: "google_invite_only" });
  });
});

describe("rule 3525 with MULTI_ORG on: accepting an invite as a new person stays open", () => {
  for (const mode of ["open", "invite"] as const) {
    it(`${mode}: the join link with a password makes the member`, async () => {
      vi.stubEnv("SIGNUP_MODE", mode);
      const A = await ownerSession(`gmb${mode[0]}`);
      const e = freshEmail();
      const inv = await createInvite(A.me, A.actor, e, "member", "ar");
      if (!inv.ok) throw new Error(inv.error);
      const r = await accept({ token: inv.token, name: "Joiner", password: "Passw0rd!x", lang: "en" });
      expect(r.status).toBe(200);
      expect(await getLogin(e)).not.toBeNull();
    });
  }
});
