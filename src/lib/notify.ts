import { CAPS, db, pushCapped } from "./db";

/**
 * Whether email can actually reach a customer. It needs the API key AND a real sender. Without MAIL_FROM the sender is
 * Resend's shared `onboarding@resend.dev`, which may deliver only to the Resend account owner's own address — so for
 * every customer, email is effectively off. Screens that promise "a link is on its way" must ask this, not whether a
 * key happens to be set.
 */
export const mailReady = () => !!process.env.RESEND_API_KEY && !!process.env.MAIL_FROM;

/**
 * How long one send may take. The Resend client takes no abort signal, so the call is raced against this: a hung call
 * must not hold a cron slot (or Reem's reminder lease, src/lib/secretary-remind.ts) until the platform kills the
 * function. A send that times out answers false like a refused one: it is not known to have gone.
 */
export const EMAIL_TIMEOUT_MS = 10_000;

/** Notification channels. Email via Resend when RESEND_API_KEY is set; WhatsApp when the Business API is approved. */
export async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const from = process.env.MAIL_FROM ?? "Noor at Thakeen <onboarding@resend.dev>";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { Resend } = await import("resend");
    const resend = new Resend(key);
    // `send` RESOLVES with { data, error }; it does not throw when the API refuses the message (see the Response type
    // in resend's own d.ts). The old code awaited it and returned true regardless, so a refused email was reported as
    // sent: password resets, trial mail and weekly plans all silently went nowhere while every screen said they had
    // been sent. The catch below only ever caught a transport failure, which is the rarer half of the problem.
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), EMAIL_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    const res = await Promise.race([resend.emails.send({ from, to, subject, text }), timeout]);
    if (res === "timeout") {
      await mailFailed(from, `no answer within ${EMAIL_TIMEOUT_MS / 1000} s`);
      return false;
    }
    if (res.error) {
      await mailFailed(from, res.error.message ?? res.error.name ?? "unknown");
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
  console.error("email refused", { from, reason });
  // The recipient is deliberately NOT recorded: this ring is read by the founder console and an address here would
  // turn a delivery log into a list of who asked for a password reset.
  await pushCapped(
    "admin:log",
    JSON.stringify({ actor: "system", email: "mail", what: "mail:refused", after: { from, reason: reason.slice(0, 200) }, at: new Date().toISOString() }),
    CAPS.adminLog,
  ).catch(() => {});
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
 */
export async function sendOnce(email: string, key: string, subject: string, text: string): Promise<OnceResult> {
  const marker = onceKey(email, key);
  if (!repairable(await db.get(marker))) return "already";
  const claim = onceClaimKey(email, key);
  const token = await db.lockOwned(claim, ONCE_CLAIM_TTL_SECONDS);
  if (!token) return "busy";
  try {
    // The suffix is caller-chosen (`nudge1`, `lifecycle:day1`, …) and the store has no key scan, so the name is recorded
    // before anything else is written: an account deletion finds the marker, the claim and the repair flag through it.
    await db.sadd(ONCE_INDEX(email), key);
    const held = await db.get(marker);
    if (!repairable(held)) return "already";
    if (held !== null && held !== undefined) {
      // An old-guard marker on a message that is due again: clear it once, never twice.
      if (!(await db.lock(onceRepairKey(email, key), ONCE_TTL_SECONDS))) return "already";
      await db.del(marker);
    }
    if (!(await sendEmail(email, subject, text))) return "failed";
    await markSent(email, key);
    return "sent";
  } finally {
    await db.unlockOwned(claim, token).catch(() => {});
  }
}
export type OnceResult = "sent" | "already" | "busy" | "failed";

/** What `markSent` stores: the moment Resend accepted the message. The old claim-before-send guard stored a bare lock. */
type SentRecord = { sent: string };
/** Whether a marker value was written by `markSent`, i.e. after Resend accepted the message. */
export const confirmedMarker = (v: unknown): v is SentRecord => typeof v === "object" && v !== null && typeof (v as SentRecord).sent === "string";
/**
 * Whether `sendOnce` may go on with this marker value: no marker, or an old-guard marker (no proof of delivery) while mail
 * can reach customers. The repair flag is checked under the claim, not here.
 */
const repairable = (v: unknown) => v === null || v === undefined || (!confirmedMarker(v) && mailReady());

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
