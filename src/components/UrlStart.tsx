import type { Dict, Lang } from "@/lib/i18n";

/** URL-first signup entry used on the hero and on inner pages: the site travels into signup and the first run. */
export default function UrlStart({ t, lang, tone = "dark" }: { t: Dict; lang: Lang; tone?: "dark" | "light" }) {
  const label = lang === "ar" ? "رابط موقعك أو متجرك" : "Your website or store URL";
  return (
    <form action={`/${lang}/app/signup`} method="get" className="flex max-w-xl flex-wrap gap-2 sm:flex-nowrap">
      <input name="url" dir="ltr" inputMode="url" autoComplete="url" placeholder={label} aria-label={label} className={tone === "dark" ? "min-w-0 flex-1 rounded-full border border-mist/25 bg-oasis px-5 py-3 text-base text-mist placeholder:text-mist-dim/70 focus:border-saffron focus:outline-none" : "input min-w-0 flex-1 rounded-full"} />
      <button className="btn btn-accent btn-lg shrink-0">{t.hero.cta}</button>
    </form>
  );
}
