import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { csvSafe } from "./admin-stats";
import { normalizeEmail } from "./auth";
import { db, mgetChunked } from "./db";
import type { Lang } from "./i18n";
import { globalKey } from "./keys";
import { mailReady, sendEmail } from "./notify";
import { appOrigin } from "./origin";
import { sameSecret } from "./secret";
import { parseStored } from "./stored";

/**
 * The newsletter list (rules 3600-3609, docs/system/flows.md "Newsletter"). A visitor leaves an address and ticks a
 * consent box; we mail ONE confirm link; only the click makes the address a subscriber (double opt-in). Every mail of
 * the list carries a link that unsubscribes in one click, with no login. This branch holds the list, the confirm mail
 * and the unsubscribe; nothing here sends a newsletter.
 *
 * Why its own key family and not the waitlist's (`waitlist:emails`, `waitlist:entries`). The waitlist is "tell me when
 * the product opens": a SET of addresses plus a list of rows that have no status, no consent time and no token, and its
 * console export lists every row. A newsletter needs a status (pending, confirmed, unsubscribed), the time of consent and
 * a suppression list that outlives the unsubscribe, and its export must not hand the founder an address that never
 * confirmed as if it were a subscriber. Reusing the waitlist set would also make an address that joined the waitlist
 * impossible to subscribe (`sadd` dedupes), and a source flag on the same rows would put marketing consent in a list that
 * was never asked for it. So: new keys, the waitlist is untouched (expand only, nothing old is read or changed).
 *
 * Storage. A subscriber is one record under the SHA-256 of the normalized address (`newsletterSub`), so no key holds an
 * address; the address is inside the record. `newsletterIndex` is a sorted set of those ids (score: first sign-up time)
 * for the console list. Both tokens are random 32 bytes, hex, mailed in the URL FRAGMENT (`#t=`, as reset links, rule
 * 546) and stored only as their SHA-256:
 * - confirm: `newsletterConfirm`, single use (`getdel`), 48 hours, one live link per subscriber (a new one removes the
 *   previous);
 * - unsubscribe: `newsletterUnsub`, reusable so a second click answers the same as the first (idempotent), 400 days. A
 *   mail is minted its own link (`mintUnsubscribeLink`), so the plain token never has to be stored.
 * Both lookups are keyed by the hash and the stored hash is compared again with `sameSecret`.
 *
 * Nothing about an address is ever written to the logs.
 */

export const CONFIRM_TTL_SECONDS = 48 * 3600;
export const UNSUB_TTL_SECONDS = 400 * 86400;
export const NEWSLETTER_SOURCES = ["footer", "blog", "site"] as const;
export type NewsletterSource = (typeof NEWSLETTER_SOURCES)[number];
export const TOKEN_RE = /^[a-f0-9]{64}$/;

const Sub = z.looseObject({
  email: z.string().min(3),
  lang: z.enum(["ar", "en"]).catch("ar"),
  status: z.enum(["pending", "confirmed", "unsubscribed"]),
  source: z.string().catch("site"),
  /** When the visitor ticked the consent box and sent the form (the latest sign-up). */
  at: z.string().catch(""),
  confirmedAt: z.string().optional(),
  unsubscribedAt: z.string().optional(),
  /** SHA-256 of the one live confirm token. */
  ct: z.string().optional(),
});
export type NewsletterSub = z.output<typeof Sub>;
export type NewsletterStatus = NewsletterSub["status"];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const tokenHash = sha;
export const newTokenText = () => randomBytes(32).toString("hex");
/** The id of an address: the SHA-256 hex of its normalized form. */
export const newsletterId = (email: string) => sha(normalizeEmail(email));
/** A shape check only (as the waitlist's), plus a length cap. */
export const validNewsletterEmail = (email: string) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const readSub = async (id: string) => parseStored("newsletter.sub", Sub, await db.get(globalKey.newsletterSub(id)), null);

/** Runs `fn` while holding this subscriber's lock. Null when someone else holds it: the caller answers busy or does nothing. */
async function withSubLock<T>(id: string, fn: () => Promise<T>): Promise<T | null> {
  const key = globalKey.newsletterLock(id);
  // 30 seconds: a confirm mail may take up to EMAIL_TIMEOUT_MS (10 s) while the lock is held.
  if (!(await db.lock(key, 30))) return null;
  try {
    return await fn();
  } finally {
    await db.unlock(key);
  }
}

/** The page a link opens. The token is in the fragment: it never reaches a server log or a Referer header. */
export const confirmLink = (lang: Lang, token: string) => `${appOrigin()}/${lang}/newsletter/confirm#t=${token}`;
export const unsubscribeLink = (lang: Lang, token: string) => `${appOrigin()}/${lang}/newsletter/unsubscribe#t=${token}`;

/**
 * A fresh unsubscribe link for a subscriber id, to put in one mail (the confirm mail now, every newsletter later). The
 * plain token is not stored, only its hash, so each mail gets its own and all of them keep working for 400 days.
 */
export async function mintUnsubscribeLink(id: string, lang: Lang): Promise<string> {
  const token = newTokenText();
  const t = sha(token);
  await db.set(globalKey.newsletterUnsub(t), { id, t }, UNSUB_TTL_SECONDS);
  return unsubscribeLink(lang, token);
}

const COPY = {
  ar: {
    subject: "أكّد اشتراكك في نشرة ذكين",
    title: "أكّد اشتراكك في النشرة",
    intro: "طلب أحدهم الاشتراك في نشرة ذكين على هذا البريد. لن نرسل لك شيئاً قبل أن تؤكد.",
    action: "أكّد الاشتراك",
    expiry: "الرابط صالح لمدة 48 ساعة ويعمل مرة واحدة.",
    ignore: "إذا لم تطلب ذلك فتجاهل هذه الرسالة، ولن يصلك شيء.",
    unsub: "للإلغاء في أي وقت افتح هذا الرابط:",
  },
  en: {
    subject: "Confirm your subscription to the Thakeen newsletter",
    title: "Confirm your subscription",
    intro: "Someone asked to subscribe this address to the Thakeen newsletter. We send you nothing until you confirm.",
    action: "Confirm subscription",
    expiry: "The link works once and for 48 hours.",
    ignore: "If this was not you, ignore this email and nothing will be sent.",
    unsub: "To cancel at any time, open this link:",
  },
} as const;

/** The text part of the confirm mail (the HTML part is the shared `notice` template). */
export function confirmMailText(lang: Lang, confirm: string, unsub: string): string {
  const c = COPY[lang];
  return `${c.intro}\n\n${c.action}:\n${confirm}\n\n${c.expiry}\n${c.ignore}\n\n${c.unsub}\n${unsub}`;
}

/** Stores a fresh confirm link (replacing the previous one) and mails it. Returns the new token's hash when the mail went out. */
async function sendConfirm(id: string, email: string, lang: Lang, previous?: string): Promise<string | null> {
  const token = newTokenText();
  const t = sha(token);
  const unsub = await mintUnsubscribeLink(id, lang);
  const confirm = confirmLink(lang, token);
  // The new link replaces the old one: a second request leaves one live link, never a pile of them.
  await Promise.all([db.set(globalKey.newsletterConfirm(t), { id, t }, CONFIRM_TTL_SECONDS), previous ? db.del(globalKey.newsletterConfirm(previous)) : Promise.resolve()]);
  const c = COPY[lang];
  const sent = await sendEmail({
    to: email,
    subject: c.subject,
    text: confirmMailText(lang, confirm, unsub),
    template: "notice",
    locale: lang,
    context: { title: c.title, paragraphs: [c.intro, c.expiry, c.ignore, `${c.unsub}\n${unsub}`], cta: { href: confirm, label: c.action } },
  });
  // A link that never went out is not kept: it would stay live for 48 hours for nobody.
  if (!sent) await db.del(globalKey.newsletterConfirm(t));
  return sent ? t : null;
}

export type SubscribeResult = "mail_off" | "ok";

/**
 * A visitor asked to subscribe (the box was ticked: the route refuses a request without consent). Ends in one of two
 * answers whatever the address already was, so the caller cannot tell a new address from a known one:
 * - `mail_off`: mail cannot reach anyone (no sender is set up): nothing is stored and the form says so;
 * - `ok`: a new, pending or unsubscribed address gets a confirm mail; a confirmed one gets nothing (it is subscribed).
 * An unsubscribed address goes through the confirm again: only a click on a mailed link makes a subscriber again.
 */
export async function startSubscription(email: string, lang: Lang, source: NewsletterSource, now: Date = new Date()): Promise<SubscribeResult> {
  if (!mailReady()) return "mail_off";
  const address = normalizeEmail(email);
  const id = newsletterId(address);
  await withSubLock(id, async () => {
    const cur = await readSub(id);
    if (cur?.status === "confirmed") return;
    // The record is written first (pending), the mail second: a mail that fails leaves a pending address the console
    // shows as pending, not a lost sign-up.
    const next: NewsletterSub = { ...(cur ?? {}), email: address, lang, status: "pending", source, at: now.toISOString() };
    delete next.confirmedAt;
    delete next.unsubscribedAt;
    await db.set(globalKey.newsletterSub(id), next);
    // ZADD LT keeps the first sign-up's score when the address is already in the index.
    await db.zadd(globalKey.newsletterIndex(), now.getTime(), id, { lt: true });
    const t = await sendConfirm(id, address, lang, cur?.ct);
    await db.set(globalKey.newsletterSub(id), { ...next, ct: t ?? undefined });
  });
  return "ok";
}

export type TokenResult = "ok" | "bad_token" | "busy";

/**
 * The confirm click. The token is single use (`getdel`: of two overlapping clicks exactly one gets the record), expires
 * in 48 hours and must be the subscriber's one live link. An address that unsubscribed after asking cannot be confirmed
 * by an old mail. A subscriber already confirmed answers `ok` (a double click on the button).
 */
export async function confirmSubscription(token: unknown, now: Date = new Date()): Promise<TokenResult> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return "bad_token";
  const t = sha(token);
  const rec = await db.getdel<{ id?: unknown; t?: unknown }>(globalKey.newsletterConfirm(t));
  if (!rec || typeof rec.id !== "string" || typeof rec.t !== "string" || !sameSecret(rec.t, t)) return "bad_token";
  const id = rec.id;
  const done = await withSubLock(id, async (): Promise<TokenResult> => {
    const cur = await readSub(id);
    if (!cur) return "bad_token";
    if (cur.status === "confirmed") return "ok";
    if (cur.status !== "pending" || !sameSecret(cur.ct, t)) return "bad_token";
    await db.set(globalKey.newsletterSub(id), { ...cur, status: "confirmed", confirmedAt: now.toISOString(), ct: undefined });
    return "ok";
  });
  if (done === null) {
    // Someone else holds the subscriber for a moment: the link was taken, so put it back for the retry.
    await db.set(globalKey.newsletterConfirm(t), rec, CONFIRM_TTL_SECONDS);
    return "busy";
  }
  return done;
}

/**
 * The unsubscribe click, from any mail of the list. No login. Idempotent: an address already unsubscribed answers `ok`
 * again, and the record stays as the suppression list (a pending sign-up that unsubscribes is suppressed too). A token
 * this list never minted, or one older than 400 days, is `bad_token`.
 */
export async function unsubscribe(token: unknown, now: Date = new Date()): Promise<TokenResult> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return "bad_token";
  const t = sha(token);
  const rec = await db.get<{ id?: unknown; t?: unknown }>(globalKey.newsletterUnsub(t));
  if (!rec || typeof rec.id !== "string" || typeof rec.t !== "string" || !sameSecret(rec.t, t)) return "bad_token";
  const id = rec.id;
  const done = await withSubLock(id, async (): Promise<TokenResult> => {
    const cur = await readSub(id);
    if (!cur) return "bad_token";
    if (cur.status === "unsubscribed") return "ok";
    // The live confirm link dies with it: an old mail must not bring the address back.
    if (cur.ct) await db.del(globalKey.newsletterConfirm(cur.ct));
    await db.set(globalKey.newsletterSub(id), { ...cur, status: "unsubscribed", unsubscribedAt: now.toISOString(), ct: undefined });
    return "ok";
  });
  return done ?? "busy";
}

export type SubscriberRow = { email: string; status: NewsletterStatus; lang: "ar" | "en"; source: string; at: string; confirmedAt: string; unsubscribedAt: string };
export type SubscriberPage = { rows: SubscriberRow[]; total: number; counts: Record<NewsletterStatus, number> };
export const SUBSCRIBERS_PAGE_MAX = 100;
const READ_CAP = 20000;

async function allSubscribers(): Promise<SubscriberRow[]> {
  const ids = (await db.zrangeWithScores(globalKey.newsletterIndex())).reverse().slice(0, READ_CAP).map((m) => m.member);
  const recs = await mgetChunked(ids.map((id) => globalKey.newsletterSub(id)));
  return recs.flatMap((raw) => {
    const s = parseStored("newsletter.sub", Sub, raw, null);
    return s ? [{ email: s.email, status: s.status, lang: s.lang, source: s.source, at: s.at, confirmedAt: s.confirmedAt ?? "", unsubscribedAt: s.unsubscribedAt ?? "" }] : [];
  });
}

/** The console list, newest sign-up first. `status` narrows it; `counts` always counts every status. */
export async function listSubscribers(opts: { status?: NewsletterStatus; offset?: number; limit?: number; everything?: boolean } = {}): Promise<SubscriberPage> {
  const all = await allSubscribers();
  const counts: Record<NewsletterStatus, number> = { pending: 0, confirmed: 0, unsubscribed: 0 };
  for (const r of all) counts[r.status]++;
  const shown = opts.status ? all.filter((r) => r.status === opts.status) : all;
  const offset = opts.everything ? 0 : Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = opts.everything ? shown.length : Math.min(SUBSCRIBERS_PAGE_MAX, Math.max(0, Math.floor(opts.limit ?? 50)));
  return { rows: shown.slice(offset, offset + limit), total: shown.length, counts };
}

/** UTF-8 CSV (the route adds the BOM). Every cell through `csvSafe`: an address like "=cmd|..." must stay text in Excel. */
export function subscribersCsv(rows: SubscriberRow[]): string {
  const esc = (v: unknown) => `"${csvSafe(String(v ?? "")).replace(/"/g, '""')}"`;
  const cols: (keyof SubscriberRow)[] = ["email", "status", "lang", "source", "at", "confirmedAt", "unsubscribedAt"];
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n");
}
