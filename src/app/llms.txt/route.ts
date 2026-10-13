import { dict, LANGS, type Lang } from "@/lib/i18n";
import { AGENTS } from "@/lib/agents";
import { AGENT_PAGES, SITE } from "@/lib/site";
import { TOOLS } from "@/lib/tools";
import { INDUSTRY_PAGES } from "@/lib/pages-industry";
import { COMPARE_PAGE } from "@/lib/pages-compare";
import { listPosts } from "@/lib/blog";
import { LEGAL } from "@/lib/legal";
import { PARTNER_TERMS } from "@/lib/partner-terms";
import { SITE_DEFAULT } from "@/lib/page-meta";
import { appOrigin } from "@/lib/origin";

/**
 * `/llms.txt` (rule 698): an index of the public site for language models, in the llms.txt format: an H1, a summary in a
 * blockquote, then `## ` sections of `- [name](url): note` links. The idea comes from supastarter's docs app
 * (docs/superpowers/specs/2026-10-08-supastarter-adoption-design.md, item 5); the code is ours.
 *
 * Every word is copy the site already shows: the share description, the footer's column titles, the menu labels, the
 * agent, industry, comparison and tool pages, the blog's front matter and the legal and partner-terms titles. This file
 * writes no sentence, claim or number of its own, so when the site's copy changes this index follows, and the two cannot
 * disagree. It links only pages that src/app/sitemap.ts lists, built the same way (`appOrigin()` plus the path), so
 * nothing under `/app`, `/api`, the founder console, OAuth or the partner dashboard. Arabic comes first, as on the site.
 *
 * The response is built once at build time (`force-static`) and then served as a file, so no handler runs per request.
 * That is why it carries no rate limit from src/lib/rate.ts, unlike other public routes: a limiter is a Redis write on
 * every hit, which is exactly the per-request work this route avoids, and a static file costs nothing to serve. Like the
 * sitemap and robots, it names the origin APP_ORIGIN had at build time.
 */
export const dynamic = "force-static";

type Link = { path: string; name: string; note?: string };
type Section = { title: string; links: Link[] };

/** One line of copy: dictionary and front-matter strings may carry line breaks, which would end a list item early. */
const line = (s: string) => s.replace(/\s+/g, " ").trim();
/** Link text cannot hold an unescaped bracket without ending the link. */
const linkText = (s: string) => line(s).replace(/[[\]\\]/g, "\\$&");

/** The site's public pages in one language, grouped as the footer groups them (src/components/Footer.tsx). */
function sections(lang: Lang): Section[] {
  const t = dict[lang], s = SITE[lang], f = s.footer;
  return [
    {
      title: f.company,
      links: [
        { path: "", name: t.brand, note: SITE_DEFAULT[lang].description },
        { path: "/pricing", name: s.menu.pricing, note: t.pricing.sub },
        { path: "/customers", name: s.menu.customers, note: s.customers.sub },
        { path: "/enterprise", name: s.menu.enterprise, note: s.enterprise.sub },
        { path: "/privacy", name: LEGAL[lang].privacy.title },
        { path: "/terms", name: LEGAL[lang].terms.title },
        { path: "/affiliates/terms", name: PARTNER_TERMS[lang].title, note: PARTNER_TERMS[lang].intro },
      ],
    },
    {
      title: f.agents,
      links: [
        { path: "/agents", name: s.menu.allAgents, note: `${s.agents.title} ${s.agents.sub}` },
        ...AGENTS.map((a) => ({ path: `/agents/${a.id}`, name: `${a.name[lang]} · ${a.role[lang]}`, note: AGENT_PAGES[lang][a.id].tagline })),
      ],
    },
    { title: f.industries, links: INDUSTRY_PAGES[lang].map((p) => ({ path: `/for/${p.slug}`, name: p.name, note: p.sub })) },
    {
      title: f.resources,
      links: [
        { path: "/resources", name: s.menu.resources, note: s.resources.sub },
        // The cards link the blog, the free tools, help, the explainer, the partner programme and the updates page.
        ...s.resources.cards.map((c) => ({ path: c.href, name: c.t, note: c.d })),
      ],
    },
    { title: s.resources.compare, links: [{ path: "/compare", name: COMPARE_PAGE[lang].title, note: COMPARE_PAGE[lang].desc }] },
    { title: t.nav.tools, links: TOOLS.map((x) => ({ path: `/tools/${x.slug}`, name: x.name[lang], note: x.desc[lang] })) },
    { title: t.nav.blog, links: listPosts(lang).map((p) => ({ path: `/blog/${p.slug}`, name: p.title, note: p.desc })) },
  ];
}

export function GET() {
  const base = appOrigin();
  const out = [
    `# ${dict.ar.brand} · ${dict.en.brand}`,
    "",
    // The first blockquote line is the summary a parser keeps; it is the Arabic one, and the English follows it.
    `> ${line(SITE_DEFAULT.ar.description)}`,
    ">",
    `> ${line(SITE_DEFAULT.en.description)}`,
  ];
  for (const lang of LANGS) {
    for (const sec of sections(lang)) {
      out.push("", `## ${line(sec.title)}`, "");
      for (const l of sec.links) {
        const note = l.note ? line(l.note) : "";
        out.push(`- [${linkText(l.name)}](${base}/${lang}${l.path})` + (note ? `: ${note}` : ""));
      }
    }
  }
  return new Response(out.join("\n") + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
