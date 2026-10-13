import Link from "next/link";
import type { Dict, Lang } from "@/lib/i18n";
import { AGENTS } from "@/lib/agents";
import { INDUSTRY_PAGES } from "@/lib/pages-industry";
import { SITE } from "@/lib/site";
import { VS_PAGES } from "@/lib/pages-vs";
import LangToggle from "./LangToggle";
import ThemeToggle from "./ui/ThemeToggle";
import Scribble from "./Scribble";
import Wordmark from "./Wordmark";

/** `lang` is optional so older pages that pass only `t` keep working; it is derived from the text direction. */
export default function Footer({ t, lang: given }: { t: Dict; lang?: Lang }) {
  const lang: Lang = given ?? (t.dir === "rtl" ? "ar" : "en");
  const s = SITE[lang], f = s.footer;
  const cols: { title: string; links: { href: string; label: string }[] }[] = [
    { title: f.agents, links: AGENTS.map((a) => ({ href: `/${lang}/agents/${a.id}`, label: `${a.name[lang]} · ${a.role[lang]}` })) },
    { title: f.industries, links: INDUSTRY_PAGES[lang].map((p) => ({ href: `/${lang}/for/${p.slug}`, label: p.name })) },
    { title: f.resources, links: s.resources.cards.map((c) => ({ href: `/${lang}${c.href}`, label: c.t })) },
    { title: f.company, links: [{ href: `/${lang}/customers`, label: s.menu.customers }, { href: `/${lang}/enterprise`, label: s.menu.enterprise }, { href: `/${lang}/pricing`, label: s.menu.pricing }, ...(VS_PAGES[lang][0] ? [{ href: `/${lang}/resources#compare`, label: s.resources.compare }] : []), { href: `/${lang}/privacy`, label: lang === "ar" ? "الخصوصية" : "Privacy" }, { href: `/${lang}/terms`, label: lang === "ar" ? "الشروط" : "Terms" }] },
  ];
  return (
    <footer className="bg-background text-foreground-muted">
      <div className="mx-auto max-w-6xl px-4 sm:px-6"><div className="relative isolate h-3" aria-hidden><Scribble kind="divider" seed="footer" /></div></div>
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-[1.2fr_1fr_1fr_1fr_1fr]">
          <div>
            <p className="font-display text-xl font-bold text-foreground"><Wordmark lang={lang} name={t.brand} /></p>
            <p className="mt-1 text-sm">{t.footer.tagline}</p>
          </div>
          {/* Each link is at least 24px tall (rule 1587, WCAG 2.5.8): 20px of text plus 4px between rows read the same as before. */}
          {cols.map((c) => (
            <nav key={c.title} aria-label={c.title}>
              <p className="text-sm font-semibold text-foreground">{c.title}</p>
              <ul className="mt-3 space-y-1 text-sm">{c.links.map((l) => <li key={l.href}><Link href={l.href} className="inline-flex min-h-6 items-center text-foreground hover:underline">{l.label}</Link></li>)}</ul>
            </nav>
          ))}
        </div>
        <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6 text-xs">
          <p>{t.footer.rights}</p>
          {/* Rule 1215: the viewer's light, dark or device choice, on every public page, beside the language. */}
          <div className="flex flex-wrap items-center gap-3">
            <ThemeToggle lang={lang} size="sm" />
            <LangToggle lang={lang} />
          </div>
        </div>
      </div>
    </footer>
  );
}
