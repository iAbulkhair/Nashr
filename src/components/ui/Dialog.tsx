"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Button from "./Button";
import { Field, Input } from "./Field";

type Lang = "ar" | "en";
const CLOSE = { ar: "إغلاق", en: "Close" } as const;

/**
 * A modal on a native `<dialog>` opened with `showModal()` (rule 1089), like `ConfirmDialog`: the browser traps focus
 * inside it, makes the page behind it inert and closes it on Escape. It is named by its title and described by
 * `description`. Focus goes back to whatever opened it when it closes, so a keyboard user keeps their place. A click on
 * the backdrop does nothing (the second click of a double click lands there). `onClose` runs on Escape, on the close
 * button and on `close()`; `blockClose` keeps it open while a request is on its way.
 */
export function Dialog({ lang, title, description, onClose, blockClose = false, role = "dialog", className = "max-w-md", children }: {
  lang: Lang;
  title: React.ReactNode;
  description?: React.ReactNode;
  onClose: () => void;
  blockClose?: boolean;
  role?: "dialog" | "alertdialog";
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  return (
    <dialog
      ref={ref}
      role={role}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-desc` : undefined}
      onCancel={(e) => { if (blockClose) e.preventDefault(); }}
      onClose={onClose}
      className={`card m-auto w-[calc(100%-2rem)] p-0 text-foreground backdrop:bg-overlay ${className}`}
    >
      <div className="p-6 text-start">
        <h2 id={`${id}-title`} className="pe-10 font-display text-lg font-bold"><bdi>{title}</bdi></h2>
        {description && <div id={`${id}-desc`} className="mt-2 text-sm leading-relaxed text-foreground-muted">{description}</div>}
        <div className="mt-4">{children}</div>
      </div>
      {/* Last in the order, so `showModal()` puts focus on the first field, not on close; drawn at the top inline end. */}
      <button type="button" onClick={() => { if (!blockClose) ref.current?.close(); }} aria-label={CLOSE[lang]} className="absolute end-2 top-2 grid h-11 w-11 place-items-center rounded-full text-foreground-muted hover:text-foreground">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="h-4 w-4" aria-hidden><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </dialog>
  );
}

/**
 * A form in a dialog (rule 1089): the fields, one error line, cancel and a submit that shows it is working. `onSubmit`
 * gets the form's data and returns nothing when it is done (the dialog closes) or the words of the refusal, which show
 * inside the dialog. While it runs, the submit is busy and Escape and the close button wait. The caller's route still
 * checks everything; this only asks. `submitReady={false}` (rule 1176: a type-to-confirm field not matched yet) keeps
 * the submit focusable but `aria-disabled`, and a submit then sends nothing.
 */
export function FormDialog({ lang, title, description, submitLabel, cancelLabel, busyLabel, destructive = false, submitReady = true, role, onSubmit, onClose, children, className }: {
  lang: Lang;
  title: React.ReactNode;
  description?: React.ReactNode;
  submitLabel: string;
  cancelLabel: string;
  busyLabel?: string;
  destructive?: boolean;
  submitReady?: boolean;
  /** "alertdialog" for a change that removes or pays out money (rule 1102). */
  role?: "dialog" | "alertdialog";
  onSubmit: (data: FormData) => Promise<string | null | void>;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const form = useRef<HTMLFormElement>(null);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !submitReady) return;
    setBusy(true); setErr("");
    let refused: string | null | void = null;
    try {
      refused = await onSubmit(new FormData(e.currentTarget));
    } finally {
      setBusy(false);
    }
    if (refused) { setErr(refused); return; }
    form.current?.closest("dialog")?.close();
  }
  return (
    <Dialog lang={lang} title={title} description={description} onClose={onClose} blockClose={busy} role={role} className={className}>
      <form ref={form} onSubmit={submit} className="grid gap-4">
        {children}
        {err && <p role="alert" className="field-error">{err}</p>}
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => form.current?.closest("dialog")?.close()}>{cancelLabel}</Button>
          <Button type="submit" variant={destructive ? "danger-solid" : "primary"} size="sm" loading={busy} loadingText={busyLabel} aria-disabled={submitReady ? undefined : true}>{submitLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** What one prompt asks. Every word comes from the caller's dictionary. */
export type PromptOptions = { title: string; label: string; initial?: string; submitLabel: string; cancelLabel: string; maxLength?: number; required?: boolean };

/**
 * The answer bookkeeping for `usePrompt`, kept apart from React so a test can drive it: one question at a time, a second
 * ask while one is open answers null at once, and only the first answer counts.
 */
export function promptGate() {
  let waiting: ((v: string | null) => void) | null = null;
  let asked = 0;
  return {
    ask(show: (n: number) => void): Promise<string | null> {
      return new Promise((resolve) => {
        if (waiting) { resolve(null); return; }
        waiting = resolve;
        asked += 1;
        show(asked);
      });
    },
    answer(v: string | null): void {
      const resolve = waiting;
      waiting = null;
      resolve?.(v);
    },
  };
}

/**
 * `const [ask, promptDialog] = usePrompt(lang)` where `window.prompt` used to be: `const name = await ask({...})` gives
 * the trimmed text, or null on cancel. Unlike the browser's prompt it speaks the page's language, has a visible label
 * and keeps the page's look. Render `promptDialog` once in the panel.
 */
export function usePrompt(lang: Lang): [(opts: PromptOptions) => Promise<string | null>, React.ReactNode] {
  const [gate] = useState(promptGate);
  const [open, setOpen] = useState<(PromptOptions & { n: number }) | null>(null);
  const answered = useRef(false);
  const ask = useCallback((opts: PromptOptions) => gate.ask((n) => { answered.current = false; setOpen({ ...opts, n }); }), [gate]);
  const settle = useCallback((v: string | null) => {
    if (answered.current) return;
    answered.current = true;
    setOpen(null);
    gate.answer(v);
  }, [gate]);
  const dialog = open ? (
    <FormDialog
      key={open.n}
      lang={lang}
      title={open.title}
      submitLabel={open.submitLabel}
      cancelLabel={open.cancelLabel}
      onSubmit={async (data) => { settle(String(data.get("value") ?? "").trim()); }}
      onClose={() => settle(null)}
    >
      <Field label={open.label} required={open.required ?? true}>
        <Input name="value" defaultValue={open.initial ?? ""} maxLength={open.maxLength} autoFocus autoComplete="off" />
      </Field>
    </FormDialog>
  ) : null;
  return [ask, dialog];
}
