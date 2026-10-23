"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/app/Icons";
import type { Lang } from "@/lib/i18n";
import { copyMarkdown, fetchMarkdown, type ClipboardEnv } from "@/lib/copy-markdown";

const WORDS = {
  ar: { copy: "نسخ الصفحة بصيغة Markdown", busy: "جارٍ النسخ…", copied: "نُسخت الصفحة بصيغة Markdown", failed: "تعذّر النسخ.", open: "افتح ملف Markdown", opens: "(يفتح في تبويب جديد)" },
  en: { copy: "Copy page as Markdown", busy: "Copying…", copied: "Page copied as Markdown", failed: "Could not copy.", open: "Open the Markdown file", opens: "(opens in a new tab)" },
} as const;

/** How long "copied" stays before the button reads its name again. */
export const COPIED_MS = 2000;

/**
 * "Copy page as Markdown" (rule 3317) on a post and a help topic. `href` is the page's own Markdown copy (rule 3316, same
 * origin, public). The text is fetched when the button is pressed, not shipped with the page, so a page that nobody copies
 * pays nothing. It is a real `<button>`, so Enter and Space work, and the result is said in a polite status, not only shown
 * by the icon. Where the browser refuses every way to copy (no clipboard API, not a secure context, offline), the status says
 * so and a link to the file appears instead, so the reader still gets the text. Without script, the link in `<noscript>`
 * does the same. `lang` is the language of the page around the button, not of the text.
 */
export default function CopyMarkdownButton({ href, lang, className = "" }: { href: string; lang: Lang; className?: string }) {
  const W = WORDS[lang];
  const [state, setState] = useState<"idle" | "busy" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    if (state === "busy") return;
    setState("busy");
    const ok = await copyMarkdown(() => fetchMarkdown(href), {
      clipboard: typeof navigator === "undefined" ? undefined : (navigator.clipboard as ClipboardEnv["clipboard"]),
      ClipboardItem: typeof ClipboardItem === "undefined" ? undefined : (ClipboardItem as unknown as new (i: Record<string, Promise<Blob>>) => unknown),
      document,
    });
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    // A failure stays: the link below it is how the reader gets the text.
    if (ok) timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  }
  const said = state === "busy" ? W.busy : state === "copied" ? W.copied : state === "failed" ? W.failed : "";
  return (
    <div dir={lang === "ar" ? "rtl" : "ltr"} lang={lang} className={`flex flex-wrap items-center gap-3 ${className}`} data-testid="copy-markdown">
      <button type="button" onClick={copy} aria-busy={state === "busy"} className="btn btn-secondary btn-xs">
        <Icon name={state === "copied" ? "check" : "copy"} className="h-3.5 w-3.5" />
        {state === "copied" ? W.copied : W.copy}
      </button>
      {state === "failed" && (
        <>
          <span className="text-xs text-foreground-muted" aria-hidden="true">{W.failed}</span>
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-xs font-bold underline">{W.open}<span className="sr-only"> {W.opens}</span></a>
        </>
      )}
      <span role="status" className="sr-only">{said}</span>
      <noscript><a href={href} className="text-xs font-bold underline">{W.open}</a></noscript>
    </div>
  );
}
