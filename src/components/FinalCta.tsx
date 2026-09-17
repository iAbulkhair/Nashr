import Link from "next/link";
import type { Dict, Lang } from "@/lib/i18n";

export default function FinalCta({ t, lang }: { t: Dict; lang: Lang }) {
  return (
    <section id="start" className="scroll-mt-20 bg-salt-dim">
      <div className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
        <h2 className="font-display text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{t.hero.title1} {t.hero.title2}</h2>
        <p className="mt-3 text-ink/70">{t.pricing.trial}</p>
        <Link href={`/${lang}/app/signup`} className="mt-8 inline-block rounded-full bg-oasis px-8 py-3 font-semibold text-mist transition hover:bg-oasis-deep">
          {t.hero.cta}
        </Link>
      </div>
    </section>
  );
}
