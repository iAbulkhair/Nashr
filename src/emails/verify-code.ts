import type { Lang } from "../lib/i18n";
import { COPY } from "./copy";
import { html } from "./html";
import { heading, layout, note, paragraph } from "./layout";
import { COLORS, FONT } from "./tokens";

/**
 * The verification code email (src/lib/verify-email.ts, rule 1960; docs/specs/2026-10-13-html-email-layout.md). The code
 * is text, never an image and never only inside a button, so a screen reader and a text client read it; it sits large in
 * a left-to-right run so its digits keep their order inside an Arabic paragraph, in Latin digits so it copies cleanly
 * (`normalizeCode` accepts Arabic-Indic digits typed back). No button: the code is typed in the app. Only digits reach the
 * markup, at most twelve of them.
 */
export function verifyCode(p: { lang: Lang; code: string }): string {
  const c = COPY[p.lang].verify;
  const code = String(p.code).replace(/\D/g, "").slice(0, 12);
  const big = html`<span dir="ltr" style="display:inline-block;font-family:${FONT};font-size:32px;line-height:44px;font-weight:700;letter-spacing:6px;color:${COLORS.ink};">${code}</span>`;
  const body = html`${heading(p.lang, c.title)}${paragraph(p.lang, c.intro)}${paragraph(p.lang, big)}${note(p.lang, c.expiry)}${note(p.lang, c.ignore)}`;
  return layout({ lang: p.lang, title: c.title, preheader: c.preheader, body });
}
