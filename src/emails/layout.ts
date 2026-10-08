import type { Lang } from "../lib/i18n";
import { appHost, appOrigin } from "../lib/origin";
import { COPY } from "./copy";
import { html, type SafeHtml, type Slot } from "./html";
import { appLink } from "./link";
import { COLORS, FONT } from "./tokens";

/**
 * The one layout every email shares: the document, the wordmark, a paper card on the ground colour and a short footer.
 * Tables, because Outlook for Windows renders with Word and lays out nothing else reliably.
 *
 * Language and direction are set on every container, not once. Gmail drops the attributes of <html> and <body>, so an
 * Arabic email whose only `lang` and `dir` sat on the document would open left to right, and a screen reader would read
 * it in the voice of Gmail's own interface language. Each table, cell, heading and paragraph therefore carries `lang`,
 * `dir` and the same direction and alignment in CSS, and each cell an `align` as well, which Outlook reads where it
 * ignores CSS.
 */
export const FLOW = { ar: { dir: "rtl", align: "right" }, en: { dir: "ltr", align: "left" } } as const satisfies Record<Lang, { dir: string; align: string }>;

/**
 * A layout table: no spacing of its own, its language and direction in the attributes and its direction in CSS. `width`
 * is the attribute Outlook reads; `center` centres the table itself (not its text) where `margin:auto` is ignored.
 */
export function table(lang: Lang, style: string, rows: Slot, attrs: { center?: boolean; width?: string } = {}): SafeHtml {
  const f = FLOW[lang];
  const center = attrs.center ? html` align="center"` : "";
  const width = attrs.width ? html` width="${attrs.width}"` : "";
  return html`<table role="presentation" cellpadding="0" cellspacing="0" border="0"${width}${center} lang="${lang}" dir="${f.dir}" style="direction:${f.dir};text-align:${f.align};${style}">${rows}</table>`;
}

/** A table cell that keeps the language and reading direction in every client (see the note at the top). `bg` also sets `bgcolor` for Outlook. */
export function cell(lang: Lang, style: string, content: Slot, bg?: string): SafeHtml {
  const f = FLOW[lang];
  const color = bg ? html` bgcolor="${bg}"` : "";
  return html`<td lang="${lang}" dir="${f.dir}" align="${f.align}"${color} style="direction:${f.dir};text-align:${f.align};${style}">${content}</td>`;
}

const TEXT = `font-family:${FONT};color:${COLORS.ink};`;

/** The email's heading, the same words as its title. */
export function heading(lang: Lang, text: string): SafeHtml {
  const f = FLOW[lang];
  return html`<h1 lang="${lang}" dir="${f.dir}" style="direction:${f.dir};text-align:${f.align};margin:0 0 16px;${TEXT}font-size:20px;line-height:30px;font-weight:700;">${text}</h1>`;
}

/** A body paragraph. `content` is text (escaped) or markup this module family made. */
export function paragraph(lang: Lang, content: Slot): SafeHtml {
  const f = FLOW[lang];
  return html`<p lang="${lang}" dir="${f.dir}" style="direction:${f.dir};text-align:${f.align};margin:0 0 16px;${TEXT}font-size:16px;line-height:26px;">${content}</p>`;
}

/** A smaller, muted paragraph: expiry notes, the line under a button. */
export function note(lang: Lang, content: Slot): SafeHtml {
  const f = FLOW[lang];
  return html`<p lang="${lang}" dir="${f.dir}" style="direction:${f.dir};text-align:${f.align};margin:0 0 16px;font-family:${FONT};color:${COLORS.muted};font-size:14px;line-height:22px;">${content}</p>`;
}

/**
 * The bare link under a button, for a client that hides or breaks it. The address is a left-to-right run, so it reads
 * the same inside an Arabic paragraph, and it may break anywhere: a long token would otherwise widen the card on a phone.
 */
export function fallbackLink(lang: Lang, href: string): SafeHtml {
  const to = appLink(href);
  return note(lang, html`${COPY[lang].fallback}<br><a href="${to}" target="_blank" style="color:${COLORS.ink};text-decoration:underline;word-break:break-all;"><span dir="ltr">${to}</span></a>`);
}

/**
 * The whole document. `title` goes into <title>, `preheader` is the hidden line most inboxes show next to the subject,
 * and `body` is the card's content. Answers the HTML part of the message, ready for `sendEmail`.
 */
export function layout(p: { lang: Lang; title: string; preheader: string; body: SafeHtml }): string {
  const { lang } = p;
  const f = FLOW[lang];
  const copy = COPY[lang];
  const home = appLink(`${appOrigin()}/${lang}/app`);
  const wordmark = html`<span style="border-bottom:2px solid ${COLORS.gold};padding-bottom:2px;">${copy.wordmark}</span>`;
  const footer = html`${copy.footer} <a href="${home}" target="_blank" style="color:${COLORS.muted};text-decoration:underline;"><span dir="ltr">${appHost()}</span></a>`;
  const card = table(lang, "width:100%;max-width:560px;margin:0 auto;", [
    html`<tr>${cell(lang, `padding:0 4px 16px;${TEXT}font-size:24px;line-height:34px;font-weight:700;`, wordmark)}</tr>`,
    html`<tr>${cell(lang, `padding:28px 24px 12px;background-color:${COLORS.paper};border:1px solid ${COLORS.lilac};border-radius:12px;${TEXT}`, p.body, COLORS.paper)}</tr>`,
    html`<tr>${cell(lang, `padding:16px 4px 0;font-family:${FONT};color:${COLORS.muted};font-size:13px;line-height:20px;`, footer)}</tr>`,
  ], { center: true, width: "100%" });
  // Outlook for Windows ignores max-width, so there the card sits in a fixed 560-pixel table only it reads.
  const ghost = (inner: SafeHtml) => html`<!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" border="0" lang="${lang}" dir="${f.dir}" style="direction:${f.dir};text-align:${f.align};"><tr><td lang="${lang}" dir="${f.dir}" align="${f.align}" style="direction:${f.dir};text-align:${f.align};"><![endif]-->${inner}<!--[if mso]></td></tr></table><![endif]-->`;
  const page = table(lang, `width:100%;background-color:${COLORS.ground};`, html`<tr>${cell(lang, "padding:24px 12px;", ghost(card), COLORS.ground)}</tr>`, { width: "100%" });
  return html`<!doctype html>
<html lang="${lang}" dir="${f.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${p.title}</title>
</head>
<body lang="${lang}" dir="${f.dir}" style="margin:0;padding:0;direction:${f.dir};background-color:${COLORS.ground};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${COLORS.ground};">${p.preheader}</div>
${page}
</body>
</html>
`.toString();
}
