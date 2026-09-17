import { randomBytes } from "crypto";
import { db } from "./db";
import { getUser, type User } from "./auth";
import { charge, refund } from "./credits";
import { judgeLater } from "./judge";
import { TASK_COST, getBrand, listPreferences, listTasks, saveTask, type Task } from "./brand";
import { generate } from "./noor";
import { memoryBlock } from "./files";
import { getGov } from "./governance";
import { activeSeasons } from "./seasons";

/** Per-user recurring tasks. Cron hits /api/cron/* → we loop users. */
export type Schedule = { weeklyPlan: boolean; dailyBrief: boolean; lastWeekly?: string; lastDaily?: string };
export const DEFAULT_SCHEDULE: Schedule = { weeklyPlan: true, dailyBrief: true };

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

/** Weekly plan for one user. Returns what happened. */
export async function runWeekly(user: User): Promise<string> {
  const email = user.scope ?? user.email;
  const brand = await getBrand(email);
  if (!brand) return "no_brand";
  const sched = await getSchedule(email);
  if (!sched.weeklyPlan) return "off";
  const gov = await getGov(email);
  const cost = TASK_COST.weekly_plan;
  if (user.plan === "trial" && new Date(user.trialEnds) < new Date()) return "trial_over";
  // weekly cap: count items Noor created on her own in the last 7 days
  const weekAgo = Date.now() - 7 * 864e5;
  const auto = (await listTasks(email)).filter((t) => t.source === "scheduled" && new Date(t.createdAt).getTime() > weekAgo).length;
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
  return `ok:${items.length}`;
}

/** Daily brief: no model call, no credits. Pure summary from stored data. */
export async function runDaily(user: User): Promise<Brief | null> {
  const email = user.scope ?? user.email;
  const sched = await getSchedule(email);
  if (!sched.dailyBrief) return null;
  const brand = await getBrand(email);
  const tasks = await listTasks(email);
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
        `• رصيدك: ${user.credits} كريدت${user.plan === "trial" ? ` (التجربة تنتهي ${user.trialEnds.slice(0, 10)})` : ""}`,
        seasons.length ? `• المواسم القريبة: ${seasons.join("، ")}` : "• لا مواسم كبرى خلال 35 يوماً — وقت مناسب لبناء الجمهور",
        pending ? "الخطوة التالية: افتح صندوق الموافقة واعتمد ما يعجبك." : "الخطوة التالية: اطلب من نور دفعة جديدة في الدردشة.",
      ]
    : [
        `Good morning ${user.name || ""} ☀️ Noor's brief for today:`,
        `• Waiting for your approval: ${pending}`,
        `• Approved in the last 7 days: ${approved7d}`,
        `• Credits: ${user.credits}${user.plan === "trial" ? ` (trial ends ${user.trialEnds.slice(0, 10)})` : ""}`,
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
  const out: User[] = [];
  for (const e of emails) {
    const u = await getUser(e);
    if (!u) continue;
    for (const b of (await listBrands(e)).filter((x) => x.status === "active")) {
      out.push({ ...u, brandId: b.id, scope: scopeFor(e, b.id) });
    }
  }
  return out;
}
