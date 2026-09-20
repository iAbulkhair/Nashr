import { randomBytes } from "crypto";
import { db } from "./db";
import { getUser, type User } from "./auth";
import { charge, refund } from "./credits";
import { judgeLater } from "./judge";
import { TASK_COST, getBrand, indexedAt, listLite, listPreferences, rebuildIndex, rebuildPending, saveTask, type Brand, type Task } from "./brand";
import { generate } from "./noor";
import { memoryBlock } from "./files";
import { getGov } from "./governance";
import { activeSeasons } from "./seasons";
import { dateFormat } from "./dates";

/** Per-user recurring tasks. Cron hits /api/cron/* → we loop users. */
export type Schedule = { weeklyPlan: boolean; dailyBrief: boolean; followUps: boolean; lastWeekly?: string; lastDaily?: string };
export const DEFAULT_SCHEDULE: Schedule = { weeklyPlan: true, dailyBrief: true, followUps: true };

export async function getSchedule(email: string): Promise<Schedule> {
  return { ...DEFAULT_SCHEDULE, ...((await db.get<Partial<Schedule>>(`schedule:${email}`)) ?? {}) };
}
export async function saveSchedule(email: string, s: Partial<Schedule>) {
  const next = { ...(await getSchedule(email)), ...s };
  await db.set(`schedule:${email}`, next);
  return next;
}

export type Brief = { date: string; text: string; pending: number; approved7d: number; credits: number; seasons: string[] };

export async function latestBrief(email: string) {
  return db.get<Brief>(`brief:${email}`);
}

/** The Sunday that starts the current UTC week, as YYYY-MM-DD. The weekly cron keys its markers to the same day. */
export function weekStartUtc(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
/**
 * Has the weekly plan already run in THIS Sunday-to-Saturday week?
 *
 * A rolling five-day window was wrong because it straddles the period boundary: a manual "Run now" on Wednesday, or a
 * Tuesday catch-up, sat less than five days before the next Sunday, so that Sunday's run was refused and the cron
 * marker recorded the week as done. The owner simply got no plan that week, with no error anywhere.
 */
export const ranThisWeek = (lastWeekly: string | undefined, now: Date = new Date()): boolean =>
  !!lastWeekly && lastWeekly.slice(0, 10) >= weekStartUtc(now);

/** Weekly plan for one user. Returns what happened. */
export async function runWeekly(user: User): Promise<string> {
  const email = user.scope ?? user.email;
  const brand = await getBrand(email);
  if (!brand) return "no_brand";
  const sched = await getSchedule(email);
  if (!sched.weeklyPlan) return "off";
  // Belt and braces next to the cron markers: never charge or generate twice for the same week.
  if (ranThisWeek(sched.lastWeekly)) return "already_this_week";
  if (!(await db.lock(`weeklylock:${email}`, 300))) return "retry:locked";
  try {
    return await weeklyFor(user, email, brand);
  } finally {
    await db.unlock(`weeklylock:${email}`);
  }
}

async function weeklyFor(user: User, email: string, brand: Brand): Promise<string> {
  const gov = await getGov(email);
  const cost = TASK_COST.weekly_plan;
  if (user.plan === "trial" && new Date(user.trialEnds) < new Date()) return "trial_over";
  // weekly cap: count items Noor created on her own in the last 7 days
  const weekAgo = Date.now() - 7 * 864e5;
  const auto = (await listLite(email, new Date(weekAgo))).filter((t) => t.source === "scheduled").length;
  if (auto >= gov.weeklyCap) return "cap_reached";
  const paid = await charge(user.email, cost);
  if (!paid.ok) return "no_credits";
  user.credits = paid.credits;
  let items;
  try {
    items = await generate("weekly_plan", brand, await listPreferences(email), "This is the automatic Sunday plan. Reference strategy.md phases and the calendar.", { memory: await memoryBlock(email), reviewer: gov.reviewer, noEmDash: gov.noEmDash, meter: user.email });
  } catch (e) {
    user.credits = await refund(user.email, cost);
    throw e;
  }
  const created: Task[] = [];
  for (const it of items) {
    const t: Task = { id: randomBytes(8).toString("hex"), type: "weekly_plan", channel: it.channel, title: it.title, body: it.body, status: gov.autoApprove.weekly_plan ? "approved" : "pending", createdAt: new Date().toISOString(), lang: brand.languages[0] ?? "ar", source: "scheduled" };
    await saveTask(email, t, true);
    created.push(t);
  }
  judgeLater(email, user.email, brand, created);
  await saveSchedule(email, { lastWeekly: new Date().toISOString() });
  const { notifyItem } = await import("./notifications");
  await notifyItem(user.email, user.lang, { kind: "weekly", agent: "noor", title: user.lang === "ar" ? "خطة الأسبوع جاهزة في صندوق الموافقة" : "This week's plan is ready in your inbox", body: user.lang === "ar" ? `${items.length} عنصر من نور. اعتمد ما يعجبك وعيّن تواريخ النشر.` : `${items.length} item(s) from Noor. Approve what you like and set publish dates.`, href: "" }, `weekly:${new Date().toISOString().slice(0, 10)}`, 2);
  return `ok:${items.length}`;
}

/** Daily brief: no model call, no credits. Pure summary from stored data. */
export async function runDaily(user: User): Promise<Brief | null> {
  const email = user.scope ?? user.email;
  const sched = await getSchedule(email);
  if (!sched.dailyBrief) return null;
  const brand = await getBrand(email);
  // Weekly: rebuild the light index from the tasks themselves, so a write that failed half way cannot stay wrong for long.
  const stamp = await indexedAt(email);
  const tasks = stamp && Date.now() - new Date(stamp).getTime() < 7 * 864e5 ? await listLite(email) : await rebuildIndex(email);
  await rebuildPending(email, tasks); // daily reconcile of the pending-ids set
  const dayAgo = Date.now() - 7 * 864e5;
  const pending = tasks.filter((t) => t.status === "pending").length;
  const approved7d = tasks.filter((t) => t.status === "approved" && new Date(t.createdAt).getTime() > dayAgo).length;
  const seasons = activeSeasons().slice(0, 2).map((s) => `${s.nameAr} (${s.daysLeft} يوم)`);
  const ar = (brand?.languages[0] ?? user.lang) === "ar";
  const lines = ar
    ? [
        `صباح الخير ${user.name || ""} ☀️ ملخص نور لليوم:`,
        `• بانتظار موافقتك: ${pending} عنصر`,
        `• اعتمدت خلال 7 أيام: ${approved7d} عنصر`,
        `• رصيدك: ${user.credits} كريدت${user.plan === "trial" ? ` (التجربة تنتهي ${dateFormat("ar", { day: "numeric", month: "long" }).format(new Date(user.trialEnds))})` : ""}`,
        seasons.length ? `• المواسم القريبة: ${seasons.join("، ")}` : "• لا مواسم كبرى خلال 35 يوماً — وقت مناسب لبناء الجمهور",
        pending ? "الخطوة التالية: افتح صندوق الموافقة واعتمد ما يعجبك." : "الخطوة التالية: اطلب من نور دفعة جديدة في الدردشة.",
      ]
    : [
        `Good morning ${user.name || ""} ☀️ Noor's brief for today:`,
        `• Waiting for your approval: ${pending}`,
        `• Approved in the last 7 days: ${approved7d}`,
        `• Credits: ${user.credits}${user.plan === "trial" ? ` (trial ends ${dateFormat("en", { day: "numeric", month: "long" }).format(new Date(user.trialEnds))})` : ""}`,
        seasons.length ? `• Upcoming seasons: ${seasons.join(", ")}` : "• No major season within 35 days — good time to build audience",
        pending ? "Next step: open the inbox and approve what you like." : "Next step: ask Noor for a new batch in chat.",
      ];
  const brief: Brief = { date: new Date().toISOString().slice(0, 10), text: lines.join("\n"), pending, approved7d, credits: user.credits, seasons };
  await db.set(`brief:${email}`, brief);
  await saveSchedule(email, { lastDaily: new Date().toISOString() });
  return brief;
}

/** One entry per (user, active brand). Extra brands get their own copy with scope set. */
export async function allUsers(): Promise<User[]> {
  const { listBrands, scopeFor } = await import("./brands");
  const emails = await db.smembers("users:all");
  const { pmap } = await import("./parallel");
  const groups = await pmap(emails, async (e) => {
    const u = await getUser(e);
    if (!u || u.suspended) return [] as User[]; // suspended accounts get no scheduled work, no charges and no email
    return (await listBrands(e)).filter((x) => x.status === "active").map((b) => ({ ...u, brandId: b.id, scope: scopeFor(e, b.id) }));
  });
  return groups.flat();
}
