import { notice } from "./notice";
import { resetPassword } from "./reset-password";
import { teamInvite } from "./team-invite";

/**
 * The HTML email templates, one module each, sharing one layout (./layout.ts) and one button (./button.ts). Each answers
 * the HTML part of a message; its caller keeps writing the subject and the plain-text part, and passes both to
 * `sendEmail` (src/lib/notify.ts), so every message is multipart. The registry is what the tests walk to hold every
 * template to the same rules (685-688): direction on every container, every value escaped, every link into the app.
 */
export const EMAIL_TEMPLATES = { resetPassword, teamInvite, notice } as const;
export type EmailTemplateId = keyof typeof EMAIL_TEMPLATES;

export { notice, resetPassword, teamInvite };
export { COPY } from "./copy";
export { paragraphs } from "./html";
