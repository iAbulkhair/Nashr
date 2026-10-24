import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "./db";
import { getUser, normalizeEmail, normalizePhone, saveUser, trialOver, type User } from "./auth";
import { monthKey, withUserLock } from "./credits";
import { setMonthly } from "./topups";
import { MAX_SEAT_OVERRIDE, PLAN_PRICE_SAR, SELF_SERVE_PLANS, allowanceOf, extraSeatsLine, firstMonthPriceSar, isTopupPack, topupPriceSar, topupsSold, vatHalalasOf, type SelfServePlan } from "./pricing";
import { ksaDay } from "./partner-rules";
import { addPaidTopup, openOffer, paymentsKey, unusedOffer, recordPayment, voidPaidTopup, voidPayment, type Payment } from "./partners";
import { enforceSeats, isTeamLockTimeout, settleExtraSeats } from "./team";
import { appOrigin } from "./origin";
import { invoiceForPayment } from "./invoice";
import { GRACE_DAYS, addDays, addMonths, billingLocked, intentOutdatesOwner, paymobRenewalDue, type Billing } from "./billing-state";
import { PaymentDeclined, PaymentError, paymentProvider, type CardTokenEvent, type PaymentProvider, type PaymentTxn, type ProviderName } from "./payments";
import { adminAudit } from "./admin-audit";
import { claimOnPayment, endOnRefund, foundingOfferOpen, freePlaces, lockedBaseHalalas, type ClaimOutcome } from "./founding";
import { log as logger } from "./log";
import { acct } from "./account-id";
import { accountKey, globalKey } from "./keys";
import { allow } from "./rate";
import { pmap } from "./parallel";
import { handPlanEnded } from "./hand-plan";
import { appHrefFor } from "@/lib/ws-href";

/**
 * Online billing through Paymob KSA (spec docs/superpowers/specs/2026-10-08-paymob-billing-design.md, rules 700-729) or
 * Geidea KSA (spec docs/superpowers/specs/2026-10-18-geidea-payment-provider-design.md, rules 3900-3917): checkout, the
 * callbacks, saved-card renewals with grace and lock, the owner's renewal settings and the founder's refund. Everything
 * is off unless `paymentProvider()` answers (src/lib/payments, rule 2050: every processor call goes through that type).
 * Paymob's stored keys and shapes stay `paymob:*` with numeric ids; Geidea's are new `pay:*` families (src/lib/keys.ts)
 * with UUID references and order ids, so the id's type picks the family and no Paymob key changes bytes. Amounts always
 * come from src/lib/pricing.ts, never from a request; the account always comes from the session or from our own intent
 * record, never from a callback's payload.
 */

/** VAT is added on top of the ex-VAT prices (`VAT_RATE`). False until Thakeen is VAT-registered, if it is not (spec open question 5). */
export const PAYMOB_CHARGES_VAT = true;

const DAYS_400 = 400 * 86400;
const REF = /^pmi_[a-f0-9]{24}$/;
/** A Geidea checkout reference: a UUID v4 from `randomUUID` (rule 3906). */
const GREF = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The provider whose checkout a reference is: Paymob's `pmi_…`, Geidea's UUID. Null for anything else. */
const refProvider = (ref: unknown): ProviderName | null => (typeof ref !== "string" ? null : REF.test(ref) ? "paymob" : GREF.test(ref) ? "geidea" : null);
/** A provider's transaction id: a number at Paymob, an order UUID at Geidea. The type picks the key family. */
type TxnId = number | string;
const intentKey = (ref: string) => (GREF.test(ref) ? globalKey.payIntent(ref) : `paymob:intent:${ref}`);
const orderKey = (orderId: number) => `paymob:order:${orderId}`;
const txnKey = (txnId: TxnId) => (typeof txnId === "string" ? globalKey.payTxn("geidea", txnId) : `paymob:txn:${txnId}`);
const doneKey = (txnId: TxnId) => (typeof txnId === "string" ? globalKey.payDone("geidea", txnId) : `paymob:done:${txnId}`);
const txLockKey = (txnId: TxnId) => (typeof txnId === "string" ? globalKey.payTxLock("geidea", txnId) : `paymob:txlock:${txnId}`);
const refundedKey = (txnId: TxnId) => (typeof txnId === "string" ? globalKey.payRefunded("geidea", txnId) : `paymob:refunded:${txnId}`);
const refundLockKey = (txnId: TxnId) => (typeof txnId === "string" ? globalKey.payRefundLock("geidea", txnId) : `paymob:refundlock:${txnId}`);
/**
 * What a refund of this transaction did to the plan (`endPlanOnRefund`): the payment id when it ended the plan (a retry
 * still answers `planEnded: true`), or `"none"` when it found no plan to end (a later repeat never ends one and answers
 * false). Either value means this transaction never ends a plan again.
 */
const refundEndedKey = (txnId: TxnId) => (typeof txnId === "string" ? globalKey.payRefundEnded("geidea", txnId) : globalKey.paymobRefundEnded(txnId));
const attemptKey = (p: ProviderName, email: string, day: string) => (p === "geidea" ? accountKey.payAttempt(email, day) : `paymob:attempt:${email}:${day}`);
export const cardKey = (email: string) => `paymob:card:${email}`;
/** The saved card of the provider that saved it: Paymob's under `paymob:card:`, Geidea's (with its agreement) under `pay:card:`. */
const cardKeyOf = (p: ProviderName, email: string) => (p === "geidea" ? accountKey.payCard(email) : cardKey(email));
/** Both providers' saved cards go together: leaving, removing the card and a refund that ends the plan (rules 1955, 2270, 3914). */
const delCards = (email: string) => Promise.all([db.del(cardKey(email)), db.del(accountKey.payCard(email))]);
/**
 * The account's latest checkout ref (rule 1155), so the return page asks "how did my payment go?" with the session's
 * account alone and never a ref from the request. A new key only (expand): code without it never reads or misses it.
 */
export const lastCheckoutKey = (email: string) => `paymob:last:${email}`;
const lastKeyOf = (p: ProviderName, email: string) => (p === "geidea" ? accountKey.payLast(email) : lastCheckoutKey(email));
const LAST_TTL = 86400;
/** Keys that belong to one account and leave with it (src/lib/account.ts `wipeAccount`), Geidea's included (rule 3914). */
export const paymobAccountKeys = (email: string) => [cardKey(email), lastCheckoutKey(email), accountKey.payCard(email), accountKey.payLast(email)];

export type IntentKind = "plan" | "topup" | "renewal";
/** What we asked Paymob to charge, stored before the call. The only source of the account and the amount for a callback. */
export type PayIntent = {
  ref: string;
  /** The account at the time of writing; read through `intentAccount` (an intent from before R1 has only this). */
  email: string;
  /**
   * The account id (`acct(u)`, rule 1991): what the payment applies to, unchanged by a later address move. Optional
   * (expand, R1): an intent without it applies to `email`, and older builds ignore it.
   */
  acct?: string;
  /** The address sent to the provider as the billing email; the card callback matches it (rule 1991). Optional (expand). */
  billingEmail?: string;
  kind: IntentKind;
  plan?: SelfServePlan;
  credits?: number;
  baseHalalas: number;
  vatHalalas: number;
  amountCents: number;
  currency: "SAR";
  /** The 15% first-month price was used (a plan's first payment only). */
  offer: boolean;
  /**
   * The checkout asked for the founding offer and it was open then (rule 1702; src/lib/founding.ts `foundingOfferOpen`).
   * The seat itself is claimed only when the payment is applied. Optional (expand): intents without it are ordinary.
   */
  founding?: boolean;
  /** A renewal charged at the account's price lock (rule 1706): the ex-VAT halalas used instead of the list price. */
  lockedBaseHalalas?: number;
  /**
   * Paid extra seats charged with this renewal (rule 3372), at EXTRA_SEAT_MONTHLY_SAR each, VAT on the sum. Optional
   * (expand): an intent without it reads as 0 seats, so its amount check is the plan alone, as before.
   */
  extraSeats?: number;
  createdAt: string;
  by: string;
  orderId?: number | string;
  status: "open" | "paid" | "failed" | "mismatch";
  txnId?: TxnId;
  /** The provider that wrote it. Written by Geidea checkouts only (expand, rule 3906): an intent without it is Paymob's. */
  provider?: ProviderName;
  /** Geidea: the card-on-file agreement a plan checkout creates, or the one a renewal charges under (rules 3906, 3910). */
  agreementId?: string;
};
/** A saved card. The token never leaves this record: no page, API answer or log reads it. */
export type SavedCard = {
  token: string; last4: string; brand: string; expMonth: string; expYear: string; savedAt: string; orderId: number | string;
  /** Geidea: the agreement the card was saved under; a renewal charges under it (rule 3910). Absent on a Paymob card. */
  agreementId?: string | null;
  provider?: ProviderName;
};
type TxnRecord = { ref: string; email: string; acct?: string; kind: IntentKind; amountCents: number; paymentId: string; provider?: ProviderName };
/** The account an intent pays for: its `acct`, or `email` on an intent written before R1. */
const intentAccount = (i: Pick<PayIntent, "acct" | "email">): string => i.acct ?? i.email;
/** The billing address the provider was given: `billingEmail`, or `email` on an intent written before R1. */
const intentBillingEmail = (i: Pick<PayIntent, "billingEmail" | "email">): string => i.billingEmail ?? i.email;

/** VAT through the one formula in pricing.ts (`vatHalalasOf`, rule 3364), while Paymob charges it. */
const vatOf = (baseHalalas: number) => (PAYMOB_CHARGES_VAT ? vatHalalasOf(baseHalalas) : 0);
/** A stored or passed seat count, read safely: a whole number from 1 to MAX_SEAT_OVERRIDE, else 0 (rule 3372). */
const seatsOf = (n: unknown): number => (Number.isSafeInteger(n) && (n as number) >= 1 ? Math.min(n as number, MAX_SEAT_OVERRIDE) : 0);
const isSelfServe = (v: unknown): v is SelfServePlan => typeof v === "string" && (SELF_SERVE_PLANS as readonly string[]).includes(v);

/**
 * The price of a plan month, a renewal or a pack, from the pricing table only. Null for anything not on sale online. A
 * renewal under a price lock passes the locked ex-VAT halalas (rule 1706): the lower of it and the list price is charged.
 * A renewal also charges its paid extra seats (`item.extraSeats`, rule 3372): seats × EXTRA_SEAT_MONTHLY_SAR on top of
 * the plan (the lock never applies to seats), VAT on the sum. A plan checkout or a pack never carries seats.
 */
export function priceFor(kind: IntentKind, item: { plan?: unknown; credits?: unknown; extraSeats?: unknown }, offer = false, lockedBaseHalalas?: number): { baseHalalas: number; vatHalalas: number; amountCents: number } | null {
  let sar: number;
  if (kind === "topup") {
    if (!isTopupPack(item.credits)) return null;
    sar = topupPriceSar(item.credits);
  } else {
    if (!isSelfServe(item.plan)) return null;
    sar = offer && kind === "plan" ? firstMonthPriceSar(item.plan) : PLAN_PRICE_SAR[item.plan];
  }
  const list = Math.round(sar * 100);
  const locked = kind === "renewal" && Number.isSafeInteger(lockedBaseHalalas) && lockedBaseHalalas! > 0 ? lockedBaseHalalas! : null;
  const seats = kind === "renewal" ? extraSeatsLine(seatsOf(item.extraSeats)).baseHalalas : 0;
  const baseHalalas = (locked === null ? list : Math.min(locked, list)) + seats;
  const vatHalalas = vatOf(baseHalalas);
  return { baseHalalas, vatHalalas, amountCents: baseHalalas + vatHalalas };
}

/**
 * The payment id recorded for a provider transaction: the same on every retry, so `recordPayment` records it once. A
 * Paymob id hashes exactly as before (`paymob:{id}`), so its payment ids do not change (rule 3915).
 */
export const paymentIdFor = (txnId: TxnId, provider: ProviderName = "paymob") => `pay_${createHash("sha256").update(`${provider}:${txnId}`).digest("hex").slice(0, 24)}`;
const newRef = () => `pmi_${randomBytes(12).toString("hex")}`;
const log = (email: string, what: string, actor: ProviderName = "paymob") => adminAudit({ actor, section: "billing", target: email, what });
/** A Geidea reference leaves the reconciliation set once its checkout settles (rule 3909); a Paymob one was never in it. */
const unopen = (ref: string) => (refProvider(ref) === "geidea" ? db.zrem(globalKey.payOpen(), ref) : Promise.resolve());
const keepTxns = (txns: string[] | undefined, id: string) => [...(txns ?? []).filter((t) => t !== id), id].slice(-12);

function billingName(u: Pick<User, "name" | "email">): { firstName: string; lastName: string } {
  const parts = (u.name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().split(/\s+/).filter(Boolean);
  const first = (parts[0] ?? u.email.split("@")[0]).slice(0, 50);
  return { firstName: first, lastName: (parts.slice(1).join(" ") || "NA").slice(0, 50) };
}

export type CheckoutError = "not_enabled" | "bad_request" | "bad_plan" | "bad_pack" | "agency" | "topup_needs_paid_plan" | "need_phone" | "paymob_error" | "provider_error" | "not_found";

/**
 * Start a payment (spec 4.1): the owner's plan month or top-up pack. `owner` is the session's account (the caller checked
 * `billing.pay`). The intent is stored before Paymob is called; the answer is the unified checkout URL.
 */
export async function startCheckout(owner: Pick<User, "id" | "email">, body: unknown, lang: "ar" | "en"): Promise<{ ok: true; url: string; ref: string } | { ok: false; error: CheckoutError }> {
  const p = paymentProvider();
  if (!p) return { ok: false, error: "not_enabled" };
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!b || (b.kind !== "plan" && b.kind !== "topup")) return { ok: false, error: "bad_request" };
  const kind = b.kind;
  if (kind === "plan" && !isSelfServe(b.plan)) return { ok: false, error: "bad_plan" };
  if (kind === "topup" && !isTopupPack(b.credits)) return { ok: false, error: "bad_pack" };
  const acc = await getUser(acct(owner));
  if (!acc) return { ok: false, error: "not_found" };
  // Agency is sold by contract at its own price: no online checkout.
  if (acc.plan === "agency") return { ok: false, error: "agency" };
  if (kind === "topup" && (!topupsSold(acc.plan) || billingLocked(acc.billing))) return { ok: false, error: "topup_needs_paid_plan" };
  const geidea = p.name === "geidea";
  const phone = normalizePhone(acc.phone ?? "");
  // Paymob needs a mobile number; Geidea's hosted page asks none for a card payment (spec F4).
  if (!geidea && !/^\+\d{8,15}$/.test(phone)) return { ok: false, error: "need_phone" };
  const offer = kind === "plan" && !!openOffer(acc);
  // The founding offer (rule 1702): the body only asks; the sale, a free seat and an account that never paid online decide.
  const founding = kind === "plan" && b.founding === true && (await foundingOfferOpen(acc));
  const item = kind === "plan" ? { plan: b.plan } : { credits: b.credits };
  const price = priceFor(kind, item, offer)!;
  const ref = geidea ? randomUUID() : newRef();
  // A Geidea plan saves the card under our own agreement id, the one every renewal charges under (rule 3906); a pack saves none.
  const agreementId = geidea && kind === "plan" ? randomUUID() : undefined;
  const intent: PayIntent = {
    ref, email: acct(acc), acct: acct(acc), billingEmail: acc.email, kind, ...(kind === "plan" ? { plan: b.plan as SelfServePlan } : { credits: b.credits as number }),
    ...price, currency: "SAR", offer, ...(founding ? { founding: true } : {}), createdAt: new Date().toISOString(), by: acc.email, status: "open",
    ...(geidea ? { provider: "geidea" as const, ...(agreementId ? { agreementId } : {}) } : {}),
  };
  await Promise.all([
    db.set(intentKey(ref), intent, DAYS_400), db.set(lastKeyOf(p.name, acct(acc)), ref, LAST_TTL),
    ...(geidea ? [db.zadd(globalKey.payOpen(), Date.now(), ref)] : []),
  ]);
  const label = kind === "plan" ? `Thakeen ${intent.plan} plan, 1 month` : `Thakeen ${intent.credits} credits top-up`;
  try {
    const it = await p.createCheckout({
      amountCents: price.amountCents,
      item: { name: label, description: `${label}${price.vatHalalas ? " (incl. VAT)" : ""}` },
      billing: { ...billingName(acc), email: acc.email, phone: geidea ? "" : phone },
      reference: ref,
      notificationUrl: `${appOrigin()}/api/billing/${p.name}/webhook`,
      redirectionUrl: `${appOrigin()}${appHrefFor(acc, lang, geidea ? "/billing?pay=return" : "/billing?paymob=return")}`,
      expirationS: 3600,
      lang,
      ...(agreementId ? { agreementId } : {}),
    });
    // Geidea answers no order before the payment (the order id arrives with the callback); Paymob's order points back here.
    if (typeof it.orderId === "number") await Promise.all([db.set(intentKey(ref), { ...intent, orderId: it.orderId }, DAYS_400), db.set(orderKey(it.orderId), ref, DAYS_400)]);
    return { ok: true, url: it.url, ref };
  } catch (e) {
    await Promise.all([db.set(intentKey(ref), { ...intent, status: "failed" }, DAYS_400), unopen(ref)]);
    logger.error(`${p.name} checkout`, { error: e instanceof PaymentError ? e.message : "error" });
    return { ok: false, error: geidea ? "provider_error" : "paymob_error" };
  }
}

type Applied = { ok: true; already: boolean; payment?: Payment } | { ok: false; error: string };

/**
 * Apply a paid intent (spec 4.1, 4.2). A plan: the plan, its month's credits when it changes (or the account was locked,
 * had no online subscription yet, or held a plan set by hand: rule 2981), the subscription state, seats, then the payment
 * through `recordPayment` (offer, commission, referral). A renewal: the paid month moves one month from the previous end,
 * nothing else, and only for the plan it was priced for (rule 2983). A pack: `addPaidTopup`. Every step is idempotent on
 * the transaction id (`billing.txns`) or the payment id derived from it.
 */
async function applyPaid(intent: PayIntent, txnId: TxnId, paymentId: string, provider: ProviderName = "paymob"): Promise<Applied> {
  const today = ksaDay();
  const baseSar = intent.baseHalalas / 100;
  if (intent.kind === "topup") {
    const r = await addPaidTopup(intentAccount(intent), { credits: intent.credits!, paidSar: baseSar, paidOn: today, ref: `${provider}:${txnId}`, paymentId }, provider);
    return r.ok ? { ok: true, already: r.already, payment: r.payment ?? undefined } : { ok: false, error: r.error };
  }
  const plan = intent.plan!;
  const cardRead = await db.get<SavedCard>(cardKeyOf(provider, intentAccount(intent)));
  const id = String(txnId);
  let claim: ClaimOutcome | null = null;
  const step = await withUserLock(intentAccount(intent), async (u): Promise<"already" | "changed" | "same" | "no_billing" | "plan_changed" | "offer_used"> => {
    const b = u.billing;
    // Rule 2757: a plan checkout opened before the account changed owner still pays its month, but the card read for it
    // belongs to the previous owner and never turns renewals on for the new one.
    const card = intentOutdatesOwner(u, intent.createdAt) ? null : cardRead;
    if (b?.txns?.includes(id)) return "already";
    // Rule 2303: the first-month price is read at checkout without reserving the offer, so several checkouts opened before
    // the first payment all carry it. Only the account's first online plan payment may take it: the offer must still be
    // unused AND no subscription may exist yet. `billing` is written under this same lock, so of two discounted payments
    // arriving together the second always sees the first's subscription. Paid but not applied: the founder refunds it.
    if (intent.kind === "plan" && intent.offer && (!unusedOffer(u) || b)) return "offer_used";
    if (intent.kind === "renewal") {
      if (!b) return "no_billing";
      // Rule 2983: a renewal pays a month of the plan it was priced for. One whose subscription has since moved to another
      // plan (a late callback for the old plan's charge after an upgrade or a downgrade) adds nothing: paid but not
      // applied, like a renewal with no subscription, and the founder refunds it.
      if (intent.plan !== b.plan) return "plan_changed";
      const next: Billing = { ...b, status: "active", paidThrough: addMonths(b.paidThrough, 1, b.anchor), failures: 0, txns: keepTxns(b.txns, id) };
      delete next.graceUntil;
      delete next.pending;
      u.billing = next;
      await saveUser(u);
      return "same";
    }
    // The account's first online subscription: the founding seat (when asked) and the price lock (rules 1703-1705).
    if (!b) claim = await claimOnPayment(u, { founding: !!intent.founding, plan, paidHalalas: intent.amountCents, paymentId, day: today, by: provider });
    // Rule 2981: the account's first online subscription, or one replacing a plan set by hand, starts a paid period today
    // whatever the plan was: its month's credits and `renewedOn` today. Before, the same plan held by hand (or set by hand
    // with no paid-through day) counted as unchanged, so the payment gave no credits and the next refill waited for the
    // first renewal, a month later.
    const changed = u.plan !== plan || billingLocked(b) || !b || !!u.handPlan;
    u.plan = plan;
    delete u.deal;
    // Paid online from now on: the subscription's own `paidThrough` governs, not a day the founder set by hand (rule 1305).
    delete u.handPlan;
    if (changed) {
      setMonthly(u, allowanceOf(u));
      u.renewedAt = monthKey();
      // The allowance renews on the subscription's own day (`billing.anchor`, below), counted from today (rule 2936).
      u.renewedOn = today;
    }
    // The same plan paid again before its month ran out adds a month to it; anything else starts a month today.
    const extend = !!b && !billingLocked(b) && b.plan === plan && b.paidThrough > today;
    u.billing = {
      provider, plan, status: "active",
      paidThrough: extend ? addMonths(b.paidThrough, 1, b.anchor) : addMonths(today, 1), anchor: extend ? b.anchor : Number(today.slice(8, 10)),
      autoRenew: !!card || (b?.autoRenew ?? false), failures: 0, txns: keepTxns(b?.txns, id),
      ...(card ? { card: { brand: card.brand, last4: card.last4 } } : b?.card ? { card: b.card } : {}),
    };
    await saveUser(u);
    return changed ? "changed" : "same";
  });
  if (step === "no_billing") return { ok: false, error: "no_billing" };
  if (step === "plan_changed") return { ok: false, error: "plan_changed" };
  if (step === "offer_used") return { ok: false, error: "offer_used" };
  const c = claim as ClaimOutcome | null;
  if (c && (c.seat || c.lock)) await log(intentAccount(intent), `founding txn:${txnId}${c.seat ? ` seat:${c.seat}` : ""}${c.lock ? ` price_lock_months:${c.lock}` : ""}`, provider);
  // Seats fit the new plan. Also on a plan transaction already applied (multi-workspace M1, 2026-10-19): a first try whose
  // `lock:team` wait ran out (`team_lock_timeout`, answered 503 "busy" by `applyTransaction`) saved the plan and its id,
  // so the retry finds it "already" and fits the seats then. `enforceSeats` is idempotent: a team that fits is not changed.
  if (step === "changed" || (step === "already" && intent.kind === "plan")) await enforceSeats(intentAccount(intent));
  const rec = await recordPayment(intentAccount(intent), { id: paymentId, amountSar: baseSar, plan, date: today, reference: `${provider}:${txnId}` }, provider);
  if (!rec.ok) return { ok: false, error: rec.error };
  // `already` is the payment record's own: the plan step of a retry after a busy answer is "already", but its payment
  // is recorded (and `paymob_paid` logged) only now, once.
  return { ok: true, already: !!rec.already, payment: rec.payment };
}

export type CallbackResult = { status: number; result: string };
const ok = (result: string): CallbackResult => ({ status: 200, result });

/**
 * A transaction, from a verified callback or from our own pay call (spec 4.4). Exactly once per transaction id: a done
 * marker, a short lock, and idempotent steps inside; a failure throws so the caller answers 500 and Paymob retries. A
 * team lock still held after the wait (`team_lock_timeout`, seats being fitted) is 503 "busy", the same retry contract
 * as the transaction lock: nothing is marked done, no payment, invoice or paid status is written, and the retry fits the
 * seats and finishes the rest once (`applyPaid`).
 */
export async function applyTransaction(p: PaymentProvider, t: PaymentTxn): Promise<CallbackResult> {
  // A refund or void made in the provider's dashboard, full or partial, arrives here as a child or refunded transaction and
  // changes nothing on the account (rules 1301, 3913): only the founder console's refund ends a plan (`refundPaymobPayment`).
  // Geidea's is logged for the founder, unless it is the callback of our own refund.
  if (t.isRefunded && p.name === "geidea" && refProvider(t.ref) === "geidea") await noteExternalRefund(p, t);
  if (t.hasParent || t.isRefunded || t.isVoided || t.pending) return ok("ignored");
  if (!t.ref || refProvider(t.ref) !== p.name) return ok("ignored");
  if (await db.get(doneKey(t.id))) return ok("already");
  const intent = await db.get<PayIntent>(intentKey(t.ref));
  // Rule 3907: an intent answers only to the provider that wrote it.
  if (!intent || (intent.provider ?? "paymob") !== p.name) return ok("ignored");
  const geidea = p.name === "geidea";
  // Rule 3907: Geidea keeps every attempt of one checkout in one order, so another paid order for an intent already paid
  // is never applied (the intent keeps its paid status); the founder refunds it.
  if (geidea && intent.status === "paid" && intent.txnId !== undefined && intent.txnId !== t.id) {
    if (!t.success) return ok("ignored");
    await Promise.all([log(intentAccount(intent), `geidea_second_order order:${t.id} ref:${intent.ref}`, p.name), db.set(doneKey(t.id), "mismatch", DAYS_400)]);
    return ok("mismatch");
  }
  if (!(await db.lock(txLockKey(t.id), 60))) return { status: 503, result: "busy" };
  try {
    if (await db.get(doneKey(t.id))) return ok("already");
    // Rule 2051: the provider only reports the transaction; our own price and our own intent decide whether it is paid.
    const expected = priceFor(intent.kind, intent, intent.offer, intent.lockedBaseHalalas);
    const mismatch = !expected || expected.amountCents !== intent.amountCents || t.amountCents !== intent.amountCents || t.currency !== "SAR"
      || (intent.orderId !== undefined && t.orderId !== intent.orderId) || (t.isLive !== null && t.isLive !== p.live)
      // Rule 3907: a Geidea order under another card-on-file agreement than the one this checkout created or charges under.
      || (geidea && intent.agreementId !== undefined && t.agreementId != null && t.agreementId !== intent.agreementId);
    if (mismatch) {
      await Promise.all([
        db.set(intentKey(intent.ref), { ...intent, status: "mismatch", txnId: t.id }, DAYS_400),
        log(intentAccount(intent), `${p.name}_mismatch txn:${t.id} ref:${intent.ref} cents:${t.amountCents} expected:${intent.amountCents} currency:${t.currency}`, p.name),
        unopen(intent.ref),
      ]);
      await db.set(doneKey(t.id), "mismatch", DAYS_400);
      return ok("mismatch");
    }
    if (!t.success) {
      if (geidea) {
        // Rule 3911: one Geidea order holds every attempt of its checkout, so a decline marks nothing done: a later attempt
        // in the same order may still pay it. The intent reads failed until then.
        if (intent.status === "open") await db.set(intentKey(intent.ref), { ...intent, status: "failed", txnId: t.id }, DAYS_400);
        return ok("declined");
      }
      await db.set(intentKey(intent.ref), { ...intent, status: "failed", txnId: t.id }, DAYS_400);
      await db.set(doneKey(t.id), "declined", DAYS_400);
      return ok("declined");
    }
    const paymentId = paymentIdFor(t.id, p.name);
    await db.set(txnKey(t.id), { ref: intent.ref, email: intentAccount(intent), acct: intentAccount(intent), kind: intent.kind, amountCents: t.amountCents, paymentId, ...(geidea ? { provider: p.name } : {}) } satisfies TxnRecord, DAYS_400);
    // Geidea sends the saved card inside the paid order itself, not in a callback of its own (rule 3906).
    if (geidea && intent.kind === "plan" && t.card) await storeTxnCard(p, intent, t);
    let applied: Applied;
    try {
      applied = await applyPaid(intent, t.id, paymentId, p.name);
    } catch (e) {
      if (isTeamLockTimeout(e)) return { status: 503, result: "busy" };
      throw e;
    }
    if (!applied.ok) {
      // Paid but not applicable (a pack for an account no longer on a paid plan, a renewal with no subscription): the
      // founder refunds it from the console. Not retried: retrying cannot change the answer.
      await Promise.all([log(intentAccount(intent), `${p.name}_unapplied txn:${t.id} ref:${intent.ref} error:${applied.error}`, p.name), unopen(intent.ref)]);
      await db.set(doneKey(t.id), "unapplied", DAYS_400);
      return ok("unapplied");
    }
    await invoiceForPayment({
      email: intentAccount(intent), paymentId, kind: intent.kind, baseHalalas: intent.baseHalalas, vatHalalas: intent.vatHalalas,
      totalHalalas: intent.amountCents, currency: "SAR", provider: p.name, providerRef: String(t.id), day: ksaDay(),
    });
    await Promise.all([
      db.set(intentKey(intent.ref), { ...intent, status: "paid", txnId: t.id }, DAYS_400),
      applied.already ? Promise.resolve() : log(intentAccount(intent), `${p.name}_paid txn:${t.id} kind:${intent.kind} ${intent.kind === "topup" ? `credits:${intent.credits}` : `plan:${intent.plan}`} sar:${intent.baseHalalas / 100} vat:${intent.vatHalalas / 100} payment:${paymentId}`, p.name),
      unopen(intent.ref),
    ]);
    await db.set(doneKey(t.id), "paid", DAYS_400);
    return ok("paid");
  } finally {
    await db.unlock(txLockKey(t.id));
  }
}

/**
 * Rule 3906: the card a Geidea plan payment saved, read from the paid order (Geidea sends no card callback of its own).
 * The same guards as `saveCard`, under the account lock: never for an order we refunded, never across an owner change,
 * and only under the agreement this checkout created, the one a renewal charges under (another would answer 750.005).
 */
async function storeTxnCard(p: PaymentProvider, intent: PayIntent, t: PaymentTxn): Promise<void> {
  const c = t.card;
  if (!c || !intent.agreementId || (c.agreementId !== null && c.agreementId !== intent.agreementId)) return;
  const card: SavedCard = {
    token: c.token, last4: c.last4, brand: c.brand || "card", expMonth: c.expMonth, expYear: c.expYear,
    savedAt: new Date().toISOString(), orderId: t.id, agreementId: intent.agreementId, provider: p.name,
  };
  let refused = false;
  await withUserLock(intentAccount(intent), async (u) => {
    if (await db.get(refundedKey(t.id))) return;
    if (intentOutdatesOwner(u, intent.createdAt)) {
      refused = true;
      return;
    }
    await db.set(cardKeyOf(p.name, intentAccount(intent)), card);
  });
  if (refused) await log(intentAccount(intent), `card_refused reason:owner_changed ref:${intent.ref}`, p.name);
}

/**
 * Rule 3913: a refund made in Geidea's own dashboard reaches us as a refunded order and changes nothing on the account
 * (as Paymob's, rule 1301); it is logged for the founder, who ends the plan from the console if that was meant. Our own
 * refund's callback (its marker or its lock is there) is not logged.
 */
async function noteExternalRefund(p: PaymentProvider, t: PaymentTxn): Promise<void> {
  const [ours, busy, intent] = await Promise.all([db.get(refundedKey(t.id)), db.get(refundLockKey(t.id)), db.get<PayIntent>(intentKey(t.ref!))]);
  if (ours || busy || !intent || intent.provider !== p.name) return;
  await log(intentAccount(intent), `${p.name}_external_refund order:${t.id} ref:${intent.ref}`, p.name);
}

/**
 * A card token callback (spec 4.4), already verified and parsed by the provider: matched to our intent through our
 * order pointer, and to its account's email.
 */
async function saveCard(ct: CardTokenEvent | null): Promise<CallbackResult> {
  if (!ct) return ok("ignored");
  const { orderId, token } = ct;
  const ref = await db.get<string>(orderKey(orderId));
  const intent = typeof ref === "string" && REF.test(ref) ? await db.get<PayIntent>(intentKey(ref)) : null;
  if (!intent || normalizeEmail(ct.email) !== normalizeEmail(intentBillingEmail(intent))) return ok("ignored");
  const card: SavedCard = {
    token, last4: ct.last4, brand: ct.brand || "card",
    expMonth: ct.expMonth, expYear: ct.expYear, savedAt: new Date().toISOString(), orderId,
  };
  // Rule 2271: a card token for an order whose payment the founder refunded is not saved again. The refund deleted the
  // card (`endPlanOnRefund`); a late or replayed callback for that order must not bring it back, or the next checkout
  // would turn automatic renewal on with it. Rule 2280: the refunded check and the write run under the account's lock,
  // the one `endPlanOnRefund` holds while it deletes the card, so a refund cannot land between the check and the write.
  let refused = false;
  const saved = await withUserLock(intentAccount(intent), async (u) => {
    if (intent.txnId !== undefined && (await db.get(refundedKey(intent.txnId)))) return false;
    // Rule 2757: a checkout opened before the account changed owner carries the previous owner's card. Under the same
    // lock the transfer writes `ownerSince` and deletes the card, so the card never lands on the new owner's account.
    if (intentOutdatesOwner(u, intent.createdAt)) {
      refused = true;
      return false;
    }
    await db.set(cardKey(intentAccount(intent)), card);
    if (!u.billing) return true;
    u.billing = { ...u.billing, card: { brand: card.brand, last4: card.last4 }, ...(intent.kind === "plan" ? { autoRenew: true } : {}) };
    await saveUser(u);
    return true;
  });
  // The refusal is logged with the intent's ref only: never the token, the card or an address.
  if (refused) await log(intentAccount(intent), `card_refused reason:owner_changed ref:${intent.ref}`);
  return saved ? ok("card_saved") : ok("ignored");
}

/**
 * The webhook's work after the route's size and rate checks (spec 4.4): the HMAC of the callback's own type first, and
 * nothing is used before it matches.
 */
export async function handlePaymobCallback(body: unknown, hmac: string | null): Promise<CallbackResult> {
  const p = paymentProvider();
  if (!p || p.name !== "paymob") return { status: 404, result: "not_enabled" };
  const e = p.parseEvent(body);
  if (!e) return { status: 400, result: "bad_body" };
  if (!p.verifyWebhook(e, hmac)) return { status: 401, result: "bad_hmac" };
  if (e.kind === "card_token") return saveCard(p.parseCardToken(e.obj));
  const t = p.parseTransaction(e.obj);
  return t ? applyTransaction(p, t) : ok("ignored");
}

/**
 * Geidea's callback after the route's size and rate checks (rules 3903, 3905): the signature inside the body first (it
 * covers the amount, currency, order, status, our reference and the timestamp), and nothing is used before it matches.
 * Geidea sends the same callback for the payment and for a refund; the card comes inside the paid order.
 */
export async function handleGeideaCallback(body: unknown): Promise<CallbackResult> {
  const p = paymentProvider();
  if (!p || p.name !== "geidea") return { status: 404, result: "not_enabled" };
  const e = p.parseEvent(body);
  if (!e) return { status: 400, result: "bad_body" };
  if (!p.verifyWebhook(e, null)) return { status: 401, result: "bad_signature" };
  const t = p.parseTransaction(e.obj);
  return t ? applyTransaction(p, t) : ok("ignored");
}

/**
 * The daily renewal (spec 4.2), for one account, from the cron's default-brand entry. Answers a short outcome for the
 * cron report, or null when nothing was due. At most one charge attempt per account per Riyadh day.
 */
export async function renewPaymob(email: string, now = Date.now()): Promise<string | null> {
  const p = paymentProvider();
  if (!p) return null;
  const today = ksaDay(now);
  const u = await getUser(email);
  const b = u?.billing;
  if (!u || !paymobRenewalDue(b, today)) return null;
  // Grace is over: lock, like an ended trial.
  if (b.status === "past_due" && b.graceUntil && today > b.graceUntil) {
    const locked = await withUserLock(email, async (x) => {
      if (!x.billing || x.billing.status !== "past_due" || !x.billing.graceUntil || today <= x.billing.graceUntil) return false;
      x.billing = { ...x.billing, status: "locked" };
      await saveUser(x);
      return true;
    });
    if (locked) await log(email, `${p.name}_locked paid_through:${b.paidThrough}`, p.name);
    return locked ? `${p.name}_locked` : null;
  }
  // A charge still pending from the last two days: its callback decides, nothing is sent twice.
  if (b.pending && b.pending.day >= addDays(today, -2)) {
    const prev = await db.get<PayIntent>(intentKey(b.pending.ref));
    if (prev?.status === "open") return `${p.name}_pending`;
  }
  // Paid extra seats (rule 3371): trimmed to what the team uses now before the period is priced, so a member who left
  // or an invite cancelled last period is not charged again. A busy team answers before the day's attempt is spent.
  // Both providers renew the same way: the seats are settled here and priced into the renewal intent.
  let seats: number;
  try {
    seats = await settleExtraSeats(acct(u));
  } catch (e) {
    if (isTeamLockTimeout(e) || (e instanceof Error && e.message === "user_lock_timeout")) return `${p.name}_seats_busy`;
    throw e;
  }
  if (!(await db.setNx(attemptKey(p.name, email, today), 1, 3 * 86400))) return null;
  // Rule 3910: a card is charged only by the provider that saved it. A subscription of the other provider (Paymob's after
  // the switch to Geidea) goes past due, then grace, then lock, and the owner pays the month from the billing page.
  const saved = b.autoRenew && b.provider === p.name ? p.savedCard : null;
  const card = saved ? await db.get<SavedCard>(cardKeyOf(p.name, email)) : null;
  let outcome = card ? `${p.name}_declined` : `${p.name}_due`;
  let dropCard = false;
  // Rule 2984: the charge call itself failed with no answer (a timeout, a network error, a 5xx): the card may have been
  // charged. Its `pending` stays, so the two-day guard above waits for the callback instead of charging the card again.
  let keepPending: string | null = null;
  if (card) {
    try {
      const r = await chargeSavedCard(p, saved!, u, b, card, today, seats);
      if (r === "paid") return `${p.name}_renewed`;
      if (r === "pending") return `${p.name}_pending`;
    } catch (e) {
      // Rule 3911: refused before anything was charged (Geidea 750.005, 750.006 or another code): a definite decline. An
      // agreement Geidea no longer knows can never be charged again, so its card goes and renewal turns off.
      if (e instanceof PaymentDeclined) dropCard = e.reason === "agreement_mismatch";
      else outcome = `${p.name}_error`;
      if (e instanceof ChargeUnanswered) keepPending = e.ref;
      logger.error(`${p.name} renewal`, { error: e instanceof PaymentError ? e.message : "error" });
    }
  }
  await withUserLock(email, async (x) => {
    const xb = x.billing;
    if (!xb || xb.paidThrough !== b.paidThrough || xb.status === "locked") return;
    x.billing = { ...xb, status: "past_due", failures: xb.failures + 1, graceUntil: xb.graceUntil ?? addDays(xb.paidThrough, GRACE_DAYS) };
    // A definite decline (or nothing charged) clears it; a charge with no answer keeps its own (rule 2984).
    if (!keepPending || xb.pending?.ref !== keepPending) delete x.billing.pending;
    if (dropCard) {
      await db.del(cardKeyOf(p.name, email));
      x.billing.autoRenew = false;
      delete x.billing.card;
    }
    await saveUser(x);
  });
  return outcome;
}

/**
 * Rule 2984: the saved-card charge was sent and no answer came (a timeout, a network error, a 5xx), or the card answered
 * and applying it failed part-way. The card may have been charged: `renewPaymob` keeps the subscription's `pending`.
 */
class ChargeUnanswered extends PaymentError {
  constructor(provider: PaymentProvider["name"], readonly ref: string, cause: unknown) {
    super(provider, cause instanceof PaymentError ? `unanswered_${cause.code}` : "unanswered", cause instanceof PaymentError ? cause.status : 0);
  }
}

/**
 * MIT through the provider's saved-card charge (Paymob: the Moto integration): a renewal intent at the plan's price plus
 * the settled paid extra seats (`seats`, rule 3372), then the saved card (spec 4.2).
 */
async function chargeSavedCard(p: PaymentProvider, saved: NonNullable<PaymentProvider["savedCard"]>, u: User, b: Billing, card: SavedCard, today: string, seats = 0): Promise<"paid" | "pending" | "declined"> {
  // The period being paid starts at `paidThrough`: a lock that covers it prices the renewal (rule 1706).
  const locked = lockedBaseHalalas(u, b.plan, b.paidThrough);
  const extra = seatsOf(seats);
  const price = priceFor("renewal", { plan: b.plan, extraSeats: extra }, false, locked ?? undefined)!;
  const geidea = p.name === "geidea";
  const ref = geidea ? randomUUID() : newRef();
  const intent: PayIntent = {
    ref, email: acct(u), acct: acct(u), billingEmail: u.email, kind: "renewal", plan: b.plan, ...price, currency: "SAR", offer: false, ...(locked !== null ? { lockedBaseHalalas: locked } : {}), ...(extra ? { extraSeats: extra } : {}), createdAt: new Date().toISOString(), by: "cron", status: "open",
    ...(geidea ? { provider: "geidea" as const, ...(card.agreementId ? { agreementId: card.agreementId } : {}) } : {}),
  };
  // The line items the provider shows: the plan, and the extra seats when there are any.
  const seatsText = extra ? ` + ${extra} extra seat${extra === 1 ? "" : "s"}` : "";
  await Promise.all([db.set(intentKey(ref), intent, DAYS_400), ...(geidea ? [db.zadd(globalKey.payOpen(), Date.now(), ref)] : [])]);
  let paymentKey: string | null = null;
  // Paymob's order id, known before the charge; null at Geidea, whose order arrives with the answer.
  let orderId: number | string | null = null;
  const withOrder = () => (orderId !== null ? { orderId } : {});
  try {
    const it = await saved.prepare({
      amountCents: price.amountCents,
      item: { name: `Thakeen ${b.plan} plan${seatsText}, 1 month`, description: `Thakeen ${b.plan} plan renewal${seatsText}${price.vatHalalas ? " (incl. VAT)" : ""}` },
      billing: { ...billingName(u), email: u.email, phone: normalizePhone(u.phone ?? "") || "NA" },
      reference: ref,
      notificationUrl: `${appOrigin()}/api/billing/${p.name}/webhook`,
      redirectionUrl: `${appOrigin()}${appHrefFor(u, u.lang, "/billing")}`,
      expirationS: 3600,
      lang: u.lang === "en" ? "en" : "ar",
    }, { token: card.token, agreementId: card.agreementId ?? null });
    paymentKey = it.paymentKey;
    orderId = it.orderId;
    if (typeof orderId === "number") await Promise.all([db.set(intentKey(ref), { ...intent, orderId }, DAYS_400), db.set(orderKey(orderId), ref, DAYS_400)]);
  } catch (e) {
    await Promise.all([db.set(intentKey(ref), { ...intent, status: "failed" }, DAYS_400), unopen(ref)]);
    throw e;
  }
  if (!paymentKey) {
    await Promise.all([db.set(intentKey(ref), { ...intent, ...withOrder(), status: "failed" }, DAYS_400), unopen(ref)]);
    throw new PaymentError(p.name, "no_payment_key");
  }
  // Rule 1956: the card is charged only if, under the account lock, the account still exists, renewal is still on and
  // the card is still saved. Account deletion (`stopRenewals`, first step of `wipeAccount`) turns renewal off and drops
  // the card under the same lock, so a renewal that read the card before the deletion stops here instead of charging
  // it. A deleted account throws `user_not_found` out of the lock, which the daily job records and never retries.
  const still = await withUserLock(acct(u), async (x) => {
    if (!x.billing || !x.billing.autoRenew || !(await db.get(cardKeyOf(p.name, acct(u))))) return false;
    x.billing = { ...x.billing, pending: { ref, day: today } };
    await saveUser(x);
    return true;
  });
  if (!still) {
    await Promise.all([db.set(intentKey(ref), { ...intent, ...withOrder(), status: "failed" }, DAYS_400), unopen(ref)]);
    throw new PaymentError(p.name, "renewal_off");
  }
  let txn: PaymentTxn | null;
  try {
    txn = await saved.charge(paymentKey, card.token, card.agreementId ?? null);
  } catch (cause) {
    // Rule 3911: refused before anything was charged (Geidea 750.005, 750.006 or another code): the intent fails and
    // `renewPaymob` counts a decline, not a charge with no answer.
    if (cause instanceof PaymentDeclined) {
      await Promise.all([db.set(intentKey(ref), { ...intent, status: "failed" }, DAYS_400), unopen(ref)]);
      throw cause;
    }
    // Rule 2984: sent, and no answer. The intent stays open and `pending` stays on the subscription (written above), so
    // its callback still applies it and no later run charges the period again inside the two-day guard.
    throw new ChargeUnanswered(p.name, ref, cause);
  }
  if (!txn || txn.pending) return "pending";
  // Our own call's answer over TLS: the reference is ours even when the answer does not echo it, but the order must match.
  // At Geidea no order is known before the charge: the answer's own reference, when it gives one, must be ours.
  if (orderId === null ? !!txn.ref && txn.ref !== ref : txn.orderId !== null && txn.orderId !== orderId) return "pending";
  let r: CallbackResult;
  try {
    r = await applyTransaction(p, { ...txn, ref: txn.ref ?? ref });
  } catch (cause) {
    // Rule 2984: the card answered but applying it failed part-way; the callback (or the transaction's retry) finishes it.
    // Until then the period counts as possibly paid, exactly like a charge with no answer.
    throw new ChargeUnanswered(p.name, ref, cause);
  }
  return txn.success && (r.result === "paid" || r.result === "already") ? "paid" : r.status === 503 ? "pending" : "declined";
}

/**
 * Rule 1955: stop every future charge of an account that is being deleted, before anything else of it is touched.
 * Under the account lock, renewal turns off and the saved card token is deleted, so `chargeSavedCard` (which re-checks
 * both under the same lock right before it charges) can not charge it any more. An account record already gone still
 * loses its card. `userLocked`: the caller already holds that lock (the address move), so only the card goes here; the
 * account record is deleted by the wipe that follows.
 */
export async function stopRenewals(email: string, opts: { userLocked?: boolean } = {}): Promise<void> {
  if (opts.userLocked) {
    await delCards(email);
    return;
  }
  try {
    await withUserLock(email, async (x) => {
      await delCards(email);
      if (x.billing?.autoRenew) {
        x.billing = { ...x.billing, autoRenew: false };
        await saveUser(x);
      }
    });
  } catch (e) {
    if (!(e instanceof Error && e.message === "user_not_found")) throw e;
    await delCards(email);
  }
}

export type RenewalAction = "cancel" | "resume" | "remove_card";

/** What the return page shows of the latest checkout: no ref, still open, paid, or not paid. */
export type CheckoutState = "none" | "pending" | "success" | "failed";
export const checkoutState = (status: PayIntent["status"] | undefined): CheckoutState =>
  status === "paid" ? "success" : status === "failed" || status === "mismatch" ? "failed" : status === "open" ? "pending" : "none";

/**
 * The latest checkout of `email` (the session's account) for the return page (GET /api/billing/status, rule 1155): its
 * state and what it was for, never the amount's internals, the order or the transaction. The ref comes from the
 * account's own pointer, and an intent that names another account answers "none".
 */
export async function lastCheckout(email: string, now = Date.now()): Promise<{ state: CheckoutState; kind?: IntentKind; plan?: SelfServePlan; credits?: number }> {
  const p = paymentProvider();
  const ref = await db.get<string>(lastKeyOf(p?.name ?? "paymob", email));
  if (typeof ref !== "string" || refProvider(ref) !== (p?.name ?? "paymob")) return { state: "none" };
  let intent = await db.get<PayIntent>(intentKey(ref));
  if (!intent || intentAccount(intent) !== email) return { state: "none" };
  // Rule 3909: Geidea's callback has no published retry, so the return page asks Geidea itself about a checkout still
  // open (or declined: a later attempt in the same order may have paid), a minute to two days old, once per 20 s.
  if (p?.name === "geidea" && (intent.status === "open" || intent.status === "failed") && reconcileDue(intent, now) && (await allow("geidearecon:" + email, 1, 20))) {
    intent = await reconcileIntent(p, intent);
  }
  return { state: checkoutState(intent.status), kind: intent.kind, ...(intent.plan ? { plan: intent.plan } : {}), ...(intent.credits ? { credits: intent.credits } : {}) };
}

const RECONCILE_MIN_MS = 60_000;
const RECONCILE_MAX_MS = 48 * 3600_000;
const reconcileDue = (intent: PayIntent, now: number) => {
  const age = now - Date.parse(intent.createdAt);
  return age >= RECONCILE_MIN_MS && age <= RECONCILE_MAX_MS;
};

/**
 * Rule 3909: what Geidea holds under our reference, applied through `applyTransaction` exactly like a verified callback:
 * our own call over TLS to Geidea's fixed host, and the order's reference must be ours. Answers the intent as it is now.
 * A failure is logged and changes nothing: the next look tries again.
 */
async function reconcileIntent(p: PaymentProvider, intent: PayIntent): Promise<PayIntent> {
  if (!p.fetchByReference) return intent;
  try {
    const t = await p.fetchByReference(intent.ref);
    if (!t || (t.ref && t.ref !== intent.ref)) return intent;
    await applyTransaction(p, { ...t, ref: intent.ref });
  } catch (e) {
    logger.error("geidea reconcile", e);
    return intent;
  }
  return (await db.get<PayIntent>(intentKey(intent.ref))) ?? intent;
}

/**
 * Rule 3909: the daily job's sweep of Geidea checkouts left open (a callback that never came): up to 50 references at
 * least 20 minutes old, five at a time, each asked of Geidea and applied as a callback would be. References older than
 * two days, and ones already settled, leave the set. Nothing while Geidea is not the chosen provider.
 */
export async function reconcileOpenCheckouts(now = Date.now()): Promise<{ checked: number; dropped: number }> {
  const p = paymentProvider();
  if (!p || p.name !== "geidea" || !p.fetchByReference) return { checked: 0, dropped: 0 };
  const rows = await db.zrangeByScore(globalKey.payOpen(), now - 20 * 60_000, 100);
  const stale = rows.filter((r) => r.score < now - RECONCILE_MAX_MS || !GREF.test(r.member));
  const due = rows.filter((r) => !stale.includes(r)).slice(0, 50);
  await Promise.all(stale.map((r) => db.zrem(globalKey.payOpen(), r.member)));
  const intents = await Promise.all(due.map((r) => db.get<PayIntent>(intentKey(r.member))));
  const settled = due.filter((_, i) => !intents[i] || intents[i]!.status === "paid" || intents[i]!.status === "mismatch");
  await Promise.all(settled.map((r) => db.zrem(globalKey.payOpen(), r.member)));
  const open = intents.filter((it): it is PayIntent => !!it && (it.status === "open" || it.status === "failed"));
  await pmap(open, (it) => reconcileIntent(p, it), 5);
  return { checked: open.length, dropped: stale.length + settled.length };
}

/** One row of the owner's payment history: the recorded payment's day, what it bought, the amount before VAT and its state. */
export type PaymentRow = { id: string; date: string; plan: string; topupCredits: number | null; amountSar: number; state: "paid" | "voided" | "refunded"; refundSar: number | null };

/**
 * The owner's payment history (rule 1156), from the payments already recorded on the account (`payments:{email}`, written
 * by the founder console and the Paymob callback) and nothing else: no invoice is made up here. Only safe fields: never
 * the partner's commission, who recorded it, the payment reference or a void reason. Newest first.
 */
export async function paymentHistory(email: string): Promise<PaymentRow[]> {
  const all = await db.hgetall<Payment>(paymentsKey(email));
  return Object.values(all ?? {})
    .filter((p): p is Payment => !!p && typeof p.id === "string" && typeof p.date === "string")
    .sort((a, b) => (a.date === b.date ? ((a.recordedAt ?? "") < (b.recordedAt ?? "") ? 1 : -1) : a.date < b.date ? 1 : -1))
    .map((p) => ({
      id: p.id, date: p.date.slice(0, 10), plan: p.plan, topupCredits: p.topup ? p.topup.credits : null,
      amountSar: Number(p.amountSar) || 0, state: p.voidedAt ? "voided" as const : p.refund ? "refunded" as const : "paid" as const, refundSar: p.refund ? p.refund.sar : null,
    }));
}
export type BillingView = { plan: string; status: Billing["status"]; paidThrough: string; graceUntil: string | null; autoRenew: boolean; card: { brand: string; last4: string } | null };
/** What a page may show of the subscription: never the token. */
export const billingView = (b: Billing | undefined): BillingView | null =>
  b && (b.provider === "paymob" || b.provider === "geidea") ? { plan: b.plan, status: b.status, paidThrough: b.paidThrough, graceUntil: b.graceUntil ?? null, autoRenew: b.autoRenew, card: b.card ?? null } : null;

/** The owner's renewal settings (spec 4.3). `email` is the session's account. */
export async function setRenewal(email: string, action: unknown): Promise<{ ok: true; billing: BillingView | null } | { ok: false; error: "bad_action" | "no_billing" | "no_card" }> {
  if (action !== "cancel" && action !== "resume" && action !== "remove_card") return { ok: false, error: "bad_action" };
  // Both providers' cards are read in one round trip; the subscription's own provider picks which one counts (rule 3914).
  const cards = action === "resume" ? await Promise.all([db.get<SavedCard>(cardKey(email)), db.get<SavedCard>(accountKey.payCard(email))]) : null;
  if (action === "remove_card") await delCards(email);
  return withUserLock(email, async (u) => {
    if (!u.billing) return action === "remove_card" ? { ok: true as const, billing: null } : { ok: false as const, error: "no_billing" as const };
    const card = cards ? cards[u.billing.provider === "geidea" ? 1 : 0] : null;
    if (action === "resume" && !card) return { ok: false as const, error: "no_card" as const };
    const next: Billing = { ...u.billing, autoRenew: action === "resume" };
    if (action === "remove_card") delete next.card;
    u.billing = next;
    await saveUser(u);
    return { ok: true as const, billing: billingView(next) };
  });
}

export type RefundError = "not_enabled" | "not_found" | "not_paymob" | "busy" | "paymob_refund_failed";
/**
 * The founder's refund of a Paymob payment (spec 4.5): the whole transaction at Paymob, once, then the payment voided
 * through the existing path (a pack's payment with its pack), then, for a plan or renewal payment, the plan ended
 * (`endPlanOnRefund`, rule 1300). A retry after the Paymob refund only finishes the void and the end.
 */
export async function refundPaymobPayment(email: string, id: unknown, by: string, reason: unknown): Promise<{ ok: true; payment: Payment; alreadyRefunded: boolean; planEnded: boolean } | { ok: false; error: RefundError }> {
  const pp = paymentProvider();
  if (!pp) return { ok: false, error: "not_enabled" };
  const e = normalizeEmail(email);
  if (typeof id !== "string" || !/^pay_[a-f0-9]{8,32}$/.test(id)) return { ok: false, error: "not_found" };
  const p = (await db.hgetall<Payment>(paymentsKey(e)))[id];
  if (!p) return { ok: false, error: "not_found" };
  // `paymob:{number}` or `geidea:{order uuid}` (rule 3912); only the chosen provider can refund its own payment.
  const m = /^paymob:(\d{1,15})$/.exec(p.reference ?? "");
  const g = /^geidea:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(p.reference ?? "");
  const txnId: TxnId = m ? Number(m[1]) : g && pp.name === "geidea" ? g[1] : 0;
  if (m && pp.name !== "paymob") return { ok: false, error: "not_paymob" };
  const rec = txnId ? await db.get<TxnRecord>(txnKey(txnId)) : null;
  if (!rec || (rec.acct ?? rec.email) !== e || rec.paymentId !== id) return { ok: false, error: "not_paymob" };
  let alreadyRefunded = !!(await db.get(refundedKey(txnId)));
  if (!alreadyRefunded) {
    if (!(await db.lock(refundLockKey(txnId), 60))) return { ok: false, error: "busy" };
    try {
      alreadyRefunded = !!(await db.get(refundedKey(txnId)));
      if (!alreadyRefunded) {
        try {
          await pp.refund(txnId, rec.amountCents);
        } catch (err) {
          logger.error(`${pp.name} refund`, { error: err instanceof PaymentError ? err.message : "error" });
          return { ok: false, error: "paymob_refund_failed" };
        }
        await db.set(refundedKey(txnId), JSON.stringify({ at: new Date().toISOString(), by }), DAYS_400);
      }
    } finally {
      await db.unlock(refundLockKey(txnId));
    }
  }
  const why = typeof reason === "string" && reason.trim() ? reason : `${pp.name} refund`;
  if (p.topup || rec.kind === "topup") {
    const r = p.topup ? await voidPaidTopup(e, p.topup.lot, by, why) : null;
    if (r?.ok) return { ok: true, payment: r.payment ?? p, alreadyRefunded, planEnded: false };
    // Rule 2980: a pack's refund never ends a plan, also when its pack is already gone (a retry after the first run voided
    // it, a pack that ran out or that the founder voided in the console): the payment alone is voided (a repeat is a
    // no-op) and the plan, its card and its seats stay. Before, `topup_not_found` fell through to `endPlanOnRefund`.
    const tv = await voidPayment(e, id, by, why);
    if (!tv.ok) return { ok: false, error: "not_found" };
    return { ok: true, payment: tv.payment, alreadyRefunded, planEnded: false };
  }
  const v = await voidPayment(e, id, by, why);
  if (!v.ok) return { ok: false, error: "not_found" };
  // A plan or renewal payment refunded in full ends the plan now (founder decision 2026-10-12, rule 1300) and deletes the
  // saved card token (founder decision 2026-10-19, rule 2270). This path
  // always refunds the whole transaction (`rec.amountCents` above); a partial refund does not exist here, and one made
  // in Paymob's own dashboard reaches us only as a refunded transaction, which `applyTransaction` ignores: it changes
  // nothing on the account (open question in rule 1301). A pack's payment never reaches this line.
  // A team lock still held after the wait (seats being fitted) is "busy" (409 in the console): the retry finishes it.
  let planEnded: boolean;
  try {
    planEnded = await endPlanOnRefund(e, id, by, txnId);
  } catch (err) {
    if (isTeamLockTimeout(err)) return { ok: false, error: "busy" };
    throw err;
  }
  return { ok: true, payment: v.payment, alreadyRefunded, planEnded };
}

/**
 * The plan ends at the moment of a full refund (rule 1300): the plan goes back to an ended trial (`trialOver`, so every
 * spending gate refuses exactly as after a trial), the online subscription is removed (nothing renews: automatic renewal
 * is off with it), a hand-set paid-through day and an Agency deal go too, and the month's plan credits are set to 0.
 * Live top-up packs keep their credits: each is its own payment, refunded on its own. Under the ledger lock, once: a
 * retry finds the ended trial with no subscription and changes nothing. The change is logged with the balance before
 * and after, then seats are fitted to the trial's: also on that retry (multi-workspace M1, 2026-10-19), so a first try whose
 * `lock:team` wait ran out (409 "busy") still fits them when the founder tries again. `enforceSeats` is idempotent.
 * True when THIS refund ended the plan, also on that retry: the first try writes `paymob:refund_ended:{txnId}` under the
 * lock right after the save. A transaction whose marker exists never ends a plan again (multi-workspace M1, 2026-10-19): repeating the
 * refund of an OLD payment after the customer bought a NEW plan answers `planEnded: true` and leaves the new
 * subscription alone. The marker goes after the save, so a save that throws leaves no marker and the retry ends the plan;
 * a marker write that fails after the save leaves the plan ended and the retry answers false (reporting only, no money).
 * A refund that finds no plan to end (an ended trial with no subscription: the second of two refunds in one period, or
 * a refund after the plan already ended) writes `"none"` under the same lock with the same 400-day expiry, so repeating
 * it after the customer bought a new plan answers `planEnded: false` and leaves the new plan alone. A build from before
 * this value (an earlier M1 build) reads any value as "ended before": it never ends a plan for that transaction either
 * and only reports `planEnded: true` (reporting, no money); builds before M1 never read the key. Refunds made before
 * this marker existed have none.
 *
 * Rule 2270 (founder decision 2026-10-19): the saved card token (`paymob:card:{acct}`) is deleted too, under the same
 * lock, only while this transaction has no marker: the first run, or a retry after a first run that stopped before its
 * marker. A repeat of a refund whose marker exists (either value) keeps the current card: it belongs to whatever the
 * customer bought since, and deleting it would break that plan's renewal (controller ruling 2026-10-19). Order: read
 * the marker, then delete the card, then write the marker. The delete always lands before any marker, so a run that
 * stops anywhere before its marker leaves no marker and the retry deletes the card again (a repeat delete is harmless);
 * a marker can only exist after its card delete succeeded. A later checkout of the refunded account then finds no card, so it cannot turn
 * automatic renewal back on by itself (`applyPaid` sets `autoRenew` from a saved card); the owner saves a card again on
 * that checkout. `chargeSavedCard` re-reads the card under this lock before it charges (rule 1956), so a renewal that has
 * not yet passed that check stops. The charge itself (`saved.charge`) runs after that lock is released: a refund that
 * lands in that window still lets that one renewal charge, the existing rule 1956 design. `saveCard` checks the refund
 * and writes the card under this same lock (rule 2280). A pack's refund never reaches here: the plan and its card stay.
 */
async function endPlanOnRefund(email: string, paymentId: string, by: string, txnId: TxnId): Promise<boolean> {
  const now = new Date();
  const change = await withUserLock(email, async (u) => {
    // A marker (either value) means a run of this refund already finished, card delete included: keep today's card.
    const mark = await db.get<string>(refundEndedKey(txnId));
    if (mark === "none") return "nothing_before" as const;
    if (mark) return "ended_before" as const;
    // Rule 2270: the card goes before any marker is written (see above), so no marker exists without its delete.
    await Promise.all([db.del(cardKey(email)), db.del(accountKey.payCard(email))]);
    // Already an ended trial with no subscription (a retry, or a second refund in one period). Not a hand-set plan whose
    // paid-through day passed: it reads as `trialOver` too (rule 2273), and its refund still ends it.
    if (!u.billing && trialOver(u) && !handPlanEnded(u, ksaDay())) {
      await db.set(refundEndedKey(txnId), "none", DAYS_400);
      return null;
    }
    const before = { plan: String(u.plan), credits: Number(u.credits) || 0, autoRenew: u.billing?.autoRenew ?? false, paidThrough: u.billing?.paidThrough ?? u.handPlan?.paidThrough ?? null };
    // The founding seat and the price lock end with the plan (rule 1708): the refunded account is no longer a paying one.
    const founding = endOnRefund(u, by, now.getTime());
    u.plan = "trial";
    // A second in the past: `trialOver` compares strictly, so a read in the same millisecond still sees it ended.
    u.trialEnds = new Date(now.getTime() - 1000).toISOString();
    delete u.billing;
    delete u.handPlan;
    delete u.deal;
    // Paid extra seats end with the plan (rule 3373): a trial never carries them, and a later plan starts at 0 extra.
    delete u.extraSeats;
    setMonthly(u, 0);
    await saveUser(u);
    await db.set(refundEndedKey(txnId), paymentId, DAYS_400);
    return { before, after: { plan: u.plan, credits: u.credits, autoRenew: false, paidThrough: null }, founding, places: { id: acct(u), email: u.email } };
  });
  if (change && typeof change === "object") {
    // Rule 2982: the places are held under the account id; a row written under the address before goes too.
    if (change.founding) await freePlaces(change.places);
    await adminAudit({ actor: by, section: "billing", action: "refund_plan_ended", target: email, what: `refund_plan_ended payment:${paymentId} plan:${change.before.plan} credits:${change.before.credits}->${change.after.credits}${change.founding ? " founding_ended" : ""}`, before: change.before, after: change.after });
  }
  await enforceSeats(email);
  return change === "ended_before" || (!!change && typeof change === "object");
}
