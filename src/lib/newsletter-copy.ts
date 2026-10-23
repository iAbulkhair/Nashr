import type { Lang } from "./i18n";

/**
 * The words of the newsletter sign-up box and of the two pages a mailed link opens (rules 3600-3609). Plain text, Arabic
 * first. The consent line says what the visitor agrees to and how to leave, and nothing else: no legal claim, no promise
 * about how often we write. It is shown beside a box that is never pre-ticked.
 */
export type NewsletterCopy = {
  title: string;
  sub: string;
  email: string;
  consent: string;
  send: string;
  sent: string;
  errors: { bad_email: string; consent_required: string; slow_down: string; mail_off: string; server: string };
  page: {
    confirm: { title: string; body: string; action: string; done: string; failed: string };
    unsubscribe: { title: string; working: string; done: string; failed: string };
    retry: string;
    missing: string;
  };
};

export const NEWSLETTER_COPY: Record<Lang, NewsletterCopy> = {
  ar: {
    title: "نشرة ذكين البريدية",
    sub: "أخبار ذكين وأفكار للتسويق في الخليج على بريدك.",
    email: "البريد الإلكتروني",
    consent: "أوافق على أن تصلني نشرة ذكين على هذا البريد. أستطيع إلغاء الاشتراك في أي وقت بنقرة واحدة من أي رسالة.",
    send: "اشترك",
    sent: "أرسلنا لك رسالة تأكيد. افتح بريدك واضغط على الرابط. لن نرسل لك شيئاً قبل أن تؤكد.",
    errors: {
      bad_email: "اكتب بريداً إلكترونياً صحيحاً.",
      consent_required: "ضع علامة الموافقة أولاً.",
      slow_down: "محاولات كثيرة. حاول مرة أخرى بعد قليل.",
      mail_off: "الاشتراك غير متاح حالياً. حاول مرة أخرى لاحقاً.",
      server: "تعذّر الاشتراك. حاول مرة أخرى.",
    },
    page: {
      confirm: {
        title: "أكّد اشتراكك في النشرة",
        body: "اضغط الزر لتأكيد أنك تريد أن تصلك نشرة ذكين على بريدك.",
        action: "أكّد الاشتراك",
        done: "تم تأكيد اشتراكك في النشرة.",
        failed: "هذا الرابط غير صالح أو انتهت مدته أو استُخدم من قبل. اشترك من جديد لتصلك رسالة تأكيد أخرى.",
      },
      unsubscribe: {
        title: "إلغاء الاشتراك",
        working: "جارٍ إلغاء اشتراكك…",
        done: "تم إلغاء اشتراكك. لن تصلك نشرة ذكين بعد الآن.",
        failed: "هذا الرابط غير صالح أو انتهت مدته.",
      },
      retry: "حاول مرة أخرى",
      missing: "الرابط ناقص. افتحه من الرسالة التي وصلتك.",
    },
  },
  en: {
    title: "The Thakeen newsletter",
    sub: "News from Thakeen and ideas for marketing in the Gulf, by email.",
    email: "Email",
    consent: "I agree to receive the Thakeen newsletter at this address. I can unsubscribe at any time with one click from any email.",
    send: "Subscribe",
    sent: "We sent you a confirmation email. Open it and press the link. We send you nothing until you confirm.",
    errors: {
      bad_email: "Enter a valid email address.",
      consent_required: "Tick the box to agree first.",
      slow_down: "Too many attempts. Please try again in a little while.",
      mail_off: "Sign-up is not available right now. Please try again later.",
      server: "Could not subscribe. Please try again.",
    },
    page: {
      confirm: {
        title: "Confirm your subscription",
        body: "Press the button to confirm that you want the Thakeen newsletter at your address.",
        action: "Confirm subscription",
        done: "Your subscription is confirmed.",
        failed: "This link is not valid, has expired or was already used. Subscribe again to get another confirmation email.",
      },
      unsubscribe: {
        title: "Unsubscribe",
        working: "Unsubscribing…",
        done: "You are unsubscribed. You will not get the Thakeen newsletter any more.",
        failed: "This link is not valid or has expired.",
      },
      retry: "Try again",
      missing: "The link is incomplete. Open it from the email you received.",
    },
  },
};
