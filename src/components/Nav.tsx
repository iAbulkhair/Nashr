import Link from "next/link";
import type { Dict, Lang } from "@/lib/i18n";
import { AGENTS } from "@/lib/agents";
import { INDUSTRY_PAGES } from "@/lib/pages-industry";
import { SITE } from "@/lib/site";
import LangToggle from "./LangToggle";
import Scribble from "./Scribble";
import Wordmark from "./Wordmark";

type Item = { href: string; label: string; note?: string };

/** A nav link as D draws it: ink text, a hand-drawn underline on hover and keyboard focus. */
function NavLink({ href, children, className = "" }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link href={href} className={`s-link text-ink ${className}`}>
      <Scribble kind="underline" seed={`nav-${href}`} />
      {children}
    </Link>
  );
}

/** Desktop dropdown: opens on hover and on keyboard focus, no client JavaScript. The panel is paper in a drawn box. */
function Drop({ label, href, items }: { label: string; href: string; items: Item[] }) {
  return (
    <div className="group relative">
      <Link href={href} className="s-link flex items-center gap-1 text-ink" aria-haspopup="true">
        <Scribble kind="underline" seed={`nav-${href}`} />
        {label}
        <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      </Link>
      <div className="invisible absolute start-0 top-full z-50 mt-1 w-72 isolate p-2 opacity-0 transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
        <Scribble kind="box" seed={`drop-${href}`} fill="paper" />
        {items.map((i) => (
          <Link key={i.href} href={i.href} className="block rounded-md px-3 py-2 text-sm text-ink hover:bg-lilac">
            <span className="font-medium">{i.label}</span>
            {i.note && <span className="block text-xs text-muted">{i.note}</span>}
          </Link>
        ))}
      </div>
    </div>
  );
}

export default function Nav({ t, lang }: { t: Dict; lang: Lang }) {
  const m = SITE[lang].menu;
  const agents: Item[] = [...AGENTS.map((a) => ({ href: `/${lang}/agents/${a.id}`, label: a.name[lang], note: a.role[lang] })), { href: `/${lang}/agents`, label: m.allAgents }];
  const industries: Item[] = INDUSTRY_PAGES[lang].map((p) => ({ href: `/${lang}/for/${p.slug}`, label: p.name }));
  const resources: Item[] = SITE[lang].resources.cards.map((c) => ({ href: `/${lang}${c.href}`, label: c.t }));
  const flat: Item[] = [{ href: `/${lang}/customers`, label: m.customers }, { href: `/${lang}/enterprise`, label: m.enterprise }, { href: `/${lang}/pricing`, label: m.pricing }];
  return (
    <header className="sticky top-0 z-40 border-b-[1.5px] border-ink bg-ground/95 text-ink backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href={`/${lang}`} className="font-display text-2xl font-bold tracking-tight text-ink">
          <Wordmark lang={lang} name={t.brand} />
        </Link>
        <nav className="hidden items-center gap-5 text-sm lg:flex" aria-label="Main">
          {/* The Agents tab leads to Noor: she is the front door to the team. */}
          <Drop label={m.agents} href={`/${lang}/agents/noor`} items={agents} />
          {/* The homepage has no industries section; the tab leads to who Nashr is built for, the items to each sector. */}
          <Drop label={m.industries} href={`/${lang}/customers`} items={industries} />
          {flat.slice(0, 2).map((l) => <NavLink key={l.href} href={l.href}>{l.label}</NavLink>)}
          <Drop label={m.resources} href={`/${lang}/resources`} items={resources} />
          <NavLink href={flat[2].href}>{flat[2].label}</NavLink>
        </nav>
        <div className="flex items-center gap-3">
          <LangToggle lang={lang} />
          <NavLink href={`/${lang}/app/login`} className="hidden text-sm sm:inline-block">{m.login}</NavLink>
          <Link href={`/${lang}/app/signup`} className="s-btn s-btn--ghost min-h-10 px-5 py-1.5 text-sm">
            <Scribble kind="pill" seed="nav-cta" fill="lemon" ring />
            {t.nav.cta}
          </Link>
          <details className="relative lg:hidden">
            <summary className="grid h-9 w-9 cursor-pointer list-none place-items-center rounded-lg border-[1.5px] border-ink" aria-label={m.open}>
              <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden><path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            </summary>
            <div className="absolute end-0 top-full z-50 mt-2 max-h-[75vh] w-72 overflow-y-auto rounded-xl border-[1.5px] border-ink bg-paper p-3 text-sm">
              {[{ title: m.agents, items: agents }, { title: m.industries, items: industries }, { title: m.resources, items: resources }].map((g) => (
                <details key={g.title} className="border-b border-ink/15 py-1">
                  <summary className="cursor-pointer list-none px-2 py-2 font-medium">{g.title}</summary>
                  {g.items.map((i) => <Link key={i.href} href={i.href} className="block rounded-lg px-4 py-1.5 text-muted hover:bg-lilac hover:text-ink">{i.label}</Link>)}
                </details>
              ))}
              {[...flat, { href: `/${lang}/app/login`, label: m.login }].map((l) => <Link key={l.href} href={l.href} className="block rounded-lg px-2 py-2 font-medium hover:bg-lilac">{l.label}</Link>)}
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}
