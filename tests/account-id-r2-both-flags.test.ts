import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { jar, json, signIn, signOut } from "./helpers/session";
import { acct, currentUser, getAccount, getLogin, sc } from "@/lib/auth";
import { OPAQUE_ACCOUNT_ID, OPAQUE_IDS } from "@/lib/account-id";
import { MULTI_ORG } from "@/lib/multi-org";
import { db } from "@/lib/db";
import { accountKey } from "@/lib/keys";
import { getPerson } from "@/lib/person";
import { holdOn } from "@/lib/email-hold";

// Rule 2749 (multi-workspace spec decision 11): R2 turns on together with M2, with no further code. Both constants are
// mocked on here; nothing else changes. A signup makes a `p_` person and an `a_` account, the person moves in place
// through the settings route, signs in at the new address, the old address signs nothing in and is held.

type Mail = { to: string; subject: string; text: string };
let mails: Mail[] = [];
vi.mock("@/lib/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/notify")>()),
  sendEmail: async (...a: unknown[]) => {
    const m = (typeof a[0] === "string" ? { to: a[0], subject: a[1], text: a[2] } : a[0]) as Mail;
    mails.push({ to: m.to, subject: m.subject, text: m.text });
    return true;
  },
}));

import * as signupRoute from "@/app/api/auth/signup/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as emailRoute from "@/app/api/account/email/route";
import * as revertRoute from "@/app/api/auth/email-revert/route";
import { markVerified } from "./helpers/session";

let ipN = 0;
const ip = () => { ipN++; return { "x-forwarded-for": `203.1.${Math.floor(ipN / 250) % 250}.${(ipN % 250) + 1}` }; };
const addr = (p: string) => `${p}-${randomBytes(4).toString("hex")}@test.example`;
const post = (body: Record<string, unknown>) => emailRoute.POST(json("/api/account/email", "POST", body, ip()));
const codeFor = (to: string) => mails.filter((m) => m.to === to).at(-1)!.text.match(/\b\d{6}\b/)![0];

beforeEach(() => {
  mails = [];
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("MAIL_FROM", "Thakeen <no-reply@test.example>");
});
afterEach(() => { vi.unstubAllEnvs(); signOut(); });

describe("rule 2749: OPAQUE_IDS and MULTI_ORG on together", () => {
  it("both constants are on (M2 and R2 enable)", () => {
    expect(OPAQUE_IDS).toBe(true);
    expect(MULTI_ORG).toBe(true);
  });

  it("signup, move in place, sign-in at the new address, the old one dead and held, and the revert back", async () => {
    const e = addr("both");
    const s = await signupRoute.POST(json("/api/auth/signup", "POST", { email: e, password: "abc12345", name: "Both", lang: "en" }, ip()));
    expect(s.status).toBe(200);
    const l = (await getLogin(e))!;
    expect(l.pid.startsWith("p_")).toBe(true);
    expect(l.acct).toMatch(OPAQUE_ACCOUNT_ID);
    expect(await db.get(accountKey.user(e))).toBeNull();
    await markVerified(e);
    const aid = l.acct!;
    await signIn(e);
    const scope = sc((await currentUser())!);
    const to = addr("both2");
    expect((await post({ action: "start", email: to, password: "abc12345" })).status).toBe(200);
    expect((await post({ action: "confirm", code: codeFor(to) })).status).toBe(200);
    expect(await getLogin(to)).toMatchObject({ pid: l.pid, acct: aid });
    expect(await getLogin(e)).toBeNull();
    expect((await getPerson(l.pid))!.email).toBe(to);
    expect((await getAccount(aid))!.email).toBe(to);
    expect(sc((await currentUser())!)).toBe(scope);
    expect(acct((await currentUser())!)).toBe(aid);
    expect(await holdOn(e)).toMatchObject({ pid: l.pid });
    signOut();
    expect((await loginRoute.POST(json("/api/auth/login", "POST", { email: to, password: "abc12345" }, ip()))).status).toBe(200);
    jar().clear();
    expect((await loginRoute.POST(json("/api/auth/login", "POST", { email: e, password: "abc12345" }, ip()))).status).toBe(401);
    expect((await signupRoute.POST(json("/api/auth/signup", "POST", { email: e, password: "abc12345", name: "Thief", lang: "en" }, ip()))).status).toBe(409);
    const token = mails.filter((m) => m.to === e).at(-1)!.text.match(/#r=([a-f0-9]{64})/)![1];
    expect((await revertRoute.POST(json("/api/auth/email-revert", "POST", { token }, ip()))).status).toBe(200);
    expect(await getLogin(e)).toMatchObject({ pid: l.pid, acct: aid });
  });
});
