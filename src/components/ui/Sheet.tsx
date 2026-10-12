"use client";
import { useEffect, useId, useRef } from "react";

type Lang = "ar" | "en";
const CLOSE = { ar: "إغلاق", en: "Close" } as const;

/**
 * A panel that slides in from an edge (rule 1111): the phone's navigation drawer, a filter panel, a bottom sheet. It is a
 * native `<dialog>` opened with `showModal()`, like `Dialog`, so the browser traps focus inside it, makes the page behind
 * inert and closes it on Escape. Render it only while open: mounting opens it and unmounting gives focus back to whatever
 * opened it. `side` is logical: "start" is the right edge in Arabic and the left in English. A click on the backdrop
 * closes it (unlike a dialog that asks a question, a sheet holds nothing that a stray click can lose); a press that began
 * inside and ended outside does not. The page behind does not scroll while it is open. The close button is 44px and last
 * in the order, so focus starts on the first link, not on close.
 */
export default function Sheet({ lang, label, onClose, side = "start", size = "sm", className = "", children }: {
  lang: Lang;
  /** The sheet's accessible name ("Menu"). */
  label: string;
  onClose: () => void;
  side?: "start" | "end" | "bottom";
  /** "lg" (rule 1180): a detail panel, up to 48rem wide and never wider than the screen less a 1rem gutter. */
  size?: "sm" | "lg";
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const downOnBackdrop = useRef(false);
  const id = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const d = ref.current;
    if (d && !d.open) d.showModal();
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = before;
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  const place = side === "bottom"
    ? "mx-0 mb-0 mt-auto max-h-[85dvh] w-full max-w-none rounded-t-2xl border-t-[1.5px] pb-[env(safe-area-inset-bottom)]"
    : `my-0 h-dvh max-h-none ${size === "lg" ? "w-[min(48rem,calc(100%-1rem))]" : "w-[min(20rem,calc(100%-3rem))]"} max-w-none ${side === "start" ? "ms-0 me-auto border-e-[1.5px]" : "ms-auto me-0 border-s-[1.5px]"}`;
  return (
    <dialog
      ref={ref}
      id={id}
      aria-label={label}
      onClose={onClose}
      // The backdrop is the dialog element itself: a press that starts and ends on it closes the sheet.
      onPointerDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (downOnBackdrop.current && e.target === e.currentTarget) ref.current?.close(); downOnBackdrop.current = false; }}
      className={`sheet sheet-${side} border-border-strong bg-surface p-0 text-foreground backdrop:bg-overlay ${place} ${className}`}
    >
      <div className="relative h-full overflow-y-auto overscroll-contain">
        {children}
        <button type="button" onClick={() => ref.current?.close()} aria-label={CLOSE[lang]} className="icon-btn absolute end-2 top-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="h-5 w-5" aria-hidden><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>
    </dialog>
  );
}
