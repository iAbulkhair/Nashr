import Link from "next/link";
import Scribble from "@/components/Scribble";
import ScribbleStatic from "@/components/ScribbleStatic";
import type { Dict, Lang } from "@/lib/i18n";

/**
 * The closing call's own title (rule 1861): it names the team and the one thing the owner does, instead of repeating
 * the hero line. Kept here, outside the `pricing` block of i18n.ts, so the pricing page's words stay with it.
 */
export const FINAL_CTA_TITLE: Record<Lang, string> = {
  ar: "أنت توافق، والفريق يشتغل.",
  en: "You approve, the team does the work.",
};

/** The closing call, drawn as prototype D (rule 518): an underlined title on lilac and the ink pill. */
export default function FinalCta({ t, lang }: { t: Dict; lang: Lang }) {
  return (
    <section id="start" className="scroll-mt-20 border-t-[1.5px] border-border-strong bg-background-muted">
      <div className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
        <h2 className="section-title">
          <span className="s-ul">
            <ScribbleStatic kind="underline" seed="final-h" rtl={lang === "ar"} />
            {FINAL_CTA_TITLE[lang]}
          </span>
        </h2>
        <p className="mt-3 text-foreground-muted">{t.pricing.trial}</p>
        <Link href={`/${lang}/app/signup`} className="s-btn mt-8">
          <Scribble kind="pill" seed="final-cta" fill="ink" shadow ring />
          {t.hero.cta}
        </Link>
      </div>
    </section>
  );
}
