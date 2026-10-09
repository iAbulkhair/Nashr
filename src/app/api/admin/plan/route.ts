import { NextResponse } from "next/server";
import { adminActor, getUser, isAdmin, isPlan, normalizeEmail, saveUser, seatLimit, type Grant, type Plan } from "@/lib/auth";
import { CAPS, db, pushCapped } from "@/lib/db";
import { monthKey, withUserLock } from "@/lib/credits";
import { getUsage } from "@/lib/usage";
import { chatStatus } from "@/lib/chat-allowance";
import { route } from "@/lib/models/route";
import { chatUsdPerMessage } from "@/lib/admin-stats";
import { pmap } from "@/lib/parallel";
import { enforceSeats } from "@/lib/team";
import { MAX_SEAT_OVERRIDE, SAR_PER_USD, allowanceOf, chatAllowanceOf, isChatOverride, parseDeal, priceOf, type AgencyDeal, type DealInput } from "@/lib/pricing";
import { addMonthly, setMonthly, topupCredits } from "@/lib/topups";
import { parseVideoGrant } from "@/lib/entitlements";

/** Largest founder credit adjustment, either way. Only a guard against a typo, and against JSON's 1e999 (Infinity). */
const MAX_ADD_CREDITS = 100_000;
/** A deal as the log and the console show it: "credits@priceSar", or "none". */
const dealLabel = (d: AgencyDeal | null | undefined) => (d ? `${d.credits}@${d.priceSar}` : "none");
/** A video grant as the log shows it: "all@YYYY-MM-DD" for the grant on the record (expired or not), "plan" for none. */
const videoLabel = (g: Grant<"all"> | undefined) => (g ? `all@${g.until}` : "plan");

// GET  /api/admin/plan → list users with this month's model usage, their plan, deal, allowance and list price, and their
//      chat: messages counted against the allowance (`chatStatus.counted`, the raw count, the trial's for a trial), the
//      override, the owner's "continue on credits" switch, the messages continued on credits this month and the credits
//      they were billed, what chat cost this month and per message (`chatUsdPerMessage`, over every message sent).
//      Each row also carries `videoGrant`, the account's founder video grant or null (rule 783).
// POST /api/admin/plan {email, plan?, deal?, addCredits?, seats?, chatAllowance?, videoGrant?, reason?}
//      plan: set the plan; the month's plan credits reset to the account's allowance (src/lib/pricing.ts `allowanceOf`)
//            and the renewal cycle starts. Top-up packs keep what is left in them (src/lib/topups.ts `setMonthly`). Leaving Agency clears the deal, and with it the seat and chat overrides (a deal's
//            seats and chat messages live there), unless the same request sets `seats` / `chatAllowance`.
//      deal: {credits, priceSar} sets the Agency contract, null clears it. Only on Agency (400 deal_needs_agency),
//            validated by `parseDeal` (400 bad_deal, or below_floor under the Business rate). A deal change alone keeps
//            the balance: the new allowance applies at the next renewal, or at once when sent with plan:"agency". A
//            deal's seats go through `seats`, the one seat source, so clearing a deal also clears the override back to
//            the plan's seats unless the same request sets `seats`.
//      addCredits: a whole number of credits to add to or take from the month's plan credits (400 bad_credits when not
//            finite or over the bound). Taking never reaches a top-up pack: those leave only by a void (POST /api/admin/topups).
//      seats: set or clear (null or 0) the seat override.
//      chatAllowance: set the chat override, a whole number 0..MAX_CHAT_OVERRIDE (`isChatOverride`; 0 is an override that
//            stops chat for the account), or clear it with null or "" back to the plan's messages (`chatAllowanceOf`).
//            Anything else is 400 bad_chat. Like a deal's seats, it is cleared when the deal ends (rule 316).
//      videoGrant: {until, note?} opens every video model to the account through the end of the UTC day `until`, null
//            clears it (src/lib/entitlements.ts `parseVideoGrant`: `until` a real day after today and at most 366 days
//            ahead, `note` at most 200 characters on one line; anything else is 400 bad_grant, decided before the account
//            is read). Only `until` and `note` are read from the body: the value, the actor and the time are set here. A
//            plan change keeps the grant; only null removes it (rule 783, tests/entitlements-grant.test.ts).
//      A plan or seat change fits the team to the new limit at once (src/lib/team.ts `enforceSeats`): the newest
//      members over it are paused, never deleted. Every change is logged in admin:log with the deal before and after.
//      Rules 243-244 and 316, tests/admin-deal.test.ts.
export async function GET(req: Request) {
  if (!(await isAdmin(req))) return NextResponse.json({ ok: false }, { status: 401 });
  const emails = await db.smembers("users:all");
  const rows = await pmap(emails, async (e) => {
    const u = await getUser(e);
    if (!u) return null;
    const [usage, chat] = await Promise.all([getUsage(u.email), chatStatus(u, route("chat").model)]);
    // The list price, or an Agency account's deal price (Business's without a deal).
    const priceSar = priceOf(u);
    const costSar = usage.usd * SAR_PER_USD;
    // `chatStatus`, not the month counter alone: a trial's messages are counted once for the whole trial.
    const chatUsd = usage.byKind.chat?.usd ?? 0;
    return ({
      email: u.email, name: u.name, phone: u.phone, plan: u.plan, credits: u.credits, trialEnds: u.trialEnds, createdAt: u.createdAt,
      // Of `credits`, what is left in live top-up packs (src/lib/topups.ts): the rest is the month's plan credits.
      topupCredits: topupCredits(u),
      renewedAt: u.renewedAt ?? null, suspended: !!u.suspended, lang: u.lang,
      // Rule 776: when the owner proved the address (null: not yet, so the account reads as signed out until they do).
      emailVerifiedAt: u.emailVerifiedAt ?? null,
      seats: seatLimit(u), seatsOverride: u.seats ?? null,
      deal: u.deal ?? null, allowance: allowanceOf(u),
      videoGrant: u.grants?.video ?? null,
      tokens: usage.in + usage.out, usd: usage.usd, calls: usage.calls, byKind: usage.byKind,
      priceSar,
      // A trial has no list price, so a margin would be meaningless rather than negative.
      marginPct: priceSar > 0 ? Math.round(((priceSar - costSar) / priceSar) * 100) : null,
      // `chatUsed` is the RAW count (`counted`), not the owner's clamped `used`: after the allowance was lowered
      // mid-period it can pass `chatAllowance`, and the console shows that as it is.
      chatUsed: chat.counted, chatAllowance: chat.allowance, chatLeft: chat.left, chatPeriod: chat.period,
      chatOverride: u.chatAllowance ?? null, chatOverflowOn: chat.overflow.on, chatOverflowUsed: chat.overflow.used,
      // What the messages continued on credits were billed this month (each its metered cost, at most `chatOverflowHold`).
      chatCredits: chat.overflow.credits,
      chatUsd, usdPerMsg: chatUsdPerMessage(chatUsd, chat),
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
  const b = (await req.json().catch(() => ({}))) as { email?: string; plan?: Plan; deal?: unknown; addCredits?: unknown; seats?: number | null; chatAllowance?: unknown; videoGrant?: unknown; reason?: string };
  const email = typeof b.email === "string" ? normalizeEmail(b.email) : "";
  // A seat override is a whole number of seats, the owner included; null or 0 goes back to the plan's.
  const seatsGiven = b.seats !== undefined;
  const clearSeats = b.seats === null || b.seats === 0;
  if (seatsGiven && !clearSeats && !(typeof b.seats === "number" && Number.isInteger(b.seats) && b.seats >= 1 && b.seats <= MAX_SEAT_OVERRIDE)) {
    return NextResponse.json({ ok: false, error: "bad_seats" }, { status: 400 });
  }
  // A chat override is a whole number of messages; 0 is an override (chat stopped), so only null or "" goes back to the plan's.
  const chatGiven = b.chatAllowance !== undefined;
  const clearChat = b.chatAllowance === null || b.chatAllowance === "";
  if (chatGiven && !clearChat && !isChatOverride(b.chatAllowance)) {
    return NextResponse.json({ ok: false, error: "bad_chat" }, { status: 400 });
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
  // The founder's video grant: null clears it; anything else must parse (src/lib/entitlements.ts), before the account is read.
  const grantGiven = b.videoGrant !== undefined;
  const clearGrant = b.videoGrant === null;
  let grant: { until: string; note?: string } | null = null;
  if (grantGiven && !clearGrant) {
    const g = parseVideoGrant(b.videoGrant);
    if (!g.ok) return NextResponse.json({ ok: false, error: "bad_grant" }, { status: 400 });
    grant = g;
  }
  const planGiven = isPlan(b.plan);
  const prev = email ? await getUser(email) : null;
  if (!prev) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const before = { plan: String(prev.plan), credits: Number(prev.credits), seats: seatLimit(prev), chat: chatAllowanceOf(prev), deal: dealLabel(prev.deal), video: videoLabel(prev.grants?.video) };
  let seatsReset = false;
  let chatReset = false;
  let billingEnded = false;
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
    // A deal's chat messages live in the chat override, the same way: they end with the contract unless this request sets them.
    if (contractEnds && !chatGiven && u.chatAllowance !== undefined) { delete u.chatAllowance; chatReset = true; }
    if (deal) u.deal = { credits: deal.credits, priceSar: deal.priceSar, setAt: new Date().toISOString(), setBy: who };
    if (planGiven) {
      setMonthly(u, allowanceOf(u));
      u.renewedAt = monthKey();
      // A plan set by hand makes the account hand-managed: the online subscription (src/lib/billing.ts, rule 717) stops
      // renewing, and a renewal lock on it ends here. The saved card stays until the owner removes it or the account goes.
      if (u.billing) { delete u.billing; billingEnded = true; }
    }
    if (addGiven) addMonthly(u, add);
    if (clearSeats) delete u.seats;
    else if (seatsGiven) u.seats = b.seats as number;
    if (clearChat) delete u.chatAllowance;
    else if (chatGiven) u.chatAllowance = b.chatAllowance as number;
    // A grant is per dimension and outlives a plan change: only this field sets or clears it. The actor and the time are
    // the server's, never the body's; `by` and `at` are what make a stored grant count (`grantActive`).
    if (clearGrant && u.grants) { delete u.grants.video; if (!Object.keys(u.grants).length) delete u.grants; }
    else if (grant) u.grants = { ...u.grants, video: { value: "all", until: grant.until, by: who, at: new Date().toISOString(), ...(grant.note ? { note: grant.note } : {}) } };
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
    chatGiven ? `chat:${clearChat ? "plan" : b.chatAllowance}` : chatReset ? "chat:plan" : "",
    billingEnded ? "billing:manual" : "",
    grantGiven ? `video:${grant ? `all@${grant.until}` : "plan"}` : "",
  ].filter(Boolean).join(" ") || "none";
  const teamChange = team && (team.disabled.length || team.enabled.length || team.cancelled.length) ? { disabled: team.disabled, enabled: team.enabled, cancelledInvites: team.cancelled.length } : undefined;
  await pushCapped("admin:log", JSON.stringify({ actor: who, email: user.email, what, before, after: { plan: user.plan, credits: user.credits, seats: seatLimit(user), chat: chatAllowanceOf(user), deal: dealAfter, video: videoLabel(user.grants?.video) }, team: teamChange, reason: (typeof b.reason === "string" ? b.reason.slice(0, 200) : "") || undefined, at: new Date().toISOString() }), CAPS.adminLog);
  return NextResponse.json({ ok: true, user: { email: user.email, plan: user.plan, credits: user.credits, renewedAt: user.renewedAt, seats: seatLimit(user), seatsOverride: user.seats ?? null, deal: user.deal ?? null, allowance: allowanceOf(user), chatAllowance: chatAllowanceOf(user), chatOverride: user.chatAllowance ?? null, videoGrant: user.grants?.video ?? null }, ...(team ? { team } : {}) });
}
