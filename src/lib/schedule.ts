import { randomBytes } from "crypto";
import { db } from "./db";
import { getUser, trialOver, type User } from "./auth";
import { charge, refund } from "./credits";
import { judgeLater } from "./judge";
import { TASK_COST, getBrand, indexedAt, listLite, listPreferencesFor, rebuildIndex, rebuildPending, saveTask, type Brand, type Task } from "./brand";
import { feedbackFor } from "./feedback";
import { generate } from "./noor";
import { modelState } from "./model";
import { memoryBlock } from "./files";
import { getGov } from "./governance";
import { activeSeasons } from "./seasons";
import { dateFormat } from "./dates";
import { initialStatus } from "./brand-rules";
import type { RoutineId } from "./routines";
import { briefAgenda, type BriefAgenda } from "./secretary-agenda";
import { agendaFor } from "./secretary";

/**
 * Per-user recurring tasks. Cron hits /api/cron/* → we loop users. `routines` holds the owner's opt-ins for the
 * routines in src/lib/routines.ts: all off unless turned on; their last runs live in their own keys, not here.
 */
export type Schedule = { weeklyPlan: boolean; dailyBrief: boolean; followUps: boolean; lastWeekly?: string; lastDaily?: string; routines?: Partial<Record<RoutineId, boolean>> };
/** The defaults of the default brand. An added brand's `weeklyPlan` defaults to off (`defaultsFor`). */
export const DEFAULT_SCHEDULE: Schedule = { weeklyPlan: true, dailyBrief: true, followUps: true };

/**
 * The Sunday plan charges TASK_COST.weekly_plan with nobody asking, so it is on by default only for the account's
 * default brand (scope = the account email). An added brand (`email#brandId`, src/lib/brands.ts `scopeFor`; an email
 * cannot contain "#") starts with it off, and the owner switches it on in Scheduled tasks. Rule 219.
 */
const defaultsFor = (scope: string): Schedule => ({ ...DEFAULT_SCHEDULE, weeklyPlan: !scope.includes("#") });

/**
 * What `schedule:{scope}` holds: only fields set explicitly, plus `weeklyPlanSetAt`, stamped whenever a save sets
 * `weeklyPlan` (only the owner's switch, PUT /api/schedule, does). Before 2026-09-30 every save wrote the merged
 * defaults back, and the daily run saves every brand every day, so every added brand that had seen one daily run stored
 * `weeklyPlan: true` although nobody chose it. On an added brand a stored `weeklyPlan` therefore counts only with the
 * stamp: an unstamped one is that old default, and the new default (off) applies. On the default brand the old and new
 * defaults agree (on), so a stored value counts as it always did, an owner's "off" included.
 */
type Stored = Partial<Schedule> & { weeklyPlanSetAt?: string };
function view(scope: string, stored: Stored): Schedule {
  const { weeklyPlanSetAt, weeklyPlan, ...rest } = stored;
  const s: Schedule = { ...defaultsFor(scope), ...rest };
  if (weeklyPlan !== undefined && (weeklyPlanSetAt || !scope.includes("#"))) s.weeklyPlan = weeklyPlan;
  return s;
}

export async function getSchedule(scope: string): Promise<Schedule> {
  return view(scope, (await db.get<Stored>(`schedule:${scope}`)) ?? {});
}
/**
 * Stores only what was ever set explicitly (the stored fields plus this patch), never the defaults, and returns the
 * merged view. Storing the merged view froze every default into the record on the first save, and runDaily saves
 * `lastDaily` for every brand every day: a default changed later (an added brand's Sunday plan) never reached a brand
 * that had seen one daily run. `routines` is merged per id, so turning one routine on or off leaves the others as they
 * were. Setting `weeklyPlan` stamps `weeklyPlanSetAt` (see `view`).
 */
export async function saveSchedule(scope: string, s: Partial<Schedule>): Promise<Schedule> {
  const stored = (await db.get<Stored>(`schedule:${scope}`)) ?? {};
  const next: Stored = { ...stored, ...s, ...(s.routines ? { routines: { ...stored.routines, ...s.routines } } : {}), ...(s.weeklyPlan !== undefined ? { weeklyPlanSetAt: new Date().toISOString() } : {}) };
  await db.set(`schedule:${scope}`, next);
  return view(scope, next);
}

/** `agenda`: Reem's counts and the first three overdue or due-today titles (absent on briefs written before 2026-09-29). */
export type Brief = { date: string; text: string; pending: number; approved7d: number; credits: number; seasons: string[]; agenda?: BriefAgenda };

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

/** The owner-notes line of the automatic Sunday plan; the judge is given the same text the agent was. */
const WEEKLY_NOTE = "This is the automatic Sunday plan. Reference strategy.md phases and the calendar.";

/** Weekly plan for one user. Returns what happened. */
export async function runWeekly(user: User): Promise<string> {
  const email = user.scope ?? user.email;
  const brand = await getBrand(email);
  if (!brand) return "no_brand";
  const sched = await getSchedule(email);
  if (!sched.weeklyPlan) return "off";
  // Belt and braces next to the cron markers: never charge or generate twice for the same week.
  if (ranThisWeek(sched.lastWeekly)) return "already_this_week";
  // Before any charge. "retry" leaves the week open in the cron markers, so the Monday and Tuesday catch-ups still
  // serve this owner if Claude is back on by then.
  if (modelState() === "paused") return "retry:paused";
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
  if (trialOver(user)) return "trial_over";
  // weekly cap: count items Noor created on her own in the last 7 days
  const weekAgo = Date.now() - 7 * 864e5;
  const auto = (await listLite(email, new Date(weekAgo))).filter((t) => t.source === "scheduled").length;
  if (auto >= gov.weeklyCap) return "cap_reached";
  // Loaded before the charge (notifications imports this module, hence the dynamic import), so nothing between the
  // charge and the refunding try below can throw.
  const { notifyItem, warnAgentCap } = await import("./notifications");
  // weekly_plan is Noor's, so it counts against her monthly cap in this brand, like a batch she was asked for.
  const paid = await charge(user.email, cost, { scope: email, agent: "noor", cap: gov.agentCaps.noor });
  if (!paid.ok) return paid.reason;
  user.credits = paid.credits;
  await warnAgentCap(user, paid);
  let items;
  let memory = "";
  try {
    const [prefs, mem, feedback] = await Promise.all([listPreferencesFor(email, "noor"), memoryBlock(email), feedbackFor(email, "noor", { gov })]);
    memory = mem;
    items = await generate("weekly_plan", brand, prefs, WEEKLY_NOTE, { memory, reviewer: gov.reviewer, noEmDash: gov.noEmDash, meter: user.email, feedback });
  } catch (e) {
    user.credits = await refund(user.email, cost, paid);
    throw e;
  }
  const created: Task[] = [];
  for (const it of items) {
    const t: Task = { id: randomBytes(8).toString("hex"), type: "weekly_plan", channel: it.channel, title: it.title, body: it.body, status: initialStatus(gov.autoApprove.weekly_plan, brand, { type: "weekly_plan", title: it.title, body: it.body }), createdAt: new Date().toISOString(), lang: brand.languages[0] ?? "ar", source: "scheduled", brief: WEEKLY_NOTE };
    await saveTask(email, t, true);
    created.push(t);
  }
  judgeLater(email, user.email, brand, created, undefined, { notes: WEEKLY_NOTE, memory });
  await saveSchedule(email, { lastWeekly: new Date().toISOString() });
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
  // Reem's block: counts from the computed agenda (no model), and the titles of the first three overdue or due-today items.
  const agenda = briefAgenda(await agendaFor(email, Date.now(), { actor: "cron", via: "cron" }));
  const chase = agenda.chase ?? 0;
  const hasAgenda = agenda.overdue + agenda.today + agenda.waiting + agenda.confirm + chase > 0;
  const top = agenda.top.map((t) => `«${t.slice(0, 80)}»`).join(ar ? "، " : ", ");
  const lines = ar
    ? [
        `صباح الخير ${user.name || ""} ☀️ ملخص نور لليوم:`,
        `• بانتظار موافقتك: ${pending} عنصر`,
        `• اعتمدت خلال 7 أيام: ${approved7d} عنصر`,
        `• رصيدك: ${user.credits} كريدت${user.plan === "trial" ? ` (التجربة تنتهي ${dateFormat("ar", { day: "numeric", month: "long" }).format(new Date(user.trialEnds))})` : ""}`,
        seasons.length ? `• المواسم القريبة: ${seasons.join("، ")}` : "• لا مواسم كبرى خلال 35 يوماً — وقت مناسب لبناء الجمهور",
        ...(hasAgenda ? [`• مهامك (ريم): ${agenda.overdue} متأخرة، ${agenda.today} لليوم، ${agenda.waiting} بانتظار غيرك${chase ? `، ${chase} حان وقت متابعتها` : ""}${agenda.confirm ? `، ${agenda.confirm} تحتاج تأكيدك` : ""}`, ...(top ? [`  أولها: ${top}`] : [])] : []),
        pending ? "الخطوة التالية: افتح صندوق الموافقة واعتمد ما يعجبك." : agenda.overdue + agenda.today ? "الخطوة التالية: افتح «مهامي» وابدأ بالمتأخر." : "الخطوة التالية: اطلب من نور دفعة جديدة في الدردشة.",
      ]
    : [
        `Good morning ${user.name || ""} ☀️ Noor's brief for today:`,
        `• Waiting for your approval: ${pending}`,
        `• Approved in the last 7 days: ${approved7d}`,
        `• Credits: ${user.credits}${user.plan === "trial" ? ` (trial ends ${dateFormat("en", { day: "numeric", month: "long" }).format(new Date(user.trialEnds))})` : ""}`,
        seasons.length ? `• Upcoming seasons: ${seasons.join(", ")}` : "• No major season within 35 days — good time to build audience",
        ...(hasAgenda ? [`• Your to-dos (Reem): ${agenda.overdue} overdue, ${agenda.today} due today, ${agenda.waiting} waiting on others${chase ? `, ${chase} to follow up` : ""}${agenda.confirm ? `, ${agenda.confirm} to confirm` : ""}`, ...(top ? [`  First: ${top}`] : [])] : []),
        pending ? "Next step: open the inbox and approve what you like." : agenda.overdue + agenda.today ? "Next step: open My to-dos and start with what is overdue." : "Next step: ask Noor for a new batch in chat.",
      ];
  const brief: Brief = { date: new Date().toISOString().slice(0, 10), text: lines.join("\n"), pending, approved7d, credits: user.credits, seasons, agenda };
  await db.set(`brief:${email}`, brief);
  await saveSchedule(email, { lastDaily: new Date().toISOString() });
  return brief;
}

/**
 * The scheduler's roster in one pass: `users`, one entry per (user, active brand), extra brands with their own copy and
 * scope set; and `idle`, the brand scopes that get no scheduled work (archived brands, and every brand of a suspended
 * account) but where the daily job still purges Reem's items deleted over 30 days ago.
 */
export async function dailyRoster(): Promise<{ users: User[]; idle: string[] }> {
  const { listBrands, scopeFor } = await import("./brands");
  const emails = await db.smembers("users:all");
  const { pmap } = await import("./parallel");
  const groups = await pmap(emails, async (e) => {
    const u = await getUser(e);
    if (!u) return { users: [] as User[], idle: [] as string[] };
    const brands = (await listBrands(e)).map((b) => ({ b, scope: scopeFor(e, b.id) }));
    // Suspended accounts get no scheduled work, no charges and no email.
    if (u.suspended) return { users: [] as User[], idle: brands.map((x) => x.scope) };
    return {
      users: brands.filter((x) => x.b.status === "active").map((x) => ({ ...u, brandId: x.b.id, scope: x.scope })),
      idle: brands.filter((x) => x.b.status !== "active").map((x) => x.scope),
    };
  });
  return { users: groups.flatMap((g) => g.users), idle: groups.flatMap((g) => g.idle) };
}

/** One entry per (user, active brand). Extra brands get their own copy with scope set. */
export async function allUsers(): Promise<User[]> {
  return (await dailyRoster()).users;
}
