import { settingsScreenMeta } from "@/lib/screen-titles";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { SUPPORT_EMAIL, dict, isLang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, seatLimit } from "@/lib/auth";
import { FIRST_MONTH_DISCOUNT_PCT, PLAN_PRICE_SAR, SELF_SERVE_PLANS, allowanceOf, firstMonthPriceSar, formatCount, type SelfServePlan } from "@/lib/pricing";
import { openLots, topupBalance, topupCredits, topupView } from "@/lib/topups";
import { can } from "@/lib/roles";
import { entitlementView } from "@/lib/entitlements";
import { chatPremiumHold } from "@/lib/models/credits";
import { paceStart, runway } from "@/lib/usage-view";
import ReadOnlyNote from "@/components/app/ReadOnlyNote";
import { OFFER_COPY, OfferBanner } from "@/components/app/BillingOffer";
import PartnerCodeForm from "@/components/app/PartnerCodeForm";
import { grantEarlyOffer, lastDayOfferOwed, offerLastDay, openOffer } from "@/lib/partners";
import ChatAllowanceCard from "@/components/app/ChatAllowanceCard";
import PlanIncludesCard from "@/components/app/PlanIncludesCard";
import TopupCard from "@/components/app/TopupCard";
import PageHeader from "@/components/ui/PageHeader";
import HelpLink from "@/components/ui/HelpLink";
import { helpHref } from "@/lib/help";
import { PaymobPayButton, PaymobPlanCard, PaymobReturnStatus } from "@/components/app/PaymobBilling";
import { paymentsEnabled } from "@/lib/payments";
import { billingView, paymentHistory } from "@/lib/billing";
import { monthUsage } from "@/lib/month-usage";
import { settingsHref } from "@/lib/settings-nav";
import CreditUsageCard from "@/components/app/settings/CreditUsageCard";
import PlanCard from "@/components/app/settings/PlanCard";
import PaymentHistory from "@/components/app/settings/PaymentHistory";

export const generateMetadata = settingsScreenMeta("billing");

export default async function Page({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(`/${lang}/app/login`);
  const t = appDict[lang];
  const m = dict[lang].pricing;
  // Paying is the owner's: pay links and the WhatsApp activation thread (which carries the account email) are built and
  // shown for the owner only. Everyone sees the plan, credits and seats, and is told to ask the owner.
  const owner = can(u, "billing");
  // Online payment through Paymob KSA (src/lib/billing.ts, rules 700-729): only when it is configured, and only for the
  // owner themself (`billing.pay` is refused while the founder impersonates). Otherwise the pay links and WhatsApp below
  // stay the way to pay, exactly as before.
  const online = can(u, "billing.pay") && paymentsEnabled();
  const sub = online ? billingView(u.billing) : null;
  const returned = (await searchParams)?.paymob === "return";
  // One pay link per self-serve tier, keyed by plan id: each card finds its own copy by id, never by position, so a card
  // can never show one tier's price with another tier's link. Agency has no pay link (PAY_LINK_AGENCY is not read): it is
  // sold by contract, through the contact card below.
  const links: Partial<Record<SelfServePlan, string>> = owner ? { starter: process.env.PAY_LINK_STARTER, pro: process.env.PAY_LINK_PRO, business: process.env.PAY_LINK_BUSINESS } : {};
  const wa = owner && process.env.SUPPORT_WHATSAPP ? `https://wa.me/${process.env.SUPPORT_WHATSAPP.replace(/\D/g, "")}?text=${encodeURIComponent(`Thakeen ${u.email}`)}` : null;
  const card = (id: SelfServePlan | "agency") => m.plans.find((p) => p.id === id);
  // Top-up packs (rule 449): the account's live packs, without payment details, and the credits left in them. A pack is
  // requested from support (the owner's WhatsApp link carries the account email) and activated by the founder. A pack
  // whose unused credits were refunded holds nothing and is not listed (`openLots`, rule 460).
  const lots = openLots(u).map(topupView);
  const fromTopups = topupCredits(u);
  const agency = card("agency");
  // The chat card (rule 315): the account's messages, read here and handed to the client card with the runway already
  // worked out, so the server and the browser render the same dates. Everyone sees it; only the owner gets the switch.
  // The balance goes with it: below `overflow.hold` credits, chat past the allowance is paused even with the switch on.
  // The seats in use and the chat status come from the account's entitlement view (src/lib/entitlements.ts, rules 784-785),
  // read once: the "what your plan includes" card below shows the same view, so the page never reads the same data twice.
  // The card is handed `ent` and `used` only: `view.grants` holds the founder's email and note, which an owner never sees.
  // This month's usage for the credit card (rule 1153) and the owner's recorded payments (rule 1156) are read alongside it.
  const now = new Date();
  const [view, month, history] = await Promise.all([entitlementView(u), monthUsage(u, now), owner ? paymentHistory(u.email) : Promise.resolve(null)]);
  const { seats: used, chat } = view.used;
  const nextReset = month.nextReset;
  const trial = chat.period === "trial";
  // A trial's messages count from signup for the whole trial; a plan's from the 1st (or from signup, when later).
  const chatRunway = runway({ used: chat.used, left: chat.left, periodStart: trial ? u.createdAt : paceStart(u.createdAt, now), resetAt: trial ? null : nextReset, trialEnds: u.trialEnds, now });
  // The 15% first-month offer (src/lib/partners.ts, rules 393-395, 409-410), owner only. A trial from its last day
  // through the early-partner offer's last day (7 days after the trial's last day) that has none yet gets it here (the
  // cron grants it on the last day; this covers a missed run while the offer can still be used). Never while the founder
  // impersonates the account: looking is not the customer's visit. An early-partner offer past its last day is not shown
  // (`openOffer`). The discount comes off the price before VAT and VAT is computed on the discounted price (rule 409).
  // Fixed-price pay links cannot carry a discount, so a discounted month is activated on WhatsApp for the discounted
  // amount. Shown while the account is still on its trial: a paid plan needs no "activate" offer (the console still
  // applies an open offer to the first payment it records). A busy lock only delays the grant to the next visit.
  if (owner && u.actor?.kind !== "founder" && lastDayOfferOwed(u) && (await grantEarlyOffer(u.email, (x) => lastDayOfferOwed(x)).catch(() => false))) u.firstMonthOffer = { kind: "early", pct: FIRST_MONTH_DISCOUNT_PCT, at: new Date().toISOString() };
  const offer = owner && u.plan === "trial" ? openOffer(u) : null;
  const offerUntil = offer ? offerLastDay(u, offer) : null;
  const O = OFFER_COPY[lang];
  const waNumber = (process.env.SUPPORT_WHATSAPP ?? "").replace(/\D/g, "");
  const offerHref = (k: SelfServePlan) => (waNumber ? `https://wa.me/${waNumber}?text=${encodeURIComponent(O.wa(u.email, card(k)?.name ?? k, firstMonthPriceSar(k)))}` : null);
  const ar = lang === "ar";
  const planName = (p: string) => (t.billing.plans as Record<string, string>)[p] ?? p;
  // The summary (rule 1154): plan, balance, seats and the next date that matters, as words and Western digits.
  const nextLabel = u.plan === "trial" ? t.billing.trialEnds : sub ? (ar ? "مدفوع حتى" : "Paid through") : (ar ? "يتجدد الكريدت في" : "Credits reset on");
  const nextDate = u.plan === "trial" ? u.trialEnds.slice(0, 10) : sub ? sub.paidThrough : nextReset;
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-0">
      <PageHeader lang={lang} title={t.billing.title} seed="billing-t1" actions={<HelpLink lang={lang} href={helpHref(lang, "credits", "task-costs")} />} />
      <dl className="mt-4 grid gap-3 card text-sm sm:grid-cols-2 lg:grid-cols-4" data-billing-summary="">
        <div><dt className="text-foreground-muted">{t.billing.current}</dt><dd className="font-display text-lg font-medium">{t.billing.plans[u.plan]}</dd></div>
        <div><dt className="text-foreground-muted">{t.billing.credits}</dt><dd className="font-mono text-lg tnum" dir="ltr">{formatCount(u.credits)}</dd>{fromTopups > 0 && <dd className="text-xs text-foreground-muted" data-topup-share="">{lang === "ar" ? `منها ${formatCount(fromTopups)} من باقات الشحن` : `incl. ${formatCount(fromTopups)} from top-ups`}</dd>}</div>
        <div><dt className="text-foreground-muted">{t.billing.seats}</dt><dd className="font-mono text-lg tnum" dir="ltr"><Link href={settingsHref(lang, "members")} className="hover:underline">{used} / {seatLimit(u)}</Link></dd></div>
        <div><dt className="text-foreground-muted">{nextLabel}</dt><dd className="font-mono text-lg tnum" dir="ltr" data-billing-next="">{nextDate}</dd></div>
      </dl>
      {!owner && <ReadOnlyNote className="mt-4" text={t.billing.ownerOnly} />}
      {returned && online && <PaymobReturnStatus lang={lang} />}
      {sub && <PaymobPlanCard lang={lang} billing={sub} />}
      <PlanIncludesCard view={{ ent: view.ent, used: view.used }} lang={lang} />
      <ChatAllowanceCard lang={lang} status={chat} owner={owner} nextReset={nextReset} trialEnds={u.trialEnds.slice(0, 10)} runway={chatRunway} credits={u.credits} premiumHold={chatPremiumHold()} />
      <CreditUsageCard t={t} lang={lang} user={{ plan: u.plan, credits: u.credits, trialEnds: u.trialEnds, createdAt: u.createdAt, topups: openLots(u).map(topupBalance) }} month={month} allowance={allowanceOf(u)} chat={chat} chatBar={false} />
      <TopupCard lang={lang} plan={u.plan} owner={owner} email={owner ? u.email : undefined} whatsapp={owner && waNumber ? waNumber : null} lots={lots} topupCredits={fromTopups} payOnline={online} />
      {owner && u.plan === "trial" && (
        <div className="mt-6 rounded-2xl bg-inverse p-6 text-inverse-muted">
          <p className="eyebrow eyebrow-accent">{lang === "ar" ? "ماذا يحدث عند التفعيل" : "What happens when you activate"}</p>
          <h2 className="mt-2 font-display text-2xl font-bold">{lang === "ar" ? "رصيد شهري تطلب به ما تحتاج: 10 منشورات في الدفعة، مقالات SEO، 3 رسائل واتساب، 5 نسخ إعلانية — بلهجتك، بانتظار موافقتك." : "Monthly credits for what you need: 10 posts per batch, SEO articles, 3 WhatsApp messages, 5 ad variants — in your dialect, waiting for your approval."}</h2>
          <p className="mt-2 text-sm text-inverse-muted/75">{lang === "ar" ? "خطة أسبوعية كل أحد، ملخص كل صباح، وتتعلم من كل تعديل. ألغِ في أي وقت." : "A weekly plan every Sunday, a brief every morning, and she learns from every edit. Cancel anytime."}</p>
        </div>
      )}
      {offer && <OfferBanner lang={lang} kind={offer.kind} code={u.referredBy?.code} until={offerUntil} />}
      {owner && u.plan === "trial" && !u.referredBy && !u.firstPaidOn && <PartnerCodeForm lang={lang} />}
      <h2 className="mt-8 font-display text-xl font-bold">{ar ? "الخطط" : "Plans"}</h2>
      {/* The VAT note (rule 1154): the prices below are before VAT, as on the pricing page. */}
      <p className="mt-1 text-sm text-foreground-muted" data-vat-note="">{m.sub}</p>
      {owner && <p className="mt-2 text-foreground-muted">{t.billing.sub}</p>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {SELF_SERVE_PLANS.map((k) => {
          const plan = card(k);
          if (!plan) return null;
          const href = offer ? offerHref(k) : links[k] ?? wa;
          return (
            <PlanCard key={k} lang={lang} id={k} name={plan.name} price={plan.price} period={plan.period} credits={plan.credits} features={plan.features.slice(0, 4)}
              current={u.plan === k} highlight={"highlight" in plan && !!plan.highlight}
              offerLine={offer ? <p data-offer-price className="text-sm font-semibold text-foreground">{O.card(firstMonthPriceSar(k), PLAN_PRICE_SAR[k])}</p> : undefined}>
              {!owner ? null : online ? (
                // The same plan already active is renewed from the subscription card above, not bought again here.
                sub?.status === "active" && sub.plan === k ? null : <PaymobPayButton lang={lang} kind="plan" plan={k} label={offer ? O.activate : t.billing.pay} />
              ) : href ? (
                <a href={href} target="_blank" rel="noreferrer" className="mt-4 inline-flex min-h-[var(--hit-min)] items-center justify-center rounded-full bg-inverse px-4 py-2 text-center text-sm font-semibold text-inverse-muted">{offer ? O.activate : links[k] ? t.billing.pay : t.billing.contact}</a>
              ) : (
                <a href={`mailto:${SUPPORT_EMAIL}`} className="mt-4 inline-flex min-h-[var(--hit-min)] items-center justify-center rounded-full border border-border px-4 py-2 text-center text-sm">{offer ? `${O.noWa} ` : ""}{SUPPORT_EMAIL}</a>
              )}
              {offer && !online && links[k] && <a href={links[k]} target="_blank" rel="noreferrer" className="mt-2 text-center text-xs text-foreground-muted underline">{O.fullPrice}</a>}
            </PlanCard>
          );
        })}
        {agency && (
          <PlanCard lang={lang} id="agency" name={agency.name} price={agency.price} period={agency.period} credits={agency.credits}
            features={agency.features.filter((f) => !/coming soon|قريباً/.test(f)).slice(0, 4)} current={u.plan === "agency"}>
            {/* Contact only, and only for the owner: the WhatsApp thread carries the account email. */}
            {owner && <a href={wa ?? `/${lang}/enterprise#contact`} target={wa ? "_blank" : undefined} rel={wa ? "noreferrer" : undefined} className="mt-4 inline-flex min-h-[var(--hit-min)] items-center justify-center rounded-full border border-border px-4 py-2 text-center text-sm">{agency.cta}</a>}
          </PlanCard>
        )}
      </div>
      {history && <PaymentHistory lang={lang} rows={history} planName={planName} />}
    </div>
  );
}
