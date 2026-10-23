"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { bannerNeeded, type AnalyticsConfig } from "@/lib/analytics";
import { CONSENT_COPY as C, CONSENT_EVENT, CONSENT_OPEN_EVENT, clearAnalyticsLines, consentCookieLine, type ConsentChoice } from "@/lib/cookie-consent";
import type { Lang } from "@/lib/i18n";
import { buttonClass } from "@/components/ui/button-class";
import { useConsent } from "./use-consent";

/**
 * The analytics consent banner (rules 3335-3339). Rendered only while a provider that needs a yes is switched on (the
 * server leaves it out otherwise). It shows until the visitor answers and again when they press "Cookie settings" in the
 * footer. Two answers of equal weight, nothing ticked in advance; the answer stays in the browser's own cookie and the
 * server never hears of it. A "no" also removes the anonymous id and Google's cookies, and turns Google off on this page.
 */
export default function ConsentBanner({ cfg, lang }: { cfg: AnalyticsConfig; lang: Lang }) {
  const choice = useConsent();
  const [reopened, setReopened] = useState(false);
  useEffect(() => {
    const open = () => setReopened(true);
    window.addEventListener(CONSENT_OPEN_EVENT, open);
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, open);
  }, []);
  if (choice === undefined) return null;
  if (!reopened && !bannerNeeded(cfg, choice)) return null;

  const answer = (c: ConsentChoice) => {
    const secure = location.protocol === "https:";
    document.cookie = consentCookieLine(c, secure);
    if (c === "no") {
      for (const line of clearAnalyticsLines(document.cookie, location.hostname)) document.cookie = line;
      if (cfg.provider === "google") (window as unknown as Record<string, unknown>)[`ga-disable-${cfg.id}`] = true;
    }
    setReopened(false);
    window.dispatchEvent(new Event(CONSENT_EVENT));
  };

  return (
    <section
      aria-label={C.label[lang]}
      data-consent-banner
      className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-lg rounded-2xl border border-border bg-background p-4 text-foreground shadow-xl sm:inset-x-auto sm:start-4"
    >
      <p className="font-semibold">{C.title[lang]}</p>
      <p className="mt-1 text-sm text-foreground-muted">
        {C.body[lang]}{" "}
        <Link href={`/${lang}/privacy`} className="underline">{C.privacy[lang]}</Link>
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" className={buttonClass({ variant: "secondary", size: "sm", block: true })} aria-pressed={choice === "yes"} onClick={() => answer("yes")}>{C.accept[lang]}</button>
        <button type="button" className={buttonClass({ variant: "secondary", size: "sm", block: true })} aria-pressed={choice === "no"} onClick={() => answer("no")}>{C.reject[lang]}</button>
      </div>
    </section>
  );
}
