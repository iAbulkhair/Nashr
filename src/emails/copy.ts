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
  /** The verification code email (./verify-code.ts, rule 1960). Same sentences as the plain-text part in src/lib/verify-email.ts. */
  verify: { title: string; intro: string; expiry: string; ignore: string; preheader: string };
  /** Noor's daily brief (./daily-brief.ts, rule 1961). `{date}` is the brief's own date line. */
  brief: { title: string; preheader: string; action: string };
  /**
   * The notice after a passkey is added (customer passkeys, rule 2415), sent through `notice`. `{name}` is the passkey's
   * cleaned name, `{time}` the time it was added in Riyadh time (Asia/Riyadh, labelled so in the copy). No credential
   * data. Rendered by `passkeyNotice` in src/app/api/account/passkeys/route.ts, which fills both slots with plain text.
   */
  passkey: { title: string; body: string; when: string; notYou: string; action: string };
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
      roles: { admin: "مدير", member: "محرر", viewer: "مشاهد" },
    },
    notice: { open: "افتح ذكين", todo: "افتح مهامي", billing: "افتح صفحة الاشتراك" },
    verify: {
      title: "رمز التحقق",
      intro: "اكتب هذا الرمز في ذكين لتأكيد بريدك:",
      expiry: "صالح لمدة 15 دقيقة.",
      ignore: "إذا لم تطلب هذا الرمز، تجاهل هذه الرسالة.",
      preheader: "رمز التحقق في ذكين صالح لمدة 15 دقيقة.",
    },
    brief: { title: "ملخص نور — {date}", preheader: "ملخص نور لليوم وما ينتظر قرارك.", action: "افتح ذكين" },
    passkey: {
      title: "أُضيف مفتاح مرور إلى حسابك",
      body: "أُضيف مفتاح المرور «{name}» إلى حسابك في ذكين.",
      when: "وقت الإضافة: {time} بتوقيت الرياض.",
      notYou: "إذا لم تضفه أنت فاحذفه من إعدادات الأمان، ثم اخرج من الأجهزة الأخرى.",
      action: "افتح إعدادات الأمان",
    },
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
      roles: { admin: "an admin", member: "an editor", viewer: "a viewer" },
    },
    notice: { open: "Open Thakeen", todo: "Open To-dos", billing: "Open Subscription" },
    verify: {
      title: "Your verification code",
      intro: "Type this code in Thakeen to confirm your email:",
      expiry: "It works for 15 minutes.",
      ignore: "If you did not ask for it, ignore this email.",
      preheader: "Your Thakeen code works for 15 minutes.",
    },
    brief: { title: "Noor's brief — {date}", preheader: "Noor's brief for today and what waits for your decision.", action: "Open Thakeen" },
    passkey: {
      title: "A passkey was added to your account",
      body: "The passkey “{name}” was added to your Thakeen account.",
      when: "Added at: {time} (Riyadh time).",
      notYou: "If you did not add it, remove it in Security settings, then sign out your other devices.",
      action: "Open Security settings",
    },
  },
};
