import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { dict, isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, seatLimit } from "@/lib/auth";
import { FIRST_MONTH_DISCOUNT_PCT, PLAN_PRICE_SAR, SELF_SERVE_PLANS, firstMonthPriceSar, type SelfServePlan } from "@/lib/pricing";
import { can } from "@/lib/roles";
import { seatsUsed } from "@/lib/team";
import ReadOnlyNote from "@/components/app/ReadOnlyNote";
import { OFFER_COPY, OfferBanner } from "@/components/app/BillingOffer";
import PartnerCodeForm from "@/components/app/PartnerCodeForm";
import { grantEarlyOffer, lastDayOfferOwed, openOffer } from "@/lib/partners";

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const t = appDict[lang];
  const m = dict[lang].pricing;
  // Paying is the owner's: pay links and the WhatsApp activation thread (which carries the account email) are built and
  // shown for the owner only. Everyone sees the plan, credits and seats, and is told to ask the owner.
  const owner = can(u, "billing");
  // One pay link per self-serve tier, keyed by plan id: each card finds its own copy by id, never by position, so a card
  // can never show one tier's price with another tier's link. Agency has no pay link (PAY_LINK_AGENCY is not read): it is
  // sold by contract, through the contact card below.
  const links: Partial<Record<SelfServePlan, string>> = owner ? { starter: process.env.PAY_LINK_STARTER, pro: process.env.PAY_LINK_PRO, business: process.env.PAY_LINK_BUSINESS } : {};
  const wa = owner && process.env.SUPPORT_WHATSAPP ? `https://wa.me/${process.env.SUPPORT_WHATSAPP.replace(/\D/g, "")}?text=${encodeURIComponent(`Thakeen ${u.email}`)}` : null;
  const card = (id: SelfServePlan | "agency") => m.plans.find((p) => p.id === id);
  const agency = card("agency");
  const used = await seatsUsed(u.email);
  // The 15% first-month offer (src/lib/partners.ts, rules 393-395), owner only. A trial in its last day, or ended less
  // than 3 days ago, that has none yet gets the early-partner offer here (the cron grants it on the last day; this covers
  // a missed run). Never while the founder impersonates the account: looking is not the customer's visit. Fixed-price
  // pay links cannot carry a discount, so a discounted month is activated on WhatsApp for the discounted amount.
  // Shown while the account is still on its trial: a paid plan needs no "activate" offer (the console still applies an
  // open offer to the first payment it records). A busy lock only delays the grant to the next visit.
  if (owner && u.actor?.kind !== "founder" && lastDayOfferOwed(u) && (await grantEarlyOffer(u.email, (x) => lastDayOfferOwed(x)).catch(() => false))) u.firstMonthOffer = { kind: "early", pct: FIRST_MONTH_DISCOUNT_PCT, at: new Date().toISOString() };
  const offer = owner && u.plan === "trial" ? openOffer(u) : null;
  const O = OFFER_COPY[lang];
  const waNumber = (process.env.SUPPORT_WHATSAPP ?? "").replace(/\D/g, "");
  const offerHref = (k: SelfServePlan) => (waNumber ? `https://wa.me/${waNumber}?text=${encodeURIComponent(O.wa(u.email, card(k)?.name ?? k, firstMonthPriceSar(k)))}` : null);
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="page-title">{t.billing.title}</h1>
      <div className="mt-4 grid gap-3 card text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><p className="text-ink/60">{t.billing.current}</p><p className="font-display text-lg font-medium">{t.billing.plans[u.plan]}</p></div>
        <div><p className="text-ink/60">{t.billing.credits}</p><p className="font-mono text-lg" dir="ltr">{u.credits}</p></div>
        <div><p className="text-ink/60">{t.billing.seats}</p><p className="font-mono text-lg" dir="ltr"><Link href={`/${lang}/app/team`} className="hover:underline">{used} / {seatLimit(u)}</Link></p></div>
        {u.plan === "trial" && <div><p className="text-ink/60">{t.billing.trialEnds}</p><p className="font-mono text-lg" dir="ltr">{u.trialEnds.slice(0, 10)}</p></div>}
      </div>
      {!owner && <ReadOnlyNote className="mt-4" text={t.billing.ownerOnly} />}
      {owner && u.plan === "trial" && (
        <div className="mt-6 rounded-2xl bg-oasis-deep p-6 text-mist">
          <p className="eyebrow eyebrow-accent">{lang === "ar" ? "ماذا يحدث عند التفعيل" : "What happens when you activate"}</p>
          <h2 className="mt-2 font-display text-2xl font-bold">{lang === "ar" ? "رصيد شهري تطلب به ما تحتاج: 10 منشورات في الدفعة، مقالات SEO، 3 رسائل واتساب، 5 نسخ إعلانية — بلهجتك، بانتظار موافقتك." : "Monthly credits for what you need: 10 posts per batch, SEO articles, 3 WhatsApp messages, 5 ad variants — in your dialect, waiting for your approval."}</h2>
          <p className="mt-2 text-sm text-mist-dim">{lang === "ar" ? "خطة أسبوعية كل أحد، ملخص كل صباح، وتتعلم من كل تعديل. ألغِ في أي وقت." : "A weekly plan every Sunday, a brief every morning, and she learns from every edit. Cancel anytime."}</p>
        </div>
      )}
      {offer && <OfferBanner lang={lang} kind={offer.kind} code={u.referredBy?.code} />}
      {owner && u.plan === "trial" && !u.referredBy && !u.firstPaidOn && <PartnerCodeForm lang={lang} />}
      {owner && <p className="mt-6 text-ink/70">{t.billing.sub}</p>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {SELF_SERVE_PLANS.map((k) => {
          const plan = card(k);
          if (!plan) return null;
          const href = offer ? offerHref(k) : links[k] ?? wa;
          return (
            <div key={k} data-tier={k} className="flex flex-col card">
              <h2 className="font-display text-lg font-medium">{plan.name}</h2>
              <p className="mt-2 font-display text-3xl font-bold" dir="ltr">{plan.price} <span className="text-xs font-normal text-ink/60">{plan.period}</span></p>
              {offer && <p data-offer-price className="text-sm font-semibold text-oasis">{O.card(firstMonthPriceSar(k), PLAN_PRICE_SAR[k])}</p>}
              <p className="text-sm text-sadu">{plan.credits}</p>
              <ul className="mt-3 flex-1 space-y-1 text-xs text-ink/70">{plan.features.slice(0, 4).map((f) => <li key={f}>• {f}</li>)}</ul>
              {!owner ? null : href ? (
                <a href={href} target="_blank" rel="noreferrer" className="mt-4 rounded-full bg-oasis px-4 py-2 text-center text-sm font-semibold text-mist">{offer ? O.activate : links[k] ? t.billing.pay : t.billing.contact}</a>
              ) : (
                <a href="mailto:hello@nashr.ai" className="mt-4 rounded-full border border-ink/20 px-4 py-2 text-center text-sm">{offer ? `${O.noWa} ` : ""}hello@nashr.ai</a>
              )}
              {offer && links[k] && <a href={links[k]} target="_blank" rel="noreferrer" className="mt-2 text-center text-xs text-ink/60 underline">{O.fullPrice}</a>}
            </div>
          );
        })}
        {agency && (
          <div data-tier="agency" className="flex flex-col card">
            <h2 className="font-display text-lg font-medium">{agency.name}</h2>
            <p className="mt-2 font-display text-2xl font-bold">{agency.price} <span className="text-xs font-normal text-ink/60">{agency.period}</span></p>
            <p className="text-sm text-sadu">{agency.credits}</p>
            <ul className="mt-3 flex-1 space-y-1 text-xs text-ink/70">{agency.features.filter((f) => !/coming soon|قريباً/.test(f)).slice(0, 4).map((f) => <li key={f}>• {f}</li>)}</ul>
            {/* Contact only, and only for the owner: the WhatsApp thread carries the account email. */}
            {owner && <a href={wa ?? `/${lang}/enterprise#contact`} target={wa ? "_blank" : undefined} rel={wa ? "noreferrer" : undefined} className="mt-4 rounded-full border border-ink/20 px-4 py-2 text-center text-sm">{agency.cta}</a>}
          </div>
        )}
      </div>
    </div>
  );
}
