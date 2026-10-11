"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/app/Icons";

type Lang = "ar" | "en";
const WORDS = {
  ar: { copy: "انسخ", copied: "نُسخ", failed: "تعذّر النسخ" },
  en: { copy: "Copy", copied: "Copied", failed: "Could not copy" },
} as const;

/** How long "Copied" stays before the button reads Copy again. */
export const COPIED_MS = 1500;

/**
 * Copies `text` to the clipboard (rule 1117). The result is said, not only shown: a polite status reads "Copied" (or that
 * copying failed, where the browser refuses the clipboard), and the icon changes to a check. `label` names what is copied
 * ("Copy reply"); with `iconOnly` it is the button's accessible name and tooltip and the button is a 44px icon target on
 * touch screens.
 */
export default function CopyButton({ text, lang, label, iconOnly = false, className = "" }: { text: string; lang: Lang; label?: string; iconOnly?: boolean; className?: string }) {
  const W = WORDS[lang];
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setState("copied"); }
    catch { setState("failed"); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  }
  const name = label ?? W.copy;
  const said = state === "copied" ? W.copied : state === "failed" ? W.failed : "";
  return (
    <>
      <button type="button" onClick={copy} aria-label={iconOnly ? name : undefined} title={iconOnly ? name : undefined} className={iconOnly ? `icon-btn ${className}` : `btn btn-secondary btn-xs ${className}`}>
        <Icon name={state === "copied" ? "check" : "copy"} className={iconOnly ? "h-4 w-4" : "h-3.5 w-3.5"} />
        {!iconOnly && (said || name)}
      </button>
      <span role="status" className="sr-only">{said}</span>
    </>
  );
}
