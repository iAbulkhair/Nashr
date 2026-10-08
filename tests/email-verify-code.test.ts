// Rules 757-758 in docs/system/tests.md: the emailed code is stored only as a hash, expires, and dies after five wrong tries.
import { describe, expect, it } from "vitest";
import { newUser, markVerified as stampVerified } from "./helpers/session";
import { db } from "@/lib/db";
import { getUser } from "@/lib/auth";
import { VERIFY, checkVerifyCode, hasPendingCode, issueVerifyCode, markVerified, normalizeCode, verifyMail } from "@/lib/verify-email";

const email = () => `code-${Math.random().toString(36).slice(2, 10)}@test.example`;
/** Some six digits that are not `code`. */
const other = (code: string) => (code === "000000" ? "000001" : "000000");
const arabicIndic = (s: string) => s.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));

describe("verification code store", () => {
  it("code is 6 digits and stored only as a hash (rule 757)", async () => {
    const e = email();
    const code = await issueVerifyCode(e);
    expect(code).toMatch(/^\d{6}$/);
    const raw = await db.get(`verify:code:${e}`);
    expect(JSON.stringify(raw)).not.toContain(code);
    expect(raw).toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{64}$/), sentAt: expect.any(Number) });
    expect(VERIFY.ttl).toBe(900);
  });

  it("right code passes once, markVerified consumes it", async () => {
    const owner = await newUser("vc", { verified: false });
    const code = await issueVerifyCode(owner.email);
    expect(await hasPendingCode(owner.email)).toBe(true);
    expect(await checkVerifyCode(owner.email, code)).toEqual({ ok: true });
    await markVerified(owner.email);
    expect(await hasPendingCode(owner.email)).toBe(false);
    expect(await checkVerifyCode(owner.email, code)).toEqual({ ok: false, reason: "expired" });
    expect((await getUser(owner.email))!.emailVerifiedAt).toBeTruthy();
  });

  it("markVerified keeps an existing emailVerifiedAt", async () => {
    const owner = await newUser("vk", { verified: false });
    const first = (await stampVerified(owner.email)).emailVerifiedAt;
    await new Promise((r) => setTimeout(r, 5));
    await markVerified(owner.email);
    expect((await getUser(owner.email))!.emailVerifiedAt).toBe(first);
  });

  it("Arabic-Indic digits and spaces are accepted", async () => {
    const e = email();
    const code = await issueVerifyCode(e);
    const typed = `${arabicIndic(code.slice(0, 3))} ${arabicIndic(code.slice(3))}`;
    expect(await checkVerifyCode(e, typed)).toEqual({ ok: true });
    expect(normalizeCode("١٢٣ ٤٥٦")).toBe("123456");
    expect(normalizeCode("۱۲۳-۴۵۶")).toBe("123456");
    expect(normalizeCode(" 12 3a456 ")).toBe("123456");
  });

  it("five wrong attempts kill the code (rule 758)", async () => {
    const e = email();
    const code = await issueVerifyCode(e);
    const bad = other(code);
    for (const left of [4, 3, 2, 1]) expect(await checkVerifyCode(e, bad)).toEqual({ ok: false, reason: "wrong", attemptsLeft: left });
    expect(await checkVerifyCode(e, bad)).toEqual({ ok: false, reason: "locked" });
    expect(await hasPendingCode(e)).toBe(false);
    expect(await checkVerifyCode(e, code)).toEqual({ ok: false, reason: "expired" });
  });

  it("parallel guesses cannot exceed five tries (rule 758)", async () => {
    const e = email();
    const code = await issueVerifyCode(e);
    const bad = other(code);
    const res = await Promise.all(Array.from({ length: 12 }, () => checkVerifyCode(e, bad)));
    expect(res.filter((r) => !r.ok && r.reason === "wrong")).toHaveLength(4);
    expect(res.every((r) => !r.ok)).toBe(true);
    expect(await checkVerifyCode(e, code)).toEqual({ ok: false, reason: "expired" });
  });

  it("a new code replaces the old one and resets the attempts", async () => {
    const e = email();
    const first = await issueVerifyCode(e);
    await checkVerifyCode(e, other(first));
    await checkVerifyCode(e, other(first));
    let second = await issueVerifyCode(e);
    while (second === first) second = await issueVerifyCode(e);
    expect(await checkVerifyCode(e, first)).toEqual({ ok: false, reason: "wrong", attemptsLeft: 4 });
    expect(await checkVerifyCode(e, second)).toEqual({ ok: true });
  });

  it("expired after the TTL", async () => {
    const e = email();
    const code = await issueVerifyCode(e);
    await db.del(`verify:code:${e}`);
    expect(await hasPendingCode(e)).toBe(false);
    expect(await checkVerifyCode(e, code)).toEqual({ ok: false, reason: "expired" });
  });

  it("mail copy names the code, the product and the 15 minutes", () => {
    const ar = verifyMail({ lang: "ar" }, "123456");
    expect(ar.subject).toBe("رمز التحقق في ذكين: 123456");
    expect(ar.text).toBe("رمز التحقق: 123456\nصالح لمدة 15 دقيقة.\nإذا لم تطلب هذا الرمز، تجاهل هذه الرسالة.");
    const en = verifyMail({ lang: "en" }, "123456");
    expect(en.subject).toBe("Your Thakeen code: 123456");
    expect(en.text).toBe("Your verification code: 123456\nIt works for 15 minutes.\nIf you did not ask for it, ignore this email.");
  });
});
