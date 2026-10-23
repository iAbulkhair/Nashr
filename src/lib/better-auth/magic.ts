import { magicLink } from "better-auth/plugins/magic-link";
import { getLogin, type Login } from "@/lib/auth";
import type { Lang } from "@/lib/i18n";
import { loginRefusalCode, verifyOwed } from "@/lib/login-finish";
import { MAGIC_TTL_SECONDS } from "@/lib/magic-token";
import { mailReady, sendEmail } from "@/lib/notify";
import { appOrigin } from "@/lib/origin";

/**
 * The magic link (rules 3415-3416, spec section 6): better-auth's magic-link plugin, with Thakeen's mail and Thakeen's
 * decision about who may get one. Only while `AUTH_ENGINE=better-auth`: the plugin is part of the one config
 * (src/lib/better-auth/server.ts), which is built only while the switch is on.
 *
 * - A link goes only to an address that may sign in now (`magicEligible`): a login `loginRefusalCode` lets in, and not an
 *   owner who still owes the address code (that owner signs in with the password and lands on the verify page, rule
 *   754). The route wrapper decides before better-auth runs, so an unknown address costs no stored row; `sendMagic`
 *   decides again, so a call that skips the wrapper still mails nobody else.
 * - The token is better-auth's (32 letters), stored only hashed (`storeToken: "hashed"`, then `ba:verify:{sha256}` by the
 *   adapter), for 15 minutes, used once (GETDEL). better-auth's own URL (token in a query string) is never mailed: the
 *   mail carries `{appOrigin}/{lang}/app/magic#t={token}`, the token in the fragment (rule 546).
 * - `disableSignUp`: a link never creates an account.
 */

/** May this login be sent a sign-in link now? The same checks a password sign-in meets, before any proof. */
export function magicEligible(l: Login | null): l is Login {
  return !!l && loginRefusalCode(l) === null && verifyOwed(l) !== true;
}

/** The link the mail carries: the magic page with the token in the fragment. */
export const magicLinkFor = (lang: Lang, token: string) => `${appOrigin()}/${lang}/app/magic#t=${token}`;

/** The mail's subject and plain-text part (the HTML part is src/emails/magic-link.ts, the same sentences). */
export function magicText(lang: Lang, link: string): { subject: string; text: string } {
  return lang === "ar"
    ? { subject: "رابط الدخول إلى ذكين", text: `مرحباً،\n\nوصلنا طلب لتسجيل الدخول إلى حسابك في ذكين برابط بدل كلمة المرور. افتح الرابط التالي خلال 15 دقيقة، وهو يعمل مرة واحدة:\n\n${link}\n\nإذا لم تطلب ذلك فتجاهل هذه الرسالة، ولن يتغير شيء.` }
    : { subject: "Your Thakeen sign-in link", text: `Hello,\n\nWe received a request to sign in to your Thakeen account with a link instead of the password. Open this link within 15 minutes; it works once:\n\n${link}\n\nIf you did not ask for this, ignore this email and nothing changes.` };
}

/** The plugin's `sendMagicLink`: checks the address again, then mails the person's own address in the form's language. */
export async function sendMagic(data: { email: string; token: string; metadata?: Record<string, unknown> }): Promise<void> {
  if (!mailReady()) return;
  const l = await getLogin(data.email);
  if (!magicEligible(l)) return;
  const lang: Lang = data.metadata?.lang === "en" ? "en" : "ar";
  const link = magicLinkFor(lang, data.token);
  const { subject, text } = magicText(lang, link);
  // The person's address, as the reset link mails it (POST /api/auth/forgot): `getLogin` already matched it to this one.
  await sendEmail({ to: l.person.email, subject, text, template: "magicLink", context: { link }, locale: lang });
}

/** The plugin as the config uses it. */
export const baMagicLink = () =>
  magicLink({ expiresIn: MAGIC_TTL_SECONDS, storeToken: "hashed", disableSignUp: true, sendMagicLink: ({ email, token, metadata }) => sendMagic({ email, token, metadata }) });
