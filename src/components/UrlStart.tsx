import Scribble from "@/components/Scribble";
import type { Dict, Lang } from "@/lib/i18n";

/**
 * URL-first signup entry used on the hero and on inner pages: the site travels into signup and the first run. Drawn as
 * prototype D (rule 518): a scribbled input on paper with its focus ring, and the ink pill.
 */
export default function UrlStart({ t, lang }: { t: Dict; lang: Lang }) {
  const label = lang === "ar" ? "رابط موقعك أو متجرك" : "Your website or store URL";
  return (
    <form action={`/${lang}/app/signup`} method="get" className="flex max-w-xl flex-wrap items-center gap-3 sm:flex-nowrap">
      <span className="s-input min-w-0 flex-1 basis-full sm:basis-auto">
        <Scribble kind="box" seed="url-start" fill="paper" ring />
        <input name="url" dir="ltr" inputMode="url" autoComplete="url" placeholder={label} aria-label={label} />
      </span>
      <button className="s-btn shrink-0">
        <Scribble kind="pill" seed="url-start-go" fill="ink" shadow ring />
        {t.hero.cta}
      </button>
    </form>
  );
}
