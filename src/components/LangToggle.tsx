"use client";
import { usePathname, useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";

const COOKIE = "nashr_lang";

/** Swap the /ar ↔ /en prefix but keep the rest of the path. */
export function swapLang(path: string, to: Lang): string {
  const m = path.match(/^\/(ar|en)(\/.*)?$/);
  if (!m) return `/${to}`;
  return `/${to}${m[2] ?? ""}`;
}

export default function LangToggle({ lang, tone = "dark", size = "md" }: { lang: Lang; tone?: "dark" | "light"; size?: "sm" | "md" }) {
  const path = usePathname() || `/${lang}`;
  const router = useRouter();

  function go(to: Lang, e: React.MouseEvent<HTMLAnchorElement>) {
    if (to === lang) { e.preventDefault(); return; }
    e.preventDefault();
    document.cookie = `${COOKIE}=${to}; path=/; max-age=31536000; samesite=lax`;
    router.push(swapLang(path, to) + window.location.search + window.location.hash);
  }

  const wrap = tone === "dark" ? "border-mist/20 bg-oasis/40" : "border-ink/15 bg-salt-dim";
  const on = tone === "dark" ? "bg-saffron text-ink" : "bg-oasis text-mist";
  const off = tone === "dark" ? "text-mist-dim hover:text-mist" : "text-ink/60 hover:text-ink";
  const pad = size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";

  const seg = (to: Lang, label: string, title: string) => (
    <a
      href={swapLang(path, to)}
      hrefLang={to}
      lang={to}
      onClick={(e) => go(to, e)}
      aria-current={to === lang ? "true" : undefined}
      aria-label={title}
      className={`rounded-full font-semibold transition ${pad} ${to === lang ? on : off}`}
    >
      {label}
    </a>
  );

  return (
    <span role="group" aria-label={lang === "ar" ? "اللغة" : "Language"} dir="ltr" className={`inline-flex items-center gap-0.5 rounded-full border p-0.5 ${wrap}`}>
      {seg("ar", "عربي", "العربية")}
      {seg("en", "EN", "English")}
    </span>
  );
}
