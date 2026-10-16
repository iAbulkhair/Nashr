"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import Button from "@/components/ui/Button";
import { buttonClass } from "@/components/ui/button-class";
import { Field } from "@/components/ui/Field";
import PasswordField from "../PasswordField";
import SettingsCard, { type CardStatus } from "./SettingsCard";

const COPY = {
  ar: {
    title: "الدخول بحساب Google", offSub: "اربط حساب Google وادخل بضغطة بدل كلمة المرور. كلمة المرور تظل شغالة.",
    onSub: "حساب Google مربوط بدخولك. تقدر تدخل فيه أو بكلمة المرور.", link: "اربط حساب Google", unlink: "فك الربط", unlinking: "يفك…",
    password: "كلمة المرور الحالية", linked: "انربط حساب Google.", unlinked: "انفك الربط.",
    google_taken: "حساب Google هذا مربوط بحساب ثاني.", google_cancelled: "ألغيت الربط.", google_failed: "ما زبط الربط. جرّب مرة ثانية.",
    wrong: "كلمة المرور غير صحيحة. إذا فتحت حسابك بـ Google وما عندك كلمة مرور، سوّ وحدة من «نسيت كلمة المرور» أول.", slow: "محاولات كثيرة. جرّب بعد ساعة.", failed: "ما زبطت. جرّب مرة ثانية.",
  },
  en: {
    title: "Sign in with Google", offSub: "Link a Google account and sign in with one click instead of the password. The password keeps working.",
    onSub: "A Google account is linked to your login. You can sign in with it or with the password.", link: "Link a Google account", unlink: "Unlink", unlinking: "Unlinking…",
    password: "Current password", linked: "Google account linked.", unlinked: "Unlinked.",
    google_taken: "This Google account is linked to another login.", google_cancelled: "You cancelled linking.", google_failed: "Linking did not work. Try again.",
    wrong: "The password is wrong. If you opened your account with Google and have no password, set one with \"Forgot your password?\" first.", slow: "Too many tries. Try again in an hour.", failed: "That did not work. Try again.",
  },
} as const;

/**
 * The acting login's Google link (rules 1946-1953), drawn only while Google sign-in is configured (GET answers `on`).
 * Linking goes through Google (GET /api/auth/google/start?mode=link) and comes back here with `?google=`; unlinking
 * needs the password, so an account never loses its last way in.
 */
/** Whether Google sign-in is on and this login is linked, or null when it could not be read. */
async function readLink(): Promise<{ on: boolean; linked: boolean } | null> {
  const res = await fetch("/api/account/google").catch(() => null);
  const j = ((await res?.json().catch(() => ({}))) ?? {}) as { ok?: boolean; on?: boolean; linked?: boolean };
  return j.ok ? { on: !!j.on, linked: !!j.linked } : null;
}

export default function GoogleLink({ lang, forbidden }: { lang: Lang; forbidden: string }) {
  const T = COPY[lang];
  const back = useSearchParams().get("google");
  const [st, setSt] = useState<{ on: boolean; linked: boolean } | null>(null);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<CardStatus>(() =>
    back === "linked" ? { tone: "ok", text: T.linked } : back === "google_taken" || back === "google_cancelled" || back === "google_failed" ? { tone: "error", text: T[back] } : null);

  const load = async () => { const v = await readLink(); if (v) setSt(v); };
  useEffect(() => { void readLink().then((v) => { if (v) setSt(v); }); }, []);

  async function unlink() {
    if (busy || !pw) return;
    setBusy(true); setStatus(null);
    const res = await fetch("/api/account/google", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "unlink", password: pw }) }).catch(() => null);
    const j = ((await res?.json().catch(() => ({}))) ?? {}) as { ok?: boolean; error?: string };
    setBusy(false); setPw("");
    setStatus(j.ok ? { tone: "ok", text: T.unlinked } : { tone: "error", text: res?.status === 403 ? forbidden : res?.status === 429 ? T.slow : j.error === "wrong_password" ? T.wrong : T.failed });
    await load();
  }

  if (!st?.on) return null;
  if (!st.linked) {
    return (
      <SettingsCard title={T.title} sub={T.offSub} status={status}>
        <a href={`/api/auth/google/start?mode=link&lang=${lang}`} className={buttonClass({ variant: "secondary", size: "sm", className: "justify-self-start" })}>{T.link}</a>
      </SettingsCard>
    );
  }
  return (
    <SettingsCard title={T.title} sub={T.onSub} status={status}>
      <Field label={T.password} required className="sm:max-w-sm">
        <PasswordField lang={lang} name="googlePassword" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </Field>
      <Button variant="secondary" size="sm" className="justify-self-start" loading={busy} loadingText={T.unlinking} aria-disabled={!pw || busy || undefined} onClick={() => void unlink()}>{T.unlink}</Button>
    </SettingsCard>
  );
}
