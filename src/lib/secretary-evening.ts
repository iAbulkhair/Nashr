/**
 * Reem's evening wrap: what happened today and what comes first tomorrow, built in code from stored facts. Server only.
 *
 * Rules held in code:
 * - Four parts, all read from the store, never from a model: items completed today (the brand's local day) with their
 *   result; the approvals and rejections the owner decided today (`decisions:{scope}`, human decisions only); items
 *   that fell overdue today; the first three items the 09:00 agenda tomorrow would put in front of the owner (overdue,
 *   due, to confirm, to chase). No motivational line.
 * - Silent when all four are empty. Sent at most once per scope and local day: `sec:wrap:{scope}:{day}` is claimed
 *   with SET NX before anything is sent.
 * - One in-app notification; one email only when email is set up and the preference is "all".
 * - When: 18:00 local; during Ramadan 21:30 local, after Taraweeh. The Vercel cron `/api/cron/evening` (15:00 UTC)
 *   serves every workspace outside Ramadan; the QStash tick (`/api/cron/secretary`) starts it for the zones whose
 *   target time just passed, and in Ramadan it is the only path (without QStash, no wrap in Ramadan).
 * - Free: no credits, no model call.
 */
import { db } from "./db";
import { sc, type User } from "./auth";
import { listDecisions } from "./decisions";
import { getSchedule } from "./schedule";
import { notifyItem } from "./notifications";
import { sendEmail } from "./notify";
import { activeSeasons } from "./seasons";
import { SEC_KEYS, listDone, listOpenItems, zoneFor } from "./secretary";
import { AUTO_CLOSE_RESULT, addDays, computeAgenda, zoneDay, zoneTime } from "./secretary-agenda";
import { ZONE_IDS, type Zone } from "./zones";

/** The wrap's local time, and in Ramadan (after Taraweeh). */
export const EVENING_AT = { hh: 18, mm: 0 } as const;
export const RAMADAN_EVENING_AT = { hh: 21, mm: 30 } as const;
/**
 * How far back a QStash tick looks for a zone's target time: the tick's 15 minutes and one more for delivery delay.
 * The once-a-day marker makes an overlap harmless; a gap would lose a day's wrap.
 */
export const EVENING_WINDOW_MS = 16 * 60_000;
const WRAP_TTL_S = 2 * 86400;
/** Decisions read to count today's: the newest 100. */
const DECISIONS_READ = 100;

const ORIGIN = () => process.env.APP_ORIGIN ?? "https://nashr-tau.vercel.app";

/** Is it Ramadan at `now` (Umm al-Qura calendar, `activeSeasons`)? */
export const isRamadan = (now: number) => activeSeasons(new Date(now)).some((s) => s.id === "ramadan");

/** Today's wrap instant in a zone: 18:00 local, 21:30 in Ramadan. */
export function eveningAt(now: number, zone: Zone, ramadan = isRamadan(now)): number {
  const t = ramadan ? RAMADAN_EVENING_AT : EVENING_AT;
  return zoneTime(zoneDay(now, zone), t.hh, t.mm, zone);
}

/** The zones whose wrap time fell within the last `EVENING_WINDOW_MS`: what a QStash tick at `now` starts. */
export function zonesDue(now: number, windowMs = EVENING_WINDOW_MS): Zone[] {
  const ramadan = isRamadan(now);
  return ZONE_IDS.filter((z) => {
    const at = eveningAt(now, z, ramadan);
    return at <= now && now - at < windowMs;
  });
}

export type Wrap = {
  day: string;
  zone: Zone;
  completed: { title: string; result: string | null; auto: boolean }[];
  approved: number;
  rejected: number;
  fellOverdue: string[];
  tomorrow: string[];
};

/**
 * The four parts of one scope's wrap at `now`, in its zone. Reads: the brand file (zone), the open set and its items,
 * the newest 50 done items, the newest 100 decisions: the same number whatever the size of the list.
 */
export async function buildWrap(scope: string, now: number): Promise<Wrap> {
  const [zone, open, done, decisions] = await Promise.all([zoneFor(scope), listOpenItems(scope), listDone(scope, 50), listDecisions(scope, DECISIONS_READ)]);
  const day = zoneDay(now, zone);
  const today = (iso: string | null | undefined) => !!iso && Number.isFinite(Date.parse(iso)) && zoneDay(Date.parse(iso), zone) === day;
  const completed = done.filter((it) => today(it.completedAt)).map((it) => ({ title: it.title, result: it.result, auto: it.result === AUTO_CLOSE_RESULT }));
  const decided = decisions.filter((d) => (d.action === "approve" || d.action === "reject") && today(d.at));
  const fellOverdue = computeAgenda(open, now, { zone }).buckets.overdue.filter((e) => today(e.item.dueAt)).map((e) => e.item.title);
  const next = computeAgenda(open, zoneTime(addDays(day, 1), 9, 0, zone), { zone });
  const tomorrow = [...next.buckets.overdue, ...next.buckets.today, ...next.buckets.confirm, ...next.buckets.chase].slice(0, 3).map((e) => e.item.title);
  return { day, zone, completed, approved: decided.filter((d) => d.action === "approve").length, rejected: decided.filter((d) => d.action === "reject").length, fellOverdue, tomorrow };
}

export const wrapEmpty = (w: Wrap) => !w.completed.length && !w.approved && !w.rejected && !w.fellOverdue.length && !w.tomorrow.length;

/** The wrap in the owner's language: a title and one line per part that has something. */
export function wrapText(w: Wrap, lang: "ar" | "en"): { title: string; body: string } {
  const q = (t: string) => `«${t.slice(0, 80)}»`;
  if (lang === "ar") {
    const lines = [
      ...(w.completed.length ? [`• أُنجز اليوم (${w.completed.length}):`, ...w.completed.slice(0, 5).map((c) => `  – ${q(c.title)}: ${c.auto ? "أُغلقت تلقائياً لأن العنصر المرتبط اعتُمد" : (c.result ?? "").slice(0, 120)}`)] : []),
      ...(w.approved || w.rejected ? [`• قراراتك اليوم في صندوق الموافقة: اعتماد ${w.approved}، رفض ${w.rejected}`] : []),
      ...(w.fellOverdue.length ? [`• تأخّر اليوم: ${w.fellOverdue.slice(0, 5).map(q).join("، ")}`] : []),
      ...(w.tomorrow.length ? [`• أول ما ينتظرك غداً 9 ص: ${w.tomorrow.map(q).join("، ")}`] : []),
    ];
    return { title: "ملخص المساء من ريم", body: lines.join("\n") };
  }
  const lines = [
    ...(w.completed.length ? [`• Done today (${w.completed.length}):`, ...w.completed.slice(0, 5).map((c) => `  – ${q(c.title)}: ${c.auto ? "closed automatically, the linked item was approved" : (c.result ?? "").slice(0, 120)}`)] : []),
    ...(w.approved || w.rejected ? [`• Your decisions today in the approval inbox: ${w.approved} approved, ${w.rejected} rejected`] : []),
    ...(w.fellOverdue.length ? [`• Fell overdue today: ${w.fellOverdue.slice(0, 5).map(q).join(", ")}`] : []),
    ...(w.tomorrow.length ? [`• First for tomorrow at 9 AM: ${w.tomorrow.map(q).join(", ")}`] : []),
  ];
  return { title: "Reem's evening wrap", body: lines.join("\n") };
}

/**
 * One workspace's wrap at `now`: built, and when it has something, sent once for the local day. "off" when the owner
 * switched follow-ups off in Scheduled tasks (the wrap is one).
 */
export async function eveningWrap(user: User, now = Date.now()): Promise<"sent" | "silent" | "already" | "off"> {
  const scope = sc(user);
  if ((await getSchedule(scope)).followUps === false) return "off";
  const w = await buildWrap(scope, now);
  if (wrapEmpty(w)) return "silent";
  if (!(await db.setNx(SEC_KEYS.wrap(scope, w.day), 1, WRAP_TTL_S))) return "already";
  const { title, body } = wrapText(w, user.lang);
  await notifyItem(user.email, user.lang, { kind: "todo", agent: "reem", title, body, href: `/${user.lang}/app/todo` });
  if (process.env.RESEND_API_KEY) {
    const pref = ((await db.get<{ emails?: string }>(`profile:${scope}`)) ?? (await db.get<{ emails?: string }>(`profile:${user.email}`)) ?? {}).emails ?? "all";
    if (pref === "all") await sendEmail(user.email, user.lang === "ar" ? `ملخص المساء — ${w.day}` : `Evening wrap — ${w.day}`, `${title}\n\n${body}\n\n${ORIGIN()}/${user.lang}/app/todo`);
  }
  return "sent";
}
