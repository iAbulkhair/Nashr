import { randomBytes } from "crypto";
import { db } from "./db";
import { log } from "./log";
import type { User } from "./auth";
import { getBrand, isWaiting, listLite } from "./brand";
import { NOT_NOW_DAYS, idleDays, soonNotNow } from "./not-now";
import { listBrands, scopeFor } from "./brands";
import { getSchedule } from "./schedule";
import { agentById, isAgentId, type AgentId } from "./agents";
import type { AgentCharge } from "./credits";
import { SEC_ALERTS_PER_DAY, SEC_KEYS, agendaFor, backFingerprint, overdueAlertFingerprint } from "./secretary";
import { compareItems, daysBetween, overdueAlerts, partyKey, partyName, zoneDay, type AwayMap, type OverdueAlert, type SecItem } from "./secretary-agenda";
import type { Zone } from "./zones";
import { appOrigin } from "./origin";
import { inAppAllowed, readPrefsMany, type NotifyPrefs } from "./notify-prefs";
import { accountKey } from "./keys";
import { listConnections } from "./connectors/store";
import { getProvider } from "./connectors/registry";
import { acct } from "./account-id";
import { brandOfScope } from "./account-id";
import { appHrefFor, appHrefIn, appHrefInBrand } from "@/lib/ws-href";

/**
 * In-app follow-ups from the team. Stored per account (not per brand) as one
 * capped JSON array so the bell is cheap to read. Each follow-up is deduped by a
 * fingerprint so the owner is nudged once per situation, not every day.
 */
export type NotifKind = "due" | "pending" | "weekly" | "credits" | "trial" | "quality" | "info" | "todo";
/**
 * `about` and `count` (rules 2350-2351, pattern 2 of docs/reports/2026-10-19-PRD-fizzy-orca_AR.md): the subject an entry is
 * about (`aboutKey`) and how many notices about it arrived while it stayed unread. Both optional (rule 679): older entries
 * have neither, and older code ignores them and shows the entry as it always did.
 */
export type Notif = { id: string; kind: NotifKind; title: string; body: string; href: string; at: string; read?: boolean; agent?: AgentId; about?: string; count?: number };

const KEY = (email: string) => accountKey.notifications(email);
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
/** A bell entry's id: `pushNotif` makes 10 hex characters; the route refuses anything outside this shape before a read. */
export const NOTIF_ID = /^[A-Za-z0-9_-]{1,40}$/;
/**
 * Mark one entry read (rule 1966), under the bell lock like every other write. The id is only looked up inside the
 * account's own list (`notifs:{email}`, the session's account), never used to build a key. Answers the unread count after
 * the write, or null when the account has no entry with that id (already gone from the capped list, or never there).
 */
export async function markRead(email: string, id: string): Promise<number | null> {
  return withBellLock(email, async () => {
    const all = await listNotifs(email);
    const hit = all.find((n) => n.id === id);
    if (!hit) return null;
    if (!hit.read) await db.set(KEY(email), all.map((n) => (n.id === id ? { ...n, read: true } : n)));
    return all.filter((n) => !n.read && n.id !== id).length;
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
  if (!got) log.error("bell lock not taken; writing without it");
  try {
    return await fn();
  } finally {
    if (got) await db.unlock(key).catch((e) => log.error("bell lock release failed", e));
  }
}
/** The marker that suppresses a repeat of one situation; exported so `wipeAccount` can name the ones it can list. */
export const seenKey = (email: string, fingerprint: string) => `notifseen:${email}:${fingerprint}`;
/**
 * A brand-level situation's fingerprint (#15). The daily and weekly jobs run once per brand, but the marker
 * `notifseen:{email}:...` is per account, so `due:{day}` claimed by the first brand silenced the same notice for every
 * other brand of the account. An added brand (`email#brandId`) now adds its id; the default brand (scope = the account
 * email) keeps the fingerprint it always had, so a notice it already sent today is not sent again on the day this ships.
 * Account-level situations (`credits`, `trial`) keep a plain fingerprint: they describe the account, once.
 */
export const brandFingerprint = (scope: string, fp: string) => (scope.includes("#") ? `${fp}#${brandOfScope(scope)}` : fp);
/**
 * The brand a brand-level notice is about, for its title: "" when the account has one active brand (nothing to tell
 * apart), else the name the brand switcher shows (the name given to the brand, else its brand file's).
 */
export async function brandTag(email: string, scope: string): Promise<string> {
  const rows = await listBrands(email);
  if (rows.filter((b) => b.status === "active").length < 2) return "";
  const row = rows.find((b) => scopeFor(email, b.id) === scope);
  return (row?.name || (await getBrand(scope))?.name || "").trim().slice(0, 60);
}
/** A notice title with its brand named, when there is one to name. */
export const withBrand = (title: string, tag: string) => (tag ? `${title} — ${tag}` : title);

/** The 80% warning's fingerprint: one per brand scope, agent and month. */
export const agentCapFingerprint = (scope: string, agent: AgentId, month: string) => `agentcap80:${scope}:${agent}:${month}`;

/**
 * One subject per bell entry (rule 2350): a brand's inbox nudges, its due list, its Not now notices, one to-do. A plain
 * label inside the account's own list, never a Redis key, and built from our own values (a scope, an item id).
 */
export const aboutKey = (what: "due" | "pending" | "notnow" | "quality" | "reconnect" | "todo", scope: string, id?: string) => [what, scope, ...(id ? [id] : [])].join(":");
/** The bell's cap on how many arrivals a counter shows: past it the entry reads "99+". */
export const COUNT_MAX = 99;

/**
 * The bell after `fresh` lands on `all` (rule 2351): a fresh entry with an `about` replaces every older entry about the
 * same subject, so the bell holds one entry per subject. Its `count` is the replaced entry's (1 when it had none) plus
 * one while that entry was unread, else it starts again at 1; read entries leave no count behind. Newest first, capped.
 */
export function collapse(fresh: Notif[], all: Notif[]): Notif[] {
  const out: Notif[] = [];
  const seen = new Map<string, Notif>();
  // Oldest fresh entry first, so a second entry about one subject in the same push counts the first.
  for (const n of [...fresh].reverse()) {
    if (!n.about) { out.unshift(n); continue; }
    const prev = seen.get(n.about) ?? all.find((x) => x.about === n.about);
    const count = prev && !prev.read ? Math.min(COUNT_MAX + 1, (prev.count ?? 1) + 1) : 1;
    const next = count > 1 ? { ...n, count } : n;
    if (seen.has(n.about)) out.splice(out.indexOf(seen.get(n.about)!), 1);
    seen.set(n.about, next);
    out.unshift(next);
  }
  return [...out, ...all.filter((x) => !x.about || !seen.has(x.about))].slice(0, MAX);
}

/** `scope`: the brand the entry is about, whose notification preferences apply (the account's when left out). */
export type Push = { n: Omit<Notif, "id" | "at">; fingerprint?: string; ttlDays?: number; scope?: string };
/**
 * Claim each fingerprint with SET NX and its TTL, all in one round; only what this caller claimed is pushed, in one
 * write of the bell under the account's bell lock (`withBellLock`). A marker read then written let two overlapping runs
 * (a chain hop and a catch-up) both notify. Answers per entry, in order: the notification pushed, or null when its
 * fingerprint was already claimed. When the bell write fails, the fingerprints this call claimed are released before
 * the error goes on, so a retry can still deliver: a claimed fingerprint with no entry would silence it for good.
 *
 * Notification preferences (rule 1146): an entry whose kind the person switched off in Settings, Notifications for its
 * brand (`Push.scope`, else the account) is claimed and answered like any other, so a caller that emails only what it
 * pushed still decides the email by its own preference, but it is not written to the bell. The preferences are read in
 * the same round as the claims. A caller that already read them for every scope it pushes (the reminder sweep, once per
 * account) passes them as `known`, and no read is made (rule 1190); a scope missing from `known` reads them all as before.
 */
export async function pushNotifs(email: string, entries: Push[], known?: Map<string, NotifyPrefs>): Promise<(Notif | null)[]> {
  const scopes = entries.map((e) => e.scope ?? email);
  const [won, prefs] = await Promise.all([
    Promise.all(entries.map((e) => (e.fingerprint ? db.setNx(seenKey(email, e.fingerprint), 1, (e.ttlDays ?? 3) * 86400) : true))),
    known && scopes.every((s) => known.has(s)) ? known : readPrefsMany(scopes, email),
  ]);
  const at = new Date().toISOString();
  const aligned: (Notif | null)[] = entries.map((e, i) => (won[i] ? { id: randomBytes(5).toString("hex"), at, ...e.n } : null));
  const items = aligned.filter((x, i): x is Notif => !!x && inAppAllowed(prefs.get(entries[i].scope ?? email)!, x.kind));
  if (!items.length) return aligned;
  try {
    await withBellLock(email, async () => {
      const all = await listNotifs(email);
      await db.set(KEY(email), collapse(items, all));
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
export async function pushNotif(email: string, n: Omit<Notif, "id" | "at">, fingerprint?: string, ttlDays = 3, scope?: string): Promise<Notif | null> {
  return (await pushMany(email, [{ n, fingerprint, ttlDays, ...(scope ? { scope } : {}) }]))[0] ?? null;
}


/** Daily follow-ups computed from the workspace. Returns what was created today. */
export async function followUps(user: User, scope: string): Promise<Notif[]> {
  const sched = await getSchedule(scope);
  if (sched.followUps === false) return [];
  const ar = user.lang === "ar";
  // Every entry opens the brand it is about (rule 894): `/b/{id}/…` of this scope, not the person's last choice.
  const to = (path = "") => appHrefFor(user, user.lang, path, brandOfScope(scope));
  const tasks = await listLite(scope, new Date(Date.now() - 180 * 864e5));
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const out: Notif[] = [];
  const add = async (n: Omit<Notif, "id" | "at">, fp: string, ttl = 3) => { const x = await pushNotif(acct(user), n, fp, ttl, scope); if (x) out.push(x); };
  // Due items and old approvals belong to this brand: its fingerprint and, on a multi-brand account, its name (#15).
  const due = tasks.filter((t) => t.status === "approved" && (t.scheduledFor === today || t.scheduledFor === tomorrow) && !t.published);
  const stale = tasks.filter((t) => isWaiting(t) && Date.now() - new Date(t.createdAt).getTime() > 48 * 36e5);
  // Items that move under "Not now" within days (rule 2344): told once per set of items, at 75% of the time.
  const soon = soonNotNow(tasks, Date.now(), sched.notNowFrom);
  const tag = due.length || stale.length || soon.length ? await brandTag(acct(user), scope) : "";

  // 1. Scheduled items due today or tomorrow and not yet published through a connector.
  if (due.length) {
    const titles = due.slice(0, 3).map((t) => t.title).join(" · ");
    await add({ kind: "due", agent: "noor", href: to("/calendar"), about: aboutKey("due", scope), title: withBrand(ar ? `${due.length} عنصر موعده اليوم أو غداً` : `${due.length} item(s) due today or tomorrow`, tag), body: ar ? `انشرها الآن، فلا شيء يُنشر تلقائياً: ${titles}` : `Publish now; nothing goes out automatically: ${titles}` }, brandFingerprint(scope, `due:${today}`), 2);
  }
  // 2. Approvals waiting more than 48 hours.
  if (stale.length) {
    await add({ kind: "pending", agent: "noor", href: to(), about: aboutKey("pending", scope), title: withBrand(ar ? `${stale.length} عنصر بانتظارك منذ أكثر من يومين` : `${stale.length} item(s) waiting for you for over 2 days`, tag), body: ar ? "اعتمد أو ارفض مع سبب، وتتعلم نور من قرارك." : "Approve or reject with a reason; Noor learns from your decision." }, brandFingerprint(scope, `pending:${Math.floor(stale.length / 5)}`), 3);
  }
  // 2b. Items about to move under "Not now": the soonest one sets the number of days.
  if (soon.length) {
    const days = Math.max(1, Math.ceil(NOT_NOW_DAYS - Math.max(...soon.map((t) => idleDays(t, Date.now(), sched.notNowFrom)))));
    const ids = soon.map((t) => t.id).sort().join(",").slice(0, 80);
    await add({ kind: "pending", agent: "noor", href: to(), about: aboutKey("notnow", scope), title: withBrand(ar ? `${soon.length} عنصر ينتقل إلى «ليس الآن» خلال ${days} يوم` : `${soon.length} item(s) move to Not now in ${days} day(s)`, tag), body: ar ? "اعتمدها أو ارفضها أو عدّلها لتبقى بانتظارك. لن يُحذف شيء." : "Approve, reject or edit them to keep them waiting. Nothing is deleted." }, brandFingerprint(scope, "notnow-soon:" + ids), 5);
  }
  // 3. Low credits.
  if (user.credits < 10) {
    await add({ kind: "credits", href: to("/billing"), title: ar ? `رصيدك ${user.credits} كريدت` : `Balance: ${user.credits} credits`, body: ar ? "لن يستطيع الفريق توليد دفعات جديدة قريباً. رقّ خطتك أو اطلب رصيداً." : "The team will not be able to generate new batches soon. Upgrade or request a top-up." }, "credits", 5);
  }
  // 4. Trial ending within 24h.
  if (user.plan === "trial") {
    const left = new Date(user.trialEnds).getTime() - Date.now();
    if (left > 0 && left < 864e5) await add({ kind: "trial", href: to("/billing"), title: ar ? "تجربتك تنتهي خلال 24 ساعة" : "Your trial ends within 24 hours", body: ar ? "اشترك لتبقى دفعاتك وجدولك تعمل." : "Subscribe to keep your batches and schedule running." }, "trial", 3);
  }
  // 5. Items the judge scored below 70 and still pending.
  const weak = tasks.filter((t) => isWaiting(t) && typeof t.score === "number" && t.score < 70);
  if (weak.length) {
    await add({ kind: "quality", agent: "dana", href: to(), about: aboutKey("quality", scope), title: ar ? `${weak.length} عنصر بدرجة جودة أقل من 70` : `${weak.length} item(s) scored below 70`, body: ar ? `${weak[0].notes ?? ""} أعد التوليد بملاحظة أوضح أو عدّل قبل الاعتماد.` : `${weak[0].notes ?? ""} Regenerate with a clearer note or edit before approving.` }, `quality:${weak.map((t) => t.id).sort().join(",").slice(0, 60)}`, 7);
  }
  // 6. Connections a platform refused (rule 2200): the owner hears it here, not only on the next failed publish.
  const broken = (await listConnections(scope)).filter((c) => {
    const p = getProvider(c.provider);
    return !!c.needsReconnect && !!p && !p.secretary;
  });
  if (broken.length) {
    const names = broken.map((c) => getProvider(c.provider)!.name).sort().join(ar ? "، " : ", ");
    const fp = ["reconnect", ...broken.map((c) => `${c.provider}@${c.needsReconnect}`).sort()].join(",").slice(0, 130);
    await add({ kind: "info", href: to("/settings/connections"), about: aboutKey("reconnect", scope), title: withBrand(ar ? `أعد ربط ${names}` : `Reconnect ${names}`, await brandTag(acct(user), scope)), body: ar ? "رفضت المنصة الربط الحالي، فلن ينشر الفريق أو يقرأ منها حتى تربطها من جديد." : "The platform refused the current connection, so the team cannot publish to it or read from it until you connect it again." }, brandFingerprint(scope, fp), 7);
  }
  // 7. Overdue to-dos on Reem's list.
  out.push(...(await overdueTodoAlerts(user, scope)));
  return out;
}

/**
 * How long an alert step's marker lives: a week at most (spec §7; `wipeAccount` leaves these markers to expire). Every
 * daily run sets it again while its step still holds, on quiet days too (ruling R15), so a step whose window runs over
 * a weekend or Eid al-Adha is never sent twice.
 */
const ALERT_TTL_DAYS = 7;
/** An absence that ended this many days ago or less is named on the item's next alert; its marker lives as long. */
const BACK_DAYS = 7;

/**
 * The last day of a contact's absence that ended in the last `BACK_DAYS` days (`endedAt`, ruling R3), when the item
 * already existed by then: an item made after the contact came back has no absence to report.
 */
function endedAbsence(it: SecItem, away: AwayMap, today: string, zone: Zone): string | null {
  if (it.owedBy === "owner" || isAgentId(it.owedBy)) return null;
  const key = partyKey(it.owedBy);
  const entry = key !== null && Object.prototype.hasOwnProperty.call(away, key) ? away[key] : undefined;
  if (!entry?.endedAt || daysBetween(entry.endedAt, today) > BACK_DAYS) return null;
  const made = Date.parse(it.createdAt);
  return Number.isFinite(made) && zoneDay(made, zone) <= entry.endedAt ? entry.endedAt : null;
}

/**
 * One alert per item that fell behind, spaced, then silence (`overdueAlerts`, spec §2.3): the owner's own overdue items
 * on the local day they fell behind and the 1st, 3rd and 7th day after, any day; an agent's from its chase moment the
 * same way; a contact's from its chase moment in working days, never on a quiet day, and on a Ramadan morning while it
 * is held for a window later today, saying "today after 10:00". Each step once, keyed by (scope, item, anchor, step), so
 * a new due date or chase moment starts afresh; after the 7th, only the morning brief. A step's marker lives seven days
 * and is set again (SET XX: never a claim) on every run its step still holds, including a quiet day's run that sends
 * nothing. The first alert after a contact's absence ended says they are back, once per absence (`backFingerprint`, 7
 * days). At most `SEC_ALERTS_PER_DAY` a brand a local day, critical and earliest first. The markers are claimed with SET
 * NX before anything is pushed; a claim beyond the day's allowance is handed back, so that item can still go on another
 * day of its window. Reads and writes are batched: no store call per item in turn.
 */
async function overdueTodoAlerts(user: User, scope: string): Promise<Notif[]> {
  const now = Date.now();
  const { zone, cal, away, buckets } = await agendaFor(scope, now, { actor: "cron", via: "cron" });
  const entries = [...buckets.overdue, ...buckets.chase, ...buckets.waiting].sort((a, b) => compareItems(a.item, b.item));
  const steps = overdueAlerts(entries, now, zone, cal);
  if (!steps.length) return [];
  const ar = user.lang === "ar";
  const lang = user.lang;
  const ttl = ALERT_TTL_DAYS * 86400;
  const marker = (a: OverdueAlert) => seenKey(acct(user), overdueAlertFingerprint(scope, a.entry.item.id, a.anchorMs, a.step));
  const due = steps.filter((a) => a.send), held = steps.filter((a) => !a.send);
  // One round: claim the steps that can be sent; keep alive the markers of steps that only hold today.
  const claims = Promise.all(due.map((a) => db.setNx(marker(a), 1, ttl)));
  await Promise.all([claims, ...held.map((a) => db.setXx(marker(a), 1, ttl))]);
  const won = await claims;
  const claimed = due.filter((_, i) => won[i]), kept = due.filter((_, i) => !won[i]);
  const today = zoneDay(now, zone);
  const counter = SEC_KEYS.alerts(scope, today);
  const total = claimed.length ? await db.incrby(counter, claimed.length) : 0;
  const allowed = Math.max(0, SEC_ALERTS_PER_DAY - (total - claimed.length));
  const send = claimed.slice(0, allowed), back = claimed.slice(allowed);
  const ended = send.map((a) => endedAbsence(a.entry.item, away, today, zone));
  const backWon = Promise.all(send.map((a, i) => (ended[i] ? db.setNx(seenKey(acct(user), backFingerprint(scope, a.entry.item.id, ended[i]!)), 1, BACK_DAYS * 86400) : false)));
  await Promise.all([
    ...(claimed.length ? [db.expireNx(counter, 2 * 86400)] : []),
    backWon,
    // Sent on an earlier run and still this step: its marker lives on.
    ...kept.map((a) => db.setXx(marker(a), 1, ttl)),
    ...(back.length ? [db.incrby(counter, -back.length), ...back.map((a) => db.del(marker(a)))] : []),
  ]);
  if (!send.length) return [];
  const isBack = await backWon;
  // Already claimed above: pushed without a fingerprint, in one write of the bell.
  return pushMany(acct(user), send.map(({ entry, step, ramadanToday: at }, i): Push => {
    const it = entry.item;
    const t = `«${it.title.slice(0, 80)}»`;
    const theirs = it.owedBy !== "owner";
    const late = !!it.dueAt && Date.parse(it.dueAt) < now;
    const who = partyName(it.owedBy, lang);
    const last = step === 7 ? (ar ? " هذا آخر تنبيه لها؛ بعده تظهر في ملخص الصباح فقط." : " This is its last alert; after today it is only in the morning brief.") : "";
    let body: string;
    if (isBack[i]) body = ar ? `انتهى غياب ${who} — وقت المتابعة${at ? ` (اليوم بعد ${at})` : ""}.` : `${who} is back: time to follow up${at ? ` (today after ${at})` : ""}.`;
    else if (at) body = ar ? `تابعه اليوم بعد ${at} مع ${who}، أو غيّر الموعد.` : `Follow up today after ${at} with ${who}, or change the date.`;
    else if (theirs) body = ar ? `تابِع مع ${who}، أو غيّر الموعد.` : `Follow up with ${who}, or change the date.`;
    else body = ar ? "أنجزها أو أجّلها أو غيّر موعدها." : "Do it, snooze it or reschedule it.";
    return {
      n: {
        kind: "todo", agent: "reem", href: appHrefInBrand(scope, lang, "/todo"), about: aboutKey("todo", scope, it.id),
        title: late ? (ar ? `متأخرة: ${t}` : `Overdue: ${t}`) : ar ? `حان وقت المتابعة: ${t}` : `Time to follow up: ${t}`,
        body: body + last,
      },
    };
  }));
}

export function notifEmailText(user: User, items: Notif[]) {
  const ar = user.lang === "ar";
  return [ar ? "متابعات الفريق اليوم:" : "Today's follow-ups from the team:", ...items.map((n) => `• ${n.title}\n  ${n.body}\n  ${appOrigin()}${n.href}`)].join("\n\n");
}

/** Helper for other modules (weekly cron, judge). */
export async function notifyItem(email: string, lang: "ar" | "en", n: { kind: NotifKind; agent?: AgentId; title: string; body: string; href: string; about?: string; brandScope?: string }, fp?: string, ttl?: number, scope?: string) {
  // A relative href opens the brand the entry is about (rule 894): `brandScope`, else the scope the entry is filed under.
  // Neither: the old path, whose `[...legacy]` page picks the session's brand (an account-wide notice).
  const { brandScope, ...rest } = n;
  const of = brandScope ?? scope;
  const href = rest.href.startsWith("/") ? rest.href : of ? appHrefInBrand(of, lang, `/${rest.href}`) : appHrefIn(email, lang, `/${rest.href}`);
  return pushNotif(email, { ...rest, href }, fp, ttl, scope);
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
    const [rows, file] = await Promise.all([listBrands(acct(user)), getBrand(paid.scope)]);
    const brand = (rows.find((b) => scopeFor(acct(user), b.id) === paid.scope)?.name || file?.name || "").trim().slice(0, 60);
    const where = brand ? (ar ? ` في «${brand}»` : ` in “${brand}”`) : "";
    await notifyItem(acct(user), user.lang, {
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
      href: "settings/governance",
      brandScope: paid.scope,
    }, agentCapFingerprint(paid.scope, paid.agent, paid.month), 35);
  } catch (e) {
    log.error("agent cap warning failed", e);
  }
}
