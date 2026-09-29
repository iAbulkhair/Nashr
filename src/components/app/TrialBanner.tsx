import Link from "next/link";
import type { Lang } from "@/lib/i18n";

/**
 * Persistent activation strip for trial accounts: days left + what the plan does + Activate. Only the owner can
 * subscribe, so everyone else sees the same countdown with "ask the account owner" instead of the button.
 */
export default function TrialBanner({ lang, days, plan, industry, owner = true }: { lang: Lang; /** whole days left, from trialDaysLeft() in the server layout */ days: number; plan: string; industry?: string; /** the acting person may subscribe (`can(u, "billing")`) */ owner?: boolean }) {
  if (plan !== "trial") return null;
  const ar = lang === "ar";
  const promise = ar
    ? `مع نور: خطة أسبوعية كل أحد، ومحتوى بلهجتك كلما طلبته، ولا يُنشر شيء إلا بطلبك.`
    : `With Noor: a weekly plan every Sunday, content in your dialect whenever you ask, and nothing is published unless you ask.`;
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-saffron/50 bg-saffron/10 px-4 py-3 text-sm">
      <div>
        <p className="font-semibold">{days > 0 ? (ar ? `تجربتك تنتهي بعد ${days} ${days === 1 ? "يوم" : "أيام"}` : `Your trial ends in ${days} day${days === 1 ? "" : "s"}`) : ar ? "انتهت تجربتك" : "Your trial has ended"}</p>
        <p className="mt-0.5 text-ink/70">{promise}{industry ? "" : ""}</p>
      </div>
      {owner ? (
        <Link href={`/${lang}/app/billing`} className="shrink-0 rounded-full bg-oasis px-5 py-2 font-semibold text-mist">{ar ? "فعّل نور" : "Activate Noor"}</Link>
      ) : (
        <p className="shrink-0 text-ink/70">{ar ? "لتفعيل الاشتراك اطلب من مالك الحساب." : "Ask the account owner to activate."}</p>
      )}
    </div>
  );
}
