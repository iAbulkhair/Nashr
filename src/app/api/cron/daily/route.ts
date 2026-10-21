import { NextResponse } from "next/server";
import { after } from "next/server";
import { dailyRoster, runDaily } from "@/lib/schedule";
import { sweepHolds } from "@/lib/hold-sweep";
import { runCronBatch } from "@/lib/cron-batch";
import { sameSecret } from "@/lib/rate";
import { recordCronRun } from "@/lib/cron-heartbeat";
import type { User } from "@/lib/auth";
import { getBrand } from "@/lib/brand";
import { mailReady, sendEmail, sendOnce } from "@/lib/notify";
import { runLifecycle } from "@/lib/lifecycle";
import { renewIfDue, saveSettledTopups } from "@/lib/credits";
import { earlyOfferDue, grantEarlyOffer } from "@/lib/partners";
import { followUps, notifEmailText } from "@/lib/notifications";
import { getDigest } from "@/lib/notif-digest";
import { emailAllowed, readPrefs } from "@/lib/notify-prefs";
import { getUser } from "@/lib/auth";
import { syncAdsIfDue } from "@/lib/perf-store";
import { syncSiteIfDue } from "@/lib/site-stats";
import { syncSocialIfDue } from "@/lib/social-stats";
import { sweepOnboardHolds } from "@/lib/onboard-confirm";
import { purgeExpired, secretaryDaily } from "@/lib/secretary";
import { SWEEP_BUDGET_DAILY_MS, SWEEP_SCOPES, mergeReports, sweepReminders, type SweepReport } from "@/lib/secretary-remind";
import { appOrigin } from "@/lib/origin";
import { paragraphs } from "@/emails";
import { paymentsEnabled } from "@/lib/payments";
import { renewPaymob } from "@/lib/billing";
import { endHandPlanIfDue } from "@/lib/hand-plan-end";
import { handPlanEnded } from "@/lib/hand-plan";
import { ksaDay } from "@/lib/partner-rules";
import { runMarginAlert } from "@/lib/margin";
import { acct, brandOfScope } from "@/lib/account-id";
import { appHrefFor } from "@/lib/ws-href";
import { jobRef, runAsAccount, type JobRef } from "@/lib/job-account";

export const maxDuration = 300;

/** Everything the daily job does for one workspace. Returns a short outcome used for the report and the done marker. */
async function dailyFor(u: User): Promise<string> {
  const out: string[] = [];
  // Once per account, on its default brand's entry, and only when Paymob is configured: a subscription whose paid month
  // ended is charged on its saved card, or marked past due, or locked once its grace days are over (src/lib/billing.ts
  // `renewPaymob`, rules 710-714). Before the credit renewal, so a locked account gets no new month. Never fatal.
  if ((u.brandId ?? "default") === "default" && u.billing && paymentsEnabled()) {
    try {
      const r = await renewPaymob(acct(u));
      if (r) out.push(r);
    } catch (e) {
      out.push(`paymob_failed:${e instanceof Error ? e.message.slice(0, 40) : "error"}`);
    }
  }
  // Once per account, on its default brand's entry: a plan set by hand whose paid-through day has passed moves to the
  // trial state (src/lib/hand-plan-end.ts, rule 2274). Before the credit renewal, which gives such a plan nothing anyway
  // (rule 1303). The copy in hand only decides whether to take the lock; the lock checks again. Never fatal.
  if ((u.brandId ?? "default") === "default" && handPlanEnded(u, ksaDay())) {
    try {
      if (await endHandPlanIfDue(acct(u))) {
        out.push("hand_plan_ended");
        u.plan = "trial";
      }
    } catch {
      // Retried by the next day's run: the lock checks the record again.
      out.push("hand_plan_failed");
    }
  }
  // Monthly credit renewal for paid plans (no-op after the first brand of a multi-brand account).
  if (await renewIfDue(acct(u))) {
    out.push("renewed");
    const fresh = await getUser(acct(u));
    if (fresh) u.credits = fresh.credits;
  }
  // Once per account, on its default brand's entry: a top-up pack that expired leaves storage too. `getUser` already
  // took it out of the balance the moment it expired (src/lib/topups.ts `settleTopups`); this writes the settled record
  // under the ledger lock, so an account nobody opens does not keep an expired pack (rule 444).
  if ((u.brandId ?? "default") === "default" && u.topupsDirty) {
    try {
      const settled = await saveSettledTopups(acct(u));
      u.credits = settled.credits;
      if (settled.saved) out.push("topups_expired");
    } catch (e) {
      out.push(`topups_failed:${e instanceof Error ? e.message.slice(0, 40) : "error"}`);
    }
  }
  // Once per account, on its default brand's entry: an added brand's setup charge that no run charged or reused for a day
  // is refunded, or only dropped when its brand exists (src/lib/onboard-confirm.ts `sweepOnboardHolds`, rule 246). Covers
  // archived brands too, which have no entry of their own. A failure is reported and never stops the rest of the day.
  if ((u.brandId ?? "default") === "default" && u.onboardPaid) {
    try {
      const swept = await sweepOnboardHolds(u);
      if (swept) {
        u.credits = swept.credits;
        if (swept.refunded.length) out.push(`onboard_refunded:${swept.refunded.length}`);
        if (swept.dropped.length) out.push(`onboard_settled:${swept.dropped.length}`);
      }
    } catch (e) {
      out.push(`onboard_sweep_failed:${e instanceof Error ? e.message.slice(0, 40) : "error"}`);
    }
  }
  // Once per account, on its default brand's entry: the trial's last day grants the 15% first-month offer the day-3 note
  // names, whether or not mail is set up (the billing page shows it). src/lib/partners.ts, rule 394.
  if ((u.brandId ?? "default") === "default" && earlyOfferDue(u)) {
    try { if (await grantEarlyOffer(acct(u), (x) => earlyOfferDue(x))) out.push("offer"); } catch (e) { out.push(`offer_failed:${e instanceof Error ? e.message.slice(0, 40) : "error"}`); }
  }
  // Once per account too: every paid-once hold (the Sunday plan's, a routine's, a handoff item's) whose run was killed and
  // never retried is refunded, or its hold dropped when the work exists (src/lib/hold-sweep.ts `sweepHolds`, rules 337
  // and 2473-2475). Reported, never fatal.
  if ((u.brandId ?? "default") === "default" && u.paidOnce) {
    try {
      const swept = await sweepHolds(u);
      if (swept) {
        u.credits = swept.credits;
        const weekly = (c: string) => c.startsWith("weekly:");
        const nRefW = swept.refunded.filter((x) => weekly(x.claim)).length, nSetW = swept.dropped.filter(weekly).length;
        const counts: [string, number][] = [["weekly_refunded", nRefW], ["weekly_settled", nSetW], ["run_refunded", swept.refunded.length - nRefW], ["run_settled", swept.dropped.length - nSetW]];
        for (const [label, n] of counts) if (n) out.push(`${label}:${n}`);
      }
    } catch (e) {
      out.push(`hold_sweep_failed:${e instanceof Error ? e.message.slice(0, 40) : "error"}`);
    }
  }
  // Reem's list, for every scope with or without a brand: purge items deleted over 30 days ago, close the ones whose
  // linked inbox item was approved, and clean the away list of contacts back over 30 days ago: `todo:{purged}p{closed}c
  // {awayCleaned}a{warned}w{deleted}d`: warned and deleted count the closed copies of recurring series moved to the
  // deletion window and deleted (rules 502-505). A failure is reported and never stops the rest of this workspace's day.
  try {
    const sec = await secretaryDaily(u.scope ?? u.email);
    if (sec.purged || sec.closed || sec.awayCleaned || sec.warned || sec.deleted) out.push(`todo:${sec.purged}p${sec.closed}c${sec.awayCleaned}a${sec.warned}w${sec.deleted}d`);
  } catch (e) { out.push(`todo_failed:${e instanceof Error ? e.message.slice(0, 40) : "error"}`); }
  const brand = await getBrand(u.scope ?? u.email);
  // Signup nudge: registered but never built a brand (Enrich-style founder follow-up)
  if (!brand) {
    // Only when mail can reach the customer (MAIL_FROM set too), and marked as sent only once Resend accepted it
    // (src/lib/notify.ts `sendOnce`): a refused nudge is tried again on the next run instead of being recorded as done.
    if (Date.now() - new Date(u.createdAt).getTime() > 10 * 60e3 && mailReady()) {
      const ar = u.lang === "ar";
      const link = `${appOrigin()}${appHrefFor(u, u.lang, "/start", brandOfScope(u.scope ?? u.email))}`;
      const subject = ar ? "نور جاهزة — أعطيها رابط موقعك" : "Noor is ready — give her your website";
      const text = ar
        ? `أهلاً ${u.name}\n\nسجّلت في ذكين وما بدأت بعد. نور جاهزة: أعطيها رابط موقعك وتكتب ملف علامتك وخطتك أمامك، ثم اطلب منها أول دفعة منشورات.\n\n${link}`
        : `Hi ${u.name}\n\nYou signed up for Thakeen but have not started. Noor is ready: give her your website and she writes your brand file and plan in front of you, then ask her for your first batch of posts.\n\n${link}`;
      // The HTML part (rule 1961): the same paragraphs in the shared layout, the bare link turned into the button. The
      // name is what the owner typed at signup, so `notice` escapes it as text.
      const res = await sendOnce(u.email, "nudge1", subject, text, { template: "notice", locale: u.lang, context: { title: subject, paragraphs: paragraphs(text).filter((p) => p !== link), cta: { href: link } } });
      if (res === "sent") out.push("nudge");
      // Not "nudge_…": the report counts every outcome that starts with "nudge" as a nudge sent.
      else if (res === "failed") out.push("mail_refused:nudge");
    }
    return out.join("+") || "no_brand";
  }
  // Yesterday's ad results into Noor's memory before the brief. A refused token or an empty account is reported in
  // the outcome and never stops the rest of this workspace's day.
  try { const ads = await syncAdsIfDue(u.scope ?? u.email); if (ads) out.push(`ads:${ads}`); } catch (e) { out.push(`ads_failed:${e instanceof Error ? e.message.slice(0, 40) : "error"}`); }
  // The site's GA4 and Search Console totals for Dana, read the same way (src/lib/site-stats.ts).
  try { if (await syncSiteIfDue(u.scope ?? u.email)) out.push("site"); } catch (e) { out.push(`site_failed:${e instanceof Error ? e.message.slice(0, 40) : "error"}`); }
  const lc = await runLifecycle(u);
  if (lc.length) out.push(`lifecycle:${lc.length}`);
  const brief = await runDaily(u);
  const fu = await followUps(u, u.scope ?? u.email);
  if (fu.length) out.push(`followups:${fu.length}`);
  // Noor's brief email: every day, only when something waits, or never (Settings, Notifications; the old field reads the same, rule 1147).
  const [prefs, digest] = await Promise.all([readPrefs(u.scope ?? u.email, u.email), getDigest(acct(u))]);
  // With a digest on (rule 2356), the follow-ups reach the owner's email there, once, and not here as well.
  const mailed = digest === "off" ? fu : [];
  if (brief) {
    out.push("brief");
    // "important": something waits for a decision, a follow-up fired, or a to-do is overdue or due today.
    const worth = emailAllowed(prefs, "brief", brief.pending > 0 || fu.length > 0 || (brief.agenda?.overdue ?? 0) + (brief.agenda?.today ?? 0) > 0);
    const extra = mailed.length ? `\n\n${notifEmailText(u, mailed)}` : "";
    const app = `${appOrigin()}${appHrefFor(u, u.lang, "", brandOfScope(u.scope ?? u.email))}`;
    const text = brief.text + extra + `\n\n${app}`;
    // The HTML part is the same text in the shared layout (rule 1961): the model's brief is untrusted, so `dailyBrief`
    // escapes every paragraph and links only the button.
    if (worth && (await sendEmail({ to: u.email, subject: u.lang === "ar" ? `ملخص نور — ${brief.date}` : `Noor's brief — ${brief.date}`, text, template: "dailyBrief", context: { date: brief.date, body: text, href: app }, locale: u.lang }))) out.push("email");
  } else if (mailed.length && prefs.brief !== "none") {
    const subject = u.lang === "ar" ? "متابعة من فريق ذكين" : "Follow-up from your Thakeen team";
    const text = notifEmailText(u, fu);
    if (await sendEmail({ to: u.email, subject, text, template: "notice", context: { title: subject, paragraphs: paragraphs(text), cta: { href: `${appOrigin()}${appHrefFor(u, u.lang, "", brandOfScope(u.scope ?? u.email))}` } }, locale: u.lang })) out.push("email");
  }
  // Instagram and LinkedIn page results for Dana (src/lib/social-stats.ts), last: up to 30 post reads may be slow, and a
  // slow platform must never cost this workspace its brief or its email. Tomorrow's report reads what lands here.
  try { if (await syncSocialIfDue(u.scope ?? u.email)) out.push("social"); } catch (e) { out.push(`social_failed:${e instanceof Error ? e.message.slice(0, 40) : "error"}`); }
  return out.join("+") || "nothing_due";
}

/**
 * An archived brand or a suspended account gets no scheduled work, but items deleted there still expire: the purge runs
 * for those scopes too (bounded per scope like every purge), so a deleted item's text never outlives its 30 days.
 */
async function purgeIdle(scope: string): Promise<string> {
  const n = await purgeExpired(scope);
  return n ? `todo:${n}p` : "idle";
}

/** A workspace entry carries the account it acts for, taken at listing time (rule 2500); an idle scope only purges. */
type DailyItem = { user: User; ref: JobRef } | { idle: string };

/** How long the batch may start workspaces, counted from the route's start: the function limit minus the longest run. */
const START_BUDGET_MS = 240_000;
/** The reminder sweep repeats while it keeps hitting its scope cap, at most this many more times, within its budget. */
const SWEEP_REPEATS = 4;

/**
 * Reem's due reminders, the fallback when the QStash tick is not running: nothing new starts after
 * `SWEEP_BUDGET_DAILY_MS` from the route's start, and while a sweep read a full `SWEEP_SCOPES` it runs again (each
 * depends on the one before, so one after the other), at most `SWEEP_REPEATS` more times.
 */
async function sweepDaily(routeStart: number): Promise<SweepReport> {
  const deadline = routeStart + SWEEP_BUDGET_DAILY_MS;
  let last = await sweepReminders(Date.now(), { deadline });
  let total = last;
  for (let i = 0; i < SWEEP_REPEATS && last.scopes === SWEEP_SCOPES && Date.now() < deadline; i++) {
    last = await sweepReminders(Date.now(), { deadline });
    total = mergeReports(total, last);
  }
  return total;
}

/**
 * Daily job for every workspace, then Reem's purge for every idle scope (archived brands, suspended accounts): eight at
 * a time, each isolated from the others' failures, resumable through runCronBatch. From Sunday to Tuesday it also kicks
 * the weekly route so anyone Sunday missed still gets a plan. Its first hop also sweeps Reem's due reminders
 * (`sweepDaily`): without the QStash tick, that is when a reminder arrives, late but never lost. The sweep's time comes
 * out of the batch's start budget, so the batch never runs past the function's limit.
 */
export async function GET(req: Request) {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!sameSecret(bearer, process.env.CRON_SECRET)) return NextResponse.json({ ok: false }, { status: 401 });
  const routeStart = Date.now();
  let reminders: SweepReport | { error: string } | null = null;
  let margin: Awaited<ReturnType<typeof runMarginAlert>> | null = null;
  if (!Number(new URL(req.url).searchParams.get("chain") ?? 0)) {
    try { reminders = await sweepDaily(routeStart); } catch (e) { reminders = { error: e instanceof Error ? e.name : "error" }; }
    // Rule 1534: the founder's margin alert, once a day on the first hop (no cron schedule of its own). Read-only for
    // customers; it never throws, and its time comes out of the batch's start budget like the sweep's.
    margin = await runMarginAlert();
  }
  const roster = await dailyRoster();
  const items: DailyItem[] = [...roster.users.map((user) => ({ user, ref: jobRef(user) })), ...roster.idle.map((idle) => ({ idle }))];
  const report = await runCronBatch({
    job: "daily", period: new Date().toISOString().slice(0, 10), items,
    id: (x) => ("user" in x ? x.user.scope ?? x.user.email : `idle:${x.idle}`), run: (x) => ("user" in x ? runAsAccount(x.ref, dailyFor) : purgeIdle(x.idle)),
    concurrency: 8, startBudgetMs: Math.max(0, START_BUDGET_MS - (Date.now() - routeStart)), markerTtlSeconds: 2 * 86400, req,
  });
  if (!report.chained && new Date().getUTCDay() <= 2) {
    // On `appOrigin()`, never `req.url`: behind the Hostinger proxy that is the internal address (rule 904).
    const weekly = `${appOrigin()}/api/cron/weekly`;
    const headers = { authorization: req.headers.get("authorization") ?? "" };
    after(() => fetch(weekly, { headers, signal: AbortSignal.timeout(8000) }).then(() => undefined, () => undefined));
  }
  await recordCronRun("daily");
  const count = (word: string) => Object.values(report.results).filter((r) => r.split("+").some((x) => x.startsWith(word))).length;
  return NextResponse.json({ ok: true, ...report, briefs: count("brief"), emails: count("email"), nudges: count("nudge"), renewed: count("renewed"), emailConfigured: mailReady(), reminders, margin });
}
