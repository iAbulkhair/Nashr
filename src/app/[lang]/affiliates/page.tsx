import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AffiliateForm from "@/components/AffiliateForm";
import Scribble from "@/components/Scribble";
import { ATTRIBUTION_DAYS, COMMISSION_MONTHS, COMMISSION_PCT, PAYOUT_MIN_SAR } from "@/lib/partner-rules";
import { FIRST_MONTH_DISCOUNT_PCT } from "@/lib/pricing";

// The programme's terms, decided by the founder on 2026-10-01 (docs/superpowers/specs/2026-10-01-affiliates-design.md).
// Every number comes from src/lib/partner-rules.ts or src/lib/pricing.ts, the same tables the code pays from (rule 402).
const C = COMMISSION_PCT, M = COMMISSION_MONTHS, D = FIRST_MONTH_DISCOUNT_PCT, W = ATTRIBUTION_DAYS, MIN = PAYOUT_MIN_SAR;

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const ar = lang === "ar";
  return {
    title: ar ? `برنامج الشركاء — ${C}% من كل دفعة لأول ${M} أشهر | ذكين` : `Partner programme — ${C}% of every payment for ${M} months | Thakeen`,
    description: ar
      ? `اكسب ${C}% من كل دفعة يدفعها عميل تحيله إلى ذكين خلال أول ${M} أشهر من اشتراكه، وعميلك يحصل على خصم ${D}% على شهره الأول بكودك.`
      : `Earn ${C}% of every payment a customer you refer to Thakeen makes in their first ${M} months, and your customer gets ${D}% off their first month with your code.`,
    alternates: { canonical: `/${lang}/affiliates`, languages: { ar: "/ar/affiliates", en: "/en/affiliates" } },
  };
}

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  const ar = lang === "ar";
  const items = ar
    ? [[`${C}%`, `من كل دفعة يدفعها عميلك، لأول ${M} أشهر من اشتراكه المدفوع`], [`${D}%`, "خصم لعميلك على شهره الأول بكودك"], [`${W} يوماً`, "ليدفع عميلك أول دفعة من نقره على رابطك أو تسجيله بكودك"], [`${MIN} ريال`, "الحد الأدنى للصرف، شهرياً بتحويل بنكي"]]
    : [[`${C}%`, `of every payment your customer makes, for their first ${M} months of paid subscription`], [`${D}%`, "off your customer's first month with your code"], [`${W} days`, "for your customer to make a first payment after clicking your link or signing up with your code"], [`SAR ${MIN}`, "minimum payout, monthly by bank transfer"]];
  return (
    <>
      <Nav t={t} lang={lang} />
      <main className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <p className="eyebrow">{ar ? "برنامج الشركاء" : "Partner program"}</p>
        <h1 className="mt-3 font-display text-4xl font-bold leading-tight sm:text-5xl"><span className="s-ul"><Scribble kind="underline" seed="affiliates-h" />{ar ? `اكسب ${C}% من كل دفعة لأول ${M} أشهر، وعميلك يوفّر ${D}% على شهره الأول.` : `Earn ${C}% of every payment for ${M} months, and your customer saves ${D}% on their first month.`}</span></h1>
        <p className="mt-4 max-w-2xl text-lg text-foreground-muted">{ar ? "للوكالات والمستشارين وصنّاع المحتوى والنشرات البريدية، من أي دولة. لك كود خاص بك ورابط، وصفحة شراكة داخل حسابك في ذكين تتابع منها إحالاتك وعمولاتك ودفعاتك." : "For agencies, consultants, creators and newsletters, in any country. You get your own code and link, and a partner page inside your Thakeen account to follow your referrals, commissions and payouts."}</p>
        <div className="mt-10 grid gap-x-5 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">{items.map(([n, l], i) => <div key={l} className="s-card"><Scribble kind="box" seed={`affiliates-n-${i}`} fill={i === 0 ? "lemon" : "paper"} /><p className="font-display text-3xl font-bold" dir="ltr">{n}</p><p className="mt-1 text-sm text-foreground-muted">{l}</p></div>)}</div>
        <div className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-2">
          <div>
            <h2 className="font-display text-2xl font-bold">{ar ? "كيف يعمل" : "How it works"}</h2>
            <ol className="mt-4 space-y-4">
              {(ar
                ? ["قدّم الطلب أدناه. نراجع طلبك ونرد خلال يوم عمل.", "عند الموافقة تحصل على كودك الخاص (مثل AHMED) ورابطك، وتظهر لك صفحة «الشراكة» داخل حسابك في ذكين. سجّل حساباً بنفس البريد إن لم يكن لديك.", `من يسجّل عبر رابطك أو يكتب كودك يحصل على خصم ${D}% على شهره الأول، ويُحسب لك إذا دفع أول دفعة خلال ${W} يوماً من نقره على رابطك أو من تسجيله بكودك.`, `تحصل على ${C}% من كل دفعة يدفعها خلال أول ${M} أشهر من اشتراكه المدفوع، تُصرف شهرياً بتحويل بنكي متى بلغ رصيدك ${MIN} ريال.`]
                : ["Apply below. We review your application and reply within one business day.", "Once approved you get your own code (like AHMED) and link, and a Partner page appears inside your Thakeen account. Sign up with the same email if you have no account yet.", `Anyone who signs up with your link or types your code gets ${D}% off their first month, and counts for you if they make a first payment within ${W} days of clicking your link or of signing up with your code.`, `You receive ${C}% of every payment they make during their first ${M} months of paid subscription, paid monthly by bank transfer once your balance reaches SAR ${MIN}.`]
              ).map((s, i) => <li key={i} className="flex gap-3"><span className="s-num !h-8 !w-8 !text-base"><Scribble kind="circleLoop" seed={`affiliates-step-${i}`} fill="paper" />{i + 1}</span><span className="pt-1">{s}</span></li>)}
            </ol>
            <h2 className="mt-8 font-display text-2xl font-bold">{ar ? "الشروط" : "Terms"}</h2>
            <ul className="mt-4 list-disc space-y-2 ps-5 text-sm text-foreground-muted">{(ar
              ? ["لا إحالة ذاتية: حسابك أنت أو أعضاء فريقك لا يُحسبون.", "إذا أُلغيت دفعة أو استُردّت تُلغى عمولتها.", `العمولة على الدفعة قبل ضريبة القيمة المضافة، وخصم عميلك ${D}% على الشهر الأول فقط قبل الضريبة، ولا يجتمع مع خصم آخر.`, "يتحمّل ذكين ضريبة القيمة المضافة على العمولة وضريبة الاستقطاع حيث تنطبق.", "لا إعلانات مدفوعة على اسم «ذكين» أو «Thakeen»، ولا رسائل مزعجة، واذكر أنها شراكة مدفوعة."]
              : ["No self-referral: your own account or your team members do not count.", "If a payment is voided or refunded, its commission is voided.", `Commission is on the payment before VAT, and your customer's ${D}% is off the first month only, before VAT, and does not combine with another discount.`, "Thakeen bears VAT on the commission and withholding tax where it applies.", "No paid ads on the names ذكين / Thakeen, no spam, and say it is a paid partnership."]
            ).map((x) => <li key={x}>{x}</li>)}</ul>
            <p className="mt-4 text-sm"><Link href={`/${lang}/affiliates/terms`} data-terms-link className="font-bold text-foreground underline">{ar ? "اقرأ شروط برنامج الشركاء كاملة" : "Read the full partner programme terms"}</Link></p>
          </div>
          <AffiliateForm lang={lang} />
        </div>
      </main>
      <Footer t={t} />
    </>
  );
}
