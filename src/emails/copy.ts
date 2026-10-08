import type { Lang } from "../lib/i18n";
import type { TeamRole } from "../lib/team";

/**
 * The words of the HTML emails, Arabic first. The plain-text part of each email is still written by its caller and is
 * not read from here: tests parse tokens and links out of that text, so it stays exactly as it was. These lines say the
 * same thing for a reader whose client shows the HTML part. `{slot}`s are filled by `fillHtml` (./html.ts), which escapes
 * every value. No arrows: an arrow drawn for one reading direction points the wrong way in the other (rule 687).
 */
export type EmailCopy = {
  /** The text wordmark at the top of every email. The product's own name, never a customer's brand. */
  wordmark: string;
  /** The footer: who sent the message, nothing else (no address, no promise). */
  footer: string;
  /** Above the bare link under a button, for a client that does not show the button. */
  fallback: string;
  reset: { title: string; greeting: string; intro: string; action: string; expiry: string; ignore: string; preheader: string };
  invite: { title: string; greeting: string; body: string; action: string; expiry: string; only: string; preheader: string; roles: Record<TeamRole, string> };
  /** Button labels of the generic notice (./notice.ts), named after the page each one opens. */
  notice: { open: string; todo: string; billing: string };
};

export const COPY: Record<Lang, EmailCopy> = {
  ar: {
    wordmark: "ذكين",
    footer: "أُرسلت إليك هذه الرسالة من ذكين.",
    fallback: "إذا لم يعمل الزر فانسخ هذا الرابط وافتحه في متصفحك:",
    reset: {
      title: "إعادة تعيين كلمة المرور",
      greeting: "مرحباً،",
      intro: "وصلنا طلب لإعادة تعيين كلمة مرور حسابك في ذكين.",
      action: "اختر كلمة مرور جديدة",
      expiry: "افتح الرابط خلال ساعة واحدة.",
      ignore: "إذا لم تطلب ذلك فتجاهل هذه الرسالة، ولن يتغير شيء.",
      preheader: "رابط إعادة تعيين كلمة المرور صالح لساعة واحدة.",
    },
    invite: {
      title: "دعوة للانضمام إلى فريق في ذكين",
      greeting: "مرحباً،",
      body: "دعاك مستخدم ذكين {inviter} للانضمام إلى حسابه في ذكين بصفة {role}.",
      action: "افتح الدعوة",
      expiry: "افتح الرابط خلال 7 أيام لتختار اسمك وكلمة مرورك.",
      only: "الدعوة لهذا البريد وحده. إذا لم تتوقعها فتجاهل هذه الرسالة، ولن يتغير شيء.",
      preheader: "دعوة للانضمام إلى فريق في ذكين، صالحة 7 أيام.",
      roles: { admin: "مدير", member: "عضو" },
    },
    notice: { open: "افتح ذكين", todo: "افتح مهامي", billing: "افتح صفحة الاشتراك" },
  },
  en: {
    wordmark: "Thakeen",
    footer: "This message was sent to you by Thakeen.",
    fallback: "If the button does not work, copy this link into your browser:",
    reset: {
      title: "Reset your password",
      greeting: "Hello,",
      intro: "We received a request to reset your Thakeen password.",
      action: "Choose a new password",
      expiry: "Open the link within one hour.",
      ignore: "If you did not ask for this, ignore this email and nothing changes.",
      preheader: "Your password reset link works for one hour.",
    },
    invite: {
      title: "You are invited to join a team on Thakeen",
      greeting: "Hello,",
      body: "The Thakeen user {inviter} invited you to join their account on Thakeen as {role}.",
      action: "Open the invitation",
      expiry: "Open the link within 7 days to choose your name and password.",
      only: "The invitation is for this email address only. If you did not expect it, ignore this email and nothing changes.",
      preheader: "An invitation to join a team on Thakeen. It works for 7 days.",
      roles: { admin: "an admin", member: "a member" },
    },
    notice: { open: "Open Thakeen", todo: "Open To-dos", billing: "Open Subscription" },
  },
};
