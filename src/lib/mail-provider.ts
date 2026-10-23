import { isProductionDeploy } from "./deploy-env";
import { log } from "./log";

/**
 * Where an email goes (rules 1962-1963, 3570-3579). `sendEmail` (src/lib/notify.ts) builds the message and hands it to
 * one provider; the provider only delivers. Three exist:
 * - `resend`: the real one, whenever RESEND_API_KEY is set. Resend's `send` RESOLVES with `{ data, error }` and does not
 *   throw when the API refuses a message, so a refusal is read from `error`, never assumed away.
 * - `smtp` (rule 3570): Nodemailer, Node runtime only, used only when SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and
 *   SMTP_FROM are all set (`smtpSettings`). It is the primary when Resend is not usable, and the fallback when Resend
 *   fails with a retryable error. The rule is written in docs/system/flows.md "Mail providers".
 * - `console`: on a deploy that is not production (`next dev`, vitest, the e2e build) with no key. It keeps the last
 *   messages in memory for a developer and the tests (`consoleOutbox`) and writes one debug line per message with the
 *   recipient's domain and the sizes only: the subject and the text carry verification codes and reset links, and
 *   "secrets are never logged" (CLAUDE.md) holds in development too. It answers `delivered: false`, because nothing
 *   reached anyone: every caller that asks "did it go?" gets the same answer it got before this provider existed.
 * On a production deploy with neither Resend nor SMTP there is no provider and `sendEmail` answers false, as before.
 */
export type MailMessage = { from: string; to: string; subject: string; text: string; html?: string; replyTo?: string };
/** `retryable` is set only by a provider that knows the failure was on its side (5xx, network, no answer): the one fact the fallback reads. */
export type MailResult = { delivered: true } | { delivered: false; refused?: string; retryable?: boolean };
export interface MailProvider {
  readonly name: "resend" | "smtp" | "console";
  send(m: MailMessage): Promise<MailResult>;
}

const NO_CONTROL = /[\r\n\0]/;
const PLAIN_ADDRESS = /^[^\s<>()[\]\\,;:"@]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
/** One bare address, `name@host.tld`: no display name, no list, no angle brackets, no line break. */
export const plainAddress = (a: string): boolean => a.length <= 254 && PLAIN_ADDRESS.test(a);
/** A sender is a bare address or `Display Name <address>`. */
export const senderAddress = (a: string): boolean => {
  if (NO_CONTROL.test(a)) return false;
  const named = /^[^<>]{1,100}<([^<>]+)>$/.exec(a.trim());
  return plainAddress(named ? named[1].trim() : a.trim());
};
/**
 * What the SMTP adapter checks before it opens a connection (and Resend's adapter checks for `replyTo`): the recipient
 * is one plain address, `replyTo` (when given) is one plain address, and no header value carries a line break (header
 * injection). The answer names the field, never the value.
 */
export function mailProblem(m: MailMessage, opts: { recipient: boolean } = { recipient: true }): string | null {
  if (opts.recipient && !plainAddress(m.to)) return "invalid recipient address";
  if (m.replyTo !== undefined && !plainAddress(m.replyTo)) return "invalid reply-to address";
  if (NO_CONTROL.test(m.subject) || NO_CONTROL.test(m.from) || NO_CONTROL.test(m.to) || NO_CONTROL.test(m.replyTo ?? "")) return "line break in a header value";
  return null;
}

/** Resend's retryable failure is a 5xx answer, or a failure before any answer (the SDK reports it as `application_error` with no status). A 4xx is the message's own fault and is never tried elsewhere. */
export function resendRetryable(e: { name?: string; statusCode?: number | null }): boolean {
  if (typeof e.statusCode === "number") return e.statusCode >= 500;
  return e.name === "application_error";
}

export function resendProvider(key: string): MailProvider {
  return {
    name: "resend",
    async send(m) {
      const problem = mailProblem(m, { recipient: false });
      if (problem) return { delivered: false, refused: problem };
      const { Resend } = await import("resend");
      const res = await new Resend(key).emails.send({ from: m.from, to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}) });
      return res.error ? { delivered: false, refused: res.error.message ?? res.error.name ?? "unknown", retryable: resendRetryable(res.error) } : { delivered: true };
    },
  };
}

/** SMTP settings as the environment gives them. Values are read at call time and never logged. */
export type SmtpSettings = { host: string; port: number; secure: boolean; user: string; pass: string; from: string };

/**
 * The SMTP settings, or null when they are not all there: SMTP_HOST (a bare host name), SMTP_PORT (1-65535), SMTP_USER,
 * SMTP_PASSWORD and SMTP_FROM (a bare address or `Name <address>`). SMTP_SECURE is `true` (implicit TLS from the first
 * byte, the usual port 465) or `false` (plain connect, then STARTTLS REQUIRED, the usual port 587); unset means `true`
 * on port 465 and `false` on any other port. There is no setting that sends credentials or mail unencrypted.
 */
export function smtpSettings(env: Record<string, string | undefined> = process.env): SmtpSettings | null {
  const host = env.SMTP_HOST?.trim() ?? "";
  const port = Number(env.SMTP_PORT?.trim());
  const user = env.SMTP_USER ?? "";
  const pass = env.SMTP_PASSWORD ?? "";
  const from = env.SMTP_FROM?.trim() ?? "";
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!user || !pass || NO_CONTROL.test(user) || !senderAddress(from)) return null;
  const flag = env.SMTP_SECURE?.trim().toLowerCase();
  const secure = flag === "true" || flag === "1" ? true : flag === "false" || flag === "0" ? false : port === 465;
  return { host, port, secure, user, pass, from };
}

/** Whether a provider that really delivers is configured: a Resend key, or complete SMTP settings. */
export const mailConfigured = (): boolean => !!process.env.RESEND_API_KEY || !!smtpSettings();

/** Time limits (ms). The whole send is also raced against EMAIL_TIMEOUT_MS (10 s) in src/lib/notify.ts: 3.5 s + 6 s fits under it. */
export const PRIMARY_BUDGET_MS = 3_500;
export const SMTP_BUDGET_MS = 6_000;

/**
 * The options handed to Nodemailer. TLS is not optional: `secure` true is implicit TLS, `secure` false sets
 * `requireTLS`, so the connection is dropped when the server does not offer STARTTLS and the password is never sent in
 * the clear. The certificate is verified (TLS 1.2 or later), local files and URLs cannot be pulled into a message, and
 * nothing is logged (a log line would carry the server's replies).
 */
export function smtpTransportOptions(c: SmtpSettings) {
  return {
    host: c.host,
    port: c.port,
    secure: c.secure,
    requireTLS: !c.secure,
    ignoreTLS: false,
    auth: { user: c.user, pass: c.pass },
    tls: { minVersion: "TLSv1.2" as const, rejectUnauthorized: true },
    connectionTimeout: 3_000,
    greetingTimeout: 3_000,
    socketTimeout: 5_000,
    dnsTimeout: 3_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  };
}

/** A fixed category for a failed SMTP send. Nodemailer's own message can quote the server's reply, so it is never passed on. */
function smtpReason(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  const rc = (e as { responseCode?: unknown } | null)?.responseCode;
  const tag = typeof code === "string" && /^[A-Z_]{3,20}$/.test(code) ? code : "ERROR";
  return typeof rc === "number" && rc >= 100 && rc < 600 ? `smtp ${tag} ${rc}` : `smtp ${tag}`;
}

/** Race a promise against a limit; a timer that has done its job is cleared. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), ms); (timer as { unref?: () => void }).unref?.(); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * SMTP through Nodemailer (rule 3570). Node runtime only: the module is imported when a message is sent, and no edge
 * route imports this file. The sender is SMTP_FROM, never the message's `from`, because MAIL_FROM belongs to the domain
 * Resend verified and an SMTP server usually refuses any other. A failure answers `delivered: false` with a fixed
 * category (`smtp EAUTH 535`), never Nodemailer's message, the host, the user or the password.
 */
export function smtpProvider(c: SmtpSettings): MailProvider {
  return {
    name: "smtp",
    async send(m) {
      const problem = mailProblem(m);
      if (problem) return { delivered: false, refused: problem };
      const transport = await import("nodemailer").then((n) => n.createTransport(smtpTransportOptions(c)));
      try {
        const done = transport.sendMail({ from: c.from, to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}) });
        const res = await within(done, SMTP_BUDGET_MS);
        if (res === "timeout") {
          done.catch(() => {});
          return { delivered: false, refused: "smtp no answer in time" };
        }
        return { delivered: true };
      } catch (e) {
        return { delivered: false, refused: smtpReason(e) };
      } finally {
        transport.close();
      }
    },
  };
}

/**
 * `primary` first; `fallback` only when the primary's answer is a retryable failure (`retryable: true`), or it threw, or
 * it gave no answer within `PRIMARY_BUDGET_MS`. A success is final (nothing is sent twice) and a refusal that is not
 * retryable, a 4xx above all, is returned as it is. One risk is accepted: a primary that answers after the budget may
 * already have accepted the message, which can leave the reader two copies, the lesser failure against none.
 */
export function withFallback(primary: MailProvider, fallback: MailProvider): MailProvider {
  return {
    name: primary.name,
    async send(m) {
      let first: MailResult | "timeout";
      try {
        first = await within(primary.send(m), PRIMARY_BUDGET_MS);
      } catch {
        first = { delivered: false, retryable: true };
      }
      if (first !== "timeout" && (first.delivered || !first.retryable)) return first;
      const second = await fallback.send(m);
      if (second.delivered) log.warn("mail sent by the fallback provider", { primary: primary.name, fallback: fallback.name });
      return second;
    },
  };
}

const OUTBOX_MAX = 20;
const outbox: MailMessage[] = [];
/** The console provider's last messages, newest last. Empty on production, where the console provider never runs. */
export const consoleOutbox = (): readonly MailMessage[] => outbox;
export const clearConsoleOutbox = () => void outbox.splice(0);

export const consoleProvider: MailProvider = {
  name: "console",
  async send(m) {
    outbox.push(m);
    if (outbox.length > OUTBOX_MAX) outbox.splice(0, outbox.length - OUTBOX_MAX);
    log.debug("mail kept by the console provider", { toDomain: m.to.split("@")[1] ?? "", subjectChars: m.subject.length, textChars: m.text.length, html: !!m.html });
    return { delivered: false };
  },
};

/**
 * The provider for this process, read at call time (tests stub the environment per case). One rule:
 * 1. Resend is usable when RESEND_API_KEY is set and either MAIL_FROM is set or SMTP is not configured (a key alone
 *    sends from Resend's shared sender, which refuses every customer; with SMTP behind it, SMTP takes over instead).
 *    Usable Resend is the primary; complete SMTP settings add SMTP as its fallback (`withFallback`).
 * 2. Otherwise complete SMTP settings make SMTP the primary, with no fallback.
 * 3. Otherwise the console provider off production, and none on production.
 */
export function mailProvider(): MailProvider | null {
  const key = process.env.RESEND_API_KEY;
  const smtp = smtpSettings();
  if (key && (process.env.MAIL_FROM || !smtp)) return smtp ? withFallback(resendProvider(key), smtpProvider(smtp)) : resendProvider(key);
  if (smtp) return smtpProvider(smtp);
  return isProductionDeploy() ? null : consoleProvider;
}
