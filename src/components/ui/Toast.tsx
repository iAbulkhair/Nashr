"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";

export type ToastTone = "success" | "info" | "warning" | "danger";
export type ToastItem = { id: number; tone: ToastTone; text: string };

/** How long a toast stays: long enough to read two lines; a danger one a little longer. */
export const TOAST_MS: Record<ToastTone, number> = { success: 5000, info: 5000, warning: 7000, danger: 8000 };

/**
 * The list of toasts, kept apart from React so a test can drive it. At most `max` show; a new one pushes the oldest out,
 * so a burst of saves never stacks up the screen. The same words twice in a row replace the first toast instead of
 * adding a second.
 */
export function toastStore(max = 3) {
  let items: ToastItem[] = [];
  let n = 0;
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((f) => f());
  return {
    push(tone: ToastTone, text: string): number {
      n += 1;
      const rest = items.filter((t) => !(t.text === text && t.tone === tone));
      items = [...rest, { id: n, tone, text }].slice(-max);
      emit();
      return n;
    },
    dismiss(id: number): void {
      const next = items.filter((t) => t.id !== id);
      if (next.length !== items.length) { items = next; emit(); }
    },
    list: (): ToastItem[] => items,
    subscribe(f: () => void): () => void {
      subs.add(f);
      return () => { subs.delete(f); };
    },
  };
}

export type Toaster = {
  success: (text: string) => void;
  info: (text: string) => void;
  warning: (text: string) => void;
  danger: (text: string) => void;
  /** Says `done` when the work succeeds and `failed` (or the error's own words from `failed(e)`) when it throws; returns the work's result. */
  promise: <T>(work: Promise<T>, words: { done: string; failed: string | ((e: unknown) => string) }) => Promise<T>;
};

const noop = () => {};
/** Outside a provider (a test rendering one panel, a page outside the app layout) every call does nothing. */
const SILENT: Toaster = { success: noop, info: noop, warning: noop, danger: noop, promise: (work) => work };

const Ctx = createContext<Toaster>(SILENT);

/** `const toast = useToast(); toast.success(t.saved)`. Errors a person must act on stay inline next to the field. */
export function useToast(): Toaster {
  return useContext(Ctx);
}

// The server renders no toasts. One shared empty list: React compares snapshots by identity, and a new array on each
// call would loop.
const NONE: ToastItem[] = [];
const serverList = () => NONE;

const CLOSE = { ar: "إغلاق الإشعار", en: "Dismiss notification" } as const;
const REGION = { ar: "الإشعارات", en: "Notifications" } as const;

const TONE_CLASS: Record<ToastTone, string> = {
  success: "border-success",
  info: "border-ink",
  warning: "border-warning",
  danger: "border-danger",
};

function ToastView({ item, lang, onClose }: { item: ToastItem; lang: "ar" | "en"; onClose: (id: number) => void }) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return;
    const t = setTimeout(() => onClose(item.id), TOAST_MS[item.tone]);
    return () => clearTimeout(t);
  }, [held, item.id, item.tone, onClose]);
  return (
    <li
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className={`pointer-events-auto flex items-start gap-3 rounded-lg border-[1.5px] border-s-4 bg-popover px-4 py-3 text-sm text-ink ${TONE_CLASS[item.tone]}`}
    >
      <p dir="auto" className="min-w-0 flex-1 leading-relaxed">{item.text}</p>
      <button type="button" onClick={() => onClose(item.id)} aria-label={CLOSE[lang]} className="-my-2 -me-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-foreground-muted hover:text-ink">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="h-4 w-4" aria-hidden><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </li>
  );
}

/**
 * Toasts for the app (rule 1088): a polite live region at the bottom, inline end (bottom left in Arabic, bottom right in
 * English), full width on a phone. The region is always in the page, so a screen reader hears each toast as it is added.
 * A toast leaves after `TOAST_MS`, waits while the pointer or focus is on it, and has a 44px close button. Mounted once
 * in the app layout, so every panel under it can call `useToast()`.
 */
export function ToastProvider({ lang, children }: { lang: "ar" | "en"; children: React.ReactNode }) {
  const [store] = useState(() => toastStore());
  const items = useSyncExternalStore(store.subscribe, store.list, serverList);
  const toaster = useMemo<Toaster>(() => ({
    success: (text) => { store.push("success", text); },
    info: (text) => { store.push("info", text); },
    warning: (text) => { store.push("warning", text); },
    danger: (text) => { store.push("danger", text); },
    promise: async (work, words) => {
      try {
        const v = await work;
        store.push("success", words.done);
        return v;
      } catch (e) {
        store.push("danger", typeof words.failed === "function" ? words.failed(e) : words.failed);
        throw e;
      }
    },
  }), [store]);
  const close = useCallback((id: number) => store.dismiss(id), [store]);
  return (
    <Ctx.Provider value={toaster}>
      {children}
      <section aria-label={REGION[lang]} className="pointer-events-none fixed inset-x-4 bottom-4 z-[70] sm:inset-x-auto sm:end-6 sm:bottom-6 sm:w-96">
        <div role="status" aria-live="polite">
          <ol className="grid gap-2">
            {items.map((t) => <ToastView key={t.id} item={t} lang={lang} onClose={close} />)}
          </ol>
        </div>
      </section>
    </Ctx.Provider>
  );
}
