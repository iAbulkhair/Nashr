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
function ConfirmDialog({ title, message, confirmLabel, cancelLabel, destructive = false, onAnswer }: ConfirmOptions & { onAnswer: (ok: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const answered = useRef(false);
  const [sent, setSent] = useState(false);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    // The least harmful choice takes focus first, so Enter on a destructive question answers no.
    (destructive ? cancelRef : okRef).current?.focus();
  }, [destructive]);
  function answer(ok: boolean) {
    if (answered.current) return;
    answered.current = true;
    setSent(true);
    if (ref.current?.open) ref.current.close();
    onAnswer(ok);
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
      // Escape closes the dialog; so does `close()` after an answer, which the ref above then ignores.
      onClose={() => answer(false)}
      className="card m-auto w-[calc(100%-2rem)] max-w-md p-0 text-ink backdrop:bg-ink/40"
    >
      <div className="p-6 text-start">
        {/* A name or a file name typed by someone else keeps its own direction inside the page's. */}
        <h2 id={`${id}-title`} className="font-display text-lg font-bold"><bdi>{title}</bdi></h2>
        <p id={`${id}-message`} className="mt-2 text-sm leading-relaxed text-ink/80">{message}</p>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button ref={cancelRef} type="button" onClick={(e) => press(e, false)} className="btn btn-secondary btn-sm">{cancelLabel}</button>
          <button ref={okRef} type="button" onClick={(e) => press(e, true)} disabled={sent} className={`btn btn-sm ${destructive ? "btn-danger-solid" : "btn-primary"}`}>{confirmLabel}</button>
        </div>
      </div>
    </dialog>
  );
}

/**
 * `const [ask, confirmDialog] = useConfirm()`: render `confirmDialog` once in the panel, outside any disabled fieldset
 * (its disabled state would reach the dialog's buttons), then write `if (!(await ask({...}))) return;` where the
 * browser's confirm used to be. A question still open when the panel unmounts is never answered, so its action never runs.
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
    <ConfirmDialog key={open.n} title={open.title} message={open.message} confirmLabel={open.confirmLabel} cancelLabel={open.cancelLabel} destructive={open.destructive} onAnswer={answer} />
  ) : null;
  return [ask, dialog];
}
