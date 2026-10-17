import type { Lang } from "../lib/i18n";
import { appOrigin } from "../lib/origin";
import { EMAIL_TEMPLATES, type EmailContext, type EmailTemplateId } from "./index";

/**
 * Fixed sample values for every registered template (rule 1964): the founder console's mail preview renders these, and
 * tests/mail-templates.test.ts walks them. Invented placeholders only, never a customer's data, nothing read from the
 * store; tokens are runs of one letter so nothing here works as a real link. A template added to the registry without a
 * sample does not compile (`Record<EmailTemplateId, …>`).
 */
export function emailSamples(lang: Lang): { [T in EmailTemplateId]: EmailContext<T> } {
  const o = appOrigin();
  const ar = lang === "ar";
  return {
    resetPassword: { link: `${o}/${lang}/app/reset#t=${"a".repeat(64)}` },
    teamInvite: { inviterEmail: "owner@test.example", role: "admin", link: `${o}/${lang}/app/join#t=${"b".repeat(64)}` },
    notice: { title: ar ? "تذكير من ريم" : "Reminder from Reem", paragraphs: [ar ? "مثال على مهمة\nموعدها اليوم" : "A sample task\ndue today", ar ? "سطر ثانٍ" : "A second line"], cta: { href: `${o}/${lang}/app/todo` } },
    verifyCode: { code: "123456" },
    dailyBrief: {
      date: ar ? "الخميس 16 أكتوبر" : "Thursday 16 October",
      body: ar ? "صباح الخير.\n\nمنشوران بانتظار موافقتك.\n\n• مثال على متابعة\n  نص المتابعة" : "Good morning.\n\nTwo posts wait for your approval.\n\n• A sample follow-up\n  Its text",
      href: `${o}/${lang}/app`,
    },
  };
}

/** Every template rendered with its sample, in `lang`: the HTML part as the customer's client would receive it. */
export function renderSamples(lang: Lang): Record<EmailTemplateId, string> {
  const s = emailSamples(lang);
  const out = {} as Record<EmailTemplateId, string>;
  for (const id of Object.keys(EMAIL_TEMPLATES) as EmailTemplateId[]) out[id] = (EMAIL_TEMPLATES[id] as (p: object) => string)({ ...s[id], lang });
  return out;
}
