import type { Lang } from "@/lib/i18n";
import { FIRST_MONTH_DISCOUNT_PCT } from "@/lib/pricing";

const P = FIRST_MONTH_DISCOUNT_PCT;

/**
 * The billing page's words for the 15% first-month offer (rules 393-395). Payments are activated by hand: the fixed-price
 * pay links (PAY_LINK_*) cannot carry a discount, so a discounted month is activated on WhatsApp, and the page says so.
 */
export const OFFER_COPY = {
  ar: {
    title: `خصم ${P}% على شهرك الأول`,
    from: { partner: (code: string) => `من كود الشريك ${code}.`, early: "عرض الشركاء الأوائل لآخر يوم في تجربتك." },
    how: "روابط الدفع الثابتة لا تحمل خصماً، لذلك نفعّل شهرك الأول بالخصم عبر واتساب: اختر خطتك بالأسفل. الخصم للشهر الأول فقط، ولا يجتمع مع خصم آخر.",
    card: (now: number, list: number) => `خصم ${P}% على شهرك الأول: ${now} ريال بدل ${list} + الضريبة`,
    activate: `فعّل بخصم ${P}% عبر واتساب`,
    noWa: "لتفعيل الخصم راسلنا على",
    fullPrice: "أو ادفع السعر الكامل",
    wa: (email: string, plan: string, price: number) => `Thakeen ${email} — أريد تفعيل خطة ${plan} بخصم ${P}% على الشهر الأول (${price} ريال + الضريبة)`,
  },
  en: {
    title: `${P}% off your first month`,
    from: { partner: (code: string) => `From partner code ${code}.`, early: "The early-partner offer for your trial's last day." },
    how: "Fixed-price pay links cannot carry a discount, so your discounted first month is activated on WhatsApp: pick your plan below. First month only, and it does not combine with another discount.",
    card: (now: number, list: number) => `${P}% off your first month: SAR ${now} instead of ${list}, plus VAT`,
    activate: `Activate with ${P}% off on WhatsApp`,
    noWa: "To use the discount, email us at",
    fullPrice: "or pay the full price",
    wa: (email: string, plan: string, price: number) => `Thakeen ${email} — please activate ${plan} with ${P}% off the first month (SAR ${price} + VAT)`,
  },
} as const;

/** The banner above the plan cards while the account has an unused first-month offer. */
export function OfferBanner({ lang, kind, code }: { lang: Lang; kind: "partner" | "early"; code?: string }) {
  const O = OFFER_COPY[lang];
  return (
    <div data-offer={kind} className="mt-6 rounded-2xl border border-oasis/40 bg-oasis/5 p-5">
      <h2 className="font-display text-xl font-bold text-oasis">{O.title}</h2>
      <p className="mt-1 text-sm text-ink/80">{kind === "partner" && code ? O.from.partner(code) : O.from.early}</p>
      <p className="mt-2 text-sm text-ink/70">{O.how}</p>
    </div>
  );
}
