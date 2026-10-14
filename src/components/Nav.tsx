import Link from "next/link";
import type { Dict, Lang } from "@/lib/i18n";
import { AGENTS } from "@/lib/agents";
import { SITE } from "@/lib/site";
import { SKIP_TO_CONTENT } from "@/lib/screen-titles";
import LangToggle from "./LangToggle";
import NavDrop, { type NavItem } from "./NavDrop";
import Scribble from "./Scribble";
import ScribbleStatic from "./ScribbleStatic";
import Wordmark from "./Wordmark";

/** The two nav words the dictionaries do not carry yet. */
export const NAV_WORDS: Record<"team" | "help", Record<Lang, string>> = {
  team: { ar: "الفريق", en: "Team" },
  help: { ar: "المساعدة", en: "Help" },
};

/**
 * The one site menu (rule 1854, site critique 2026-10-14): the same four links on every public page, in this order, then
 * the call to action. "How it works" is the homepage's seven steps (`#steps`), the page that explains it. Customers,
 * agencies, sectors and resources moved to the footer, which lists every one of them.
 */
export function navItems(t: Dict, lang: Lang): (NavItem & { key: "team" | "how" | "pricing" | "help" })[] {
  return [
    { key: "team", href: `/${lang}/agents`, label: NAV_WORDS.team[lang] },
    { key: "how", href: `/${lang}#steps`, label: t.nav.how },
    { key: "pricing", href: `/${lang}/pricing`, label: SITE[lang].menu.pricing },
    { key: "help", href: `/${lang}/help`, label: NAV_WORDS.help[lang] },
  ];
}

/** A nav link as D draws it: ink text, a hand-drawn underline on hover and keyboard focus, 44px tall. */
function NavLink({ href, rtl, children, className = "" }: { href: string; rtl: boolean; children: React.ReactNode; className?: string }) {
  return (
    <Link href={href} className={`s-link min-h-[var(--hit-min)] items-center text-foreground ${className || "inline-flex"}`}>
      <ScribbleStatic kind="underline" seed={`nav-${href}`} rtl={rtl} />
      {children}
    </Link>
  );
}

/**
 * The site header on every public page. Four links and the call to action (rule 1854); log in and the language toggle are
 * small utilities beside them. A skip link to `#main` comes first (rule 1858). Under `lg` the four links and log in fold
 * into a native `<details>` menu whose button is 44px (rule 1856); under `sm` the language toggle moves into it too, so
 * the header fits a 375px screen.
 */
export default function Nav({ t, lang }: { t: Dict; lang: Lang }) {
  const m = SITE[lang].menu;
  const rtl = lang === "ar";
  const items = navItems(t, lang);
  const agents: NavItem[] = [...AGENTS.map((a) => ({ href: `/${lang}/agents/${a.id}`, label: a.name[lang], note: a.role[lang] })), { href: `/${lang}/agents`, label: m.allAgents }];
  const login = { href: `/${lang}/app/login`, label: m.login };
  return (
    <>
      <a href="#main" className="skip-link">{SKIP_TO_CONTENT[lang]}</a>
      <header className="sticky top-0 z-40 border-b-[1.5px] border-border-strong bg-background/95 text-foreground backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2 sm:px-6">
          <Link href={`/${lang}`} className="inline-flex min-h-[var(--hit-min)] items-center font-display text-2xl font-bold tracking-tight text-foreground">
            <Wordmark lang={lang} name={t.brand} />
          </Link>
          <nav className="hidden items-center gap-6 text-sm lg:flex" aria-label={lang === "ar" ? "القائمة الرئيسية" : "Main"}>
            {items.map((i) =>
              i.key === "team"
                ? <NavDrop key={i.key} label={i.label} href={i.href} items={agents} rtl={rtl} />
                : <NavLink key={i.key} href={i.href} rtl={rtl}>{i.label}</NavLink>,
            )}
          </nav>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline-flex"><LangToggle lang={lang} /></span>
            <NavLink href={login.href} rtl={rtl} className="hidden text-sm sm:inline-flex">{login.label}</NavLink>
            <Link href={`/${lang}/app/signup`} className="s-btn s-btn--ghost min-h-[var(--hit-min)] px-5 py-1.5 text-sm">
              <Scribble kind="pill" seed="nav-cta" fill="lemon" ring />
              {t.nav.cta}
            </Link>
            <details className="relative lg:hidden">
              <summary className="grid min-h-[var(--hit-min)] min-w-[var(--hit-min)] cursor-pointer list-none place-items-center rounded-lg border-[1.5px] border-border-strong" aria-label={m.open}>
                <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden><path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </summary>
              <div className="absolute end-0 top-full z-50 mt-2 max-h-[75vh] w-72 overflow-y-auto rounded-xl border-[1.5px] border-border-strong bg-surface p-3 text-sm">
                {[...items, login].map((l) => (
                  <Link key={l.href} href={l.href} className="flex min-h-[var(--hit-min)] items-center rounded-lg px-2 font-medium hover:bg-background-muted">{l.label}</Link>
                ))}
                <div className="mt-2 border-t border-border px-2 pt-3 sm:hidden"><LangToggle lang={lang} /></div>
              </div>
            </details>
          </div>
        </div>
      </header>
    </>
  );
}
