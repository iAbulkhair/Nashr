import { dailyBrief } from "./daily-brief";
import { notice } from "./notice";
import { resetPassword } from "./reset-password";
import { teamInvite } from "./team-invite";
import { verifyCode } from "./verify-code";

/**
 * The HTML email templates, one module each, sharing one layout (./layout.ts) and one button (./button.ts). Each answers
 * the HTML part of a message; its caller keeps writing the subject and the plain-text part. Callers send through the
 * typed `sendEmail({ to, subject, text, template, context, locale })` (src/lib/notify.ts, rule 1962), which renders the
 * named template here, so every message is multipart. The registry is what the tests walk to hold every template to the
 * same rules (685-688): direction on every container, every value escaped, every link into the app. The founder console's
 * mail preview renders it too (./samples.ts, rule 1964).
 */
export const EMAIL_TEMPLATES = { resetPassword, teamInvite, notice, verifyCode, dailyBrief } as const;
export type EmailTemplateId = keyof typeof EMAIL_TEMPLATES;
/** What a template takes besides the language: the `context` of a typed `sendEmail`. */
export type EmailContext<T extends EmailTemplateId> = Omit<Parameters<(typeof EMAIL_TEMPLATES)[T]>[0], "lang">;

/** Render one registered template in `locale`. The one place a template id becomes HTML. */
export function renderEmail<T extends EmailTemplateId>(template: T, context: EmailContext<T>, locale: "ar" | "en"): string {
  const fn = EMAIL_TEMPLATES[template] as (p: EmailContext<T> & { lang: "ar" | "en" }) => string;
  return fn({ ...context, lang: locale });
}

export { dailyBrief, notice, resetPassword, teamInvite, verifyCode };
export { COPY } from "./copy";
export { paragraphs } from "./html";
