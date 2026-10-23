import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { readFileSync } from "node:fs";
import { currentUser, strongPassword } from "@/lib/auth";
import { appOrigin } from "@/lib/origin";
import { PASSWORD_MAX_BYTES, passwordBytes, passwordChecks } from "@/lib/auth-client";
import { db } from "@/lib/db";
import { globalKey, personKey } from "@/lib/keys";
import { ownerOf } from "@/lib/membership";
import { actingLogin } from "@/lib/own-password";
import { SUPPORT_EMAIL } from "@/lib/i18n";
import { clearConsoleOutbox, consoleOutbox, plainAddress } from "@/lib/mail-provider";
import { lifecyclePart, REPLY_INVITED } from "@/lib/lifecycle";
import * as signupRoute from "@/app/api/auth/signup/route";
import * as resetRoute from "@/app/api/auth/reset/route";
import * as accountRoute from "@/app/api/account/route";
import * as passwordLinkRoute from "@/app/api/account/password-link/route";
import * as supportRoute from "@/app/api/support/route";
import { json, newMember, newUser, PERSONS, signIn, signOut } from "./helpers/session";

/**
 * Auth and mail polish (rules 3100-3112, docs/system/tests/3100-auth-mail-polish.md): a 72-byte password cap, "Set a
 * password" for a login without one, and reply-to on outgoing mail.
 */

type Sent = { from: string; to: string; subject: string; text: string; html?: string; replyTo?: string };
const sent: Sent[] = [];
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async (msg: Sent) => { sent.push(msg); return { data: { id: "re_1" }, error: null }; } };
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  signOut();
  sent.length = 0;
  clearConsoleOutbox();
});

const mailOn = () => { vi.stubEnv("RESEND_API_KEY", "re_test_key"); vi.stubEnv("MAIL_FROM", "Thakeen <noreply@mail.example>"); };
let ipN = 0;
const ip = () => ({ "x-forwarded-for": `192.0.2.${(++ipN % 250) + 1}` });

// 36 Arabic characters are 72 bytes; with one digit the password is 73. 35 letters plus a digit is 71.
const AR_OK = "ب".repeat(35) + "1";
const AR_LONG = "ب".repeat(36) + "1";
const LATIN_OK = "a".repeat(71) + "1";
const LATIN_LONG = "a".repeat(72) + "1";

describe("rule 3100: a password is at most 72 bytes in UTF-8", () => {
  it("counts bytes, not characters: an Arabic letter is two", () => {
    expect(PASSWORD_MAX_BYTES).toBe(72);
    expect(passwordBytes("abc")).toBe(3);
    expect(passwordBytes("ب")).toBe(2);
    expect(passwordBytes(AR_OK)).toBe(71);
    expect(passwordBytes(AR_LONG)).toBe(73);
    expect(passwordBytes(LATIN_LONG)).toBe(73);
  });

  it("the server rule and the live client rules agree on every case", () => {
    for (const [pw, ok] of [[LATIN_OK, true], [LATIN_LONG, false], [AR_OK, true], [AR_LONG, false], ["abc12345", true], ["abc", false]] as const) {
      expect(strongPassword(pw), pw).toBe(ok);
      expect(passwordChecks(pw).every(Boolean), pw).toBe(ok);
    }
    expect(passwordChecks(LATIN_LONG)).toEqual([true, true, true, false]);
  });

  it("sign-up refuses a 73-byte password", async () => {
    for (const pw of [LATIN_LONG, AR_LONG]) {
      const r = await signupRoute.POST(json("/api/auth/signup", "POST", { email: `cap${++ipN}@test.example`, password: pw, name: "Cap", lang: "en" }, ip()));
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe("weak_password");
    }
  });

  it("a reset refuses a 73-byte password before it reads the link", async () => {
    const r = await resetRoute.POST(json("/api/auth/reset", "POST", { token: "a".repeat(64), password: AR_LONG }, ip()));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("weak_password");
  });

  it("a change refuses a 73-byte password and keeps the old one", async () => {
    const u = await newUser("capchg");
    await signIn(u.email);
    const r = await accountRoute.PATCH(json("/api/account", "PATCH", { currentPassword: "abc12345", newPassword: LATIN_LONG }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("weak_password");
    const ok = await accountRoute.PATCH(json("/api/account", "PATCH", { currentPassword: "abc12345", newPassword: LATIN_OK }));
    expect(ok.status).toBe(200);
  });

  it("joining a team checks the same rule, and the copy names the cap in both languages", () => {
    expect(readFileSync("src/lib/team.ts", "utf8")).toMatch(/!strongPassword\(input\.password\)\) return fail\("weak_password"\)/);
    const team = readFileSync("src/lib/app-i18n-team.ts", "utf8");
    expect(team).toContain("لا تزيد عن 72 حرفاً لاتينياً أو 36 حرفاً عربياً");
    expect(team).toContain("No more than 72 Latin or 36 Arabic characters");
    const form = readFileSync("src/components/app/AuthForm.tsx", "utf8");
    expect(form).toContain("No more than 72 Latin or 36 Arabic characters");
  });
});

/** A login whose person has no password, as a Google sign-up leaves it (only `p_` persons keep credentials on `person:`). */
async function withoutPassword(email: string, pid: string) {
  const row = (await db.get<Record<string, unknown>>(personKey.person(pid as never)))!;
  const { passHash: _drop, ...rest } = row;
  void _drop;
  await db.set(personKey.person(pid as never), rest);
  void email;
}
const pOnly = it.skipIf(PERSONS === "legacy");
const sendLink = (body: unknown = { lang: "en" }) => passwordLinkRoute.POST(json("/api/account/password-link", "POST", body));

describe("rule 3101: POST /api/account/password-link mails the reset link to the session's own address", () => {
  it("a visitor gets 401", async () => {
    expect((await sendLink()).status).toBe(401);
  });

  it("a login that has a password gets 409 has_password, and actingLogin says so", async () => {
    mailOn();
    const u = await newUser("haspw");
    await signIn(u.email);
    expect((await actingLogin((await currentUser())!))?.hasPassword).toBe(true);
    const r = await sendLink();
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("has_password");
    expect(sent).toHaveLength(0);
  });

  pOnly("a Google-only owner gets the link at its own address; an address in the body is ignored", async () => {
    mailOn();
    const u = await newUser("nopw");
    await withoutPassword(u.email, ownerOf(u));
    await signIn(u.email);
    const r = await sendLink({ lang: "ar", email: "attacker@evil.example", to: "attacker@evil.example" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, mail: true, sent: true });
    expect(sent.map((m) => m.to)).toEqual([u.email]);
    expect(JSON.stringify(sent)).not.toContain("evil.example");
    const token = /#t=([a-f0-9]{64})/.exec(sent[0].text)?.[1];
    expect(token).toBeTruthy();
    expect(sent[0].text).toContain("/ar/app/reset#t=");
    expect(await db.get(globalKey.passwordReset(createHash("sha256").update(token!).digest("hex")))).toEqual({ email: u.email, kind: "owner" });
  });

  pOnly("a member without a password gets a member link at the member's address", async () => {
    mailOn();
    const owner = await newUser("nopwown");
    const m = await newMember(owner, "member");
    await withoutPassword(m.email, m.pid);
    await signIn(m.email);
    const r = await sendLink();
    expect(r.status).toBe(200);
    expect(sent.map((x) => x.to)).toEqual([m.email]);
    const token = /#t=([a-f0-9]{64})/.exec(sent[0].text)![1];
    expect(await db.get(globalKey.passwordReset(createHash("sha256").update(token).digest("hex")))).toEqual({ email: m.email, kind: "member" });
  });

  pOnly("shares the forgot route's per-address bucket: the fourth link in 15 minutes is slow_down", async () => {
    mailOn();
    const u = await newUser("nopwslow");
    await withoutPassword(u.email, ownerOf(u));
    await signIn(u.email);
    for (let i = 0; i < 3; i++) expect((await sendLink()).status).toBe(200);
    const r = await sendLink();
    expect(r.status).toBe(429);
    expect((await r.json()).error).toBe("slow_down");
    expect(sent).toHaveLength(3);
  });

  pOnly("without mail delivery it says so and sends nothing", async () => {
    const u = await newUser("nopwoff");
    await withoutPassword(u.email, ownerOf(u));
    await signIn(u.email);
    expect(await (await sendLink()).json()).toEqual({ ok: true, mail: false, sent: false });
    expect(sent).toHaveLength(0);
  });

  it("a founder viewing the account is refused", async () => {
    mailOn();
    vi.stubEnv("ADMIN_EMAILS", "founder-3101@test.example");
    const u = await newUser("nopwimp");
    await signIn(u.email, { imp: "founder-3101@test.example" });
    expect((await sendLink()).status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("the forgot route and the card share one writer and one bucket", () => {
    const forgot = readFileSync("src/app/api/auth/forgot/route.ts", "utf8");
    const card = readFileSync("src/app/api/account/password-link/route.ts", "utf8");
    for (const src of [forgot, card]) {
      expect(src).toMatch(/mailResetLink\(/);
      expect(src).toMatch(/globalKey\.resetLinkBucket\(/);
    }
    expect(card).toMatch(/mailResetLink\(me\.email, lang\)/);
    expect(card).not.toMatch(/b\.email|body\.email/);
  });
});

describe("rule 3102: Security settings offers Set a password to a login without one", () => {
  it("the page reads hasPassword on the server and the card replaces the change form", () => {
    const page = readFileSync("src/app/[lang]/app/settings/security/page.tsx", "utf8");
    expect(page).toMatch(/actingLogin\(u\)/);
    expect(page).toMatch(/password=\{\{ has: me\?\.hasPassword \?\? true/);
    const settings = readFileSync("src/components/app/settings/SecuritySettings.tsx", "utf8");
    expect(settings).toMatch(/!password\.has \? <SetPasswordCard/);
    const card = readFileSync("src/components/app/settings/SetPasswordCard.tsx", "utf8");
    expect(card).toMatch(/postJson\("\/api\/account\/password-link", \{ lang \}\)/);
    expect(card).toContain("عيّن كلمة مرور");
    expect(card).toContain("Set a password");
    expect(card).toMatch(/<bdi dir="ltr"/);
  });
});

describe("rule 3107: a reply-to is one plain address or nothing", () => {
  it("accepts a plain address", () => {
    for (const a of ["hello@thakeen.com", "a.b+c@sub.example.co"]) expect(plainAddress(a), a).toBe(true);
  });
  it("refuses header injection, lists and display names", () => {
    for (const a of ["a@b.com\r\nBcc: x@y.com", "a@b.com\nX: y", "a@b.com, c@d.com", "a@b.com;c@d.com", "Name <a@b.com>", "\"q\"@b.com", "a b@c.com", "", "nodomain@", "@b.com", "a@b", `${"a".repeat(250)}@b.com`, 42, null, undefined])
      expect(plainAddress(a), JSON.stringify(a)).toBe(false);
  });
});

describe("rules 3106 and 3107: sendEmail passes a plain reply-to to the provider and drops anything else", () => {
  it("Resend receives replyTo", async () => {
    mailOn();
    const { sendEmail } = await import("@/lib/notify");
    expect(await sendEmail("to@test.example", "s", "t", undefined, { replyTo: SUPPORT_EMAIL })).toBe(true);
    expect(sent.at(-1)).toMatchObject({ to: "to@test.example", replyTo: SUPPORT_EMAIL });
  });

  it("an injected reply-to is dropped, the message still goes, and the value is not logged", async () => {
    mailOn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendEmail } = await import("@/lib/notify");
    expect(await sendEmail("to@test.example", "s", "t", undefined, { replyTo: "a@b.com\r\nBcc: spy@evil.example" })).toBe(true);
    expect(sent.at(-1)).not.toHaveProperty("replyTo");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("evil.example");
  });

  it("no reply-to: the message is as before", async () => {
    mailOn();
    const { sendEmail } = await import("@/lib/notify");
    await sendEmail("to@test.example", "s", "t");
    expect(sent.at(-1)).not.toHaveProperty("replyTo");
  });

  it("the console provider keeps the reply-to with the message", async () => {
    const { sendEmail } = await import("@/lib/notify");
    await sendEmail({ to: "dev@test.example", subject: "s", text: "t", template: "notice", context: { title: "T", paragraphs: ["p"], cta: { href: `${appOrigin()}/en/app`, label: "Go" } }, locale: "en", replyTo: SUPPORT_EMAIL });
    expect(consoleOutbox().at(-1)).toMatchObject({ to: "dev@test.example", replyTo: SUPPORT_EMAIL });
  });
});

describe("rule 3108: the email-change notice invites a reply, so the reply goes to support", () => {
  it("sends the notice with reply-to SUPPORT_EMAIL", () => {
    const src = readFileSync("src/lib/email-change.ts", "utf8");
    expect(src).toMatch(/sendEmail\(me\.email, m\.subject, m\.text, undefined, \{ replyTo: SUPPORT_EMAIL \}\)/);
    expect(SUPPORT_EMAIL).toBe("hello@thakeen.com");
  });
});

describe("rule 3109: a support ticket mailed to the founder replies to the customer", () => {
  it("reply-to is the address the customer typed", async () => {
    mailOn();
    vi.stubEnv("WAITLIST_TO", "founder-inbox@test.example");
    const r = await supportRoute.POST(json("/api/support", "POST", { email: "customer@test.example", message: "Help", type: "question" }, ip()));
    expect(r.status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ to: "founder-inbox@test.example", replyTo: "customer@test.example" });
  });

  it("a typed address that is not plain is dropped, and the ticket still arrives", async () => {
    mailOn();
    vi.stubEnv("WAITLIST_TO", "founder-inbox@test.example");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await supportRoute.POST(json("/api/support", "POST", { email: "c@test.example\r\nBcc: x@evil.example", message: "Help" }, ip()));
    expect(r.status).toBe(200);
    expect(sent.at(-1)?.to).toBe("founder-inbox@test.example");
    expect(sent.at(-1)).not.toHaveProperty("replyTo");
  });
});

describe("rule 3110: lifecycle notes that ask for a reply carry reply-to support", () => {
  it("day 2 and day 10 only", () => {
    expect([...REPLY_INVITED].sort()).toEqual(["day10", "day2"]);
    const u = { lang: "en" as const, id: "u-3110@test.example", email: "u-3110@test.example" };
    const tpl = { subject: "S", body: "B" };
    expect(lifecyclePart(u, "day2", tpl).replyTo).toBe(SUPPORT_EMAIL);
    expect(lifecyclePart(u, "day10", tpl).replyTo).toBe(SUPPORT_EMAIL);
    for (const k of ["day1", "day3"]) expect(lifecyclePart(u, k, tpl)).not.toHaveProperty("replyTo");
  });
});
