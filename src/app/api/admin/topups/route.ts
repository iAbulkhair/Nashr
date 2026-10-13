import { NextResponse } from "next/server";
import { adminActor, getUser, normalizeEmail } from "@/lib/auth";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { addPaidTopup, refundPaidTopup, voidPaidTopup, type Payment, type PaidTopupError, type RefundTopupError } from "@/lib/partners";
import { parseTopup, parseTopupRefund, topupCredits } from "@/lib/topups";
import { adminAudit, reasonRefused } from "@/lib/admin-audit";

export const dynamic = "force-dynamic";

/** A pack id as `addTopup` writes it: 16 hex characters. Anything else is never looked up. */
const LOT_ID = /^[0-9a-f]{16}$/;
/** The console's id of one "Refund unused" request (`rf_` and hex), so a retry is recognised. */
const REFUND_ID = /^rf_[a-f0-9]{8,32}$/;

const STATUS: Record<PaidTopupError | RefundTopupError | "bad_credits" | "bad_ref", number> = {
  topup_needs_paid_plan: 409, too_many_topups: 409, payment_voided: 409, topup_not_found: 404, not_found: 404,
  bad_id: 400, bad_amount: 400, bad_plan: 400, bad_date: 400, bad_credits: 400, bad_ref: 400,
  topup_expired: 409, topup_voided: 409, topup_refunded: 409, topup_not_paid: 409, nothing_left: 409, left_changed: 409,
  not_refunded: 409, payment_missing: 409,
};

/** What the log line says of the pack's payment: its id and the partner's commission, or why none is due. */
const paymentText = (p: Payment | null) =>
  p ? ` payment:${p.id}${p.commission ? ` commission:${p.commission.sar}` : p.notCounted ? ` not_counted:${p.notCounted}` : ""}` : "";

/**
 * Credit top-ups, activated by hand (rules 446-447, 454-455, 460): there is no payment gateway yet, so the owner asks on
 * WhatsApp from the billing page, pays, and the founder records the payment here, which puts the pack on the account at
 * once and records the payment (src/lib/partners.ts `addPaidTopup`).
 *
 * POST /api/admin/topups {email, action: "add", credits, paidSar, paidOn, ref?, paymentId?, reason?}
 *      credits: one of TOPUP_PACKS (src/lib/pricing.ts); paidSar: the amount paid excluding VAT; paidOn: the payment's
 *      date, YYYY-MM-DD, not after today in Riyadh; ref: the payment reference (`parseTopup` in src/lib/topups.ts checks
 *      all four: 400 bad_pack, bad_paid, bad_date or bad_ref, before any read). paymentId: the console's request id
 *      (`pay_` and hex, 400 bad_id otherwise), kept until the request succeeds, so a retry adds one pack and records one
 *      payment. A trial is refused (409 topup_needs_paid_plan: packs are sold to paid plans only), and so is a 51st live
 *      pack (409 too_many_topups) and an id whose payment was voided (409 payment_voided). The pack is valid
 *      TOPUP_VALID_DAYS from now. When something was paid, the payment is recorded in the account's Payments with the
 *      partner's commission when one is due (15% of the amount before VAT, inside the partner's window): "Add top-up" is
 *      the only place a top-up's payment is recorded.
 * POST /api/admin/topups {email, action: "void", id, reason?}
 *      Voids the pack's payment (and its commission), then removes the pack and the credits still in it (a payment
 *      reversed, a pack recorded by mistake); credits already spent from it stay spent. 400 bad_id for an id that is not
 *      16 hex characters, 404 topup_not_found.
 * POST /api/admin/topups {email, action: "refund", id, credits, on, ref, refundId?, reason?}  (founder decision 2026-10-02)
 *      Refunds the unused credits of a live pack the customer asked to be paid back for, before it expires: `credits` the
 *      credits left the console showed (the amount is computed from them), `on` the transfer's day, `ref` its reference
 *      (`parseTopupRefund`: 400 bad_credits, bad_date, bad_ref; 400 bad_id for a malformed pack or request id, before any
 *      read). Under the account's ledger lock exactly the credits left leave the pack and the balance, the refund
 *      (credits left × the price per credit paid, excluding VAT) is recorded on the pack's payment and the partner's
 *      commission on it is reduced in proportion, once (`refundPaidTopup`). 409 topup_expired, topup_voided,
 *      topup_refunded, topup_not_paid, nothing_left, or left_changed (with the credits left and the amount now) change
 *      nothing; 404 topup_not_found. A retry with the same `refundId` answers `already`.
 * POST /api/admin/topups {email, action: "refund", id, finish: true, reason?}  (rule 465)
 *      "Finish refund": a refund that stopped after the credits left and before the pack's payment was marked is finished
 *      from the pack's own refund record (no credits, day or reference are sent: they are the pack's), so the partner's
 *      commission is reduced and Payments shows the refund. Answers `completed`, `already` when nothing was left to do,
 *      409 not_refunded on a pack never refunded. A pack whose "Add top-up" stopped before its payment was recorded has
 *      that payment recorded with the refund (409 payment_missing when the account is no longer on a paid plan).
 *
 * The founder only (`adminActor`: the console cookie, a founder signed in as themselves, or the key header), else 401
 * before the body is read. The account comes from the body's email and is changed only under the ledger lock
 * (`addTopup` / `voidTopup` in src/lib/credits.ts, `recordPayment` / `voidPayment` / `refundPaidTopup` in
 * src/lib/partners.ts). Every change is logged in admin:log with the actor, the balance before and after, the pack, what
 * was paid, the payment date, the payment id and the commission (and for a refund, the credits and amount refunded and
 * the commission before and after); payment and transfer references stay on the pack and the payment only. A retried
 * "add" or "refund" that changed nothing is not logged twice.
 */
export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  // Rule 1376: once a second factor is enrolled, a founder write needs a live step-up or a code (src/lib/admin-2fa.ts).
  const no2fa = await secondFactorRefusal(req, who);
  if (no2fa) return no2fa;
  const b = (await req.json().catch(() => ({}))) as { email?: unknown; action?: unknown; id?: unknown; reason?: unknown; paymentId?: unknown; refundId?: unknown; finish?: unknown };
  const email = typeof b.email === "string" ? normalizeEmail(b.email) : "";
  const reason = (typeof b.reason === "string" ? b.reason.slice(0, 200) : "") || undefined;
  if (b.action !== "add" && b.action !== "void" && b.action !== "refund") return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  // Add, void, refund and finish all ask a reason in the console, so the server asks it too (rule 1185).
  const noReason = reasonRefused(b.reason);
  if (noReason) return noReason;
  const parsed = b.action === "add" ? parseTopup(b) : null;
  if (parsed && !parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  // "Finish refund" sends no credits, day or reference: they come from the pack's refund record (rule 465).
  const finish = b.action === "refund" && b.finish === true;
  const asked = b.action === "refund" && !finish ? parseTopupRefund(b) : null;
  if (asked && !asked.ok) return NextResponse.json({ ok: false, error: asked.error }, { status: 400 });
  if (b.action === "add" && b.paymentId !== undefined && !(typeof b.paymentId === "string" && /^pay_[a-f0-9]{8,32}$/.test(b.paymentId))) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  if (b.action !== "add" && !(typeof b.id === "string" && LOT_ID.test(b.id))) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  if (b.action === "refund" && b.refundId !== undefined && !(typeof b.refundId === "string" && REFUND_ID.test(b.refundId))) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  if (!email || !(await getUser(email))) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  try {
    if (parsed?.ok) {
      const done = await addPaidTopup(email, { ...parsed.topup, paymentId: b.paymentId }, who);
      if (!done.ok) return NextResponse.json({ ok: false, error: done.error }, { status: STATUS[done.error] });
      const { lot, payment } = done;
      if (!done.already) {
        await adminAudit({
          actor: who, section: "billing", target: email, what: `topup:+${lot.credits}${paymentText(payment)}${done.reclassified ? ` reclassified:${done.reclassified.join(",")}` : ""}`,
          before: { credits: done.before }, after: { credits: done.credits },
          // The pack as the console shows it, without the payment reference.
          extra: { topup: { id: lot.id, credits: lot.credits, paidSar: lot.paidSar, paidOn: lot.paidOn, expiresAt: lot.expiresAt } },
          reason,
        });
      }
      const fresh = await getUser(email);
      return NextResponse.json({ ok: true, lot, credits: done.credits, topupCredits: fresh ? topupCredits(fresh) : 0, payment, already: done.already });
    }
    if (asked?.ok || finish) {
      const refundId = typeof b.refundId === "string" ? b.refundId : undefined;
      const done = await refundPaidTopup(email, b.id as string, asked?.ok ? { ...asked.refund, ...(refundId ? { id: refundId } : {}) } : { finish: true }, who);
      if (!done.ok) return NextResponse.json({ ok: false, error: done.error, ...(done.left !== undefined ? { left: done.left, sar: done.sar } : {}) }, { status: STATUS[done.error] });
      const { lot, payment, refunded } = done;
      if (!done.already) {
        const after = payment?.commission?.sar ?? (payment ? 0 : undefined);
        await adminAudit({
          actor: who, section: "billing", target: email,
          what: `topup_refund:${lot.credits} removed:${refunded.credits} sar:${refunded.sar}${payment ? ` payment:${payment.id}` : ""}${done.commissionBefore !== undefined && after !== undefined ? ` commission:${done.commissionBefore}->${after}` : ""}${done.completed ? " completed" : ""}${done.reclassified ? ` reclassified:${done.reclassified.join(",")}` : ""}`,
          before: { credits: done.before }, after: { credits: done.credits },
          // The pack and the refund, without the payment's or the transfer's reference.
          extra: {
            topup: { id: lot.id, credits: lot.credits, paidSar: lot.paidSar, paidOn: lot.paidOn, expiresAt: lot.expiresAt },
            refund: { credits: refunded.credits, sar: refunded.sar, on: lot.refund?.on },
          },
          reason,
        });
      }
      const fresh = await getUser(email);
      return NextResponse.json({ ok: true, lot, credits: done.credits, topupCredits: fresh ? topupCredits(fresh) : 0, refunded, payment, already: !!done.already, completed: !!done.completed });
    }
    const done = await voidPaidTopup(email, b.id as string, who, reason);
    if (!done.ok) return NextResponse.json({ ok: false, error: done.error }, { status: STATUS[done.error] });
    const { lot, payment } = done;
    await adminAudit({
      actor: who, section: "billing", target: email, what: `topup_void:${lot.credits} removed:${done.removed}${payment ? ` payment:${payment.id} void` : ""}${done.reclassified ? ` reclassified:${done.reclassified.join(",")}` : ""}`,
      before: { credits: done.before }, after: { credits: done.credits },
      extra: { topup: { id: lot.id, credits: lot.credits, paidSar: lot.paidSar, paidOn: lot.paidOn, expiresAt: lot.expiresAt } },
      reason,
    });
    const fresh = await getUser(email);
    return NextResponse.json({ ok: true, lot, credits: done.credits, topupCredits: fresh ? topupCredits(fresh) : 0, removed: done.removed, payment });
  } catch (e) {
    // Deleted between the check above and the lock.
    if (e instanceof Error && e.message === "user_not_found") return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    throw e;
  }
}
