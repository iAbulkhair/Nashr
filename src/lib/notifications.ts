import { randomBytes } from "crypto";
import { db } from "./db";
import type { User } from "./auth";
import { getBrand, listLite } from "./brand";
import { listBrands, scopeFor } from "./brands";
import { getSchedule } from "./schedule";
import { agentById, type AgentId } from "./agents";
import type { AgentCharge } from "./credits";
import { agendaFor, overdueFingerprint } from "./secretary";
import { arCount, riyadhDay } from "./secretary-agenda";

/**
 * In-app follow-ups from the team. Stored per account (not per brand) as one
 * capped JSON array so the bell is cheap to read. Each follow-up is deduped by a
 * fingerprint so the owner is nudged once per situation, not every day.
 */
export type NotifKind = "due" | "pending" | "weekly" | "credits" | "trial" | "quality" | "info" | "todo";
export type Notif = { id: string; kind: NotifKind; title: string; body: string; href: string; at: string; read?: boolean; agent?: AgentId };

const KEY = (email: string) => `notifs:${email}`;
const MAX = 50;

export async function listNotifs(email: string): Promise<Notif[]> {
  return (await db.get<Notif[]>(KEY(email))) ?? [];
}
export async function unreadCount(email: string) {
  return (await listNotifs(email)).filter((n) => !n.read).length;
}
export async function markAllRead(email: string) {
  const all = await listNotifs(email);
  if (all.some((n) => !n.read)) await db.set(KEY(email), all.map((n) => ({ ...n, read: true })));
}
/** The marker that suppresses a repeat of one situation; exported so `wipeAccount` can name the ones it can list. */
export const seenKey = (email: string, fingerprint: string) => `notifseen:${email}:${fingerprint}`;
/** The 80% warning's fingerprint: one per brand scope, agent and month. */
export const agentCapFingerprint = (scope: string, agent: AgentId, month: string) => `agentcap80:${scope}:${agent}:${month}`;

/** Push one follow-up. `fingerprint` + `ttlDays` suppress repeats of the same situation. */
export async function pushNotif(email: string, n: Omit<Notif, "id" | "at">, fingerprint?: string, ttlDays = 3): Promise<Notif | null> {
  if (fingerprint) {
    const k = seenKey(email, fingerprint);
    if (await db.get(k)) return null;
    await db.set(k, 1, ttlDays * 86400);
  }
  const item: Notif = { id: randomBytes(5).toString("hex"), at: new Date().toISOString(), ...n };
  const all = await listNotifs(email);
  await db.set(KEY(email), [item, ...all].slice(0, MAX));
  return item;
}

const ORIGIN = () => process.env.APP_ORIGIN ?? "https://nashr-tau.vercel.app";

/** Daily follow-ups computed from the workspace. Returns what was created today. */
export async function followUps(user: User, scope: string): Promise<Notif[]> {
  const sched = await getSchedule(scope);
  if (sched.followUps === false) return [];
  const ar = user.lang === "ar";
  const app = `/${user.lang}/app`;
  const tasks = await listLite(scope, new Date(Date.now() - 180 * 864e5));
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const out: Notif[] = [];
  const add = async (n: Omit<Notif, "id" | "at">, fp: string, ttl = 3) => { const x = await pushNotif(user.email, n, fp, ttl); if (x) out.push(x); };

  // 1. Scheduled items due today or tomorrow and not yet published through a connector.
  const due = tasks.filter((t) => t.status === "approved" && (t.scheduledFor === today || t.scheduledFor === tomorrow) && !t.published);
  if (due.length) {
    const titles = due.slice(0, 3).map((t) => t.title).join(" · ");
    await add({ kind: "due", agent: "noor", href: `${app}/calendar`, title: ar ? `${due.length} عنصر موعده اليوم أو غداً` : `${due.length} item(s) due today or tomorrow`, body: ar ? `انشرها الآن، فلا شيء يُنشر تلقائياً: ${titles}` : `Publish now; nothing goes out automatically: ${titles}` }, `due:${today}`, 2);
  }
  // 2. Approvals waiting more than 48 hours.
  const stale = tasks.filter((t) => t.status === "pending" && Date.now() - new Date(t.createdAt).getTime() > 48 * 36e5);
  if (stale.length) {
    await add({ kind: "pending", agent: "noor", href: app, title: ar ? `${stale.length} عنصر بانتظارك منذ أكثر من يومين` : `${stale.length} item(s) waiting for you for over 2 days`, body: ar ? "اعتمد أو ارفض مع سبب، وتتعلم نور من قرارك." : "Approve or reject with a reason; Noor learns from your decision." }, `pending:${Math.floor(stale.length / 5)}`, 3);
  }
  // 3. Low credits.
  if (user.credits < 10) {
    await add({ kind: "credits", href: `${app}/billing`, title: ar ? `رصيدك ${user.credits} كريدت` : `Balance: ${user.credits} credits`, body: ar ? "لن يستطيع الفريق توليد دفعات جديدة قريباً. رقّ خطتك أو اطلب رصيداً." : "The team will not be able to generate new batches soon. Upgrade or request a top-up." }, "credits", 5);
  }
  // 4. Trial ending within 24h.
  if (user.plan === "trial") {
    const left = new Date(user.trialEnds).getTime() - Date.now();
    if (left > 0 && left < 864e5) await add({ kind: "trial", href: `${app}/billing`, title: ar ? "تجربتك تنتهي خلال 24 ساعة" : "Your trial ends within 24 hours", body: ar ? "اشترك لتبقى دفعاتك وجدولك تعمل." : "Subscribe to keep your batches and schedule running." }, "trial", 3);
  }
  // 5. Items the judge scored below 70 and still pending.
  const weak = tasks.filter((t) => t.status === "pending" && typeof t.score === "number" && t.score < 70);
  if (weak.length) {
    await add({ kind: "quality", agent: "dana", href: app, title: ar ? `${weak.length} عنصر بدرجة جودة أقل من 70` : `${weak.length} item(s) scored below 70`, body: ar ? `${weak[0].notes ?? ""} أعد التوليد بملاحظة أوضح أو عدّل قبل الاعتماد.` : `${weak[0].notes ?? ""} Regenerate with a clearer note or edit before approving.` }, `quality:${weak.map((t) => t.id).sort().join(",").slice(0, 60)}`, 7);
  }
  // 6. Overdue to-dos on Reem's list: one nudge per brand per Riyadh day, whatever the number of items.
  const agenda = await agendaFor(scope, Date.now(), { actor: "cron", via: "cron" });
  if (agenda.counts.overdue > 0) {
    const n = agenda.counts.overdue;
    const first = agenda.buckets.overdue.slice(0, 2).map((e) => `«${e.item.title.slice(0, 60)}»`).join(ar ? "، " : ", ");
    await add({ kind: "todo", agent: "reem", href: `${app}/todo`, title: ar ? arCount(n, { one: "مهمة متأخرة في قائمتك", two: "مهمتان متأخرتان في قائمتك", few: "مهام متأخرة في قائمتك", many: "مهمة متأخرة في قائمتك" }) : `${n} overdue to-do${n === 1 ? "" : "s"} on your list`, body: ar ? `ابدأ بـ ${first}. أنجزها أو أجّلها أو غيّر موعدها.` : `Start with ${first}. Do it, snooze it or reschedule it.` }, overdueFingerprint(scope, riyadhDay(Date.now())), 2);
  }
  return out;
}

export function notifEmailText(user: User, items: Notif[]) {
  const ar = user.lang === "ar";
  return [ar ? "متابعات الفريق اليوم:" : "Today's follow-ups from the team:", ...items.map((n) => `• ${n.title}\n  ${n.body}\n  ${ORIGIN()}${n.href}`)].join("\n\n");
}

/** Helper for other modules (weekly cron, judge). */
export async function notifyItem(email: string, lang: "ar" | "en", n: { kind: NotifKind; agent?: AgentId; title: string; body: string; href: string }, fp?: string, ttl?: number) {
  return pushNotif(email, { ...n, href: n.href.startsWith("/") ? n.href : `/${lang}/app/${n.href}` }, fp, ttl);
}

/**
 * The one 80% warning of an agent's monthly credit cap, for every charging path: pass the charge result. It fires on the
 * charge that crossed 80% (`warn80`) and the fingerprint keeps it to one per brand scope, agent and month, even when a
 * refund dips below the line and the next charge crosses it again. The bell is per account and Governance shows the
 * brand that is open, so the warning names the brand the cap belongs to. It never throws: the credits are already
 * charged, and a failed notification must not skip the refund that follows a failed generation.
 */
export async function warnAgentCap(user: Pick<User, "email" | "lang">, paid: Extract<AgentCharge, { ok: true }>) {
  if (!paid.warn80 || paid.cap === undefined) return;
  const ar = user.lang === "ar";
  const name = agentById(paid.agent).name[user.lang];
  try {
    // Named as the brand switcher names it: the name given to the brand, else its brand file's.
    const [rows, file] = await Promise.all([listBrands(user.email), getBrand(paid.scope)]);
    const brand = (rows.find((b) => scopeFor(user.email, b.id) === paid.scope)?.name || file?.name || "").trim().slice(0, 60);
    const where = brand ? (ar ? ` في «${brand}»` : ` in “${brand}”`) : "";
    await notifyItem(user.email, user.lang, {
      kind: "credits",
      agent: paid.agent,
      title: ar ? `${name}${where}: ${paid.spent} من ${paid.cap} كريدت هذا الشهر` : `${name}${where}: ${paid.spent} of ${paid.cap} credits this month`,
      body: brand
        ? ar
          ? `اقترب الاستهلاك من الحد الشهري الذي وضعته لهذا الوكيل في صفحة الحوكمة لعلامة «${brand}»، فبدّل إليها لترى الحد أو تغيّره. عند بلوغه تتوقف دفعاته وصوره ومقاطعه فيها حتى ترفع الحد أو يبدأ الشهر القادم. الدردشة لا تُحسب.`
          : `This agent is close to the monthly cap you set for it in Governance for the brand “${brand}”; switch to that brand to see or change it. At the cap its batches, images and videos there stop until you raise the cap or the next month starts. Chat is not counted.`
        : ar
          ? "اقترب الاستهلاك من الحد الشهري الذي وضعته لهذا الوكيل في صفحة الحوكمة لهذه العلامة. عند بلوغه تتوقف دفعاته وصوره ومقاطعه حتى ترفع الحد أو يبدأ الشهر القادم. الدردشة لا تُحسب."
          : "This agent is close to the monthly cap you set for it in Governance for this brand. At the cap its batches, images and videos stop until you raise the cap or the next month starts. Chat is not counted.",
      href: "governance",
    }, agentCapFingerprint(paid.scope, paid.agent, paid.month), 35);
  } catch (e) {
    console.error("agent cap warning failed", e);
  }
}
