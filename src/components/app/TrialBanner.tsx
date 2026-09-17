import Link from "next/link";
import type { Lang } from "@/lib/i18n";

/** Persistent activation strip for trial users: days left + concrete 30-day promise + Activate. */
export default function TrialBanner({ lang, trialEnds, plan, industry }: { lang: Lang; trialEnds: string; plan: string; industry?: string }) {
  if (plan !== "trial") return null;
  const ar = lang === "ar";
  const days = Math.max(0, Math.ceil((new Date(trialEnds).getTime() - Date.now()) / 864e5));
  const promise = ar
    ? `أول 30 يوماً مع نور: 40 منشوراً بلهجتك، 4 مقالات SEO، 12 رسالة واتساب، 20 نسخة إعلانية — كلها تنتظر موافقتك، لا تُنشر بدونك.`
    : `Your first 30 days with Noor: 40 posts in your dialect, 4 SEO articles, 12 WhatsApp messages, 20 ad variants — all waiting for your approval, nothing published without you.`;
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-saffron/50 bg-saffron/10 px-4 py-3 text-sm">
      <div>
        <p className="font-semibold">{days > 0 ? (ar ? `تجربتك تنتهي بعد ${days} ${days === 1 ? "يوم" : "أيام"}` : `Your trial ends in ${days} day${days === 1 ? "" : "s"}`) : ar ? "انتهت تجربتك" : "Your trial has ended"}</p>
        <p className="mt-0.5 text-ink/70">{promise}{industry ? "" : ""}</p>
      </div>
      <Link href={`/${lang}/app/billing`} className="shrink-0 rounded-full bg-oasis px-5 py-2 font-semibold text-mist">{ar ? "فعّلي نور" : "Activate Noor"}</Link>
    </div>
  );
}
