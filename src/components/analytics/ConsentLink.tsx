"use client";
import { CONSENT_COPY, CONSENT_OPEN_EVENT } from "@/lib/cookie-consent";
import type { Lang } from "@/lib/i18n";

/** The footer's "Cookie settings" (rule 3337): opens the banner again so the visitor can change their answer. */
export default function ConsentLink({ lang }: { lang: Lang }) {
  return (
    <button type="button" className="inline-flex min-h-6 items-center hover:underline" onClick={() => window.dispatchEvent(new Event(CONSENT_OPEN_EVENT))}>
      {CONSENT_COPY.settings[lang]}
    </button>
  );
}
