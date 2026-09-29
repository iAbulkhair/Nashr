import { NextResponse } from "next/server";
import { PLAN_CREDITS, adminActor, getUser, isAdmin, isPlan, normalizeEmail, saveUser, seatLimit, type Plan } from "@/lib/auth";
import { CAPS, db, pushCapped } from "@/lib/db";
import { monthKey, withUserLock } from "@/lib/credits";
import { getUsage } from "@/lib/usage";
import { PLAN_PRICE_SAR } from "@/lib/admin-stats";
import { pmap } from "@/lib/parallel";
import { enforceSeats } from "@/lib/team";

/** SAR per USD, for the margin column. One place, so the number is not repeated across the console. */
const SAR_PER_USD = 3.75;
/** Upper bound of a founder seat override. Enterprise is 25 by plan; this only guards against a typo. */
const MAX_SEATS = 500;

// GET  /api/admin/plan            → list users with this month's model usage
// POST /api/admin/plan {email, plan?, addCredits?, seats?, reason?} → set plan (resets to plan allowance, starts renewal
//      cycle) / add credits / set or clear (null or 0) the seat override. A plan or seat change fits the team to the new
//      limit at once (src/lib/team.ts `enforceSeats`): the newest members over it are paused, never deleted.
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const emails = await db.smembers("users:all");
  const rows = await pmap(emails, async (e) => {
    const u = await getUser(e);
    if (!u) return null;
    const usage = await getUsage(u.email);
    const priceSar = PLAN_PRICE_SAR[u.plan] ?? 0;
    const costSar = usage.usd * SAR_PER_USD;
    return ({
      email: u.email, name: u.name, phone: u.phone, plan: u.plan, credits: u.credits, trialEnds: u.trialEnds, createdAt: u.createdAt,
      renewedAt: u.renewedAt ?? null, suspended: !!u.suspended, lang: u.lang,
      seats: seatLimit(u), seatsOverride: u.seats ?? null,
      tokens: usage.in + usage.out, usd: usage.usd, calls: usage.calls, byKind: usage.byKind,
      priceSar,
      // Trial and enterprise have no list price, so a margin would be meaningless rather than negative.
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
  const b = (await req.json().catch(() => ({}))) as { email?: string; plan?: Plan; addCredits?: number; seats?: number | null; reason?: string };
  const email = typeof b.email === "string" ? normalizeEmail(b.email) : "";
  // A seat override is a whole number of seats, the owner included; null or 0 goes back to the plan's.
  const seatsGiven = b.seats !== undefined;
  const clearSeats = b.seats === null || b.seats === 0;
  if (seatsGiven && !clearSeats && !(typeof b.seats === "number" && Number.isInteger(b.seats) && b.seats >= 1 && b.seats <= MAX_SEATS)) {
    return NextResponse.json({ ok: false, error: "bad_seats" }, { status: 400 });
  }
  const prev = email ? await getUser(email) : null;
  if (!prev) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const before = { plan: String(prev.plan), credits: Number(prev.credits), seats: seatLimit(prev) };
  const user = await withUserLock(email, async (u) => {
    if (isPlan(b.plan)) {
      u.plan = b.plan;
      u.credits = PLAN_CREDITS[b.plan];
      u.renewedAt = monthKey();
    }
    if (typeof b.addCredits === "number") u.credits = Math.max(0, u.credits + Math.trunc(b.addCredits));
    if (clearSeats) delete u.seats;
    else if (seatsGiven) u.seats = b.seats as number;
    await saveUser(u);
    return u;
  });
  // Every change to the seat limit, up or down, refits the team: paused members come back oldest-first when it grows.
  const team = isPlan(b.plan) || seatsGiven ? await enforceSeats(user.email) : null;
  const what = [isPlan(b.plan) ? `plan:${b.plan}` : "", typeof b.addCredits === "number" ? `credits:${b.addCredits}` : "", seatsGiven ? `seats:${clearSeats ? "plan" : b.seats}` : ""].filter(Boolean).join(" ") || "none";
  const teamChange = team && (team.disabled.length || team.enabled.length || team.cancelled.length) ? { disabled: team.disabled, enabled: team.enabled, cancelledInvites: team.cancelled.length } : undefined;
  await pushCapped("admin:log", JSON.stringify({ actor: who, email: user.email, what, before, after: { plan: user.plan, credits: user.credits, seats: seatLimit(user) }, team: teamChange, reason: (typeof b.reason === "string" ? b.reason.slice(0, 200) : "") || undefined, at: new Date().toISOString() }), CAPS.adminLog);
  return NextResponse.json({ ok: true, user: { email: user.email, plan: user.plan, credits: user.credits, renewedAt: user.renewedAt, seats: seatLimit(user), seatsOverride: user.seats ?? null }, ...(team ? { team } : {}) });
}
