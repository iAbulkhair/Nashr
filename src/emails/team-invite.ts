import type { Lang } from "../lib/i18n";
import type { TeamRole } from "../lib/team";
import { button } from "./button";
import { COPY } from "./copy";
import { fillHtml, html } from "./html";
import { fallbackLink, heading, layout, note, paragraph } from "./layout";

/**
 * The team invitation (src/app/api/team/invite/route.ts). It takes no organisation, brand or display name, and has no
 * field that could carry one (rule 688): those are free text anyone can set at signup or on the brand form, and this
 * email goes from the product's own domain to any address, so naming them would make it a relay for whatever the sender
 * typed. The only thing the sender chose is the address of the login that sent it, shown as a left-to-right run.
 *
 * The join link carries its token in the fragment (`#t=`) like the reset link, so the same condition holds: Resend's
 * click tracking must stay off for the sending domain, or the token is stored at its redirect (./reset-password.ts).
 */
export function teamInvite(p: { lang: Lang; inviterEmail: string; role: TeamRole; link: string }): string {
  const c = COPY[p.lang].invite;
  const intro = fillHtml(c.body, { inviter: html`<span dir="ltr">${p.inviterEmail}</span>`, role: c.roles[p.role] });
  const body = html`${heading(p.lang, c.title)}${paragraph(p.lang, c.greeting)}${paragraph(p.lang, intro)}${button({ lang: p.lang, label: c.action, href: p.link })}${note(p.lang, c.expiry)}${fallbackLink(p.lang, p.link)}${note(p.lang, c.only)}`;
  return layout({ lang: p.lang, title: c.title, preheader: c.preheader, body });
}
