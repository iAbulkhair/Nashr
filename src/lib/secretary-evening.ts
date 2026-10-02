/**
 * Reem's evening wrap: what happened today and what comes first tomorrow, built in code from stored facts. Server only.
 *
 * Rules held in code:
 * - Four parts, all read from the store, never from a model, after the agenda closed the items whose linked inbox item
 *   was approved (`agendaFor`, so an approved item shows as done, not as overdue): items completed today (the brand's
 *   local day) with their result; the approvals (approve, and publish, which approves) and rejections the owner decided
 *   today (`decisions:{scope}`, human decisions only); items that fell overdue since the previous evening's wrap time
 *   (an all-day item due yesterday included; a debt someone else owes when it became chaseable); the first three items
 *   the agenda would put in front of the owner at the next working morning (09:00 tomorrow, or the first working moment
 *   after it: Sunday 08:00 after a Riyadh Thursday, 10:00 in Ramadan, and the line names that day and time): overdue,
 *   due, to confirm, to chase. Both read the brand's work calendar and away map, so a quiet day or an away contact
 *   holds a chase back. No motivational line.
 * - Silent when all four are empty. Sent at most once per scope and local day: `sec:wrap:{scope}:{day}` is claimed
 *   with SET NX before anything is sent, and released when the in-app notification could not be written, so a retry
 *   can still send it (never after that notification was written: an email failure keeps it).
 * - One in-app notification; one email only when email is set up and the preference is "all". With more than one active
 *   brand, the title and the email's subject name the brand the wrap is about.
 * - When: 18:00 local; during Ramadan 21:30 local, after Taraweeh. The Vercel cron `/api/cron/evening` (15:00 UTC)
 *   serves every workspace outside Ramadan; the QStash tick (`/api/cron/secretary`) starts it for the zones whose
 *   target time just passed, and in Ramadan it is the only path (without QStash, no wrap in Ramadan).
 * - Switched off with the follow-ups in Scheduled tasks (`followUps: false`).
 * - Free: no credits, no model call.
 */
import { db } from "./db";
import { sc, type User } from "./auth";
import { getBrand } from "./brand";
import { listBrands, scopeFor } from "./brands";
import { listDecisions } from "./decisions";
import { getSchedule } from "./schedule";
import { notifyItem } from "./notifications";
import { sendEmail } from "./notify";
import { activeSeasons } from "./seasons";
import { SEC_KEYS, agendaFor, listDone, listOpenItems } from "./secretary";
import { AUTO_CLOSE_RESULT, addDays, computeAgenda, daysBetween, endOfZoneDay, firstWorkingMoment, formatWhen, zoneDay, zoneLocalInput, zoneTime } from "./secretary-agenda";
import { dateFormat } from "./dates";
import { DEFAULT_ZONE, ZONE_IDS, type Zone } from "./zones";
import { appOrigin } from "./origin";

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


/**
 * Is it Ramadan at `now` on `zone`'s calendar day (Umm al-Qura, `activeSeasons`)? Per zone: in the hour between Dubai's
 * midnight and Riyadh's the two are on different days, so Ramadan starts (and ends) an hour apart.
 */
export const isRamadan = (now: number, zone: Zone = DEFAULT_ZONE) => activeSeasons(new Date(now), zone).some((s) => s.id === "ramadan");

/** Today's wrap instant in a zone: 18:00 local, 21:30 in Ramadan (that zone's, unless the caller already knows). */
export function eveningAt(now: number, zone: Zone, ramadan = isRamadan(now, zone)): number {
  const t = ramadan ? RAMADAN_EVENING_AT : EVENING_AT;
  return zoneTime(zoneDay(now, zone), t.hh, t.mm, zone);
}

/** The zones whose wrap time fell within the last `EVENING_WINDOW_MS`: what a QStash tick at `now` starts. */
export function zonesDue(now: number, windowMs = EVENING_WINDOW_MS): Zone[] {
  return ZONE_IDS.filter((z) => {
    const at = eveningAt(now, z);
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
  /** The moment "tomorrow" is read at: 09:00 tomorrow, or the first working moment after it. The line names it. */
  tomorrowAt: number;
};

/** The previous evening's wrap instant in a zone: 18:00, or 21:30 when that day was in Ramadan. */
export function previousEveningAt(now: number, zone: Zone): number {
  const prev = addDays(zoneDay(now, zone), -1);
  const t = isRamadan(zoneTime(prev, 12, 0, zone), zone) ? RAMADAN_EVENING_AT : EVENING_AT;
  return zoneTime(prev, t.hh, t.mm, zone);
}

/** A decision the wrap counts: approve and publish (publishing a pending item approves it), and reject. */
const APPROVALS = new Set(["approve", "publish"]);

/**
 * The four parts of one scope's wrap at `now`, in its zone. First the agenda (`agendaFor`, as the cron): it closes the
 * items whose linked inbox item was approved, so they count as done today and never as overdue, and it reads the
 * brand's work calendar and away map, which both computations below use. Then one round of reads: the open set and its
 * items, the newest 50 done items, the newest 100 decisions: the same number whatever the size of the list.
 * - "Fell overdue": the owner's own overdue items whose due time passed since the previous evening's wrap time; and
 *   the items someone else owes (overdue, to chase, or waiting) whose chase moment's anchor passed in that window, the
 *   moment they became chaseable (a debt due on a weekend, Eid or during an absence falls overdue when the pause ends),
 *   even when chasing still waits now (the 21:30 wrap in Ramadan is outside its hours).
 * - "Tomorrow": the agenda at the next working morning, 09:00 tomorrow or the first working moment after it
 *   (`firstWorkingMoment`: Sunday 08:00 after a Riyadh Thursday, 10:00 on a Ramadan day with the default hours).
 */
export async function buildWrap(scope: string, now: number): Promise<Wrap> {
  const { zone, cal, away } = await agendaFor(scope, now, { actor: "cron", via: "cron" });
  const [open, done, decisions] = await Promise.all([listOpenItems(scope), listDone(scope, 50), listDecisions(scope, DECISIONS_READ)]);
  const day = zoneDay(now, zone);
  const today = (iso: string | null | undefined) => !!iso && Number.isFinite(Date.parse(iso)) && zoneDay(Date.parse(iso), zone) === day;
  const completed = done.filter((it) => today(it.completedAt)).map((it) => ({ title: it.title, result: it.result, auto: it.result === AUTO_CLOSE_RESULT }));
  const decided = decisions.filter((d) => (APPROVALS.has(d.action) || d.action === "reject") && today(d.at));
  const since = previousEveningAt(now, zone);
  const rule = { zone, cal, away };
  const a = computeAgenda(open, now, rule);
  const inWindow = (t: number) => t > since && t <= now;
  // `anchor`, not `at`: `at` is when chasing may happen now, and at a Ramadan 21:30 wrap that is tomorrow's window.
  const fellOverdue = [...a.buckets.overdue, ...a.buckets.chase, ...a.buckets.waiting]
    .filter((e) => (e.item.owedBy === "owner" ? e.bucket === "overdue" && inWindow(Date.parse(e.item.dueAt ?? "")) : !!e.moment && inWindow(e.moment.anchor)))
    .map((e) => e.item.title);
  const tomorrowAt = firstWorkingMoment(zoneTime(addDays(day, 1), 9, 0, zone), cal);
  const next = computeAgenda(open, tomorrowAt, rule);
  const tomorrow = [...next.buckets.overdue, ...next.buckets.today, ...next.buckets.confirm, ...next.buckets.chase].slice(0, 3).map((e) => e.item.title);
  return { day, zone, completed, approved: decided.filter((d) => APPROVALS.has(d.action)).length, rejected: decided.filter((d) => d.action === "reject").length, fellOverdue, tomorrow, tomorrowAt };
}

export const wrapEmpty = (w: Wrap) => !w.completed.length && !w.approved && !w.rejected && !w.fellOverdue.length && !w.tomorrow.length;

/** The wrap's title: named after the brand when the account has more than one active brand (`brand`). */
export function wrapTitle(lang: "ar" | "en", brand = ""): string {
  if (lang === "ar") return brand ? `ملخص المساء من ريم — «${brand}»` : "ملخص المساء من ريم";
  return brand ? `Reem's evening wrap — “${brand}”` : "Reem's evening wrap";
}

/**
 * When "tomorrow" is read, as the owner reads it (ruling R14): «غداً 9 ص» / "tomorrow at 9 AM" on an ordinary evening;
 * the next morning's day by name after a weekend or holiday eve («الأحد 8 ص» / "Sunday at 8 AM" after a Riyadh
 * Thursday), with its date when it is a week or more away (after Eid); the time of a Ramadan window («غداً 10 ص»), with
 * its minutes when it does not start on the hour. Latin digits.
 */
function readAt(w: Wrap, lang: "ar" | "en"): string {
  const ar = lang === "ar";
  if (!Number.isFinite(w.tomorrowAt)) return ar ? "غداً 9 ص" : "tomorrow at 9 AM";
  const wall = zoneLocalInput(w.tomorrowAt, w.zone);
  const day = wall.slice(0, 10), hh = +wall.slice(11, 13), mm = +wall.slice(14, 16);
  const time = `${hh % 12 || 12}${mm ? `:${String(mm).padStart(2, "0")}` : ""} ${ar ? (hh < 12 ? "ص" : "م") : hh < 12 ? "AM" : "PM"}`;
  const ahead = daysBetween(w.day, day);
  if (ahead === 1) return ar ? `غداً ${time}` : `tomorrow at ${time}`;
  const name = ahead < 7
    ? dateFormat(lang, { weekday: "long" }).format(new Date(`${day}T12:00:00Z`))
    : formatWhen(new Date(endOfZoneDay(day, w.zone)).toISOString(), true, lang, zoneTime(w.day, 12, 0, w.zone), w.zone);
  return ar ? `${name} ${time}` : `${name} at ${time}`;
}

/** The wrap in the owner's language: a title and one line per part that has something. */
export function wrapText(w: Wrap, lang: "ar" | "en", brand = ""): { title: string; body: string } {
  const q = (t: string) => `«${t.slice(0, 80)}»`;
  if (lang === "ar") {
    const lines = [
      ...(w.completed.length ? [`• أُنجز اليوم (${w.completed.length}):`, ...w.completed.slice(0, 5).map((c) => `  – ${q(c.title)}: ${c.auto ? "أُغلقت تلقائياً لأن العنصر المرتبط اعتُمد" : (c.result ?? "").slice(0, 120)}`)] : []),
      ...(w.approved || w.rejected ? [`• قراراتك اليوم في صندوق الموافقة: اعتماد ${w.approved}، رفض ${w.rejected}`] : []),
      ...(w.fellOverdue.length ? [`• تأخّر منذ ملخص الأمس: ${w.fellOverdue.slice(0, 5).map(q).join("، ")}`] : []),
      ...(w.tomorrow.length ? [`• أول ما ينتظرك ${readAt(w, "ar")}: ${w.tomorrow.map(q).join("، ")}`] : []),
    ];
    return { title: wrapTitle("ar", brand), body: lines.join("\n") };
  }
  const lines = [
    ...(w.completed.length ? [`• Done today (${w.completed.length}):`, ...w.completed.slice(0, 5).map((c) => `  – ${q(c.title)}: ${c.auto ? "closed automatically, the linked item was approved" : (c.result ?? "").slice(0, 120)}`)] : []),
    ...(w.approved || w.rejected ? [`• Your decisions today in the approval inbox: ${w.approved} approved, ${w.rejected} rejected`] : []),
    ...(w.fellOverdue.length ? [`• Fell overdue since yesterday's wrap: ${w.fellOverdue.slice(0, 5).map(q).join(", ")}`] : []),
    ...(w.tomorrow.length ? [`• First for ${readAt(w, "en")}: ${w.tomorrow.map(q).join(", ")}`] : []),
  ];
  return { title: wrapTitle("en", brand), body: lines.join("\n") };
}

/**
 * The brand a wrap names: "" when the account has one active brand (nothing to tell apart), else the name given to the
 * brand, else its brand file's, as the brand switcher names it. One read of the brand list, one of the brand file only
 * when the list has no name.
 */
async function wrapBrand(email: string, scope: string): Promise<string> {
  const rows = await listBrands(email);
  if (rows.filter((b) => b.status === "active").length < 2) return "";
  const listed = rows.find((b) => scopeFor(email, b.id) === scope)?.name?.trim();
  return (listed || (await getBrand(scope))?.name || "").trim().slice(0, 60);
}

/**
 * One workspace's wrap at `now`: built, and when it has something, sent once for the local day. "off" when the owner
 * switched follow-ups off in Scheduled tasks (the wrap is one of them; the switch's text says so). The once-a-day
 * marker is released when the in-app notification cannot be written, so the batch's retry sends it; an email failure
 * after that keeps the marker, or the retry would push a second notification.
 */
export async function eveningWrap(user: User, now = Date.now()): Promise<"sent" | "silent" | "already" | "off"> {
  const scope = sc(user);
  if ((await getSchedule(scope)).followUps === false) return "off";
  const w = await buildWrap(scope, now);
  if (wrapEmpty(w)) return "silent";
  const marker = SEC_KEYS.wrap(scope, w.day);
  if (!(await db.setNx(marker, 1, WRAP_TTL_S))) return "already";
  let brand = "", title = "", body = "";
  try {
    brand = await wrapBrand(user.email, scope);
    ({ title, body } = wrapText(w, user.lang, brand));
    await notifyItem(user.email, user.lang, { kind: "todo", agent: "reem", title, body, href: `/${user.lang}/app/todo` });
  } catch (e) {
    await db.del(marker).catch(() => {});
    throw e;
  }
  if (process.env.RESEND_API_KEY) {
    const pref = ((await db.get<{ emails?: string }>(`profile:${scope}`)) ?? (await db.get<{ emails?: string }>(`profile:${user.email}`)) ?? {}).emails ?? "all";
    const subject = user.lang === "ar" ? `ملخص المساء — ${w.day}${brand ? ` — «${brand}»` : ""}` : `Evening wrap — ${w.day}${brand ? ` — “${brand}”` : ""}`;
    if (pref === "all") await sendEmail(user.email, subject, `${title}\n\n${body}\n\n${appOrigin()}/${user.lang}/app/todo`);
  }
  return "sent";
}
