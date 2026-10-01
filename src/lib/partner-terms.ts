import { ATTRIBUTION_DAYS, COMMISSION_MONTHS, COMMISSION_PCT, PARTNER_TERMS_VERSION, PAYOUT_MIN_SAR } from "./partner-rules";
import { FIRST_MONTH_DISCOUNT_PCT } from "./pricing";

/**
 * The partner programme terms, as the founder decided them on 2026-10-01 (rule 413), shown at /{lang}/affiliates/terms
 * and agreed to on the application form (rule 414). Plain words, no boilerplate beyond these points. Every number comes
 * from the tables the code pays from (src/lib/partner-rules.ts, src/lib/pricing.ts). When this text changes, change
 * `PARTNER_TERMS_VERSION` too, so new applications record the version they agreed to.
 */
const C = COMMISSION_PCT, M = COMMISSION_MONTHS, W = ATTRIBUTION_DAYS, D = FIRST_MONTH_DISCOUNT_PCT, MIN = PAYOUT_MIN_SAR;

export type TermsDoc = { title: string; updated: string; intro: string; sections: { id: string; h: string; p: string[] }[]; back: string };

export const PARTNER_TERMS: Record<"ar" | "en", TermsDoc> = {
  ar: {
    title: "شروط برنامج الشركاء",
    updated: `آخر تحديث: ${PARTNER_TERMS_VERSION}`,
    intro: "هذه شروط برنامج الشركاء في ذكين. توافق عليها عند تقديم طلب الشراكة.",
    sections: [
      { id: "who", h: "من يمكنه الانضمام", p: ["أن يكون عمرك 18 سنة أو أكثر.", "حساب شريك واحد لكل شخص.", "حساب بنكي (آيبان) باسمك. البرنامج مفتوح للشركاء من كل الدول."] },
      { id: "commission", h: "العمولة", p: [`${C}% من كل دفعة (قبل ضريبة القيمة المضافة) يدفعها عميل أحلته، خلال أول ${M} أشهر من اشتراكه، إذا اشترك العميل خلال ${W} يوماً من استخدام رابطك أو كودك.`] },
      { id: "discount", h: "خصم العميل", p: [`كودك يعطي عميلك خصم ${D}% على شهره الأول. الخصم على السعر قبل الضريبة، ثم تُحسب ضريبة القيمة المضافة على السعر بعد الخصم.`, "لا يجتمع مع خصومات أخرى."] },
      { id: "payouts", h: "الصرف", p: [`نحوّل لك شهرياً بتحويل بنكي متى بلغ رصيدك المستحق ${MIN} ريال.`, "إذا استُردّت دفعة أو أُلغيت، تُلغى عمولتها."] },
      { id: "taxes", h: "الضرائب", p: ["يتحمّل ذكين ضريبة القيمة المضافة على العمولة: إن كنت مسجلاً فيها تُضاف على عمولتك ويدفعها ذكين.", `ويتحمّل ذكين ضريبة الاستقطاع حيث تنطبق، فتصلك عمولتك ${C}% كاملة.`, "وتبقى مسؤولاً عن ضريبة الدخل الخاصة بك في بلدك."] },
      { id: "not-allowed", h: "غير مسموح", p: ["إحالة نفسك أو فريقك.", "الإعلانات المدفوعة على اسم «ذكين» أو «Thakeen».", "الرسائل المزعجة أو غير المرغوب فيها.", "الوعد بنتائج أو خصومات غير موجودة.", "تقديم نفسك على أنك ذكين.", "مخالفة أي من ذلك تلغي العمولة المرتبطة بها."] },
      { id: "disclosure", h: "الإفصاح", p: ["اذكر بوضوح في منشوراتك أنها شراكة مدفوعة، والتزم بأنظمة الإعلان في بلدك (في السعودية قد يشمل ذلك ترخيص «موثوق»)."] },
      { id: "changes", h: "التعديل والإنهاء", p: ["يحق لذكين تعديل هذه الشروط بإشعار قبل 30 يوماً.", "إذا انتهت الشراكة، يُصرف لك رصيدك المستحق."] },
    ],
    back: "برنامج الشركاء",
  },
  en: {
    title: "Partner programme terms",
    updated: `Last updated ${PARTNER_TERMS_VERSION}`,
    intro: "These are the terms of the Thakeen partner programme. You agree to them when you apply.",
    sections: [
      { id: "who", h: "Who can join", p: ["You are 18 or older.", "One partner account per person.", "A bank account (IBAN) in your name. Partners from any country can join."] },
      { id: "commission", h: "Commission", p: [`${C}% of each payment (before VAT) for the first ${M} months of each customer you refer, if the customer subscribes within ${W} days of using your link or code.`] },
      { id: "discount", h: "Customer discount", p: [`Your code gives the customer ${D}% off their first month. The discount comes off the price before VAT; VAT is then computed on the discounted price.`, "It does not combine with other discounts."] },
      { id: "payouts", h: "Payouts", p: [`Monthly by bank transfer once your payable balance reaches SAR ${MIN}.`, "Commission on a refunded or voided payment is cancelled."] },
      { id: "taxes", h: "Taxes", p: ["Thakeen bears VAT on the commission: if you are VAT-registered, it is added on top of your commission and Thakeen pays it.", `Thakeen bears withholding tax where it applies, so you receive the full ${C}%.`, "You remain responsible for your own income tax in your country."] },
      { id: "not-allowed", h: "Not allowed", p: ["Referring yourself or your own team.", "Paid ads on the names ذكين / Thakeen.", "Spam or unsolicited messages.", "Promising results or discounts that do not exist.", "Presenting yourself as Thakeen.", "Breaking any of these cancels the commission linked to it."] },
      { id: "disclosure", h: "Disclosure", p: ["Say clearly in your posts that it is a paid partnership, and follow the advertising rules in your country (in Saudi Arabia this can include a Mawthooq licence)."] },
      { id: "changes", h: "Changes and ending", p: ["Thakeen may change these terms with 30 days' notice.", "If the partnership ends, your payable balance is paid."] },
    ],
    back: "Partner programme",
  },
};
