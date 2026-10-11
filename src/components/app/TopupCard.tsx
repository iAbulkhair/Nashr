import type { Lang } from "@/lib/i18n";
import { PRICES_INCLUDE_VAT, TOPUP_PACKS, TOPUP_VALID_DAYS, formatCount, topupPriceSar, topupsSold, type Plan } from "@/lib/pricing";
import type { TopupView } from "@/lib/topups";
import ReadOnlyNote from "./ReadOnlyNote";
import { PaymobPayButton } from "./PaymobBilling";

/**
 * The billing page's "Top up credits" section (rule 449). A server component with no state: the page reads the account
 * and passes what this shows. Every number comes from src/lib/pricing.ts (the packs, the price per credit, how long a pack lasts)
 * or from the account's own packs, never from the copy.
 *
 * With Paymob configured (`payOnline`, src/lib/billing.ts, rules 700-729) the owner of a paid plan pays a pack by card: the
 * server prices it and the pack is added when Paymob's callback confirms the payment. Otherwise nothing here takes a
 * payment: the owner of a paid plan gets one button per pack that
 * opens WhatsApp support (`SUPPORT_WHATSAPP`, as the plan activation does) with a message naming the pack, its price and
 * the account's email, or an email to support when no number is set; the founder activates the pack after the payment
 * (POST /api/admin/topups). A trial sees the packs as available after subscribing, with no button. Anyone else sees the
 * packs and the account's packs read-only and is told to ask the owner.
 */
export default function TopupCard({ lang, plan, owner, email, whatsapp, lots, topupCredits, payOnline = false }: {
  lang: Lang;
  plan: Plan;
  /** `can(u, "billing")`: only the owner is offered a button (the message carries the account email). */
  owner: boolean;
  /** The account's email, for the request message: passed for the owner only. */
  email?: string;
  /** SUPPORT_WHATSAPP as digits, for the owner only; null when not set. */
  whatsapp: string | null;
  /** The account's live packs (`topupView`: no payment details). */
  lots: TopupView[];
  /** Credits left in them. */
  topupCredits: number;
  /** Paymob is configured and the owner themself is here (`billing.pay`): packs are paid by card. */
  payOnline?: boolean;
}) {
  const ar = lang === "ar";
  const n = formatCount;
  const sold = topupsSold(plan);
  const vat = PRICES_INCLUDE_VAT ? (ar ? "شامل الضريبة" : "incl. VAT") : (ar ? "+ الضريبة" : "+ VAT");
  const price = (credits: number) => (ar ? `${n(topupPriceSar(credits))} ريال ${vat}` : `${n(topupPriceSar(credits))} SAR ${vat}`);
  const request = (credits: number) => ar
    ? `ذكين: أرغب في شحن رصيدي بباقة ${n(credits)} كريدت (${price(credits)}). الحساب: ${email ?? ""}`
    : `Thakeen: I'd like to top up with the ${n(credits)}-credit pack (${price(credits)}). Account: ${email ?? ""}`;
  // A button only for the owner of a paid plan; WhatsApp when the support number is set, else an email to support.
  const href = (credits: number) => !owner || !sold ? null
    : whatsapp ? `https://wa.me/${whatsapp}?text=${encodeURIComponent(request(credits))}`
      : `mailto:hello@nashr.ai?subject=${encodeURIComponent(request(credits))}`;
  return (
    <section id="topup" className="mt-6 card scroll-mt-6" aria-labelledby="topup-title" data-topups="">
      <h2 id="topup-title" className="font-display text-lg font-bold">{ar ? "اشحن رصيدك" : "Top up credits"}</h2>
      <p className="mt-1 text-sm text-foreground-muted">{ar
        ? `باقات كريدت إضافية فوق خطتك: تُستخدم بعد كريدت خطتك الشهري، وتبقى صالحة ${n(TOPUP_VALID_DAYS)} يوماً من تفعيلها. كريدت الخطة الشهري لا يُرحَّل إلى الشهر التالي.`
        : `Extra credits on top of your plan: used after your plan's monthly credits, and valid for ${n(TOPUP_VALID_DAYS)} days from activation. Monthly plan credits never roll over.`}</p>
      {/* The refund policy (founder decision of 2026-10-02, rule 460): the founder refunds the unused share by hand. */}
      <p className="mt-1 text-sm text-foreground-muted" data-topup-refund="">{ar
        ? "يمكن استرداد كريدت باقات الشحن غير المستخدم عند الطلب قبل انتهاء صلاحيته."
        : "Unused top-up credits can be refunded on request before they expire."}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {TOPUP_PACKS.map((credits) => {
          const link = href(credits);
          return (
            <div key={credits} data-pack={credits} className="flex flex-col rounded-xl border border-foreground/10 p-4">
              <p className="font-display text-2xl font-bold" dir="ltr">{n(credits)} <span className="text-sm font-normal text-foreground-muted">{ar ? "كريدت" : "credits"}</span></p>
              <p className="mt-1 text-sm text-danger" data-pack-price="">{price(credits)}</p>
              <p className="mt-1 flex-1 text-xs text-foreground-muted">{ar ? `صالحة ${n(TOPUP_VALID_DAYS)} يوماً` : `Valid ${n(TOPUP_VALID_DAYS)} days`}</p>
              {owner && sold && payOnline ? (
                <PaymobPayButton lang={lang} kind="topup" credits={credits} className="rounded-full bg-inverse px-4 py-2 text-center text-sm font-semibold text-inverse-muted" />
              ) : link && (
                <a href={link} target="_blank" rel="noreferrer" data-pack-request="" className="mt-3 rounded-full bg-inverse px-4 py-2 text-center text-sm font-semibold text-inverse-muted">
                  {whatsapp ? (ar ? "اطلبها عبر واتساب" : "Request on WhatsApp") : (ar ? "اطلبها بالبريد" : "Request by email")}
                </a>
              )}
            </div>
          );
        })}
      </div>
      {!sold ? (
        <p className="mt-3 text-sm text-foreground-muted" data-topup-trial="">{ar ? "باقات الشحن متاحة بعد الاشتراك في خطة مدفوعة." : "Top-up packs are available once you subscribe to a paid plan."}</p>
      ) : owner && payOnline ? (
        <p className="mt-3 text-xs text-foreground-muted" data-topup-online="">{ar
          ? "ادفع بالبطاقة: تُضاف الباقة إلى حسابك فور تأكيد بوابة الدفع."
          : "Pay by card: the pack is added to your account as soon as the payment gateway confirms it."}</p>
      ) : owner ? (
        <p className="mt-3 text-xs text-foreground-muted">{ar
          ? "لا دفع إلكتروني بعد: يفتح الزر محادثة مع الدعم برسالة جاهزة تذكر الباقة وبريد حسابك، وبعد الدفع نفعّل الباقة على حسابك يدوياً."
          : "No online checkout yet: the button opens a chat with support with a message naming the pack and your account email; once you have paid, we activate the pack on your account by hand."}</p>
      ) : (
        <ReadOnlyNote className="mt-3" text={ar ? "اطلب من مالك الحساب شحن الرصيد." : "Ask the account owner to top up the credits."} />
      )}
      {lots.length > 0 && (
        <div className="mt-4 border-t border-foreground/10 pt-4">
          <h3 className="font-display font-medium">{ar ? "باقاتك الحالية" : "Your top-up packs"} <span className="font-mono text-sm font-normal text-foreground-muted" dir="ltr">({n(topupCredits)})</span></h3>
          <ul className="mt-2 space-y-1 text-sm">
            {lots.map((l) => (
              <li key={l.id} data-lot={l.id} className="flex flex-wrap justify-between gap-2">
                <span>{ar ? `${n(l.left)} متبقٍّ من ${n(l.credits)} كريدت` : `${n(l.left)} of ${n(l.credits)} credits left`}</span>
                <span className="text-foreground-muted">{ar ? "تنتهي " : "Expires "}<span className="font-mono" dir="ltr">{l.expiresAt.slice(0, 10)}</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
