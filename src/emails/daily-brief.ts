import type { Lang } from "../lib/i18n";
import { button } from "./button";
import { COPY } from "./copy";
import { fill } from "../lib/fill";
import { html, paragraphs, plain } from "./html";
import { heading, layout, paragraph } from "./layout";

/**
 * Noor's daily brief and the team's follow-ups under it (src/app/api/cron/daily/route.ts, rule 1961). `body` is the
 * plain-text brief the model and the follow-up list wrote: untrusted text, so it is split into paragraphs and every one
 * goes in escaped, never as Markdown and never as raw HTML (rule 686); a line break becomes `<br>`. The bare app address
 * the text part ends with is dropped from the HTML, where the button carries it. `href` must point into the app (rule 687).
 */
export function dailyBrief(p: { lang: Lang; date: string; body: string; href: string }): string {
  const c = COPY[p.lang].brief;
  // Filled as text: the heading and <title> escape it.
  const title = fill(c.title, { date: p.date });
  const paras = paragraphs(p.body).filter((x) => x !== p.href);
  const body = html`${heading(p.lang, title)}${paras.map((x) => paragraph(p.lang, plain(x)))}${button({ lang: p.lang, label: c.action, href: p.href })}`;
  return layout({ lang: p.lang, title, preheader: c.preheader, body });
}

