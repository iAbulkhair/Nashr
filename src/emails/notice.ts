import type { Lang } from "../lib/i18n";
import { button } from "./button";
import { COPY } from "./copy";
import { html, plain } from "./html";
import { heading, layout, paragraph } from "./layout";

/** How much of the first paragraph the hidden preheader carries: inboxes show about this much next to the subject. */
const PREHEADER_CHARS = 140;

/**
 * The generic notice: a title, paragraphs and at most one button. Lifecycle notes and Reem's reminder, series warning
 * and evening wrap use it. Titles and paragraphs are plain text that people and models wrote (task titles, Reem's
 * bodies, a brand's name), so each goes in escaped, never as raw HTML and never as rendered Markdown; a line break inside
 * a paragraph becomes `<br>`, and addresses in it are kept left to right. Split a body with `paragraphs()` (./html.ts).
 * The button's label defaults to opening the app; its href must point into the app (rule 687).
 */
export function notice(p: { lang: Lang; title: string; paragraphs: string[]; cta?: { href: string; label?: string } }): string {
  const c = COPY[p.lang].notice;
  const cta = p.cta ? button({ lang: p.lang, label: p.cta.label ?? c.open, href: p.cta.href }) : "";
  const body = html`${heading(p.lang, p.title)}${p.paragraphs.map((x) => paragraph(p.lang, plain(x)))}${cta}`;
  // Cut by code point, not UTF-16 unit: an emoji across the edge would leave a lone surrogate (U+FFFD in the inbox).
  const preheader = Array.from((p.paragraphs[0] ?? p.title).replace(/\s+/g, " ")).slice(0, PREHEADER_CHARS).join("");
  return layout({ lang: p.lang, title: p.title, preheader, body });
}
