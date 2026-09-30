import { NextResponse } from "next/server";
import { after } from "next/server";
import { dailyRoster, runDaily } from "@/lib/schedule";
import { runCronBatch } from "@/lib/cron-batch";
import { sameSecret } from "@/lib/rate";
import type { User } from "@/lib/auth";
import { getBrand } from "@/lib/brand";
import { once, sendEmail } from "@/lib/notify";
import { runLifecycle } from "@/lib/lifecycle";
import { db } from "@/lib/db";
import { renewIfDue } from "@/lib/credits";
import { followUps, notifEmailText } from "@/lib/notifications";
import { getUser } from "@/lib/auth";
import { syncAdsIfDue } from "@/lib/perf-store";
import { sweepOnboardHolds } from "@/lib/onboard-confirm";
import { purgeExpired, secretaryDaily } from "@/lib/secretary";

export const maxDuration = 300;

const ORIGIN = () => process.env.APP_ORIGIN ?? "https://nashr-tau.vercel.app";

/** Everything the daily job does for one workspace. Returns a short outcome used for the report and the done marker. */
async function dailyFor(u: User): Promise<string> {
  const out: string[] = [];
  // Monthly credit renewal for paid plans (no-op after the first brand of a multi-brand account).
  if (await renewIfDue(u.email)) {
    out.push("renewed");
    const fresh = await getUser(u.email);
    if (fresh) u.credits = fresh.credits;
  }
  // Once per account, on its default brand's entry: an added brand's setup charge that no run charged or reused for a day
  // is refunded, or only dropped when its brand exists (src/lib/onboard-confirm.ts `sweepOnboardHolds`, rule 226). Covers
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
  // Reem's list, for every scope with or without a brand: purge items deleted over 30 days ago and close the ones whose
  // linked inbox item was approved. A failure is reported and never stops the rest of this workspace's day.
  try { const sec = await secretaryDaily(u.scope ?? u.email); if (sec.purged || sec.closed) out.push(`todo:${sec.purged}p${sec.closed}c`); } catch (e) { out.push(`todo_failed:${e instanceof Error ? e.message.slice(0, 40) : "error"}`); }
  const brand = await getBrand(u.scope ?? u.email);
  // Signup nudge: registered but never built a brand (Enrich-style founder follow-up)
  if (!brand) {
    if (Date.now() - new Date(u.createdAt).getTime() > 10 * 60e3 && process.env.RESEND_API_KEY && (await once(u.email, "nudge1"))) {
      const ar = u.lang === "ar";
      const link = `${ORIGIN()}/${u.lang}/app/start`;
      const ok = await sendEmail(u.email, ar ? "نور جاهزة — أعطيها رابط موقعك" : "Noor is ready — give her your website", ar
        ? `أهلاً ${u.name}\n\nسجّلت في نشر وما بدأت بعد. نور جاهزة: أعطيها رابط موقعك وتكتب ملف علامتك وخطتك أمامك، ثم اطلب منها أول دفعة منشورات.\n\n${link}`
        : `Hi ${u.name}\n\nYou signed up for Nashr but have not started. Noor is ready: give her your website and she writes your brand file and plan in front of you, then ask her for your first batch of posts.\n\n${link}`);
      if (ok) out.push("nudge");
    }
    return out.join("+") || "no_brand";
  }
  // Yesterday's ad results into Noor's memory before the brief. A refused token or an empty account is reported in
  // the outcome and never stops the rest of this workspace's day.
  try { const ads = await syncAdsIfDue(u.scope ?? u.email); if (ads) out.push(`ads:${ads}`); } catch (e) { out.push(`ads_failed:${e instanceof Error ? e.message.slice(0, 40) : "error"}`); }
  const lc = await runLifecycle(u);
  if (lc.length) out.push(`lifecycle:${lc.length}`);
  const brief = await runDaily(u);
  const fu = await followUps(u, u.scope ?? u.email);
  if (fu.length) out.push(`followups:${fu.length}`);
  const pref = ((await db.get<{ emails?: string }>(`profile:${u.scope ?? u.email}`)) ?? (await db.get<{ emails?: string }>(`profile:${u.email}`)) ?? {}).emails ?? "all";
  if (brief) {
    out.push("brief");
    // "important": something waits for a decision, a follow-up fired, or a to-do is overdue or due today.
    const worth = pref === "all" || (pref === "important" && (brief.pending > 0 || fu.length > 0 || (brief.agenda?.overdue ?? 0) + (brief.agenda?.today ?? 0) > 0));
    const extra = fu.length ? `\n\n${notifEmailText(u, fu)}` : "";
    if (worth && (await sendEmail(u.email, u.lang === "ar" ? `ملخص نور — ${brief.date}` : `Noor's brief — ${brief.date}`, brief.text + extra + `\n\n${ORIGIN()}/${u.lang}/app`))) out.push("email");
  } else if (fu.length && pref !== "none") {
    if (await sendEmail(u.email, u.lang === "ar" ? "متابعة من فريق نشر" : "Follow-up from your Nashr team", notifEmailText(u, fu))) out.push("email");
  }
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

type DailyItem = { user: User } | { idle: string };

/**
 * Daily job for every workspace, then Reem's purge for every idle scope (archived brands, suspended accounts): eight at
 * a time, each isolated from the others' failures, resumable through runCronBatch. From Sunday to Tuesday it also kicks
 * the weekly route so anyone Sunday missed still gets a plan.
 */
export async function GET(req: Request) {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!sameSecret(bearer, process.env.CRON_SECRET)) return NextResponse.json({ ok: false }, { status: 401 });
  const roster = await dailyRoster();
  const items: DailyItem[] = [...roster.users.map((user) => ({ user })), ...roster.idle.map((idle) => ({ idle }))];
  const report = await runCronBatch({
    job: "daily", period: new Date().toISOString().slice(0, 10), items,
    id: (x) => ("user" in x ? x.user.scope ?? x.user.email : `idle:${x.idle}`), run: (x) => ("user" in x ? dailyFor(x.user) : purgeIdle(x.idle)),
    concurrency: 8, startBudgetMs: 240_000, markerTtlSeconds: 2 * 86400, req,
  });
  if (!report.chained && new Date().getUTCDay() <= 2) {
    const weekly = new URL("/api/cron/weekly", req.url).toString();
    const headers = { authorization: req.headers.get("authorization") ?? "" };
    after(() => fetch(weekly, { headers, signal: AbortSignal.timeout(8000) }).then(() => undefined, () => undefined));
  }
  const count = (word: string) => Object.values(report.results).filter((r) => r.split("+").some((x) => x.startsWith(word))).length;
  return NextResponse.json({ ok: true, ...report, briefs: count("brief"), emails: count("email"), nudges: count("nudge"), renewed: count("renewed"), emailConfigured: !!process.env.RESEND_API_KEY });
}
