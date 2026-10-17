import { describe, expect, it } from "vitest";
import { randomBytes } from "crypto";
import { readFileSync } from "node:fs";
import { jar, json, newUser } from "./helpers/session";
import { getUser } from "@/lib/auth";
import { REFERRAL_CREDITS, REFERRAL_MONTHLY_CAP, applyReferral, codeFor, referralStats, registerCode, rewardReferrer } from "@/lib/referral";
import { recordPayment, voidPayment } from "@/lib/partners";
import { ksaDay } from "@/lib/partner-rules";
import { pmap } from "@/lib/parallel";
import * as signup from "@/app/api/auth/signup/route";

/**
 * The credits referral cannot be farmed with throwaway accounts (rules 556-559): the new account gets its bonus at
 * signup, the referrer only when the referred account's first payment is recorded, once, and at most
 * REFERRAL_MONTHLY_CAP times per Riyadh calendar month. Self-referral is still refused.
 */

const ip = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
const creditsOf = async (email: string) => (await getUser(email))!.credits;
const pay = (email: string, id?: string) => recordPayment(email, { amountSar: 299, plan: "pro", date: ksaDay(), ...(id ? { id } : {}) }, "founder@test.example");
const payId = () => `pay_${randomBytes(8).toString("hex")}`;

async function signupWith(ref?: string) {
  jar().clear();
  const email = `refd-${randomBytes(4).toString("hex")}@test.example`;
  const res = await signup.POST(json("/api/auth/signup", "POST", { email, password: "abc12345", name: "Friend", lang: "en", ...(ref ? { ref } : {}) }, { "x-forwarded-for": ip() }));
  return { res, email };
}
async function referrer() {
  const u = await newUser("referrer");
  await registerCode(u.email);
  return u.email;
}

describe("credits referral: no bonus for throwaway accounts (rules 556-559)", () => {
  it("556: a signup with a referral code pays the new account only; the referrer's bonus waits as pending", async () => {
    const ref = await referrer();
    const before = await creditsOf(ref);
    const plain = await signupWith();
    const { res, email } = await signupWith(codeFor(ref));
    expect(res.status).toBe(200);
    expect((await res.json()).referred).toBe(true);
    expect(await creditsOf(email)).toBe((await creditsOf(plain.email)) + REFERRAL_CREDITS);
    expect(await creditsOf(ref)).toBe(before);
    const s = await referralStats(ref);
    expect(s).toMatchObject({ count: 1, pending: 1, earned: 0 });
  });

  it("557: the first decision pays the referrer +50; every later one answers already", async () => {
    const ref = await referrer();
    const { email } = await signupWith(codeFor(ref));
    const before = await creditsOf(ref);
    const runs = await Promise.all([rewardReferrer(email), rewardReferrer(email), rewardReferrer(email)]);
    expect(runs.filter((r) => r === "paid")).toHaveLength(1);
    expect(runs.filter((r) => r === "already")).toHaveLength(2);
    expect(await creditsOf(ref)).toBe(before + REFERRAL_CREDITS);
  });

  it("557: paying through recordPayment, retried and concurrent, credits the referrer once", async () => {
    const ref = await referrer();
    const { email } = await signupWith(codeFor(ref));
    const before = await creditsOf(ref);
    const id = payId();
    // The same request twice at once, a second payment at once, then a retry.
    const results = await Promise.all([pay(email, id), pay(email, id), pay(email, payId())]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await creditsOf(ref)).toBe(before + REFERRAL_CREDITS);
    expect((await pay(email, id)).ok).toBe(true);
    expect(await creditsOf(ref)).toBe(before + REFERRAL_CREDITS);
    expect(await referralStats(ref)).toMatchObject({ pending: 0, earned: REFERRAL_CREDITS });
  });

  it("557: voiding the first payment and recording another never pays the referrer twice", async () => {
    const ref = await referrer();
    const { email } = await signupWith(codeFor(ref));
    const before = await creditsOf(ref);
    const first = await pay(email);
    expect(first.ok).toBe(true);
    expect(await creditsOf(ref)).toBe(before + REFERRAL_CREDITS);
    expect((await voidPayment(email, first.ok ? first.payment.id : "", "founder@test.example", "refund")).ok).toBe(true);
    expect((await pay(email)).ok).toBe(true);
    expect(await creditsOf(ref)).toBe(before + REFERRAL_CREDITS);
  });

  it("558: the 11th paid referral of a Riyadh month pays the referrer nothing", async () => {
    const ref = await referrer();
    const friends = await pmap(Array.from({ length: REFERRAL_MONTHLY_CAP + 1 }, (_, i) => i), async () => {
      const f = await newUser("friend");
      expect(await applyReferral(f.email, codeFor(ref))).toBe(true);
      return f.email;
    });
    const before = await creditsOf(ref);
    await pmap(friends, (f) => pay(f));
    expect(await creditsOf(ref)).toBe(before + REFERRAL_MONTHLY_CAP * REFERRAL_CREDITS);
    const s = await referralStats(ref);
    expect(s).toMatchObject({ count: REFERRAL_MONTHLY_CAP + 1, pending: 0, earned: REFERRAL_MONTHLY_CAP * REFERRAL_CREDITS });
    // A later payment by the capped friend does not reopen it.
    await pay(friends[0]);
    await pay(friends[friends.length - 1]);
    expect(await creditsOf(ref)).toBe(before + REFERRAL_MONTHLY_CAP * REFERRAL_CREDITS);
  });

  it("559: self-referral is still refused and pays nobody", async () => {
    const ref = await referrer();
    const before = await creditsOf(ref);
    expect(await applyReferral(ref, codeFor(ref))).toBe(false);
    expect(await rewardReferrer(ref)).toBe("none");
    expect((await pay(ref)).ok).toBe(true);
    expect(await creditsOf(ref)).toBe(before);
  });

  it("559: the copy says the referrer's bonus comes at the friend's first payment, never at signup", () => {
    // The dictionary was split into parts (rule 2010); the copy is checked across all of them, as before.
    const i18n = ["app-i18n", "app-i18n-shell", "app-i18n-workspace", "app-i18n-pages", "app-i18n-todo", "app-i18n-team"].map((f) => readFileSync(`src/lib/${f}.ts`, "utf8")).join("\n");
    const help = readFileSync("src/lib/help.ts", "utf8");
    expect(i18n).not.toContain("أنت وصديقك تحصلان");
    expect(i18n).not.toContain("You and your friend each get");
    expect(help).not.toContain("50 لك و50 لصديقك عند تسجيله");
    expect(help).not.toContain("50 for you and 50 for your friend when they sign up");
    expect(i18n).toContain(`وتحصل أنت على ${REFERRAL_CREDITS} كريدت عند أول دفعة له (حتى ${REFERRAL_MONTHLY_CAP} مكافآت في الشهر)`);
    expect(help).toContain(`و${REFERRAL_CREDITS} لك عند أول دفعة له (حتى ${REFERRAL_MONTHLY_CAP} مكافآت في الشهر)`);
    expect(i18n).toContain(`you get ${REFERRAL_CREDITS} credits when they make their first payment (up to ${REFERRAL_MONTHLY_CAP} bonuses a month)`);
    expect(help).toContain(`${REFERRAL_CREDITS} for you when they make their first payment (up to ${REFERRAL_MONTHLY_CAP} bonuses a month)`);
  });
});

describe("account deletion (rules 556-559)", () => {
  it("deleting a referrer removes the pending, claimed and monthly referral keys", async () => {
    const { wipeAccount } = await import("@/lib/account");
    const { referralKeys } = await import("@/lib/referral");
    const ref = await newUser("refwipe");
    await registerCode(ref.email);
    const friend = await newUser("friendwipe");
    await applyReferral(friend.email, codeFor(ref.email));
    await rewardReferrer(friend.email);
    const { db } = await import("@/lib/db");
    const [pending, paid, month] = referralKeys(ref.email);
    const state = () => Promise.all([db.hgetall(pending), db.smembers(paid), db.get(month)]);
    const before = await state();
    expect(Object.keys(before[0])).toHaveLength(1);
    expect(before[1]).toHaveLength(1);
    expect(Number(before[2])).toBe(1);
    await wipeAccount(ref.email);
    const after = await state();
    expect([Object.keys(after[0] ?? {}).length, after[1].length, after[2] ?? null]).toEqual([0, 0, null]);
  });
});
