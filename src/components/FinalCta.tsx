import Link from "next/link";
import Scribble from "@/components/Scribble";
import type { Dict, Lang } from "@/lib/i18n";

/** The closing call, drawn as prototype D (rule 518): an underlined title on lilac and the ink pill. */
export default function FinalCta({ t, lang }: { t: Dict; lang: Lang }) {
  return (
    <section id="start" className="scroll-mt-20 border-t-[1.5px] border-ink bg-lilac">
      <div className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
        <h2 className="section-title">
          <span className="s-ul">
            <Scribble kind="underline" seed="final-h" />
            {t.hero.title1} {t.hero.title2}
          </span>
        </h2>
        <p className="mt-3 text-muted">{t.pricing.trial}</p>
        <Link href={`/${lang}/app/signup`} className="s-btn mt-8">
          <Scribble kind="pill" seed="final-cta" fill="ink" shadow ring />
          {t.hero.cta}
        </Link>
      </div>
    </section>
  );
}
