import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { newMember, newUser, signIn, signOut } from "./helpers/session";
import { currentUser, getUser, saveUser, acct } from "@/lib/auth";
import { db } from "@/lib/db";
import { wipeAccount } from "@/lib/account";
import { cardKey, stopRenewals } from "@/lib/billing";
import type { Billing } from "@/lib/billing-state";
import { devicesKey } from "@/lib/devices";
import { mfaKeys } from "@/lib/mfa";
import { linkKey, subKey } from "@/lib/google-signin";
import { withUserLock } from "@/lib/credits";
import { saveBrands, scopeFor } from "@/lib/brands";
import { profileKey } from "@/lib/notify-prefs";

/** Account deletion and the account-security pack (rules 1954-1956, docs/system/tests/1930-account-security.md). */
const read = (f: string) => readFileSync(f, "utf8");
const billing = (autoRenew: boolean): Billing => ({ provider: "paymob", plan: "pro", status: "active", paidThrough: "2026-11-01", anchor: 1, autoRenew, failures: 0, txns: [] } as Billing);
afterEach(() => signOut());

/** Every per-login key the pack writes, for one login. */
const packKeys = (l: string, sub: string) => [...mfaKeys(l), `emailchange:${l}`, `emailchange:tries:${l}`, subKey(l), linkKey(sub), devicesKey(l)];
async function seed(l: string, sub: string) {
  await Promise.all([
    db.set(mfaKeys(l)[0], { enc: "x", kid: "k", rc: [], at: new Date().toISOString() }),
    db.set(mfaKeys(l)[1], { enc: "y" }),
    db.set(`emailchange:${l}`, { to: "x@test.example", hash: "h", at: Date.now() }),
    db.set(`emailchange:tries:${l}`, 2),
    db.set(subKey(l), sub),
    db.set(linkKey(sub), l),
    db.hset(devicesKey(l), "d1", { k: "session:h:x", ua: "x", ip: "1.2.3.4", at: Date.now() }),
  ]);
}

describe("rule 1954: deleting an account removes the two-step, address-change, Google and device records of every login", () => {
  it("owner and member keys are gone and neither session opens anything", async () => {
    // No shadow memberships: the owner and the member hold nothing else. The owner goes with the account (reconciliation 7).
    // With `MULTI_ORG` on the member's person and login outlive their last membership (rule 2126, tests/multi-org-lifecycle.test.ts:
    // `forgetPersonIfAlone` does nothing), so the member's own records stay and its session opens no workspace; the person's
    // deletion is the M3 flow, not the account's.
    const owner = await newUser("wipe", { shadow: false });
    const m = await newMember(owner, "member", "m", { shadow: false });
    await Promise.all([seed(owner.email, "gOwnerSub1"), seed(m.email, "gMemberSub1")]);
    await signIn(m.email);
    expect(await currentUser()).not.toBeNull();
    await wipeAccount(acct(owner));
    const left = await db.mget<unknown>(packKeys(owner.email, "gOwnerSub1"));
    expect(left.filter((v) => v !== null && v !== undefined)).toEqual([]);
    const kept = await db.mget<unknown>(packKeys(m.email, "gMemberSub1"));
    expect(kept.filter((v) => v !== null && v !== undefined).length, "the member's person keeps its own login records").toBeGreaterThan(0);
    expect(await currentUser()).toBeNull();
    expect(await getUser(acct(owner))).toBeNull();
  });

  it("every brand's notification choices go, not only the default brand's", async () => {
    const owner = await newUser("wipe");
    await saveBrands(acct(owner), [{ id: "default", name: "", createdAt: new Date().toISOString(), status: "active" }, { id: "b2wipe", name: "Second", createdAt: new Date().toISOString(), status: "active" }]);
    const added = scopeFor(acct(owner), "b2wipe");
    await Promise.all([db.set(profileKey(acct(owner)), { email: true }), db.set(profileKey(added), { email: false })]);
    await wipeAccount(acct(owner));
    expect(await db.mget<unknown>([profileKey(acct(owner)), profileKey(added)])).toEqual([null, null]);
  });

  it("a stored Google id that is not a plain id is never turned into a key", () => {
    const src = read("src/lib/account.ts");
    expect(src).toMatch(/\/\^\[A-Za-z0-9_-\]\{1,255\}\$\/\.test/);
  });
});

describe("rule 1955: deletion first turns renewal off and drops the saved card, under the account lock", () => {
  it("stopRenewals turns autoRenew off and deletes the card", async () => {
    const u = await newUser("wipe");
    await saveUser({ ...(await getUser(acct(u)))!, billing: billing(true) });
    await db.set(cardKey(acct(u)), { token: "tok_test", brand: "visa", last4: "4242" });
    await stopRenewals(acct(u));
    expect((await getUser(acct(u)))!.billing!.autoRenew).toBe(false);
    expect(await db.get(cardKey(acct(u)))).toBeNull();
  });

  it("a card left behind by an account record already gone is still deleted", async () => {
    const email = "gone-wipe@test.example";
    await db.set(cardKey(email), { token: "tok_test" });
    await stopRenewals(email);
    expect(await db.get(cardKey(email))).toBeNull();
  });

  it("a caller already inside the account lock (the address move) drops the card without waiting on the lock again", async () => {
    const u = await newUser("wipe");
    await db.set(cardKey(acct(u)), { token: "tok_test" });
    await withUserLock(acct(u), async () => { await stopRenewals(acct(u), { userLocked: true }); });
    expect(await db.get(cardKey(acct(u)))).toBeNull();
    expect(read("src/lib/verify-email.ts")).toContain("await wipeAccount(id, { userLocked: true, loginLocked: true, teamLocked: true, ...(pk === \"skipped\" ? { keepPasskeys: true } : {}) });");
  });

  it("wipeAccount calls it before anything else of the account is touched", async () => {
    const src = read("src/lib/account.ts");
    const body = src.slice(src.indexOf("export async function wipeAccount"));
    expect(body.indexOf("await stopRenewals(e, opts);")).toBeGreaterThan(0);
    expect(body.indexOf("await stopRenewals(e, opts);")).toBeLessThan(body.indexOf("db.smembers(membersKey(e))"));
    const u = await newUser("wipe");
    await saveUser({ ...(await getUser(acct(u)))!, billing: billing(true) });
    await db.set(cardKey(acct(u)), { token: "tok_test" });
    await wipeAccount(acct(u));
    expect(await db.get(cardKey(acct(u)))).toBeNull();
  });
});

describe("rule 1956: a renewal that read the card before the deletion re-checks it under the account lock before charging", () => {
  it("chargeSavedCard charges only when the account, renewal and card are all still there", () => {
    const src = read("src/lib/billing.ts");
    const body = src.slice(src.indexOf("async function chargeSavedCard"));
    const check = body.indexOf("const still = await withUserLock(acct(u)");
    expect(check).toBeGreaterThan(0);
    expect(body).toMatch(/if \(!x\.billing \|\| !x\.billing\.autoRenew \|\| !\(await db\.get\(cardKeyOf\(p\.name, acct\(u\)\)\)\)\) return false;/);
    expect(body).toContain('throw new PaymentError(p.name, "renewal_off")');
    expect(check).toBeLessThan(body.indexOf("saved.charge(paymentKey, card.token, card.agreementId ?? null)"));
  });
});
