"use client";
import { useRef, useState } from "react";
import type { Lang } from "@/lib/i18n";
import PasswordField from "./PasswordField";
import Button from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";

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
 * typed. DELETE /api/account still checks the password and the role in code; this dialog only asks. It is the shared
 * `Dialog` (rule 1089) as an alert dialog: focus starts on the email field, never on the delete button, and returns to
 * the button that opened it. While the delete runs the button shows it is busy (rule 1082) and Escape waits.
 * `failText` gives the message for a refusal other than a wrong password, which is shown inside the dialog.
 */
export default function DeleteAccountDialog({ lang, email, onClose, onDeleted, failText }: { lang: Lang; email: string; onClose: () => void; onDeleted: () => void; failText: (status: number) => string }) {
  const S = DELETE_ACCOUNT_TEXT[lang];
  const form = useRef<HTMLFormElement>(null);
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ready = emailMatches(typed, email) && password.length > 0;
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setErr("");
    const res = await fetch("/api/account", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }).catch(() => null);
    setBusy(false);
    if (res?.ok) { setPassword(""); onDeleted(); return; }
    setErr(res?.status === 401 ? S.wrongPassword : failText(res?.status ?? 0));
  }
  return (
    <Dialog lang={lang} role="alertdialog" title={S.title} onClose={onClose} blockClose={busy} description={
      <>
        <p>{S.lead}</p>
        <ul className="mt-2 list-disc space-y-1 ps-5">{S.lose.map((l) => <li key={l}>{l}</li>)}</ul>
      </>
    }>
      <form ref={form} onSubmit={submit} className="grid gap-4">
        <Field label={<>{S.typeEmail} <bdi className="font-mono text-xs text-foreground-muted" dir="ltr">{email}</bdi></>}>
          <Input type="email" autoFocus autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
        <Field label={S.password}>
          <PasswordField lang={lang} name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {err && <p role="alert" className="field-error">{err}</p>}
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => form.current?.closest("dialog")?.close()}>{S.cancel}</Button>
          <Button type="submit" variant="danger-solid" size="sm" disabled={!ready} loading={busy}>{S.confirm}</Button>
        </div>
      </form>
    </Dialog>
  );
}
