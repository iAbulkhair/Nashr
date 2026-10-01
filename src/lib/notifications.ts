import { randomBytes } from "crypto";
import { db } from "./db";
import type { User } from "./auth";
import { getBrand, listLite } from "./brand";
import { listBrands, scopeFor } from "./brands";
import { getSchedule } from "./schedule";
import { agentById, type AgentId } from "./agents";
import type { AgentCharge } from "./credits";
import { SEC_ALERTS_PER_DAY, SEC_KEYS, agendaFor, overdueAlertFingerprint } from "./secretary";
import { overdueAlerts, partyName, zoneDay } from "./secretary-agenda";
import { appOrigin } from "./origin";

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
  await withBellLock(email, async () => {
    const all = await listNotifs(email);
    if (all.some((n) => !n.read)) await db.set(KEY(email), all.map((n) => ({ ...n, read: true })));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The bell's lock key, per account: every read-then-write of `notifs:{email}` holds it. */
export const bellLockKey = (email: string) => `notiflock:${email}`;
/**
 * Run one read-then-write of the bell under the account's lock (SET NX for 10 s, 60 tries 50 ms apart, as the item lock
 * in secretary.ts), so two writers landing together (the reminder tick, the daily follow-ups, an evening wrap, the owner
 * opening the bell) never overwrite each other's entries. If the lock cannot be taken in about 3 s the write goes ahead
 * anyway, as it did before the lock: a late entry that might race is better than one dropped.
 */
export async function withBellLock<T>(email: string, fn: () => Promise<T>): Promise<T> {
  const key = bellLockKey(email);
  let got = false;
  for (let i = 0; i < 60 && !got; i++) {
    got = await db.lock(key, 10);
    if (!got) await sleep(50);
  }
  if (!got) console.error("bell lock not taken; writing without it");
  try {
    return await fn();
  } finally {
    if (got) await db.unlock(key).catch((e) => console.error("bell lock release failed", e instanceof Error ? e.name : "error"));
  }
}
/** The marker that suppresses a repeat of one situation; exported so `wipeAccount` can name the ones it can list. */
export const seenKey = (email: string, fingerprint: string) => `notifseen:${email}:${fingerprint}`;
/** The 80% warning's fingerprint: one per brand scope, agent and month. */
export const agentCapFingerprint = (scope: string, agent: AgentId, month: string) => `agentcap80:${scope}:${agent}:${month}`;

export type Push = { n: Omit<Notif, "id" | "at">; fingerprint?: string; ttlDays?: number };
/**
 * Claim each fingerprint with SET NX and its TTL, all in one round; only what this caller claimed is pushed, in one
 * write of the bell under the account's bell lock (`withBellLock`). A marker read then written let two overlapping runs
 * (a chain hop and a catch-up) both notify. Answers per entry, in order: the notification pushed, or null when its
 * fingerprint was already claimed. When the bell write fails, the fingerprints this call claimed are released before
 * the error goes on, so a retry can still deliver: a claimed fingerprint with no entry would silence it for good.
 */
export async function pushNotifs(email: string, entries: Push[]): Promise<(Notif | null)[]> {
  const won = await Promise.all(entries.map((e) => (e.fingerprint ? db.setNx(seenKey(email, e.fingerprint), 1, (e.ttlDays ?? 3) * 86400) : true)));
  const at = new Date().toISOString();
  const aligned: (Notif | null)[] = entries.map((e, i) => (won[i] ? { id: randomBytes(5).toString("hex"), at, ...e.n } : null));
  const items = aligned.filter((x): x is Notif => !!x);
  if (!items.length) return aligned;
  try {
    await withBellLock(email, async () => {
      const all = await listNotifs(email);
      await db.set(KEY(email), [...items, ...all].slice(0, MAX));
    });
  } catch (e) {
    const mine = entries.filter((x, i) => won[i] && x.fingerprint).map((x) => seenKey(email, x.fingerprint!));
    await Promise.all(mine.map((k) => db.del(k).catch(() => {})));
    throw e;
  }
  return aligned;
}
async function pushMany(email: string, entries: Push[]): Promise<Notif[]> {
  return (await pushNotifs(email, entries)).filter((x): x is Notif => !!x);
}

/** Push one follow-up. `fingerprint` + `ttlDays` suppress repeats of the same situation, claimed atomically. */
export async function pushNotif(email: string, n: Omit<Notif, "id" | "at">, fingerprint?: string, ttlDays = 3): Promise<Notif | null> {
  return (await pushMany(email, [{ n, fingerprint, ttlDays }]))[0] ?? null;
}


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
  // 6. Overdue to-dos on Reem's list.
  out.push(...(await overdueTodoAlerts(user, scope)));
  return out;
}

/** How long an overdue alert's marker lives: past the longest window between two steps (days 3 to 6). */
const ALERT_TTL_DAYS = 5;

/**
 * One alert per overdue item, spaced, then silence: on the day it became overdue and the 1st, 3rd and 7th local day
 * after (`overdueAlerts`), each step once, keyed by (scope, item, due time, step), so a new due date starts afresh and
 * the same text never repeats every day. After the 7th day the item is only in the morning brief. At most
 * `SEC_ALERTS_PER_DAY` a brand a local day, critical and earliest first. The markers are claimed with SET NX before
 * anything is pushed; a claim beyond the day's allowance is handed back, so that item can still go on another day of
 * its window. Reads and writes are batched: no store call per item in turn.
 */
async function overdueTodoAlerts(user: User, scope: string): Promise<Notif[]> {
  const now = Date.now();
  const agenda = await agendaFor(scope, now, { actor: "cron", via: "cron" });
  const due = overdueAlerts(agenda.buckets.overdue, now, agenda.zone);
  if (!due.length) return [];
  const ar = user.lang === "ar";
  const lang = user.lang;
  const fps = due.map((a) => overdueAlertFingerprint(scope, a.entry.item.id, a.entry.item.dueAt!, a.step));
  const won = await Promise.all(fps.map((fp) => db.setNx(seenKey(user.email, fp), 1, ALERT_TTL_DAYS * 86400)));
  const claimed = due.filter((_, i) => won[i]);
  if (!claimed.length) return [];
  const counter = SEC_KEYS.alerts(scope, zoneDay(now, agenda.zone));
  const total = await db.incrby(counter, claimed.length);
  const allowed = Math.max(0, SEC_ALERTS_PER_DAY - (total - claimed.length));
  const send = claimed.slice(0, allowed), back = claimed.slice(allowed);
  await Promise.all([
    db.expireNx(counter, 2 * 86400),
    ...(back.length ? [db.incrby(counter, -back.length), ...back.map((a) => db.del(seenKey(user.email, fps[due.indexOf(a)])))] : []),
  ]);
  if (!send.length) return [];
  // Already claimed above: pushed without a fingerprint, in one write of the bell.
  return pushMany(user.email, send.map(({ entry, step }): Push => {
    const t = `«${entry.item.title.slice(0, 80)}»`;
    const chase = entry.next === "chase";
    const who = partyName(entry.item.owedBy, lang);
    const last = step === 7 ? (ar ? " هذا آخر تنبيه لها؛ بعده تظهر في ملخص الصباح فقط." : " This is its last alert; after today it is only in the morning brief.") : "";
    return {
      n: {
        kind: "todo", agent: "reem", href: `/${lang}/app/todo`,
        title: ar ? `متأخرة: ${t}` : `Overdue: ${t}`,
        body: (ar ? (chase ? `تابِع مع ${who}، أو غيّر الموعد.` : "أنجزها أو أجّلها أو غيّر موعدها.") : chase ? `Follow up with ${who}, or change the date.` : "Do it, snooze it or reschedule it.") + last,
      },
    };
  }));
}

export function notifEmailText(user: User, items: Notif[]) {
  const ar = user.lang === "ar";
  return [ar ? "متابعات الفريق اليوم:" : "Today's follow-ups from the team:", ...items.map((n) => `• ${n.title}\n  ${n.body}\n  ${appOrigin()}${n.href}`)].join("\n\n");
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
