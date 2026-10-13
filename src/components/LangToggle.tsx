"use client";
import { usePathname, useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { LANG_COOKIE, expireLegacyLine } from "@/lib/cookie-names";

/** Writes `thakeen_lang` and removes the old `nashr_lang` (rule 1810); src/proxy.ts reads the new name first. */
function remember(to: Lang) {
  document.cookie = `${LANG_COOKIE}=${to}; path=/; max-age=31536000; samesite=lax`;
  const old = expireLegacyLine(LANG_COOKIE);
  if (old) document.cookie = old;
}

/** Swap the /ar ↔ /en prefix but keep the rest of the path. */
export function swapLang(path: string, to: Lang): string {
  const m = path.match(/^\/(ar|en)(\/.*)?$/);
  if (!m) return `/${to}`;
  return `/${to}${m[2] ?? ""}`;
}

export default function LangToggle({ lang, size = "md" }: { lang: Lang; size?: "sm" | "md" }) {
  const path = usePathname() || `/${lang}`;
  const router = useRouter();

  function go(to: Lang, e: React.MouseEvent<HTMLAnchorElement>) {
    if (to === lang) { e.preventDefault(); return; }
    e.preventDefault();
    remember(to);
    router.push(swapLang(path, to) + window.location.search + window.location.hash);
  }

  const on = "bg-inverse text-inverse-foreground";
  const off = "text-foreground-muted hover:text-foreground";
  const pad = size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";

  const seg = (to: Lang, label: string, title: string) => (
    <a
      href={swapLang(path, to)}
      hrefLang={to}
      lang={to}
      onClick={(e) => go(to, e)}
      aria-current={to === lang ? "true" : undefined}
      // The visible word is the name (WCAG 2.5.3, found by the axe check, rule 1801): a voice user says what they see.
      // The full language name is a hover hint only.
      title={title}
      className={`rounded-full font-semibold transition ${pad} ${to === lang ? on : off}`}
    >
      {label}
    </a>
  );

  return (
    <span role="group" aria-label={lang === "ar" ? "اللغة" : "Language"} dir="ltr" className="inline-flex items-center gap-0.5 rounded-full border-[1.5px] border-border-strong bg-surface p-0.5">
      {seg("ar", "عربي", "العربية")}
      {seg("en", "EN", "English")}
    </span>
  );
}
