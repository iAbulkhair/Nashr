import Link from "next/link";
import type { Dict, Lang } from "@/lib/i18n";

export default function Hero({ t, lang }: { t: Dict; lang: Lang }) {
  return (
    <section className="bg-oasis-deep text-mist">
      <div className="mx-auto grid max-w-6xl gap-12 px-4 pb-20 pt-16 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:pt-24">
        <div>
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-saffron/40 px-3 py-1 text-xs font-medium text-saffron">
            <span className="h-1.5 w-1.5 rounded-full bg-saffron" aria-hidden />
            {t.hero.eyebrow}
          </p>
          <h1 className="font-display text-5xl font-bold leading-[1.1] tracking-tight sm:text-6xl lg:text-7xl">
            <span className="block font-light text-mist-dim">{t.hero.title1}</span>
            <span className="block">{t.hero.title2}</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-mist-dim">{t.hero.sub}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href={`/${lang}/app/signup`} className="rounded-full bg-saffron px-6 py-3 font-semibold text-ink transition hover:bg-saffron/90">
              {t.hero.cta}
            </Link>
            <a href="#log" className="rounded-full border border-mist/25 px-6 py-3 font-medium text-mist transition hover:border-mist/60">
              {t.hero.cta2}
            </a>
          </div>
        </div>

        <div id="log" className="rounded-2xl border border-mist/10 bg-oasis p-5 shadow-2xl shadow-black/30 sm:p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-base font-medium">{t.hero.logTitle}</h2>
            <span className="inline-flex items-center gap-2 font-mono text-xs text-mist-dim">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-saffron opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-saffron" />
              </span>
              live
            </span>
          </div>
          <ol className="divide-y divide-mist/10">
            {t.hero.log.map((row, i) => (
              <li key={row.t} className="log-row flex gap-4 py-3" style={{ animationDelay: `${0.25 + i * 0.35}s` }}>
                <time className="w-12 shrink-0 pt-0.5 font-mono text-sm text-saffron" dir="ltr">
                  {row.t}
                </time>
                <div className="min-w-0">
                  <span className="mb-1 inline-block rounded bg-mist/10 px-1.5 py-0.5 text-[11px] font-medium text-mist-dim">{row.tag}</span>
                  <p className="text-sm leading-relaxed text-mist">{row.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs leading-relaxed text-mist-dim">{t.hero.logNote}</p>
        </div>
      </div>
      <div className="sadu" aria-hidden />
    </section>
  );
}
