import { randomBytes } from "crypto";
import { db } from "./db";
import type { User } from "./auth";
import { listLite } from "./brand";
import { getSchedule } from "./schedule";
import type { AgentId } from "./agents";

/**
 * In-app follow-ups from the team. Stored per account (not per brand) as one
 * capped JSON array so the bell is cheap to read. Each follow-up is deduped by a
 * fingerprint so the owner is nudged once per situation, not every day.
 */
export type NotifKind = "due" | "pending" | "weekly" | "credits" | "trial" | "quality" | "info";
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
/** Push one follow-up. `fingerprint` + `ttlDays` suppress repeats of the same situation. */
export async function pushNotif(email: string, n: Omit<Notif, "id" | "at">, fingerprint?: string, ttlDays = 3): Promise<Notif | null> {
  if (fingerprint) {
    const k = `notifseen:${email}:${fingerprint}`;
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
