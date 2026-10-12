import Link from "next/link";
import type { Lang } from "@/lib/i18n";
import { plural } from "@/lib/format";

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
  // Rule 1094: the count takes the language's own plural form ("بعد يومين", "بعد 11 يومًا"), not a one-or-many guess.
  const left = ar
    ? plural("ar", days, { one: "تجربتك تنتهي بعد يوم واحد", two: "تجربتك تنتهي بعد يومين", few: "تجربتك تنتهي بعد # أيام", many: "تجربتك تنتهي بعد # يومًا", other: "تجربتك تنتهي بعد # يوم" })
    : plural("en", days, { one: "Your trial ends in # day", other: "Your trial ends in # days" });
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border-[1.5px] border-border-strong bg-notice-bg px-4 py-3 text-sm text-foreground">
      <div>
        <p className="font-semibold">{days > 0 ? left : ar ? "انتهت تجربتك" : "Your trial has ended"}</p>
        <p className="mt-0.5 text-foreground-muted">{promise}{industry ? "" : ""}</p>
      </div>
      {owner ? (
        <Link href={`/${lang}/app/settings/billing`} className="btn btn-primary shrink-0 rounded-full px-5 py-2">{ar ? "فعّل نور" : "Activate Noor"}</Link>
      ) : (
        <p className="shrink-0 text-foreground-muted">{ar ? "لتفعيل الاشتراك اطلب من مالك الحساب." : "Ask the account owner to activate."}</p>
      )}
    </div>
  );
}
