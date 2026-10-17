"use client";
import { useEffect, useState } from "react";
import type { Lang } from "@/lib/i18n";
import Button from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import { Field, Input } from "@/components/ui/Field";
import PasswordField from "../PasswordField";
import type { CardStatus } from "./SettingsCard";

const COPY = {
  ar: {
    change: "غيّر البريد", newEmail: "البريد الجديد", password: "كلمة المرور الحالية", send: "أرسل الرمز", sending: "يرسل…",
    cancel: "إلغاء", code: "الرمز اللي وصلك", confirm: "ثبّت البريد الجديد", confirming: "يثبّت…",
    sentTo: (e: string) => `أرسلنا رمز من 6 أرقام إلى ${e}. اكتبه هنا خلال 15 دقيقة، وبعدها يصير هو بريد دخولك.`,
    after: "لما يتغيّر البريد تطلع كل أجهزتك من الحساب إلا هذا، ويوصل بريدك القديم تنبيه.",
    done: (e: string) => `تم. بريد دخولك الحين ${e}.`,
    wrong: "كلمة المرور غير صحيحة.", invalid: "اكتب بريد صحيح.", same: "هذا نفس بريدك الحالي.",
    taken: "هذا البريد عليه حساب ثاني في ذكين.", hasData: "حسابك فيه شغل، وتغيير بريد المالك لحساب فيه شغل يمر عن طريق الدعم الحين. راسلنا ونغيّره لك.",
    limit: "وصلت حد التغييرات اليوم. جرّب بكرة.", slow: "طلبات كثيرة. جرّب بعد شوي.", mailOff: "الإيميل واقف عندنا الحين. جرّب بعدين.",
    badCode: "الرمز غلط.", expired: "الرمز انتهى أو انقفل. اطلب رمز جديد.", failed: "ما زبطت. جرّب مرة ثانية.",
  },
  en: {
    change: "Change email", newEmail: "New email", password: "Current password", send: "Send the code", sending: "Sending…",
    cancel: "Cancel", code: "The code you got", confirm: "Confirm the new email", confirming: "Confirming…",
    sentTo: (e: string) => `We sent a 6-digit code to ${e}. Type it here within 15 minutes and it becomes your sign-in email.`,
    after: "Once it changes, every device but this one is signed out and your old address gets a notice.",
    done: (e: string) => `Done. Your sign-in email is now ${e}.`,
    wrong: "The password is wrong.", invalid: "Enter a valid email.", same: "That is already your email.",
    taken: "That email already has a Thakeen login.", hasData: "Your account already holds work, and an owner's email on such an account is changed through support for now. Write to us and we will change it.",
    limit: "You reached today's limit of changes. Try tomorrow.", slow: "Too many tries. Try again a bit later.", mailOff: "Email is off on our side right now. Try later.",
    badCode: "That code is wrong.", expired: "The code ran out or was locked. Ask for a new one.", failed: "That did not work. Try again.",
  },
} as const;

async function call(method: "GET" | "POST", body?: Record<string, unknown>) {
  const res = await fetch("/api/account/email", { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) }).catch(() => null);
  const j = ((await res?.json().catch(() => ({}))) ?? {}) as { ok?: boolean; error?: string; pending?: string | null; email?: string; devCode?: string };
  return { status: res?.status ?? 0, j };
}

/**
 * The sign-in address change inside the Email card (rules 1942-1945): the password and the new address send a code to
 * the new address; the code moves the login. A waiting code survives a reload (GET shows its address). The page then
 * reloads so every screen shows the new address under the new session the route opened.
 */
export default function EmailChange({ lang, forbidden, onStatus }: { lang: Lang; forbidden: string; onStatus: (s: CardStatus) => void }) {
  const T = COPY[lang];
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"" | "start" | "confirm">("");
  const [ownerHasData, setOwnerHasData] = useState(false);

  useEffect(() => { void call("GET").then(({ j }) => { if (j.ok && j.pending) setPending(j.pending); }); }, []);

  const err = (s: number, e?: string) =>
    s === 403 ? forbidden : e === "wrong_password" ? T.wrong : e === "invalid_email" ? T.invalid : e === "same_email" ? T.same : e === "taken" ? T.taken
      : e === "owner_has_data" ? T.hasData : e === "limit" ? T.limit : e === "mail_unavailable" ? T.mailOff : s === 429 ? T.slow
      : e === "wrong" ? T.badCode : e === "expired" || e === "locked" ? T.expired : T.failed;

  async function start() {
    if (busy) return;
    setBusy("start"); onStatus(null);
    const { status, j } = await call("POST", { action: "start", password: pw, email: to.trim() });
    setBusy(""); setPw("");
    if (j.ok && j.pending) { setPending(j.pending); setOpen(false); onStatus({ tone: "ok", text: T.sentTo(j.pending) }); return; }
    if (j.error === "owner_has_data") setOwnerHasData(true);
    onStatus({ tone: "error", text: err(status, j.error) });
  }
  async function confirm() {
    if (busy) return;
    setBusy("confirm"); onStatus(null);
    const { status, j } = await call("POST", { action: "confirm", code });
    setBusy(""); setCode("");
    if (j.ok && j.email) { onStatus({ tone: "ok", text: T.done(j.email) }); window.location.reload(); return; }
    if (j.error === "expired" || j.error === "locked" || j.error === "taken" || j.error === "owner_has_data") setPending(null);
    onStatus({ tone: "error", text: err(status, j.error) });
  }

  if (pending) {
    const ready = /^\d{6}$/.test(code.replace(/\s/g, ""));
    return (
      <div className="grid gap-3">
        <p className="text-sm text-foreground-muted">{T.sentTo(pending)}</p>
        <Field label={T.code} required className="sm:max-w-xs">
          <Input name="emailCode" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" size="sm" loading={busy === "confirm"} loadingText={T.confirming} aria-disabled={!ready || !!busy || undefined} onClick={() => { if (ready) void confirm(); }}>{T.confirm}</Button>
          <Button variant="ghost" size="sm" onClick={() => { setPending(null); setCode(""); onStatus(null); }}>{T.cancel}</Button>
        </div>
      </div>
    );
  }

  if (!open) {
    return ownerHasData
      ? <Callout tone="notice">{T.hasData}</Callout>
      : <Button variant="secondary" size="sm" className="justify-self-start" onClick={() => setOpen(true)}>{T.change}</Button>;
  }

  const ready = to.trim().length > 3 && pw.length > 0;
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={T.newEmail} required>
          <Input name="newEmail" type="email" dir="ltr" autoComplete="email" maxLength={120} value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label={T.password} required>
          <PasswordField lang={lang} name="emailPassword" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
      </div>
      <p className="text-xs text-foreground-muted">{T.after}</p>
      <div className="flex flex-wrap gap-3">
        <Button variant="primary" size="sm" loading={busy === "start"} loadingText={T.sending} aria-disabled={!ready || !!busy || undefined} onClick={() => { if (ready) void start(); }}>{T.send}</Button>
        <Button variant="ghost" size="sm" onClick={() => { setOpen(false); setPw(""); onStatus(null); }}>{T.cancel}</Button>
      </div>
    </div>
  );
}
