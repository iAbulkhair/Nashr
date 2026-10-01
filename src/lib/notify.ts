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

/** Once-only guard for a named notification per user. */
export async function once(email: string, key: string): Promise<boolean> {
  // One atomic step, not read-then-write: two cron runs overlapping on the same user would otherwise both see nothing
  // and both send. `lock` is SET NX EX, so exactly one caller gets true, and the TTL bounds a marker that used to live
  // for ever.
  const first = await db.lock(onceKey(email, key), ONCE_TTL_SECONDS);
  // The suffix is caller-chosen (`weekly:2026-09-20`, `nudge1`, …) and the store has no key scan, so the names are
  // recorded here; without this an account deletion cannot find them and the address outlives the account.
  if (first) await db.sadd(ONCE_INDEX(email), key);
  return first;
}
export const onceKey = (email: string, key: string) => `notified:${email}:${key}`;
export const ONCE_INDEX = (email: string) => `notifiedkeys:${email}`;
/** Long enough that a "once ever" nudge is never repeated in practice, short enough that the key does not outlive the account. */
const ONCE_TTL_SECONDS = 400 * 86400;
