import { NextResponse } from "next/server";
import { adminActor, getUser, isAdmin, isPlan, normalizeEmail, saveUser, seatLimit, type Plan } from "@/lib/auth";
import { CAPS, db, pushCapped } from "@/lib/db";
import { monthKey, withUserLock } from "@/lib/credits";
import { getUsage } from "@/lib/usage";
import { pmap } from "@/lib/parallel";
import { enforceSeats } from "@/lib/team";
import { MAX_SEAT_OVERRIDE, SAR_PER_USD, allowanceOf, parseDeal, priceOf, type AgencyDeal, type DealInput } from "@/lib/pricing";

/** Largest founder credit adjustment, either way. Only a guard against a typo, and against JSON's 1e999 (Infinity). */
const MAX_ADD_CREDITS = 100_000;
/** A deal as the log and the console show it: "credits@priceSar", or "none". */
const dealLabel = (d: AgencyDeal | null | undefined) => (d ? `${d.credits}@${d.priceSar}` : "none");

// GET  /api/admin/plan → list users with this month's model usage, their plan, deal, allowance and list price.
// POST /api/admin/plan {email, plan?, deal?, addCredits?, seats?, reason?}
//      plan: set the plan; the balance resets to the account's allowance (src/lib/pricing.ts `allowanceOf`) and the
//            renewal cycle starts. Leaving Agency clears the deal, and with it the seat override (a deal's seats live
//            there), unless the same request sets `seats`.
//      deal: {credits, priceSar} sets the Agency contract, null clears it. Only on Agency (400 deal_needs_agency),
//            validated by `parseDeal` (400 bad_deal, or below_floor under the Business rate). A deal change alone keeps
//            the balance: the new allowance applies at the next renewal, or at once when sent with plan:"agency". A
//            deal's seats go through `seats`, the one seat source, so clearing a deal also clears the override back to
//            the plan's seats unless the same request sets `seats`.
//      addCredits: a whole number of credits to add or take (400 bad_credits when not finite or over the bound).
//      seats: set or clear (null or 0) the seat override.
//      A plan or seat change fits the team to the new limit at once (src/lib/team.ts `enforceSeats`): the newest
//      members over it are paused, never deleted. Every change is logged in admin:log with the deal before and after.
//      Rules 243-244, tests/admin-deal.test.ts.
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const emails = await db.smembers("users:all");
  const rows = await pmap(emails, async (e) => {
    const u = await getUser(e);
    if (!u) return null;
    const usage = await getUsage(u.email);
    // The list price, or an Agency account's deal price (Business's without a deal).
    const priceSar = priceOf(u);
    const costSar = usage.usd * SAR_PER_USD;
    return ({
      email: u.email, name: u.name, phone: u.phone, plan: u.plan, credits: u.credits, trialEnds: u.trialEnds, createdAt: u.createdAt,
      renewedAt: u.renewedAt ?? null, suspended: !!u.suspended, lang: u.lang,
      seats: seatLimit(u), seatsOverride: u.seats ?? null,
      deal: u.deal ?? null, allowance: allowanceOf(u),
      tokens: usage.in + usage.out, usd: usage.usd, calls: usage.calls, byKind: usage.byKind,
      priceSar,
      // A trial has no list price, so a margin would be meaningless rather than negative.
      marginPct: priceSar > 0 ? Math.round(((priceSar - costSar) / priceSar) * 100) : null,
    });
  });
  const users = rows.filter((x): x is NonNullable<typeof x> => !!x);
  users.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const total = await getUsage("_all");
  return NextResponse.json({ ok: true, count: users.length, users, total });
}

export async function POST(req: Request) {
  const who = await adminActor(req);
  if (!who) return NextResponse.json({ ok: false }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { email?: string; plan?: Plan; deal?: unknown; addCredits?: unknown; seats?: number | null; reason?: string };
  const email = typeof b.email === "string" ? normalizeEmail(b.email) : "";
  // A seat override is a whole number of seats, the owner included; null or 0 goes back to the plan's.
  const seatsGiven = b.seats !== undefined;
  const clearSeats = b.seats === null || b.seats === 0;
  if (seatsGiven && !clearSeats && !(typeof b.seats === "number" && Number.isInteger(b.seats) && b.seats >= 1 && b.seats <= MAX_SEAT_OVERRIDE)) {
    return NextResponse.json({ ok: false, error: "bad_seats" }, { status: 400 });
  }
  // Credits to add: a finite number within the bound. JSON 1e999 parses to Infinity, which the store would keep as null.
  const addGiven = b.addCredits !== undefined && b.addCredits !== null;
  if (addGiven && !(typeof b.addCredits === "number" && Number.isFinite(b.addCredits) && Math.abs(b.addCredits) <= MAX_ADD_CREDITS)) {
    return NextResponse.json({ ok: false, error: "bad_credits" }, { status: 400 });
  }
  const add = addGiven ? Math.trunc(b.addCredits as number) : 0;
  // The Agency deal: null clears it; anything else must parse and respect the Business rate (src/lib/pricing.ts).
  const dealGiven = b.deal !== undefined;
  const clearDeal = b.deal === null;
  let deal: DealInput | null = null;
  if (dealGiven && !clearDeal) {
    const p = parseDeal(b.deal);
    if (!p.ok) return NextResponse.json({ ok: false, error: p.error }, { status: 400 });
    deal = p.deal;
  }
  const planGiven = isPlan(b.plan);
  const prev = email ? await getUser(email) : null;
  if (!prev) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const before = { plan: String(prev.plan), credits: Number(prev.credits), seats: seatLimit(prev), deal: dealLabel(prev.deal) };
  let seatsReset = false;
  const done = await withUserLock(email, async (u) => {
    const plan = planGiven ? (b.plan as Plan) : u.plan;
    // Decided on the record as it is under the lock, before anything changes: a refused request writes nothing.
    if (deal && plan !== "agency") return "deal_needs_agency" as const;
    // The contract ends when the account leaves Agency or the deal is cleared. Its seats end with it: they live in the
    // seat override (decision 6), which `seatLimit` honours on every plan, so leaving it would keep a deal's 20 seats on
    // a Pro plan. A request that sets `seats` itself says what the new number is.
    const contractEnds = (u.plan === "agency" && plan !== "agency") || (clearDeal && !!u.deal);
    if (planGiven) u.plan = plan;
    // A deal lives only on Agency: leaving Agency clears it, so a later return to Agency starts from Business.
    if (u.plan !== "agency" || clearDeal) delete u.deal;
    if (contractEnds && !seatsGiven && u.seats !== undefined) { delete u.seats; seatsReset = true; }
    if (deal) u.deal = { credits: deal.credits, priceSar: deal.priceSar, setAt: new Date().toISOString(), setBy: who };
    if (planGiven) {
      u.credits = allowanceOf(u);
      u.renewedAt = monthKey();
    }
    if (addGiven) u.credits = Math.max(0, (Number.isFinite(u.credits) ? u.credits : 0) + add);
    if (clearSeats) delete u.seats;
    else if (seatsGiven) u.seats = b.seats as number;
    await saveUser(u);
    return u;
  });
  if (done === "deal_needs_agency") return NextResponse.json({ ok: false, error: "deal_needs_agency" }, { status: 400 });
  const user = done;
  // Every change to the seat limit, up or down, refits the team: paused members come back oldest-first when it grows.
  const team = planGiven || seatsGiven || seatsReset ? await enforceSeats(user.email) : null;
  const dealAfter = dealLabel(user.deal);
  const what = [
    planGiven ? `plan:${b.plan}` : "",
    // Named when sent, and when a plan change cleared it.
    dealGiven || dealAfter !== before.deal ? `deal:${dealAfter}` : "",
    addGiven ? `credits:${add}` : "",
    seatsGiven ? `seats:${clearSeats ? "plan" : b.seats}` : seatsReset ? "seats:plan" : "",
  ].filter(Boolean).join(" ") || "none";
  const teamChange = team && (team.disabled.length || team.enabled.length || team.cancelled.length) ? { disabled: team.disabled, enabled: team.enabled, cancelledInvites: team.cancelled.length } : undefined;
  await pushCapped("admin:log", JSON.stringify({ actor: who, email: user.email, what, before, after: { plan: user.plan, credits: user.credits, seats: seatLimit(user), deal: dealAfter }, team: teamChange, reason: (typeof b.reason === "string" ? b.reason.slice(0, 200) : "") || undefined, at: new Date().toISOString() }), CAPS.adminLog);
  return NextResponse.json({ ok: true, user: { email: user.email, plan: user.plan, credits: user.credits, renewedAt: user.renewedAt, seats: seatLimit(user), seatsOverride: user.seats ?? null, deal: user.deal ?? null, allowance: allowanceOf(user) }, ...(team ? { team } : {}) });
}
