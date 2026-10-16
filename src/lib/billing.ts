import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";
import { getUser, normalizeEmail, normalizePhone, saveUser, trialOver, type User } from "./auth";
import { monthKey, withUserLock } from "./credits";
import { setMonthly } from "./topups";
import { PLAN_PRICE_SAR, SELF_SERVE_PLANS, VAT_RATE, allowanceOf, firstMonthPriceSar, isTopupPack, topupPriceSar, topupsSold, type SelfServePlan } from "./pricing";
import { ksaDay } from "./partner-rules";
import { addPaidTopup, openOffer, paymentsKey, recordPayment, voidPaidTopup, voidPayment, type Payment } from "./partners";
import { enforceSeats } from "./team";
import { appOrigin } from "./origin";
import { invoiceForPayment } from "./invoice";
import { GRACE_DAYS, addDays, addMonths, billingLocked, paymobRenewalDue, type Billing } from "./billing-state";
import { PaymobError, TOKEN_HMAC_FIELDS, TXN_HMAC_FIELDS, checkoutUrl, createIntention, parseTxn, payWithToken, paymobConfig, refundTxn, verifyHmac, type PaymobConfig, type Txn } from "./paymob";
import { adminAudit } from "./admin-audit";
import { claimOnPayment, endOnRefund, foundingOfferOpen, freePlaces, lockedBaseHalalas, type ClaimOutcome } from "./founding";
import { log as logger } from "./log";

/**
 * Online billing through Paymob KSA (spec docs/superpowers/specs/2026-10-08-paymob-billing-design.md, rules 700-729):
 * checkout, the callbacks, saved-card renewals with grace and lock, the owner's renewal settings and the founder's
 * refund. Everything is off unless `paymobConfig()` answers (src/lib/paymob.ts). Amounts always come from
 * src/lib/pricing.ts, never from a request; the account always comes from the session or from our own intent record,
 * never from a callback's payload.
 */

/** VAT is added on top of the ex-VAT prices (`VAT_RATE`). False until Thakeen is VAT-registered, if it is not (spec open question 5). */
export const PAYMOB_CHARGES_VAT = true;

const DAYS_400 = 400 * 86400;
const REF = /^pmi_[a-f0-9]{24}$/;
const intentKey = (ref: string) => `paymob:intent:${ref}`;
const orderKey = (orderId: number) => `paymob:order:${orderId}`;
const txnKey = (txnId: number) => `paymob:txn:${txnId}`;
const doneKey = (txnId: number) => `paymob:done:${txnId}`;
const txLockKey = (txnId: number) => `paymob:txlock:${txnId}`;
const refundedKey = (txnId: number) => `paymob:refunded:${txnId}`;
const refundLockKey = (txnId: number) => `paymob:refundlock:${txnId}`;
const attemptKey = (email: string, day: string) => `paymob:attempt:${email}:${day}`;
export const cardKey = (email: string) => `paymob:card:${email}`;
/**
 * The account's latest checkout ref (rule 1155), so the return page asks "how did my payment go?" with the session's
 * account alone and never a ref from the request. A new key only (expand): code without it never reads or misses it.
 */
export const lastCheckoutKey = (email: string) => `paymob:last:${email}`;
const LAST_TTL = 86400;
/** Keys that belong to one account and leave with it (src/lib/account.ts `wipeAccount`). */
export const paymobAccountKeys = (email: string) => [cardKey(email), lastCheckoutKey(email)];

export type IntentKind = "plan" | "topup" | "renewal";
/** What we asked Paymob to charge, stored before the call. The only source of the account and the amount for a callback. */
export type PayIntent = {
  ref: string;
  email: string;
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
  createdAt: string;
  by: string;
  orderId?: number;
  status: "open" | "paid" | "failed" | "mismatch";
  txnId?: number;
};
/** A saved card. The token never leaves this record: no page, API answer or log reads it. */
export type SavedCard = { token: string; last4: string; brand: string; expMonth: string; expYear: string; savedAt: string; orderId: number };
type TxnRecord = { ref: string; email: string; kind: IntentKind; amountCents: number; paymentId: string };

const vatOf = (baseHalalas: number) => (PAYMOB_CHARGES_VAT ? Math.round(baseHalalas * VAT_RATE) : 0);
const isSelfServe = (v: unknown): v is SelfServePlan => typeof v === "string" && (SELF_SERVE_PLANS as readonly string[]).includes(v);

/**
 * The price of a plan month, a renewal or a pack, from the pricing table only. Null for anything not on sale online. A
 * renewal under a price lock passes the locked ex-VAT halalas (rule 1706): the lower of it and the list price is charged.
 */
export function priceFor(kind: IntentKind, item: { plan?: unknown; credits?: unknown }, offer = false, lockedBaseHalalas?: number): { baseHalalas: number; vatHalalas: number; amountCents: number } | null {
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
  const baseHalalas = locked === null ? list : Math.min(locked, list);
  const vatHalalas = vatOf(baseHalalas);
  return { baseHalalas, vatHalalas, amountCents: baseHalalas + vatHalalas };
}

/** The payment id recorded for a Paymob transaction: the same on every retry, so `recordPayment` records it once. */
export const paymentIdFor = (txnId: number) => `pay_${createHash("sha256").update(`paymob:${txnId}`).digest("hex").slice(0, 24)}`;
const newRef = () => `pmi_${randomBytes(12).toString("hex")}`;
const log = (email: string, what: string) => adminAudit({ actor: "paymob", section: "billing", target: email, what });
const keepTxns = (txns: string[] | undefined, id: string) => [...(txns ?? []).filter((t) => t !== id), id].slice(-12);

function billingName(u: Pick<User, "name" | "email">): { firstName: string; lastName: string } {
  const parts = (u.name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().split(/\s+/).filter(Boolean);
  const first = (parts[0] ?? u.email.split("@")[0]).slice(0, 50);
  return { firstName: first, lastName: (parts.slice(1).join(" ") || "NA").slice(0, 50) };
}

export type CheckoutError = "not_enabled" | "bad_request" | "bad_plan" | "bad_pack" | "agency" | "topup_needs_paid_plan" | "need_phone" | "paymob_error" | "not_found";

/**
 * Start a payment (spec 4.1): the owner's plan month or top-up pack. `owner` is the session's account (the caller checked
 * `billing.pay`). The intent is stored before Paymob is called; the answer is the unified checkout URL.
 */
export async function startCheckout(owner: Pick<User, "email">, body: unknown, lang: "ar" | "en"): Promise<{ ok: true; url: string; ref: string } | { ok: false; error: CheckoutError }> {
  const cfg = paymobConfig();
  if (!cfg) return { ok: false, error: "not_enabled" };
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!b || (b.kind !== "plan" && b.kind !== "topup")) return { ok: false, error: "bad_request" };
  const kind = b.kind;
  if (kind === "plan" && !isSelfServe(b.plan)) return { ok: false, error: "bad_plan" };
  if (kind === "topup" && !isTopupPack(b.credits)) return { ok: false, error: "bad_pack" };
  const acc = await getUser(owner.email);
  if (!acc) return { ok: false, error: "not_found" };
  // Agency is sold by contract at its own price: no online checkout.
  if (acc.plan === "agency") return { ok: false, error: "agency" };
  if (kind === "topup" && (!topupsSold(acc.plan) || billingLocked(acc.billing))) return { ok: false, error: "topup_needs_paid_plan" };
  const phone = normalizePhone(acc.phone ?? "");
  if (!/^\+\d{8,15}$/.test(phone)) return { ok: false, error: "need_phone" };
  const offer = kind === "plan" && !!openOffer(acc);
  // The founding offer (rule 1702): the body only asks; the sale, a free seat and an account that never paid online decide.
  const founding = kind === "plan" && b.founding === true && (await foundingOfferOpen(acc));
  const item = kind === "plan" ? { plan: b.plan } : { credits: b.credits };
  const price = priceFor(kind, item, offer)!;
  const ref = newRef();
  const intent: PayIntent = {
    ref, email: acc.email, kind, ...(kind === "plan" ? { plan: b.plan as SelfServePlan } : { credits: b.credits as number }),
    ...price, currency: "SAR", offer, ...(founding ? { founding: true } : {}), createdAt: new Date().toISOString(), by: acc.email, status: "open",
  };
  await Promise.all([db.set(intentKey(ref), intent, DAYS_400), db.set(lastCheckoutKey(acc.email), ref, LAST_TTL)]);
  const label = kind === "plan" ? `Thakeen ${intent.plan} plan, 1 month` : `Thakeen ${intent.credits} credits top-up`;
  try {
    const it = await createIntention(cfg, {
      amountCents: price.amountCents,
      integration: cfg.cardIntegration,
      item: { name: label, description: `${label}${price.vatHalalas ? " (incl. VAT)" : ""}` },
      billing: { ...billingName(acc), email: acc.email, phone },
      reference: ref,
      notificationUrl: `${appOrigin()}/api/billing/paymob/webhook`,
      redirectionUrl: `${appOrigin()}/${lang}/app/billing?paymob=return`,
      expirationS: 3600,
    });
    await Promise.all([db.set(intentKey(ref), { ...intent, orderId: it.orderId }, DAYS_400), db.set(orderKey(it.orderId), ref, DAYS_400)]);
    return { ok: true, url: checkoutUrl(cfg, it.clientSecret), ref };
  } catch (e) {
    await db.set(intentKey(ref), { ...intent, status: "failed" }, DAYS_400);
    logger.error("paymob checkout", { error: e instanceof PaymobError ? e.message : "error" });
    return { ok: false, error: "paymob_error" };
  }
}

type Applied = { ok: true; already: boolean; payment?: Payment } | { ok: false; error: string };

/**
 * Apply a paid intent (spec 4.1, 4.2). A plan: the plan, its month's credits when it changes (or the account was locked),
 * the subscription state, seats, then the payment through `recordPayment` (offer, commission, referral). A renewal: the
 * paid month moves one month from the previous end, nothing else. A pack: `addPaidTopup`. Every step is idempotent on
 * the transaction id (`billing.txns`) or the payment id derived from it.
 */
async function applyPaid(intent: PayIntent, txnId: number, paymentId: string): Promise<Applied> {
  const today = ksaDay();
  const baseSar = intent.baseHalalas / 100;
  if (intent.kind === "topup") {
    const r = await addPaidTopup(intent.email, { credits: intent.credits!, paidSar: baseSar, paidOn: today, ref: `paymob:${txnId}`, paymentId }, "paymob");
    return r.ok ? { ok: true, already: r.already, payment: r.payment ?? undefined } : { ok: false, error: r.error };
  }
  const plan = intent.plan!;
  const card = await db.get<SavedCard>(cardKey(intent.email));
  const id = String(txnId);
  let claim: ClaimOutcome | null = null;
  const step = await withUserLock(intent.email, async (u): Promise<"already" | "changed" | "same" | "no_billing"> => {
    const b = u.billing;
    if (b?.txns?.includes(id)) return "already";
    if (intent.kind === "renewal") {
      if (!b) return "no_billing";
      const next: Billing = { ...b, status: "active", paidThrough: addMonths(b.paidThrough, 1, b.anchor), failures: 0, txns: keepTxns(b.txns, id) };
      delete next.graceUntil;
      delete next.pending;
      u.billing = next;
      await saveUser(u);
      return "same";
    }
    // The account's first online subscription: the founding seat (when asked) and the price lock (rules 1703-1705).
    if (!b) claim = await claimOnPayment(u, { founding: !!intent.founding, plan, paidHalalas: intent.amountCents, paymentId, day: today });
    const changed = u.plan !== plan || billingLocked(b);
    u.plan = plan;
    delete u.deal;
    // Paid online from now on: the subscription's own `paidThrough` governs, not a day the founder set by hand (rule 1305).
    delete u.handPlan;
    if (changed) {
      setMonthly(u, allowanceOf(u));
      u.renewedAt = monthKey();
    }
    // The same plan paid again before its month ran out adds a month to it; anything else starts a month today.
    const extend = !!b && !billingLocked(b) && b.plan === plan && b.paidThrough > today;
    u.billing = {
      provider: "paymob", plan, status: "active",
      paidThrough: extend ? addMonths(b.paidThrough, 1, b.anchor) : addMonths(today, 1), anchor: extend ? b.anchor : Number(today.slice(8, 10)),
      autoRenew: !!card || (b?.autoRenew ?? false), failures: 0, txns: keepTxns(b?.txns, id),
      ...(card ? { card: { brand: card.brand, last4: card.last4 } } : b?.card ? { card: b.card } : {}),
    };
    await saveUser(u);
    return changed ? "changed" : "same";
  });
  if (step === "no_billing") return { ok: false, error: "no_billing" };
  const c = claim as ClaimOutcome | null;
  if (c && (c.seat || c.lock)) await log(intent.email, `founding txn:${txnId}${c.seat ? ` seat:${c.seat}` : ""}${c.lock ? ` price_lock_months:${c.lock}` : ""}`);
  if (step === "changed") await enforceSeats(intent.email);
  const rec = await recordPayment(intent.email, { id: paymentId, amountSar: baseSar, plan, date: today, reference: `paymob:${txnId}` }, "paymob");
  if (!rec.ok) return { ok: false, error: rec.error };
  return { ok: true, already: step === "already" || !!rec.already, payment: rec.payment };
}

export type CallbackResult = { status: number; result: string };
const ok = (result: string): CallbackResult => ({ status: 200, result });

/**
 * A transaction, from a verified callback or from our own pay call (spec 4.4). Exactly once per transaction id: a done
 * marker, a short lock, and idempotent steps inside; a failure throws so the caller answers 500 and Paymob retries.
 */
export async function applyTransaction(cfg: PaymobConfig, t: Txn): Promise<CallbackResult> {
  // A refund or void made in Paymob's dashboard, full or partial, arrives here as a child or refunded transaction and
  // changes nothing on the account (rule 1301): only the founder console's refund ends a plan (`refundPaymobPayment`).
  if (t.hasParent || t.isRefunded || t.isVoided || t.pending) return ok("ignored");
  if (!t.ref || !REF.test(t.ref)) return ok("ignored");
  if (await db.get(doneKey(t.id))) return ok("already");
  const intent = await db.get<PayIntent>(intentKey(t.ref));
  if (!intent) return ok("ignored");
  if (!(await db.lock(txLockKey(t.id), 60))) return { status: 503, result: "busy" };
  try {
    if (await db.get(doneKey(t.id))) return ok("already");
    const expected = priceFor(intent.kind, intent, intent.offer, intent.lockedBaseHalalas);
    const mismatch = !expected || expected.amountCents !== intent.amountCents || t.amountCents !== intent.amountCents || t.currency !== "SAR"
      || (intent.orderId !== undefined && t.orderId !== intent.orderId) || (t.isLive !== null && t.isLive !== cfg.live);
    if (mismatch) {
      await Promise.all([
        db.set(intentKey(intent.ref), { ...intent, status: "mismatch", txnId: t.id }, DAYS_400),
        log(intent.email, `paymob_mismatch txn:${t.id} ref:${intent.ref} cents:${t.amountCents} expected:${intent.amountCents} currency:${t.currency}`),
      ]);
      await db.set(doneKey(t.id), "mismatch", DAYS_400);
      return ok("mismatch");
    }
    if (!t.success) {
      await db.set(intentKey(intent.ref), { ...intent, status: "failed", txnId: t.id }, DAYS_400);
      await db.set(doneKey(t.id), "declined", DAYS_400);
      return ok("declined");
    }
    const paymentId = paymentIdFor(t.id);
    await db.set(txnKey(t.id), { ref: intent.ref, email: intent.email, kind: intent.kind, amountCents: t.amountCents, paymentId } satisfies TxnRecord, DAYS_400);
    const applied = await applyPaid(intent, t.id, paymentId);
    if (!applied.ok) {
      // Paid but not applicable (a pack for an account no longer on a paid plan, a renewal with no subscription): the
      // founder refunds it from the console. Not retried: retrying cannot change the answer.
      await log(intent.email, `paymob_unapplied txn:${t.id} ref:${intent.ref} error:${applied.error}`);
      await db.set(doneKey(t.id), "unapplied", DAYS_400);
      return ok("unapplied");
    }
    await invoiceForPayment({
      email: intent.email, paymentId, kind: intent.kind, baseHalalas: intent.baseHalalas, vatHalalas: intent.vatHalalas,
      totalHalalas: intent.amountCents, currency: "SAR", provider: "paymob", providerRef: String(t.id), day: ksaDay(),
    });
    await Promise.all([
      db.set(intentKey(intent.ref), { ...intent, status: "paid", txnId: t.id }, DAYS_400),
      applied.already ? Promise.resolve() : log(intent.email, `paymob_paid txn:${t.id} kind:${intent.kind} ${intent.kind === "topup" ? `credits:${intent.credits}` : `plan:${intent.plan}`} sar:${intent.baseHalalas / 100} vat:${intent.vatHalalas / 100} payment:${paymentId}`),
    ]);
    await db.set(doneKey(t.id), "paid", DAYS_400);
    return ok("paid");
  } finally {
    await db.unlock(txLockKey(t.id));
  }
}

/** A card token callback (spec 4.4): matched to our intent through our order pointer, and to its account's email. */
async function saveCard(o: Record<string, unknown>): Promise<CallbackResult> {
  const orderId = typeof o.order_id === "string" && /^\d{1,15}$/.test(o.order_id) ? Number(o.order_id) : typeof o.order_id === "number" ? o.order_id : null;
  const token = typeof o.token === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(o.token) ? o.token : null;
  if (!orderId || !Number.isSafeInteger(orderId) || !token) return ok("ignored");
  const ref = await db.get<string>(orderKey(orderId));
  const intent = typeof ref === "string" && REF.test(ref) ? await db.get<PayIntent>(intentKey(ref)) : null;
  if (!intent || normalizeEmail(typeof o.email === "string" ? o.email : "") !== intent.email) return ok("ignored");
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[^\w -]/g, "").slice(0, max) : "");
  const card: SavedCard = {
    token, last4: text(o.masked_pan, 32).replace(/\D/g, "").slice(-4), brand: text(o.card_subtype, 20) || "card",
    expMonth: text(o.expiry_month, 2), expYear: text(o.expiry_year, 4), savedAt: new Date().toISOString(), orderId,
  };
  await db.set(cardKey(intent.email), card);
  await withUserLock(intent.email, async (u) => {
    if (!u.billing) return;
    u.billing = { ...u.billing, card: { brand: card.brand, last4: card.last4 }, ...(intent.kind === "plan" ? { autoRenew: true } : {}) };
    await saveUser(u);
  });
  return ok("card_saved");
}

/**
 * The webhook's work after the route's size and rate checks (spec 4.4): the HMAC of the callback's own type first, and
 * nothing is used before it matches.
 */
export async function handlePaymobCallback(body: unknown, hmac: string | null): Promise<CallbackResult> {
  const cfg = paymobConfig();
  if (!cfg) return { status: 404, result: "not_enabled" };
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const obj = b && b.obj && typeof b.obj === "object" && !Array.isArray(b.obj) ? (b.obj as Record<string, unknown>) : null;
  if (!b || !obj || (b.type !== "TRANSACTION" && b.type !== "TOKEN")) return { status: 400, result: "bad_body" };
  if (!verifyHmac(obj, b.type === "TOKEN" ? TOKEN_HMAC_FIELDS : TXN_HMAC_FIELDS, hmac, cfg.hmacSecret)) return { status: 401, result: "bad_hmac" };
  if (b.type === "TOKEN") return saveCard(obj);
  const t = parseTxn(obj);
  return t ? applyTransaction(cfg, t) : ok("ignored");
}

/**
 * The daily renewal (spec 4.2), for one account, from the cron's default-brand entry. Answers a short outcome for the
 * cron report, or null when nothing was due. At most one charge attempt per account per Riyadh day.
 */
export async function renewPaymob(email: string, now = Date.now()): Promise<string | null> {
  const cfg = paymobConfig();
  if (!cfg) return null;
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
    if (locked) await log(email, `paymob_locked paid_through:${b.paidThrough}`);
    return locked ? "paymob_locked" : null;
  }
  // A charge still pending from the last two days: its callback decides, nothing is sent twice.
  if (b.pending && b.pending.day >= addDays(today, -2)) {
    const prev = await db.get<PayIntent>(intentKey(b.pending.ref));
    if (prev?.status === "open") return "paymob_pending";
  }
  if (!(await db.setNx(attemptKey(email, today), 1, 3 * 86400))) return null;
  const card = b.autoRenew && cfg.motoIntegration ? await db.get<SavedCard>(cardKey(email)) : null;
  let outcome = card ? "paymob_declined" : "paymob_due";
  if (card) {
    try {
      const r = await chargeSavedCard(cfg, u, b, card, today);
      if (r === "paid") return "paymob_renewed";
      if (r === "pending") return "paymob_pending";
    } catch (e) {
      outcome = "paymob_error";
      logger.error("paymob renewal", { error: e instanceof PaymobError ? e.message : "error" });
    }
  }
  await withUserLock(email, async (x) => {
    const xb = x.billing;
    if (!xb || xb.paidThrough !== b.paidThrough || xb.status === "locked") return;
    x.billing = { ...xb, status: "past_due", failures: xb.failures + 1, graceUntil: xb.graceUntil ?? addDays(xb.paidThrough, GRACE_DAYS) };
    delete x.billing.pending;
    await saveUser(x);
  });
  return outcome;
}

/** MIT on the Moto integration: a renewal intent at the plan's full price, then the saved card (spec 4.2). */
async function chargeSavedCard(cfg: PaymobConfig, u: User, b: Billing, card: SavedCard, today: string): Promise<"paid" | "pending" | "declined"> {
  // The period being paid starts at `paidThrough`: a lock that covers it prices the renewal (rule 1706).
  const locked = lockedBaseHalalas(u, b.plan, b.paidThrough);
  const price = priceFor("renewal", { plan: b.plan }, false, locked ?? undefined)!;
  const ref = newRef();
  const intent: PayIntent = { ref, email: u.email, kind: "renewal", plan: b.plan, ...price, currency: "SAR", offer: false, ...(locked !== null ? { lockedBaseHalalas: locked } : {}), createdAt: new Date().toISOString(), by: "cron", status: "open" };
  await db.set(intentKey(ref), intent, DAYS_400);
  let paymentKey: string | null = null;
  let orderId = 0;
  try {
    const it = await createIntention(cfg, {
      amountCents: price.amountCents,
      integration: cfg.motoIntegration!,
      item: { name: `Thakeen ${b.plan} plan, 1 month`, description: `Thakeen ${b.plan} plan renewal${price.vatHalalas ? " (incl. VAT)" : ""}` },
      billing: { ...billingName(u), email: u.email, phone: normalizePhone(u.phone ?? "") || "NA" },
      reference: ref,
      notificationUrl: `${appOrigin()}/api/billing/paymob/webhook`,
      redirectionUrl: `${appOrigin()}/${u.lang}/app/billing`,
      expirationS: 3600,
    });
    paymentKey = it.paymentKey;
    orderId = it.orderId;
    await Promise.all([db.set(intentKey(ref), { ...intent, orderId }, DAYS_400), db.set(orderKey(orderId), ref, DAYS_400)]);
  } catch (e) {
    await db.set(intentKey(ref), { ...intent, status: "failed" }, DAYS_400);
    throw e;
  }
  if (!paymentKey) {
    await db.set(intentKey(ref), { ...intent, orderId, status: "failed" }, DAYS_400);
    throw new PaymobError("no_payment_key");
  }
  await withUserLock(u.email, async (x) => {
    if (!x.billing) return;
    x.billing = { ...x.billing, pending: { ref, day: today } };
    await saveUser(x);
  });
  const txn = await payWithToken(paymentKey, card.token);
  if (!txn || txn.pending) return "pending";
  // Our own call's answer over TLS: the reference is ours even when the answer does not echo it, but the order must match.
  if (txn.orderId !== null && txn.orderId !== orderId) return "pending";
  const r = await applyTransaction(cfg, { ...txn, ref: txn.ref ?? ref });
  return txn.success && (r.result === "paid" || r.result === "already") ? "paid" : r.status === 503 ? "pending" : "declined";
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
export async function lastCheckout(email: string): Promise<{ state: CheckoutState; kind?: IntentKind; plan?: SelfServePlan; credits?: number }> {
  const ref = await db.get<string>(lastCheckoutKey(email));
  if (typeof ref !== "string" || !REF.test(ref)) return { state: "none" };
  const intent = await db.get<PayIntent>(intentKey(ref));
  if (!intent || intent.email !== email) return { state: "none" };
  return { state: checkoutState(intent.status), kind: intent.kind, ...(intent.plan ? { plan: intent.plan } : {}), ...(intent.credits ? { credits: intent.credits } : {}) };
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
  b?.provider === "paymob" ? { plan: b.plan, status: b.status, paidThrough: b.paidThrough, graceUntil: b.graceUntil ?? null, autoRenew: b.autoRenew, card: b.card ?? null } : null;

/** The owner's renewal settings (spec 4.3). `email` is the session's account. */
export async function setRenewal(email: string, action: unknown): Promise<{ ok: true; billing: BillingView | null } | { ok: false; error: "bad_action" | "no_billing" | "no_card" }> {
  if (action !== "cancel" && action !== "resume" && action !== "remove_card") return { ok: false, error: "bad_action" };
  const card = action === "resume" ? await db.get<SavedCard>(cardKey(email)) : null;
  if (action === "remove_card") await db.del(cardKey(email));
  return withUserLock(email, async (u) => {
    if (!u.billing) return action === "remove_card" ? { ok: true as const, billing: null } : { ok: false as const, error: "no_billing" as const };
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
  const cfg = paymobConfig();
  if (!cfg) return { ok: false, error: "not_enabled" };
  const e = normalizeEmail(email);
  if (typeof id !== "string" || !/^pay_[a-f0-9]{8,32}$/.test(id)) return { ok: false, error: "not_found" };
  const p = (await db.hgetall<Payment>(paymentsKey(e)))[id];
  if (!p) return { ok: false, error: "not_found" };
  const m = /^paymob:(\d{1,15})$/.exec(p.reference ?? "");
  const txnId = m ? Number(m[1]) : 0;
  const rec = txnId ? await db.get<TxnRecord>(txnKey(txnId)) : null;
  if (!rec || rec.email !== e || rec.paymentId !== id) return { ok: false, error: "not_paymob" };
  let alreadyRefunded = !!(await db.get(refundedKey(txnId)));
  if (!alreadyRefunded) {
    if (!(await db.lock(refundLockKey(txnId), 60))) return { ok: false, error: "busy" };
    try {
      alreadyRefunded = !!(await db.get(refundedKey(txnId)));
      if (!alreadyRefunded) {
        try {
          await refundTxn(cfg, txnId, rec.amountCents);
        } catch (err) {
          logger.error("paymob refund", { error: err instanceof PaymobError ? err.message : "error" });
          return { ok: false, error: "paymob_refund_failed" };
        }
        await db.set(refundedKey(txnId), JSON.stringify({ at: new Date().toISOString(), by }), DAYS_400);
      }
    } finally {
      await db.unlock(refundLockKey(txnId));
    }
  }
  const why = typeof reason === "string" && reason.trim() ? reason : "paymob refund";
  if (p.topup) {
    const r = await voidPaidTopup(e, p.topup.lot, by, why);
    if (r.ok) return { ok: true, payment: r.payment ?? p, alreadyRefunded, planEnded: false };
  }
  const v = await voidPayment(e, id, by, why);
  if (!v.ok) return { ok: false, error: "not_found" };
  // A plan or renewal payment refunded in full ends the plan now (founder decision 2026-10-12, rule 1300). This path
  // always refunds the whole transaction (`rec.amountCents` above); a partial refund does not exist here, and one made
  // in Paymob's own dashboard reaches us only as a refunded transaction, which `applyTransaction` ignores: it changes
  // nothing on the account (open question in rule 1301). A pack's payment never reaches this line.
  const planEnded = await endPlanOnRefund(e, id, by);
  return { ok: true, payment: v.payment, alreadyRefunded, planEnded };
}

/**
 * The plan ends at the moment of a full refund (rule 1300): the plan goes back to an ended trial (`trialOver`, so every
 * spending gate refuses exactly as after a trial), the online subscription is removed (nothing renews: automatic renewal
 * is off with it), a hand-set paid-through day and an Agency deal go too, and the month's plan credits are set to 0.
 * Live top-up packs keep their credits: each is its own payment, refunded on its own. Under the ledger lock, once: a
 * retry finds the ended trial with no subscription and changes nothing. Seats are fitted to the trial's and the change
 * is logged with the balance before and after.
 */
async function endPlanOnRefund(email: string, paymentId: string, by: string): Promise<boolean> {
  const now = new Date();
  const change = await withUserLock(email, async (u) => {
    if (!u.billing && trialOver(u)) return null;
    const before = { plan: String(u.plan), credits: Number(u.credits) || 0, autoRenew: u.billing?.autoRenew ?? false, paidThrough: u.billing?.paidThrough ?? u.handPlan?.paidThrough ?? null };
    // The founding seat and the price lock end with the plan (rule 1708): the refunded account is no longer a paying one.
    const founding = endOnRefund(u, by, now.getTime());
    u.plan = "trial";
    // A second in the past: `trialOver` compares strictly, so a read in the same millisecond still sees it ended.
    u.trialEnds = new Date(now.getTime() - 1000).toISOString();
    delete u.billing;
    delete u.handPlan;
    delete u.deal;
    setMonthly(u, 0);
    await saveUser(u);
    return { before, after: { plan: u.plan, credits: u.credits, autoRenew: false, paidThrough: null }, founding };
  });
  if (!change) return false;
  await Promise.all([enforceSeats(email), change.founding ? freePlaces(email) : null]);
  await adminAudit({ actor: by, section: "billing", action: "refund_plan_ended", target: email, what: `refund_plan_ended payment:${paymentId} plan:${change.before.plan} credits:${change.before.credits}->${change.after.credits}${change.founding ? " founding_ended" : ""}`, before: change.before, after: change.after });
  return true;
}
