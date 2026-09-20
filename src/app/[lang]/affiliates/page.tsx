import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { dict, isLang } from "@/lib/i18n";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import AffiliateForm from "@/components/AffiliateForm";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const ar = lang === "ar";
  return {
    title: ar ? "برنامج الشركاء — اكسب 25% متكررة | نشر" : "Affiliate programme — earn 25% recurring | Nashr",
    description: ar ? "اكسب 25% متكررة على كل عميل تحيله إلى نشر." : "Earn 25% recurring on every customer you refer to Nashr.",
    alternates: { canonical: `/${lang}/affiliates`, languages: { ar: "/ar/affiliates", en: "/en/affiliates" } },
  };
}

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const t = dict[lang];
  const ar = lang === "ar";
  const items = ar
    ? [["25%", "عمولة متكررة على كل دفعة، مدى حياة العميل"], ["60 يوماً", "نافذة الإحالة من الضغط على رابطك"], ["شهرياً", "دفعات عبر تحويل بنكي، الحد الأدنى 200 ريال"], ["0", "رسوم أو حد أدنى للإحالات"]]
    : [["25%", "recurring on every payment, for the life of the customer"], ["60 days", "attribution window from click"], ["Monthly", "payouts by bank transfer, SAR 200 minimum"], ["0", "fees or minimum referrals"]];
  return (
    <>
      <Nav t={t} lang={lang} />
      <main className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <p className="eyebrow">{ar ? "برنامج الشركاء" : "Partner program"}</p>
        <h1 className="mt-3 font-display text-4xl font-bold text-oasis sm:text-5xl">{ar ? "اكسب 25% متكررة على كل عميل تحيله لنشر." : "Earn 25% recurring on every customer you refer to Nashr."}</h1>
        <p className="mt-4 max-w-2xl text-lg text-ink/70">{ar ? "للوكالات والمستشارين وصنّاع المحتوى والنشرات البريدية في الخليج. عميلك يحصل على مسوّق بالذكاء الاصطناعي بلهجته، وأنت تحصل على ربع كل فاتورة، إلى الأبد." : "For Gulf agencies, consultants, creators and newsletters. Your client gets an AI marketer in their dialect; you get a quarter of every invoice, forever."}</p>
        <div className="mt-10 grid gap-4 sm:grid-cols-4">{items.map(([n, l]) => <div key={l} className="card card-sm"><p className="page-title" dir="ltr">{n}</p><p className="mt-1 text-sm text-ink/70">{l}</p></div>)}</div>
        <div className="mt-12 grid gap-10 lg:grid-cols-2">
          <div>
            <h2 className="font-display text-2xl font-bold">{ar ? "كيف يعمل" : "How it works"}</h2>
            <ol className="mt-4 space-y-3 text-ink/80">
              {(ar ? ["قدّم الطلب أدناه. نوافق خلال يوم عمل.", "تستلم رابطك وكودك، ونصوصاً جاهزة للنشر.", "كل من يسجّل عبر رابطك ويشترك خلال 60 يوماً يُحسب لك.", "تستلم 25% من كل دفعة شهرياً عبر تحويل بنكي."] : ["Apply below. We approve within one business day.", "You get your link and code, plus ready-to-post copy.", "Anyone who signs up via your link and subscribes within 60 days counts.", "You receive 25% of every payment, monthly, by bank transfer."]).map((s, i) => <li key={i} className="flex gap-3"><span className="font-mono text-oasis">{i + 1}.</span>{s}</li>)}
            </ol>
            <h2 className="mt-8 font-display text-2xl font-bold">{ar ? "القواعد" : "Rules"}</h2>
            <ul className="mt-4 space-y-2 text-sm text-ink/70">{(ar ? ["لا إعلانات مدفوعة على اسم «نشر» أو «نور».", "لا إحالة ذاتية.", "30 يوماً للتحقق من كل دفعة قبل صرف عمولتها."] : ["No paid search on the 'Nashr' or 'Noor' brand.", "No self-referrals.", "30-day verification per payment before commission is released."]).map((x) => <li key={x}>• {x}</li>)}</ul>
          </div>
          <AffiliateForm lang={lang} />
        </div>
      </main>
      <Footer t={t} />
    </>
  );
}
