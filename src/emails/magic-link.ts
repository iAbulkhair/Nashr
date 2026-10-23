import type { Lang } from "../lib/i18n";
import { button } from "./button";
import { COPY } from "./copy";
import { html } from "./html";
import { fallbackLink, heading, layout, note, paragraph } from "./layout";

/**
 * The sign-in link email (rule 3415, src/lib/better-auth/magic.ts), sent only while `AUTH_ENGINE=better-auth`. `link` is
 * the magic page with the token in its fragment (`#t=`, rule 546), used exactly as given, like the reset link. The
 * 15-minute note matches the token's lifetime (`MAGIC_TTL_SECONDS`). The same Resend click-tracking caveat as the reset
 * email applies (./reset-password.ts): the HTML part's link passes through Resend only if click tracking is switched on.
 */
export function magicLink(p: { lang: Lang; link: string }): string {
  const c = COPY[p.lang].magic;
  const body = html`${heading(p.lang, c.title)}${paragraph(p.lang, c.greeting)}${paragraph(p.lang, c.intro)}${button({ lang: p.lang, label: c.action, href: p.link })}${note(p.lang, c.expiry)}${fallbackLink(p.lang, p.link)}${note(p.lang, c.ignore)}`;
  return layout({ lang: p.lang, title: c.title, preheader: c.preheader, body });
}
