import type { Lang } from "../lib/i18n";
import { html, type SafeHtml } from "./html";
import { cell, table } from "./layout";
import { appLink } from "./link";
import { COLORS, FONT } from "./tokens";

/**
 * The one button: a link in a one-cell table, lemon with ink text, the product's accent pair. It needs no image and no
 * VML: every client paints the cell's colour, the link carries the padding, and Outlook for Windows, which ignores
 * padding on a link, takes it from the cell's `mso-padding-alt`. The href must point into the app (`appLink`, rule 687);
 * it is escaped like every other value.
 */
export function button(p: { lang: Lang; label: string; href: string }): SafeHtml {
  const href = appLink(p.href);
  const link = html`<a href="${href}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:16px;line-height:22px;font-weight:700;color:${COLORS.ink};text-decoration:none;border-radius:8px;">${p.label}</a>`;
  return table(p.lang, "margin:4px 0 20px;", html`<tr>${cell(p.lang, `mso-padding-alt:12px 24px;background-color:${COLORS.lemon};border-radius:8px;`, link, COLORS.lemon)}</tr>`);
}
