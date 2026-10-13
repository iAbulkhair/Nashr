"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminFetch } from "@/lib/admin-fetch";
import { FormDialog } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import Button from "@/components/ui/Button";
import { SW, staffError, type Lang } from "@/lib/staff-words";

const post = (body: Record<string, unknown>) =>
  adminFetch("/api/admin/staff/me", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/**
 * The staff member's own account page: change the password (the current one, the policy, a new authenticator code;
 * every other session ends), new recovery codes (shown once), and sign out.
 */
export default function StaffAccount({ lang, email, name, recoveryLeft }: { lang: Lang; email: string; name: string; recoveryLeft: number }) {
  const S = SW[lang];
  const router = useRouter();
  const [open, setOpen] = useState<"password" | "recovery" | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [left, setLeft] = useState(recoveryLeft);
  const [note, setNote] = useState("");

  async function change(data: FormData): Promise<string | null> {
    const v = (k: string) => String(data.get(k) ?? "");
    if (v("password") !== v("repeat")) return S.mismatch;
    const r = await post({ action: "password", current: v("current"), password: v("password"), code: v("code").trim() });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!j.ok) return r.status === 429 ? staffError(lang, "slow_down") : staffError(lang, j.error);
    setNote(S.changed);
    return null;
  }

  async function regenerate(data: FormData): Promise<string | null> {
    const r = await post({ action: "recovery", code: String(data.get("code") ?? "").trim() });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; recovery?: string[] };
    if (!j.ok || !Array.isArray(j.recovery)) return r.status === 429 ? staffError(lang, "slow_down") : staffError(lang, j.error);
    setCodes(j.recovery);
    setLeft(j.recovery.length);
    return null;
  }

  async function signOut() {
    await adminFetch("/api/admin/staff/login", { method: "DELETE" }).catch(() => null);
    router.push(`/${lang}/admin/login`);
    router.refresh();
  }

  return (
    <section className="grid max-w-xl gap-4">
      <div className="grid gap-1">
        <h1 className="font-display text-2xl font-bold">{S.accountTitle}</h1>
        <p className="text-sm text-foreground-muted">{S.accountNote}</p>
      </div>
      <div className="card grid gap-1 text-sm">
        <p className="font-semibold">{name}</p>
        <p dir="ltr" className="text-foreground-muted">{email}</p>
        <p>{S.left}: <span className="tnum" dir="ltr">{left}</span></p>
      </div>
      {note && <p role="status" className="text-sm">{note}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => { setNote(""); setOpen("password"); }}>{S.changePassword}</Button>
        <Button size="sm" variant="secondary" onClick={() => { setNote(""); setOpen("recovery"); }}>{S.newCodes}</Button>
        <Button size="sm" variant="secondary" onClick={() => void signOut()}>{S.signOut}</Button>
      </div>
      {open === "password" && (
        <FormDialog lang={lang} title={S.changePassword} submitLabel={S.go} cancelLabel={S.cancel} busyLabel={S.busy} onSubmit={change} onClose={() => setOpen(null)}>
          <Field label={S.current}><Input name="current" type="password" autoComplete="current-password" dir="ltr" required /></Field>
          <Field label={S.newPassword} hint={S.passwordHint}><Input name="password" type="password" autoComplete="new-password" dir="ltr" minLength={12} maxLength={128} required /></Field>
          <Field label={S.repeat}><Input name="repeat" type="password" autoComplete="new-password" dir="ltr" maxLength={128} required /></Field>
          <Field label={S.freshCode}><Input name="code" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} required /></Field>
        </FormDialog>
      )}
      {open === "recovery" && !codes && (
        <FormDialog lang={lang} title={S.newCodes} description={S.newCodesNote} role="alertdialog" submitLabel={S.go} cancelLabel={S.cancel} busyLabel={S.busy} onSubmit={regenerate} onClose={() => { if (!codes) setOpen(null); }}>
          <Field label={S.freshCode}><Input name="code" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} required /></Field>
        </FormDialog>
      )}
      {codes && (
        <FormDialog lang={lang} title={S.saveTitle} role="alertdialog" submitLabel={S.saved} cancelLabel={S.cancel} onSubmit={async () => null} onClose={() => { setCodes(null); setOpen(null); }}>
          <p className="text-sm">{S.saveNote}</p>
          <ul dir="ltr" className="grid grid-cols-2 gap-2 rounded-lg bg-background-muted/60 p-3 font-mono text-sm">
            {codes.map((c) => <li key={c} className="select-all">{c}</li>)}
          </ul>
        </FormDialog>
      )}
    </section>
  );
}
