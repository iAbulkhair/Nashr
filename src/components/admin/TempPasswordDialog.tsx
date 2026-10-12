"use client";
import { useEffect, useId, useRef, useState } from "react";

const T = {
  en: { title: "Temporary password", body: "Shown once. Copy it and send it to the account owner on WhatsApp; it is gone when you close this.", copy: "Copy", copied: "Copied", done: "Done" },
  ar: { title: "كلمة مرور مؤقتة", body: "تظهر مرة واحدة. انسخها وأرسلها لصاحب الحساب على واتساب؛ تختفي عند إغلاق هذه النافذة.", copy: "انسخ", copied: "نُسخت", done: "تم" },
} as const;

/**
 * The temporary password from "Reset password" (rule 960), in the console's own modal instead of `window.prompt`: the
 * browser's prompt put it in an editable text box with Cancel and OK, in the browser's language, and nothing said it
 * would not be shown again. Here it is read-only, copied with one button, and the parent drops it from state on close
 * (`onClose`), so it cannot be opened a second time. A native `<dialog>` with `showModal()` traps focus and closes on Escape.
 */
export default function TempPasswordDialog({ lang, email, password, onClose }: { lang: "en" | "ar"; email: string; password: string; onClose: () => void }) {
  const S = T[lang];
  const ref = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <dialog ref={ref} aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} onClose={onClose} className="card m-auto w-[calc(100%-2rem)] max-w-md p-0 text-foreground backdrop:bg-overlay">
      <div className="p-6 text-start">
        <h2 id={`${id}-title`} className="font-display text-lg font-bold">{S.title}</h2>
        <p className="mt-1 text-sm text-foreground-muted" dir="ltr">{email}</p>
        <p id={`${id}-body`} className="mt-3 text-sm leading-relaxed text-foreground-muted">{S.body}</p>
        <div className="mt-4 flex items-center gap-2">
          <code className="flex-1 select-all rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm" dir="ltr" data-testid="temp-password">{password}</code>
          <button type="button" onClick={copy} className="btn btn-secondary btn-sm">{copied ? S.copied : S.copy}</button>
        </div>
        <p role="status" className="sr-only">{copied ? S.copied : ""}</p>
        <div className="mt-6 flex justify-end">
          <button type="button" onClick={() => ref.current?.close()} className="btn btn-primary btn-sm">{S.done}</button>
        </div>
      </div>
    </dialog>
  );
}
