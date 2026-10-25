import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as signupRoute from "@/app/api/auth/signup/route";
import * as listRoute from "@/app/api/workspaces/route";
import { getLogin, getUser, sessionKey } from "@/lib/auth";
import { wipeAccount } from "@/lib/account";
import { db } from "@/lib/db";
import { listNotifs, seenKey } from "@/lib/notifications";
import { WELCOME_FP, welcomeNotice, welcomeOnSignup } from "@/lib/welcome";
import { ownerOf } from "@/lib/membership";
import { addShadowMembership, json, newMember, newUser, signIn } from "./helpers/session";

vi.mock("@/lib/multi-org", async (orig) => ({ ...(await orig<typeof import("@/lib/multi-org")>()), MULTI_ORG: true }));

/**
 * Rule 3506: one welcome notice in the bell on the first sign-up only, in the sign-up language, through
 * src/lib/notifications.ts. A retry pushes nothing more; a team join or a second workspace pushes none; the account wipe
 * deletes the claim so a new account at the same address is welcomed again.
 */
let n = 0;
const address = (p: string) => `${p}-${Date.now().toString(36)}-${n++}@test.example`;
const signup = (email: string, lang: "ar" | "en") =>
  signupRoute.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "New Owner", lang }, { "x-forwarded-for": `10.35.${n % 250}.${(n * 3) % 250}` }));
const welcomes = async (aid: string) => (await listNotifs(aid)).filter((x) => x.title === "أهلاً بك في ذكين" || x.title === "Welcome to Thakeen");

describe("rule 3506: the welcome notice", () => {
  it("a password sign-up gets one, in its language, pointing at the start page", async () => {
    for (const lang of ["ar", "en"] as const) {
      const e = address(`wel${lang}`);
      expect((await signup(e, lang)).status).toBe(200);
      const aid = (await getLogin(e))!.acct!;
      const got = await welcomes(aid);
      expect(got).toHaveLength(1);
      expect(got[0].title).toBe(lang === "ar" ? "أهلاً بك في ذكين" : "Welcome to Thakeen");
      expect(got[0].kind).toBe("info");
      expect(got[0].href).toContain("/start");
      expect(got[0].href.startsWith(`/${lang}/`)).toBe(true);
    }
  });

  it("a retry pushes no second one", async () => {
    const u = await newUser("welr");
    expect(await welcomeOnSignup(u)).toBe(true);
    expect(await welcomeOnSignup(u)).toBe(false);
    await Promise.all([welcomeOnSignup(u), welcomeOnSignup(u)]);
    expect(await welcomes(u.id ?? u.email)).toHaveLength(1);
  });

  it("a second workspace and a team join push none", async () => {
    const u = await newUser("welw", { shadow: false });
    await addShadowMembership(ownerOf(u), u.createdAt);
    const token = await signIn(u.email);
    expect((await listRoute.POST(json("/api/workspaces", "POST", { name: "Second shop", lang: "en" }))).status).toBe(200);
    const aid = (await db.get<{ acct: string }>(sessionKey(token)))!.acct;
    expect(await welcomes(aid)).toHaveLength(0);
    await newMember(u);
    expect(await welcomes(u.id ?? u.email)).toHaveLength(0);
    // The source: only the two sign-up paths call it.
    expect(readFileSync("src/lib/workspaces.ts", "utf8")).not.toContain("welcome");
    expect(readFileSync("src/lib/team.ts", "utf8")).not.toContain("welcomeOnSignup");
    expect(readFileSync("src/app/api/auth/signup/route.ts", "utf8")).toContain("await welcomeOnSignup(account)");
    expect(readFileSync("src/app/api/auth/google/callback/route.ts", "utf8")).toMatch(/if \(res\.login\.kind === "owner"\) await welcomeOnSignup\(res\.login\.user\)/);
  });

  it("the account wipe deletes the claim, so a new account at the address is welcomed again", async () => {
    const u = await newUser("welx");
    const aid = u.id ?? u.email;
    await welcomeOnSignup(u);
    expect(await db.get(seenKey(aid, WELCOME_FP))).not.toBeNull();
    await wipeAccount(aid);
    expect(await getUser(aid)).toBeNull();
    expect(await db.get(seenKey(aid, WELCOME_FP))).toBeNull();
  });

  it("never fails the sign-up and promises nothing", async () => {
    const ar = welcomeNotice({ id: "a_x", email: "x@test.example", lang: "ar" });
    const en = welcomeNotice({ id: "a_x", email: "x@test.example", lang: "en" });
    expect(`${ar.body} ${en.body}`).not.toMatch(/\d+%|guarantee|نضمن|مضمون/);
    // The store failing under the claim: logged, false, never thrown into the sign-up.
    const spy = vi.spyOn(db, "setNx").mockRejectedValueOnce(new Error("redis down"));
    await expect(welcomeOnSignup({ id: "a_y", email: "y@test.example", lang: "en" })).resolves.toBe(false);
    spy.mockRestore();
  });
});
