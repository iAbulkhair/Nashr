import { NextResponse } from "next/server";
import { adminActor, getUser, normalizeEmail } from "@/lib/auth";
import { CAPS, pushCapped } from "@/lib/db";
import { addTopup, voidTopup, type TopupChange } from "@/lib/credits";
import { parseTopup, topupCredits } from "@/lib/topups";

export const dynamic = "force-dynamic";

/** A pack id as `addTopup` writes it: 16 hex characters. Anything else is never looked up. */
const LOT_ID = /^[0-9a-f]{16}$/;

const STATUS: Record<Extract<TopupChange, { ok: false }>["error"], number> = { topup_needs_paid_plan: 409, too_many_topups: 409, topup_not_found: 404 };

/**
 * Credit top-ups, activated by hand (rules 446-447): there is no payment gateway yet, so the owner asks on WhatsApp from
 * the billing page, pays, and the founder records the payment here, which puts the pack on the account at once.
 *
 * POST /api/admin/topups {email, action: "add", credits, paidSar, paidOn, ref?, reason?}
 *      credits: one of TOPUP_PACKS (src/lib/pricing.ts); paidSar: the amount paid excluding VAT; paidOn: the payment's
 *      date, YYYY-MM-DD; ref: the payment reference (`parseTopup` in src/lib/topups.ts checks all four: 400 bad_pack,
 *      bad_paid, bad_date or bad_ref, before any read). A trial is refused (409 topup_needs_paid_plan: packs are sold to
 *      paid plans only), and so is a 51st live pack (409 too_many_topups). The pack is valid TOPUP_VALID_DAYS from now.
 * POST /api/admin/topups {email, action: "void", id, reason?}
 *      Removes the pack and the credits still in it (a payment reversed, a pack recorded by mistake); credits already
 *      spent from it stay spent. 400 bad_id for an id that is not 16 hex characters, 404 topup_not_found.
 *
 * The founder only (`adminActor`: the console cookie, a founder signed in as themselves, or the key header), else 401
 * before the body is read. The account comes from the body's email and is changed only under the ledger lock
 * (`addTopup` / `voidTopup` in src/lib/credits.ts). Every change is logged in admin:log with the actor, the balance
 * before and after, the pack, what was paid and the payment date; the payment reference stays on the pack only.
 */
export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { email?: unknown; action?: unknown; id?: unknown; reason?: unknown };
  const email = typeof b.email === "string" ? normalizeEmail(b.email) : "";
  const reason = (typeof b.reason === "string" ? b.reason.slice(0, 200) : "") || undefined;
  if (b.action !== "add" && b.action !== "void") return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  const parsed = b.action === "add" ? parseTopup(b) : null;
  if (parsed && !parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  if (b.action === "void" && !(typeof b.id === "string" && LOT_ID.test(b.id))) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  if (!email || !(await getUser(email))) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  let done: TopupChange;
  try {
    done = parsed?.ok ? await addTopup(email, { ...parsed.topup, by: who }) : await voidTopup(email, b.id as string);
  } catch (e) {
    // Deleted between the check above and the lock.
    if (e instanceof Error && e.message === "user_not_found") return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    throw e;
  }
  if (!done.ok) return NextResponse.json({ ok: false, error: done.error }, { status: STATUS[done.error] });
  const { lot } = done;
  const fresh = await getUser(email);
  const what = b.action === "add" ? `topup:+${lot.credits}` : `topup_void:${lot.credits} removed:${done.removed ?? 0}`;
  await pushCapped("admin:log", JSON.stringify({
    actor: who, email, what,
    before: { credits: done.before }, after: { credits: done.credits },
    // The pack as the console shows it, without the payment reference.
    topup: { id: lot.id, credits: lot.credits, paidSar: lot.paidSar, paidOn: lot.paidOn, expiresAt: lot.expiresAt },
    reason, at: new Date().toISOString(),
  }), CAPS.adminLog);
  return NextResponse.json({ ok: true, lot, credits: done.credits, topupCredits: fresh ? topupCredits(fresh) : 0, ...(b.action === "void" ? { removed: done.removed ?? 0 } : {}) });
}
