import Link from "next/link";
import type { Dict, Lang } from "@/lib/i18n";
import LangToggle from "./LangToggle";

export default function Nav({ t, lang }: { t: Dict; lang: Lang }) {
  const links = [
    { href: `/${lang}#how`, label: t.nav.how },
    { href: `/${lang}#agents`, label: t.nav.agents },
    { href: `/${lang}#industries`, label: t.nav.industries },
    { href: `/${lang}/pricing`, label: t.nav.pricing },
    { href: `/${lang}/tools`, label: t.nav.tools },
    { href: `/${lang}/blog`, label: t.nav.blog },
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-mist/10 bg-oasis-deep/90 text-mist backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href={`/${lang}`} className="font-display text-2xl font-bold tracking-tight">
          {t.brand}
          <span className="ms-2 inline-block h-2 w-2 rounded-full bg-saffron align-middle" aria-hidden />
        </Link>
        <nav className="hidden items-center gap-6 text-sm md:flex" aria-label="Main">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="text-mist-dim transition hover:text-mist">
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <LangToggle lang={lang} />
          <Link href={`/${lang}/app/signup`} className="btn btn-accent btn-pill">
            {t.nav.cta}
          </Link>
        </div>
      </div>
    </header>
  );
}
