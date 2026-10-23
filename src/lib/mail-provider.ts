import { isProductionDeploy } from "./deploy-env";
import { log } from "./log";

/**
 * Where an email goes (rules 1962-1963). `sendEmail` (src/lib/notify.ts) builds the message and hands it to one
 * provider; the provider only delivers. Two exist:
 * - `resend`: the real one, whenever RESEND_API_KEY is set. Resend's `send` RESOLVES with `{ data, error }` and does not
 *   throw when the API refuses a message, so a refusal is read from `error`, never assumed away.
 * - `console`: on a deploy that is not production (`next dev`, vitest, the e2e build) with no key. It keeps the last
 *   messages in memory for a developer and the tests (`consoleOutbox`) and writes one debug line per message with the
 *   recipient's domain and the sizes only: the subject and the text carry verification codes and reset links, and
 *   "secrets are never logged" (CLAUDE.md) holds in development too. It answers `delivered: false`, because nothing
 *   reached anyone: every caller that asks "did it go?" gets the same answer it got before this provider existed.
 * On a production deploy without a key there is no provider and `sendEmail` answers false, as before.
 */
export type MailMessage = { from: string; to: string; subject: string; text: string; html?: string; /** Where a reply goes (rule 3106); a plain address only (`plainAddress`). */ replyTo?: string };

/**
 * Whether `v` is one plain email address and nothing else (rule 3107): no display name, no list, no angle brackets,
 * quotes, commas, semicolons or white space (so no CR or LF), at most 254 characters. A reply-to is the only header
 * value a caller can take from a person's input (the support form's own address), so anything that could add a second
 * address or a header line is refused here, before a provider sees it.
 */
export const plainAddress = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 254 && /^[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"']+\.[^\s@<>()[\]\\,;:"']+$/.test(v);
export type MailResult = { delivered: true } | { delivered: false; refused?: string };
export interface MailProvider {
  readonly name: "resend" | "console";
  send(m: MailMessage): Promise<MailResult>;
}

export function resendProvider(key: string): MailProvider {
  return {
    name: "resend",
    async send(m) {
      const { Resend } = await import("resend");
      const res = await new Resend(key).emails.send({ from: m.from, to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), ...(plainAddress(m.replyTo) ? { replyTo: m.replyTo } : {}) });
      return res.error ? { delivered: false, refused: res.error.message ?? res.error.name ?? "unknown" } : { delivered: true };
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
    log.debug("mail kept by the console provider", { toDomain: m.to.split("@")[1] ?? "", subjectChars: m.subject.length, textChars: m.text.length, html: !!m.html, replyTo: !!m.replyTo });
    return { delivered: false };
  },
};

/** The provider for this process, read at call time (tests stub the key per case). */
export function mailProvider(): MailProvider | null {
  const key = process.env.RESEND_API_KEY;
  if (key) return resendProvider(key);
  return isProductionDeploy() ? null : consoleProvider;
}
