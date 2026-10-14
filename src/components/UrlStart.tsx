import Scribble from "@/components/Scribble";
import type { Dict, Lang } from "@/lib/i18n";

/**
 * URL-first signup entry used on the hero and on inner pages: the site travels into signup and the first run. Drawn as
 * prototype D (rule 518): a scribbled input on paper with its focus ring, and the ink pill.
 *
 * The field has a visible label that wraps it (rule 1846), so it needs no id and the form can appear twice on a page.
 * It is a URL field (`type="url"`, the URL keyboard on a phone), and the form does not ask the browser to validate it:
 * an owner who types `mystore.com` without `https://` still gets in, and the start page reads and confirms the address.
 */
export default function UrlStart({ t, lang }: { t: Dict; lang: Lang }) {
  const label = lang === "ar" ? "رابط موقعك أو متجرك (اختياري)" : "Your website or store URL (optional)";
  return (
    <form action={`/${lang}/app/signup`} method="get" noValidate className="flex max-w-xl flex-wrap items-end gap-3 sm:flex-nowrap">
      <label className="grid min-w-0 flex-1 basis-full gap-1.5 text-start sm:basis-auto">
        <span className="text-sm font-bold">{label}</span>
        <span className="s-input">
          <Scribble kind="box" seed="url-start" fill="paper" ring />
          <input name="url" type="url" dir="ltr" inputMode="url" autoComplete="url" placeholder="yourstore.com" />
        </span>
      </label>
      <button className="s-btn shrink-0">
        <Scribble kind="pill" seed="url-start-go" fill="ink" shadow ring />
        {t.hero.cta}
      </button>
    </form>
  );
}
