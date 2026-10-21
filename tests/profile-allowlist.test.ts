import { afterEach, describe, expect, it, vi } from "vitest";
import { newMember, newUser, signIn } from "./helpers/session";
import { getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import * as profileRoute from "@/app/api/profile/route";

/**
 * Rule 787: GET /api/profile builds the account record it sends from a list of allowed fields, never from the stored
 * record minus a list of removed ones. A remove-list sends every field added to `User` later (a founder's note, a billing
 * internal) until someone remembers to remove it, and a build from before that removal sends it again after a rollback
 * (`flows.md` 52, item 9). The keys below are written out on purpose: a new field reaches the profile only when this
 * test and the route's list both name it.
 */
afterEach(() => { vi.unstubAllEnvs(); });

/** What the owner (and a founder acting as the owner) gets in `user`: the fields the Profile page reads, plus the deal's terms (rule 243) and the packs' balances (rule 453). */
const OWNER_KEYS = ["createdAt", "credits", "deal", "email", "lang", "name", "phone", "plan", "renewedAt", "role", "topups", "trialEnds"];
/** A member's `user`: its own name, email, language and role, and the account summary every seat shares. */
const MEMBER_KEYS = ["createdAt", "credits", "email", "lang", "name", "plan", "renewedAt", "role", "topups", "trialEnds"];
/** Strings stored in fields the customer must never be sent. None may appear anywhere in the answer. */
const SECRETS = ["founder-fairuse@test.example", "founder-seat@test.example", "founder-lock@test.example", "founder-deal@test.example", "founder-grant@test.example", "SECRET-GRANT-NOTE", "SECRET-BANK-REF", "founder-topup@test.example", "SECRET-INTENT-REF", "SECRET-TXN", "partner-owner@test.example", "SECRET-PARTNER-REF", "pay_7870000000000000", "founder-hand@test.example"];

const DAY = 86400_000;
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const month = new Date().toISOString().slice(0, 7);

/**
 * An owner record with every persisted `User` field set. Typed `Required<...>` so a field added to `User` later fails
 * the type-check here until it is set, and this test then shows whether the profile sends it.
 */
async function fullAccount(): Promise<Required<Omit<User, "scope" | "brandId" | "actor" | "topupsDirty">>> {
  // No shadow membership, which sign-in would otherwise pick as the person's only live account. The owner follows
  // `TEST_PERSONS`; from M4 (rule 2138) the record must name its real owner, since no legacy resolver reads past it.
  const made = await newUser("allow", { shadow: false });
  const u = (await getUser(made.email))!;
  const full: Required<Omit<User, "scope" | "brandId" | "actor" | "topupsDirty">> = {
    // The account id (rule 1995): storage only, never a profile field.
    id: u.email,
    // The owning person (multi-workspace membership, rule 1995): storage only, never a profile field.
    ownerPid: u.ownerPid ?? u.email,
    // The name given at create (multi-workspace M2): the switcher reads it, the profile does not send it.
    workspaceName: "WORKSPACE-NAME",
    email: u.email,
    name: "Owner Name",
    phone: "+966500000787",
    // The legacy mirror of the person's hash (rule 2132): `saveUser` drops it from M4 (rule 2138); never a profile field.
    passHash: "$2b$10$profileallowlistfixturehashhhhhhhhhhhhhhhhhhhhhhhhhhhh",
    plan: "agency",
    credits: 1300,
    trialEnds: iso(-30),
    createdAt: u.createdAt,
    lang: "ar",
    renewedAt: month,
    suspended: false,
    sessionsAfter: u.sessionsAfter!,
    agentSpend: { month, by: { [u.email]: { noor: 12 } } },
    seats: 7,
    brandCap: 12,
    deal: { credits: 5000, priceSar: 3330, setAt: iso(-3), setBy: "founder-deal@test.example" },
    grants: { video: { value: "all", until: iso(10).slice(0, 10), by: "founder-grant@test.example", at: iso(-1), note: "SECRET-GRANT-NOTE" } },
    referredBy: { partner: "partner-owner@test.example", code: "PARTNER787", at: iso(-40), via: "code", ref: "SECRET-PARTNER-REF" },
    firstMonthOffer: { kind: "partner", pct: 15, at: iso(-40), usedAt: iso(-20), paymentId: "pay_7870000000000000" },
    firstPaidOn: iso(-20).slice(0, 10),
    partnerCode: "OWNCODE787",
    onboardPaid: { [`${u.email}#b2`]: { scope: `${u.email}#b2`, agent: "noor", month, credits: 9, at: iso(0) } },
    paidOnce: { [`weekly:${u.email}:2026-41`]: { scope: u.email, agent: "dana", month, credits: 3, at: iso(0) } },
    chatAllowance: 900,
    chatOverflow: true,
    chatCarryMicro: 4321,
    topups: [{ id: "a1b2c3d4e5f60787", credits: 300, left: 300, at: iso(-2), expiresAt: iso(88), paidSar: 287.5, paidOn: iso(-2).slice(0, 10), ref: "SECRET-BANK-REF", by: "founder-topup@test.example" }],
    billing: { provider: "paymob", plan: "business", status: "active", paidThrough: iso(10).slice(0, 10), anchor: 9, autoRenew: true, failures: 0, card: { brand: "visa", last4: "0787" }, pending: { ref: "SECRET-INTENT-REF", day: iso(0).slice(0, 10) }, txns: ["SECRET-TXN-1"] },
    teamSessionsAfter: iso(-1),
    devicesAfter: iso(-1),
    emailVerifiedAt: u.emailVerifiedAt!,
    gatedSignup: true,
    emailMoves: { day: iso(0).slice(0, 10), n: 1 },
    chinaHostingOk: true,
    // The signup consent record (rule 1325): not a profile field; the owner reads it in the data download.
    consent: { terms: "2026-10-02", privacy: "2026-10-12", at: iso(-40), lang: "ar", via: "signup_notice" },
    handPlan: { paidThrough: iso(20).slice(0, 10), by: "founder-hand@test.example", at: iso(-1) },
    // The founding seat and the price lock (rules 1700-1719): not profile fields; the owner reads them in the data download.
    founding: { at: iso(-20), by: "founder-seat@test.example", paymentId: "pay_7870000000000001" },
    priceLock: { plan: "business", baseHalalas: 99900, from: iso(-20).slice(0, 10), until: iso(340).slice(0, 10), months: 12, founding: true, at: iso(-20), by: "founder-lock@test.example", paidHalalas: 114885, paymentId: "pay_7870000000000001" },
    // The founder's fair-use lift (rule 1731): a founder field, never sent to the customer.
    fairUseLift: { month, at: iso(-1), by: "founder-fairuse@test.example" },
  };
  await saveUser(full);
  return full;
}

const read = async () => {
  const res = await profileRoute.GET();
  expect(res.status).toBe(200);
  const raw = await res.text();
  return { raw, body: JSON.parse(raw) as { user: Record<string, unknown> } };
};

describe("GET /api/profile sends only the account fields it names (rule 787)", () => {
  it("an owner record with every field set comes back with the allowed keys only", async () => {
    const full = await fullAccount();
    await signIn(full.email);
    const { raw, body } = await read();
    expect(Object.keys(body.user).sort()).toEqual(OWNER_KEYS);
    expect(body.user).toMatchObject({ name: "Owner Name", email: full.email, phone: "+966500000787", lang: "ar", plan: "agency", credits: 1300, renewedAt: month, role: "owner" });
    // The deal as its terms, the packs as their balances: never who set them or what was paid.
    expect(body.user.deal).toEqual({ credits: 5000, priceSar: 3330 });
    expect(body.user.topups).toEqual([{ credits: 300, left: 300, expiresAt: full.topups[0].expiresAt }]);
    for (const s of [...SECRETS, full.passHash]) expect(raw, s).not.toContain(s);
    if (full.ownerPid.startsWith("p_")) expect(raw).not.toContain(full.ownerPid);
  });

  it("a founder acting as the owner gets the same keys; a member gets its own and the summary", async () => {
    const full = await fullAccount();
    vi.stubEnv("ADMIN_EMAILS", "founder-allow@test.example");
    await signIn(full.email, { imp: "founder-allow@test.example" });
    const founder = await read();
    expect(Object.keys(founder.body.user).sort()).toEqual(OWNER_KEYS);
    for (const s of [...SECRETS, full.passHash]) expect(founder.raw, s).not.toContain(s);

    const m = await newMember(full);
    await signIn(m.email);
    const member = await read();
    expect(Object.keys(member.body.user).sort()).toEqual(MEMBER_KEYS);
    expect(member.body.user).toMatchObject({ email: m.email, role: "member" });
    for (const s of [...SECRETS, full.passHash, "+966500000787"]) expect(member.raw, s).not.toContain(s);
  });

  it("a field the route does not know, added to the stored record, is not sent", async () => {
    const full = await fullAccount();
    // As a later release (or a hand edit) would leave it: a new field on `user:{email}` that this build has never heard of.
    await db.set(`user:${full.email}`, { ...(await db.get<Record<string, unknown>>(`user:${full.email}`)), founderMemo: "SECRET-UNKNOWN-FIELD", riskScore: 87 });
    await signIn(full.email);
    const { raw, body } = await read();
    expect(Object.keys(body.user).sort()).toEqual(OWNER_KEYS);
    expect(raw).not.toContain("founderMemo");
    expect(raw).not.toContain("SECRET-UNKNOWN-FIELD");
    expect(raw).not.toContain("riskScore");
  });
});
