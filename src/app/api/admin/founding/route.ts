import { NextResponse } from "next/server";
import { accountByLogin, adminActor, getUser, isAdmin, normalizeEmail, saveUser, type User } from "@/lib/auth";
import { acct } from "@/lib/account-id";
import { secondFactorRefusal } from "@/lib/admin-2fa";
import { withUserLock } from "@/lib/credits";
import { db } from "@/lib/db";
import { pmap } from "@/lib/parallel";
import { paymentsEnabled } from "@/lib/payments";
import { ksaDay } from "@/lib/partner-rules";
import { adminAudit, reasonRefused } from "@/lib/admin-audit";
import {
  FOUNDING_LOCK_MONTHS, FOUNDING_SEATS, LATER_LOCK_MONTHS, LOCKS_KEY, PRICE_LOCK_ACCOUNTS, REFUND_WINDOW_DAYS, SALE_START, SEATS_KEY,
  applyGrant, foundingView, freePlaces, isGrantAction, refundProposalFor, saleStarted, type GrantError,
} from "@/lib/founding";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/founding (rule 1709): the founding seats and price locks for the founder console. The counts are the
 * two sets' sizes; each counted account's seat, lock and 7-day refund proposal (src/lib/founding.ts `refundProposal`).
 * Founder only. Reads the accounts in parallel, never one by one.
 */
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const [seats, locks] = await Promise.all([db.zrangeWithScores(SEATS_KEY), db.zrangeWithScores(LOCKS_KEY)]);
  const seatSet = new Set(seats.map((s) => s.member));
  const emails = [...new Set([...seats.map((s) => s.member), ...locks.map((l) => l.member)])];
  const users = await pmap(emails, (e) => getUser(e));
  const today = ksaDay();
  const rows = emails.map((email, i) => {
    const u = users[i];
    // A place without an account record (a claim whose save never happened, an account deleted by hand): shown, so the founder can free it.
    if (!u) return { email, missing: true, inSeats: seatSet.has(email), seat: null, lock: null, refund: null };
    return { email, missing: false, inSeats: seatSet.has(email), plan: String(u.plan), ...foundingView(u), refund: refundProposalFor(u, today) };
  });
  return NextResponse.json({
    ok: true,
    rules: { seats: FOUNDING_SEATS, lockAccounts: PRICE_LOCK_ACCOUNTS, foundingMonths: FOUNDING_LOCK_MONTHS, laterMonths: LATER_LOCK_MONTHS, saleStart: SALE_START, refundDays: REFUND_WINDOW_DAYS },
    paymentsOn: paymentsEnabled(), started: saleStarted(today),
    seats: { taken: seats.length, left: Math.max(0, FOUNDING_SEATS - seats.length) },
    locks: { taken: locks.length },
    rows,
  });
}

const STATUS: Record<GrantError, number> = { bad_plan: 400, bad_from: 400, seats_full: 409, has_seat: 409, no_seat: 409, has_lock: 409, no_lock: 409 };

/**
 * POST /api/admin/founding {action, email, reason, plan?, from?} (rule 1710): the founder grants or ends a founding seat
 * or a price lock by hand. `grant_seat` | `end_seat` | `grant_lock` (plan: the subscription's by default; from: a Riyadh
 * day, today by default) | `end_lock`. Founder only (`adminActor`), the second factor (rule 1376), a reason of 3 to 200
 * characters (rule 1185), under the account's lock, and one audit row with the seat and lock before and after. Ending
 * frees the place in its counted set. No money moves here.
 */
export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const no2fa = await secondFactorRefusal(req, who);
  if (no2fa) return no2fa;
  const b = (await req.json().catch(() => ({}))) as { action?: unknown; email?: unknown; reason?: unknown; plan?: unknown; from?: unknown };
  if (!isGrantAction(b.action)) return NextResponse.json({ ok: false, error: "bad_action" }, { status: 400 });
  const action = b.action;
  const noReason = reasonRefused(b.reason);
  if (noReason) return noReason;
  const email = typeof b.email === "string" ? normalizeEmail(b.email) : "";
  if (!email) return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  type View = ReturnType<typeof foundingView>;
  let done: { ok: true; before: View; after: View; free?: { seat?: boolean; lock?: boolean } } | { ok: false; error: GrantError };
  // The address names the account; the lock and the save use its id (rule 1982).
  const account = await accountByLogin(email);
  if (!account) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  try {
    done = await withUserLock(acct(account), async (u: User) => {
      const before = foundingView(u);
      const r = await applyGrant(u, action, { plan: b.plan, from: b.from }, who);
      if (!r.ok) return r;
      await saveUser(u);
      return { ok: true as const, before, after: foundingView(u), free: r.free };
    });
  } catch (e) {
    if (e instanceof Error && e.message === "user_not_found") return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    throw e;
  }
  if (!done.ok) return NextResponse.json(done, { status: STATUS[done.error] });
  if (done.free) await freePlaces(email, done.free);
  await adminAudit({ actor: who, section: "billing", action: `founding_${action}`, target: email, what: `founding_${action} ${email}`, before: done.before, after: done.after, reason: b.reason });
  return NextResponse.json({ ok: true, email, ...done.after });
}
