"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { Lang } from "@/lib/i18n";
import PasswordField from "./PasswordField";

export const DELETE_ACCOUNT_TEXT = {
  ar: {
    title: "حذف الحساب نهائياً",
    lead: "سيُحذف ما يلي ولا يمكن استرجاعه:",
    lose: ["كل علاماتك وملفاتها ومحادثاتها ومسوداتها وروابط المنصات", "دخول كل أعضاء فريقك ودعواتهم المعلقة", "رصيدك من الكريدت"],
    typeEmail: "للتأكيد اكتب بريدك الإلكتروني",
    password: "كلمة المرور",
    cancel: "تراجع",
    confirm: "احذف حسابي نهائياً",
    wrongPassword: "كلمة المرور غير صحيحة",
  },
  en: {
    title: "Delete your account for good",
    lead: "This deletes the following, and it cannot be undone:",
    lose: ["Every brand with its files, conversations, drafts and platform connections", "Every team member's login and pending invite", "Your credit balance"],
    typeEmail: "To confirm, type your email address",
    password: "Password",
    cancel: "Go back",
    confirm: "Delete my account for good",
    wrongPassword: "Wrong password",
  },
} as const;

/** The typed address matches the account's, ignoring case and outer spaces (rule 964). */
export const emailMatches = (typed: string, email: string) => typed.trim().toLowerCase() === email.trim().toLowerCase();

/**
 * Deleting the account (rule 964), in the app's own modal instead of `window.prompt`: the browser's prompt showed the
 * password as plain text, in the browser's language, and said nothing of what goes with the account. Here the password is
 * masked (`PasswordField`), the list says what is lost, and the delete button stays off until the account's own email is
 * typed. DELETE /api/account still checks the password and the role in code; this dialog only asks. A native `<dialog>`
 * with `showModal()` traps focus and closes on Escape; focus starts on the email field, never on the delete button.
 * `failText` gives the message for a refusal other than a wrong password, which is shown inside the dialog.
 */
export default function DeleteAccountDialog({ lang, email, onClose, onDeleted, failText }: { lang: Lang; email: string; onClose: () => void; onDeleted: () => void; failText: (status: number) => string }) {
  const S = DELETE_ACCOUNT_TEXT[lang];
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const ready = emailMatches(typed, email) && password.length > 0 && !busy;
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setErr("");
    const res = await fetch("/api/account", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }).catch(() => null);
    setBusy(false);
    if (res?.ok) { setPassword(""); onDeleted(); return; }
    setErr(res?.status === 401 ? S.wrongPassword : failText(res?.status ?? 0));
  }
  return (
    <dialog ref={ref} role="alertdialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-lead`} onClose={onClose} className="card m-auto w-[calc(100%-2rem)] max-w-md p-0 text-ink backdrop:bg-ink/40">
      <form onSubmit={submit} className="grid gap-4 p-6 text-start">
        <h2 id={`${id}-title`} className="font-display text-lg font-bold">{S.title}</h2>
        <div>
          <p id={`${id}-lead`} className="text-sm text-ink/80">{S.lead}</p>
          <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-ink/80">{S.lose.map((l) => <li key={l}>{l}</li>)}</ul>
        </div>
        <div>
          <label htmlFor={`${id}-email`} className="text-sm font-medium">{S.typeEmail} <bdi className="font-mono text-xs text-muted" dir="ltr">{email}</bdi></label>
          <input id={`${id}-email`} type="email" dir="ltr" autoFocus autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} className="input mt-1" />
        </div>
        <div>
          <label htmlFor={`${id}-password`} className="text-sm font-medium">{S.password}</label>
          <div className="mt-1"><PasswordField lang={lang} id={`${id}-password`} name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        </div>
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" onClick={() => ref.current?.close()} className="btn btn-secondary btn-sm">{S.cancel}</button>
          <button type="submit" disabled={!ready} className="btn btn-danger-solid btn-sm">{S.confirm}</button>
        </div>
      </form>
    </dialog>
  );
}
