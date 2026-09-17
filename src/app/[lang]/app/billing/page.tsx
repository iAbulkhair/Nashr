import { notFound, redirect } from "next/navigation";
import { dict, isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser } from "@/lib/auth";

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const t = appDict[lang];
  const m = dict[lang].pricing;
  const links: Record<string, string | undefined> = { starter: process.env.PAY_LINK_STARTER, pro: process.env.PAY_LINK_PRO, agency: process.env.PAY_LINK_AGENCY };
  const wa = process.env.SUPPORT_WHATSAPP ? `https://wa.me/${process.env.SUPPORT_WHATSAPP.replace(/\D/g, "")}?text=${encodeURIComponent(`Nashr ${u.email}`)}` : null;
  const keys = ["starter", "pro", "agency"] as const;
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="page-title">{t.billing.title}</h1>
      <div className="mt-4 grid gap-3 card text-sm sm:grid-cols-3">
        <div><p className="text-ink/60">{t.billing.current}</p><p className="font-display text-lg font-medium">{t.billing.plans[u.plan]}</p></div>
        <div><p className="text-ink/60">{t.billing.credits}</p><p className="font-mono text-lg" dir="ltr">{u.credits}</p></div>
        {u.plan === "trial" && <div><p className="text-ink/60">{t.billing.trialEnds}</p><p className="font-mono text-lg" dir="ltr">{u.trialEnds.slice(0, 10)}</p></div>}
      </div>
      {u.plan === "trial" && (
        <div className="mt-6 rounded-2xl bg-oasis-deep p-6 text-mist">
          <p className="eyebrow eyebrow-accent">{lang === "ar" ? "ماذا يحدث عند التفعيل" : "What happens when you activate"}</p>
          <h2 className="mt-2 font-display text-2xl font-bold">{lang === "ar" ? "في أول 30 يوماً: 40 منشوراً، 4 مقالات، 12 رسالة واتساب، 20 إعلاناً — بلهجتك، بانتظار موافقتك." : "In your first 30 days: 40 posts, 4 articles, 12 WhatsApp messages, 20 ads — in your dialect, waiting for your approval."}</h2>
          <p className="mt-2 text-sm text-mist-dim">{lang === "ar" ? "خطة أسبوعية كل أحد، ملخص كل صباح، وتتعلم من كل تعديل. ألغِ في أي وقت." : "A weekly plan every Sunday, a brief every morning, and she learns from every edit. Cancel anytime."}</p>
        </div>
      )}
      <p className="mt-6 text-ink/70">{t.billing.sub}</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {keys.map((k, idx) => {
          const plan = m.plans[idx];
          const href = links[k] ?? wa;
          return (
            <div key={k} className="flex flex-col card">
              <h2 className="font-display text-lg font-medium">{plan.name}</h2>
              <p className="mt-2 font-display text-3xl font-bold" dir="ltr">{plan.price} <span className="text-xs font-normal text-ink/60">{plan.period}</span></p>
              <p className="text-sm text-sadu">{plan.credits}</p>
              <ul className="mt-3 flex-1 space-y-1 text-xs text-ink/70">{plan.features.slice(0, 4).map((f) => <li key={f}>• {f}</li>)}</ul>
              {href ? (
                <a href={href} target="_blank" rel="noreferrer" className="mt-4 rounded-full bg-oasis px-4 py-2 text-center text-sm font-semibold text-mist">{links[k] ? t.billing.pay : t.billing.contact}</a>
              ) : (
                <a href="mailto:hello@nashr.ai" className="mt-4 rounded-full border border-ink/20 px-4 py-2 text-center text-sm">hello@nashr.ai</a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
