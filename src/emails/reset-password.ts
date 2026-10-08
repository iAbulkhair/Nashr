import type { Lang } from "../lib/i18n";
import { button } from "./button";
import { COPY } from "./copy";
import { html } from "./html";
import { fallbackLink, heading, layout, note, paragraph } from "./layout";

/**
 * The password reset email (src/app/api/auth/forgot/route.ts). `link` is the reset page with the token in its fragment
 * (`#t=`, rule 546), used exactly as given: a fragment never reaches a server, so the token stays out of every log. The
 * one-hour note matches the token's lifetime and the plain-text part.
 *
 * That guarantee now also depends on Resend's click tracking staying off for the sending domain. Click tracking rewrites
 * every href in the HTML part to pass through Resend's redirect, so the whole link, fragment and token included, would
 * be stored on Resend's servers; the plain-text part is never rewritten, which is why text-only mail never had this
 * dependency. It is a dashboard switch, not something this code can set per message.
 */
export function resetPassword(p: { lang: Lang; link: string }): string {
  const c = COPY[p.lang].reset;
  const body = html`${heading(p.lang, c.title)}${paragraph(p.lang, c.greeting)}${paragraph(p.lang, c.intro)}${button({ lang: p.lang, label: c.action, href: p.link })}${note(p.lang, c.expiry)}${fallbackLink(p.lang, p.link)}${note(p.lang, c.ignore)}`;
  return layout({ lang: p.lang, title: c.title, preheader: c.preheader, body });
}
