import type { Lang } from "@/lib/i18n";

/**
 * A screen's link to the help answer about it (rule 2147). `href` comes from `helpHref` (src/lib/help.ts), so it is typed
 * against the help topics and slugs. It opens in a new tab: the help page is part of the public site, and the screen the
 * user was stuck on, with whatever they typed into it, stays open. No directive, so a server page or a client panel can
 * render it.
 */
export default function HelpLink({ lang, href, className = "" }: { lang: Lang; href: string; className?: string }) {
  const ar = lang === "ar";
  return (
    <a href={href} target="_blank" rel="noreferrer" data-help-link="" className={`text-sm font-bold text-foreground underline ${className}`}>
      {ar ? "كيف يشتغل هذا؟" : "How does this work?"}
      <span className="sr-only">{ar ? " (يفتح في تبويب جديد)" : " (opens in a new tab)"}</span>
    </a>
  );
}
