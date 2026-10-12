"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";

/** What one question shows. Every label comes from the caller's dictionary, so the dialog speaks the page's language. */
export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Deletes, removes or undoes something: the confirm button is the solid danger one and focus starts on cancel. */
  destructive?: boolean;
  /**
   * The action itself, run by the dialog after a yes (rule 1110): the confirm button turns busy, cancel and Escape wait,
   * and the dialog stays open until it settles. It returns nothing when done (the question then answers yes) or the words
   * of a refusal, which show inside the dialog under the message so the person can try again or go back. Left out, the
   * dialog only answers and the panel runs the action behind its own busy state, as before.
   */
  run?: () => Promise<string | null | void>;
  /** Replaces the confirm label while `run` works ("Deleting…"). */
  busyLabel?: string;
  /** Shown when `run` throws (a dropped connection): the caller's words for "could not finish, try again". */
  failLabel?: string;
};

/**
 * The answer bookkeeping, kept apart from React so a test can drive it. One question is open at a time: asking again
 * while one is open (a second click on the button that asked, before the dialog showed) answers the new question no at
 * once and shows nothing, so one click path can never run its action twice. `answer` settles the open question; any
 * later answer before the next question does nothing. `show(n)` receives the question's number, which keys the dialog.
 */
export function confirmGate() {
  let waiting: ((ok: boolean) => void) | null = null;
  let asked = 0;
  return {
    ask(show: (n: number) => void): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        if (waiting) { resolve(false); return; }
        waiting = resolve;
        asked += 1;
        show(asked);
      });
    },
    answer(ok: boolean): void {
      const resolve = waiting;
      waiting = null;
      resolve?.(ok);
    },
  };
}

/**
 * One confirmation on a native `<dialog>` opened with `showModal()`: the browser traps focus inside it, makes the page
 * behind it inert and closes it on Escape. Escape and the cancel button answer no; the confirm button answers yes. The
 * answer is given once: the first click marks it in a ref before React re-renders and disables the confirm button, and
 * every later close (the `close` event that `dialog.close()` itself fires included) is ignored.
 * supastarter's alert awaited the action inside the dialog with its button still live, so a double click ran it twice;
 * this dialog only answers, and the panel runs the action behind its own busy state.
 *
 * A click outside the box does nothing, as with the browser's own confirm. The dialog opens within the first click on
 * the button that asked, so the second click of a double click lands on the backdrop, which the browser reports as a
 * click on the `<dialog>` itself; so does a text selection in the message released outside the box. Either would answer
 * no before the person read the question. For the same reason a click the browser counts as the second or later of a
 * multi-click (`detail > 1`) is ignored on the two buttons too: it began on the page behind, not in this dialog.
 * Keyboard activation reports `detail` 0 and a first click 1, so neither is affected.
 */
function ConfirmDialog({ title, message, confirmLabel, cancelLabel, destructive = false, run, busyLabel, failLabel, onAnswer }: ConfirmOptions & { onAnswer: (ok: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const answered = useRef(false);
  const [sent, setSent] = useState(false);
  // While `run` works: the confirm button says so and every way out waits (rule 1110).
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState("");
  const id = useId();
  useEffect(() => {
    // Focus goes back to whatever asked when the dialog goes, so a keyboard user keeps their place (rule 1110).
    const opener = document.activeElement as HTMLElement | null;
    const d = ref.current;
    if (d && !d.open) d.showModal();
    // The least harmful choice takes focus first, so Enter on a destructive question answers no.
    (destructive ? cancelRef : okRef).current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, [destructive]);
  function answer(ok: boolean) {
    if (answered.current) return;
    answered.current = true;
    setSent(true);
    if (ok && run) { void work(run); return; }
    if (ref.current?.open) ref.current.close();
    onAnswer(ok);
  }
  /** Runs the action inside the dialog; a refusal opens the question again, a success closes it with a yes. */
  async function work(action: () => Promise<string | null | void>) {
    setBusy(true); setRefusal("");
    let refused: string | null | void = null;
    try { refused = await action(); } catch { refused = failLabel ?? "…"; } finally { setBusy(false); }
    if (refused) { setRefusal(refused); answered.current = false; setSent(false); okRef.current?.focus(); return; }
    if (ref.current?.open) ref.current.close();
    onAnswer(true);
  }
  function press(e: React.MouseEvent, ok: boolean) {
    if (e.detail <= 1) answer(ok);
  }
  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-message`}
      aria-busy={busy || undefined}
      // Escape closes the dialog; so does `close()` after an answer, which the ref above then ignores. While the action
      // runs, Escape waits: the request is on its way and its answer belongs in this dialog.
      onCancel={(e) => { if (busy) e.preventDefault(); }}
      onClose={() => answer(false)}
      className="card m-auto w-[calc(100%-2rem)] max-w-md p-0 text-ink backdrop:bg-overlay"
    >
      <div className="p-6 text-start">
        {/* A name or a file name typed by someone else keeps its own direction inside the page's. */}
        <h2 id={`${id}-title`} className="font-display text-lg font-bold"><bdi>{title}</bdi></h2>
        <p id={`${id}-message`} className="mt-2 text-sm leading-relaxed text-ink/80">{message}</p>
        {refusal && <p role="alert" className="field-error mt-3" dir="auto">{refusal}</p>}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button ref={cancelRef} type="button" onClick={(e) => press(e, false)} disabled={busy} className="btn btn-secondary btn-sm">{cancelLabel}</button>
          <button ref={okRef} type="button" onClick={(e) => press(e, true)} disabled={sent} aria-busy={busy || undefined} className={`btn btn-sm ${destructive ? "btn-danger-solid" : "btn-primary"}`}>
            {busy && <svg viewBox="0 0 24 24" fill="none" aria-hidden className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" /><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>}
            {busy && busyLabel ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/**
 * `const [ask, confirmDialog] = useConfirm()`: render `confirmDialog` once in the panel, outside any disabled fieldset
 * (its disabled state would reach the dialog's buttons), then write `if (!(await ask({...}))) return;` where the
 * browser's confirm used to be. A question still open when the panel unmounts is never answered, so its action never runs.
 * With `run`, the answer is yes only once the action finished; a refusal stays in the dialog (rule 1110).
 */
export function useConfirm(): [(opts: ConfirmOptions) => Promise<boolean>, React.ReactNode] {
  const [gate] = useState(confirmGate);
  const [open, setOpen] = useState<(ConfirmOptions & { n: number }) | null>(null);
  const ask = useCallback((opts: ConfirmOptions) => gate.ask((n) => setOpen({ ...opts, n })), [gate]);
  const answer = useCallback((ok: boolean) => {
    setOpen(null);
    gate.answer(ok);
  }, [gate]);
  const dialog = open ? (
    <ConfirmDialog key={open.n} title={open.title} message={open.message} confirmLabel={open.confirmLabel} cancelLabel={open.cancelLabel} destructive={open.destructive} run={open.run} busyLabel={open.busyLabel} failLabel={open.failLabel} onAnswer={answer} />
  ) : null;
  return [ask, dialog];
}
