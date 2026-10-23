import { db } from "./db";
import { adminAudit } from "./admin-audit";
import { renderEmail, type EmailContext, type EmailTemplateId } from "../emails";
import type { Lang } from "./i18n";
import { log } from "./log";
import { wsKey } from "./keys";
import { mailProvider, smtpSettings } from "./mail-provider";

/**
 * Whether email can actually reach a customer. It needs the API key AND a real sender. Without MAIL_FROM the sender is
 * Resend's shared `onboarding@resend.dev`, which may deliver only to the Resend account owner's own address — so for
 * every customer, email is effectively off. Screens that promise "a link is on its way" must ask this, not whether a
 * key happens to be set. Complete SMTP settings (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM; rule 3570)
 * also make mail ready: SMTP_FROM is its own sender.
 */
export const mailReady = () => (!!process.env.RESEND_API_KEY && !!process.env.MAIL_FROM) || !!smtpSettings();

/**
 * How long one send may take. The Resend client takes no abort signal, so the call is raced against this: a hung call
 * must not hold a cron slot (or Reem's reminder lease, src/lib/secretary-remind.ts) until the platform kills the
 * function. A send that times out answers false like a refused one: it is not known to have gone.
 */
export const EMAIL_TIMEOUT_MS = 10_000;

/**
 * A message from one registered template (rule 1962): the caller names the template, hands it its typed `context` and
 * the reader's `locale`, and keeps writing the subject and the plain-text part itself (tests parse tokens and links out
 * of the text, so it stays word for word). `sendEmail` renders the HTML part from src/emails/ and sends both.
 */
export type TemplateMail<T extends EmailTemplateId = EmailTemplateId> = { to: string; subject: string; text: string; template: T; context: EmailContext<T>; locale: Lang };

/**
 * Send one email. Two forms:
 * - typed: `sendEmail({ to, subject, text, template, context, locale })`, for every message a customer receives. The
 *   template's context is checked at compile time against its function in src/emails/ (`EmailContext`).
 * - plain: `sendEmail(to, subject, text, html?)`, for internal text-only mail (the support inbox, staff alerts) and the
 *   routes that still build their HTML themselves. Expand step: the typed form is new, the plain one stays.
 *
 * The message goes to the provider for this process (src/lib/mail-provider.ts, rule 1963): Resend when RESEND_API_KEY is
 * set (SMTP behind it as the fallback, or alone when Resend is not usable; rule 3570), the console provider on a
 * non-production deploy without either, none on production without either. The answer is true only when Resend or SMTP
 * accepted the message; a refusal, a timeout, a transport error, the console provider and no provider at
 * all answer false. `html`, when given, is sent with the plain-text part, so a templated message is multipart (rule 689);
 * without it Resend receives no `html` key. Click tracking must stay off for the sending domain in Resend: it rewrites
 * the HTML part's links through Resend's redirect, and the reset and join links carry their token in the fragment (rule
 * 546, src/emails/reset-password.ts).
 */
export async function sendEmail<T extends EmailTemplateId>(mail: TemplateMail<T>): Promise<boolean>;
export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<boolean>;
export async function sendEmail(a: string | TemplateMail, subject?: string, text?: string, html?: string): Promise<boolean> {
  const msg = typeof a === "string" ? { to: a, subject: subject ?? "", text: text ?? "", html } : { to: a.to, subject: a.subject, text: a.text, html: renderEmail(a.template, a.context, a.locale) };
  const provider = mailProvider();
  if (!provider) return false;
  const from = process.env.MAIL_FROM ?? "Noor at Thakeen <onboarding@resend.dev>";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A hung call must not hold a cron slot: the provider's promise is raced against EMAIL_TIMEOUT_MS. The old code
    // awaited Resend and returned true regardless, so a refused email was reported as sent; the provider now reports a
    // refusal (`delivered: false` with `refused`), and the catch below only ever sees a transport failure.
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), EMAIL_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    const res = await Promise.race([provider.send({ from, ...msg }), timeout]);
    if (res === "timeout") {
      await mailFailed(from, `no answer within ${EMAIL_TIMEOUT_MS / 1000} s`);
      return false;
    }
    if (!res.delivered) {
      if (res.refused !== undefined) await mailFailed(from, res.refused);
      return false;
    }
    return true;
  } catch (e) {
    await mailFailed(from, e instanceof Error ? e.message : "transport error");
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A refused email is an operational fact, not a log line nobody reads. The commonest cause is the default sender:
 * without MAIL_FROM the address is Resend's `onboarding@resend.dev`, which may only deliver to the Resend account
 * owner's own address, so every other recipient is rejected one at a time and in silence.
 */
async function mailFailed(from: string, reason: string) {
  log.error("email refused", { from, reason: reason.slice(0, 200) });
  // The recipient is deliberately NOT recorded: this ring is read by the founder console and an address here would
  // turn a delivery log into a list of who asked for a password reset.
  await adminAudit({ actor: "system", section: "system", target: "mail", what: "mail:refused", after: { from, reason: reason.slice(0, 200) } }).catch(() => {});
}

/**
 * A named one-time email per user (the signup nudge, each lifecycle note), marked as sent only after Resend accepted it.
 *
 * The old guard (`once()`) claimed a 400-day marker and THEN sent. Resend refuses every recipient but the account owner
 * while MAIL_FROM is unset, and `sendEmail` answers false for that, but the marker was already taken: every nudge and
 * trial note refused since 2026-09-18 was recorded as done and would never have been retried. Now it is claim, send,
 * confirm:
 * - a short claim (`ONCE_CLAIM_TTL_SECONDS`, SET NX with an owner token) so two overlapping cron runs cannot both send;
 * - the long marker only once `sendEmail` answered true (Resend accepted it);
 * - the claim released either way, so a refused or timed-out send is tried again on the next run.
 * The marker is re-read under the claim: a run that sent and released between this run's first read and its claim has
 * marked it by then. A process that dies between the send and the marker can send once more after the claim expires,
 * which is the lesser failure: a duplicate note against a note that never arrives.
 *
 * Burned markers (founder decision 2026-10-01). A marker the old guard wrote proves nothing was delivered: RESEND_API_KEY
 * arrived on 2026-09-18, MAIL_FROM never did, so every such marker stands for a refused send (the one exception is the
 * Resend account owner's own address, which may get that one note twice). `markSent` now stores a dated record
 * (`{ sent }`), which the old guard never wrote, so the two are told apart by the value alone. When mail can reach
 * customers (`mailReady()`) and the message is due again (the callers only ask for due messages: the nudge while the
 * account has no brand, a lifecycle note inside its window), an old-guard marker is cleared ONCE, under the claim, and
 * the message goes out through the normal path. The once-only part is a 400-day repair flag per (account, message)
 * (`onceRepairKey`, SET NX): a second run, a second instance, or a send that is refused after the repair can never clear
 * an old marker again. A marker written by `markSent` is never cleared.
 *
 * Only markers written before `REPAIR_BEFORE` are cleared, whatever the deploy order. The old guard is still what runs on
 * main, so if MAIL_FROM went live before this code did, the markers it wrote in that gap would stand for sends that
 * succeeded, and clearing them would mail those customers twice. The old guard always wrote its marker with a 400-day
 * expiry, so its remaining TTL gives the moment it was written (`writtenBeforeRepairCutoff`); a marker with no expiry
 * predates that guard. A marker burned after the cutoff and before this code is live is left alone: missing that one
 * repair is the lesser failure.
 *
 * `email` names the marker's owner (an account id from rule 3022 on, the sign-in address before); `to` is the recipient
 * and defaults to it.
 *
 * `html`, when given, is the message's HTML part and goes to `sendEmail` with the text (rule 689): a registered template
 * (`{ template, context, locale }`, rule 1962), or markup a caller already built.
 */
export async function sendOnce<T extends EmailTemplateId>(email: string, key: string, subject: string, text: string, html?: string | OncePart<T>, to: string = email): Promise<OnceResult> {
  const marker = onceKey(email, key);
  const first = await db.get(marker);
  if (!repairable(first) || (isOldMarker(first) && !(await writtenBeforeRepairCutoff(marker)))) return "already";
  const claim = onceClaimKey(email, key);
  const token = await db.lockOwned(claim, ONCE_CLAIM_TTL_SECONDS);
  if (!token) return "busy";
  try {
    // The suffix is caller-chosen (`nudge1`, `lifecycle:day1`, …) and the store has no key scan, so the name is recorded
    // before anything else is written: an account deletion finds the marker, the claim and the repair flag through it.
    await db.sadd(ONCE_INDEX(email), key);
    const held = await db.get(marker);
    if (!repairable(held)) return "already";
    if (isOldMarker(held)) {
      // An old-guard marker on a message that is due again: clear it once, never twice, and only one written before the cutoff.
      if (!(await writtenBeforeRepairCutoff(marker))) return "already";
      if (!(await db.lock(onceRepairKey(email, key), ONCE_TTL_SECONDS))) return "already";
      await db.del(marker);
    }
    const sent = typeof html === "object" ? await sendEmail({ to, subject, text, ...html }) : await sendEmail(to, subject, text, html);
    if (!sent) return "failed";
    await markSent(email, key);
    return "sent";
  } finally {
    await db.unlockOwned(claim, token).catch(() => {});
  }
}
export type OnceResult = "sent" | "already" | "busy" | "failed";
/** The template half of a typed message, for `sendOnce`: the address, subject and text are its own arguments. */
export type OncePart<T extends EmailTemplateId = EmailTemplateId> = Pick<TemplateMail<T>, "template" | "context" | "locale">;

/** What `markSent` stores: the moment Resend accepted the message. The old claim-before-send guard stored a bare lock. */
type SentRecord = { sent: string };
/** Whether a marker value was written by `markSent`, i.e. after Resend accepted the message. */
export const confirmedMarker = (v: unknown): v is SentRecord => typeof v === "object" && v !== null && typeof (v as SentRecord).sent === "string";
/**
 * Whether `sendOnce` may go on with this marker value: no marker, or an old-guard marker (no proof of delivery) while mail
 * can reach customers. The repair flag is checked under the claim, not here.
 */
const repairable = (v: unknown) => v === null || v === undefined || (!confirmedMarker(v) && mailReady());
/** A marker the old claim-before-send guard wrote: present, but with no `sent` record. */
const isOldMarker = (v: unknown) => v !== null && v !== undefined && !confirmedMarker(v);

/**
 * Old-guard markers written at or after this moment are never cleared (founder decision 2026-10-01). MAIL_FROM was not set
 * in production when it was fixed, so every old marker written before it stands for a refused send. Do not move it later:
 * a marker the old guard wrote after MAIL_FROM went live stands for a message the customer received.
 */
export const REPAIR_BEFORE = "2026-10-01T17:00:00.000Z";
/**
 * Whether the old-guard marker at `marker` was written before `REPAIR_BEFORE`. The old guard wrote every marker with a
 * 400-day expiry (SET NX EX), so the write time is now minus (400 days minus the remaining TTL). No expiry (-1) means a
 * guard older than that one, so before the cutoff; a missing key (-2) has nothing to repair.
 */
export async function writtenBeforeRepairCutoff(marker: string): Promise<boolean> {
  const ttl = await db.ttl(marker);
  if (ttl === -1) return true;
  if (ttl < 0) return false;
  return repairClock.now() - (ONCE_TTL_SECONDS - ttl) * 1000 < Date.parse(REPAIR_BEFORE);
}
/**
 * The clock `writtenBeforeRepairCutoff` reads. Always `Date.now()` in the product; tests pin it so a marker "written
 * before the cutoff" stays one whatever day CI runs (no old marker can outlive the cutoff by more than 400 days).
 */
export const repairClock = { now: () => Date.now() };

/** Record a named one-time email as sent. Only `sendOnce` calls this in the product, after Resend accepted the message. */
export async function markSent(email: string, key: string): Promise<void> {
  const record: SentRecord = { sent: new Date().toISOString() };
  await Promise.all([db.set(onceKey(email, key), record, ONCE_TTL_SECONDS), db.sadd(ONCE_INDEX(email), key)]);
}
export const onceKey = (email: string, key: string) => `notified:${email}:${key}`;
/** The in-flight claim for one named email. Short: it only has to outlast one send (`EMAIL_TIMEOUT_MS`) and the marker write. */
export const onceClaimKey = (email: string, key: string) => `notifying:${email}:${key}`;
/** Set the one time an old-guard (burned) marker for this message was cleared, so it is never cleared again. */
export const onceRepairKey = (email: string, key: string) => `notifyrepair:${email}:${key}`;
export const ONCE_INDEX = (email: string) => `notifiedkeys:${email}`;
/** Long enough that a "once ever" nudge is never repeated in practice, short enough that the key does not outlive the account. */
const ONCE_TTL_SECONDS = 400 * 86400;
export const ONCE_CLAIM_TTL_SECONDS = 120;

/** How long a day's mail claim lives: the batch's own marker TTL, so a retry on the next day's run still finds it. */
const MAIL_DAY_TTL_SECONDS = 2 * 86400;

/**
 * Send the workspace's one daily email at most once a day (rule 3023). The claim is `SET NX` on the workspace and the
 * UTC day (the batch's period) BEFORE the send; a refused send releases it so a retry may try again, a killed run keeps
 * it so the retry does not mail twice. Answers whether the mail was accepted.
 */
export async function mailOncePerDay(scope: string, send: () => Promise<boolean>): Promise<boolean> {
  const key = wsKey.dailyMail(scope, new Date().toISOString().slice(0, 10));
  if (!(await db.lock(key, MAIL_DAY_TTL_SECONDS))) return false;
  let ok = false;
  try {
    ok = await send();
  } finally {
    if (!ok) await db.unlock(key).catch(() => {});
  }
  return ok;
}
