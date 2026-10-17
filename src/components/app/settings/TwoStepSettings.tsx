"use client";
import { useEffect, useState } from "react";
import type { Lang } from "@/lib/i18n";
import Button from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import { Field, Input } from "@/components/ui/Field";
import QrCode from "@/components/admin/QrCode";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import PasswordField from "../PasswordField";
import SettingsCard, { type CardStatus } from "./SettingsCard";

const COPY = {
  ar: {
    title: "الدخول بخطوتين",
    offSub: "بعد كلمة المرور يطلب منك ذكين رمز من تطبيق المصادقة في جوالك، فلو أحد عرف كلمة مرورك ما يقدر يدخل.",
    recommend: "ننصحك فيه لأنك مالك الحساب: حسابك فيه الفوترة والفريق وكل ملفات العلامة.",
    onSub: (left: number) => `مفعّل. باقي عندك ${left} من رموز الاسترداد.`,
    lowCodes: "رموز الاسترداد قربت تخلص. ولّد رموز جديدة.",
    password: "كلمة المرور", start: "فعّل الدخول بخطوتين", starting: "يجهّز…",
    scan: "امسح الرمز بتطبيق المصادقة (Google Authenticator أو Microsoft Authenticator أو 1Password)، أو اكتب المفتاح يدوي:",
    qr: "رمز QR لإضافة ذكين في تطبيق المصادقة", key: "المفتاح",
    code: "الرمز من التطبيق (6 أرقام)", confirm: "تأكيد وتفعيل", confirming: "يتحقق…", cancel: "إلغاء",
    codesTitle: "رموز الاسترداد", codesSub: "احفظها في مكان آمن. كل رمز يشتغل مرة وحدة لو ضاع جوالك، وما راح نعرضها لك مرة ثانية.",
    copy: "انسخ الرموز", copied: "انتسخت.", saved: "حفظتها",
    codeOrRecovery: "رمز التطبيق أو رمز استرداد",
    off: "أوقف الدخول بخطوتين", offBusy: "يوقف…", renew: "ولّد رموز استرداد جديدة", renewBusy: "يولّد…",
    turnedOn: "تفعّل الدخول بخطوتين.", turnedOff: "توقّف الدخول بخطوتين.", renewed: "هذي رموزك الجديدة، والقديمة ما عادت تشتغل.",
    wrong: "كلمة المرور غير صحيحة.", badCode: "الرمز غير صحيح أو انتهى. جرّب الرمز اللي بعده.", noSetup: "انتهت مهلة الإعداد. ابدأ من جديد.",
    slow: "محاولات كثيرة. جرّب بعد ربع ساعة.", failed: "ما زبطت. جرّب مرة ثانية.", loading: "يحمّل…",
  },
  en: {
    title: "Two-step sign-in",
    offSub: "After your password, Thakeen asks for a code from the authenticator app on your phone, so a stolen password alone cannot sign in.",
    recommend: "Recommended for you as the account owner: your account holds billing, the team and every brand file.",
    onSub: (left: number) => `On. You have ${left} recovery codes left.`,
    lowCodes: "You are running low on recovery codes. Make new ones.",
    password: "Password", start: "Turn on two-step sign-in", starting: "Preparing…",
    scan: "Scan the code with your authenticator app (Google Authenticator, Microsoft Authenticator or 1Password), or type the key by hand:",
    qr: "QR code to add Thakeen to your authenticator app", key: "Key",
    code: "Code from the app (6 digits)", confirm: "Confirm and turn on", confirming: "Checking…", cancel: "Cancel",
    codesTitle: "Recovery codes", codesSub: "Keep them somewhere safe. Each one works once if you lose your phone, and we will not show them again.",
    copy: "Copy the codes", copied: "Copied.", saved: "I saved them",
    codeOrRecovery: "App code or a recovery code",
    off: "Turn off two-step sign-in", offBusy: "Turning off…", renew: "Make new recovery codes", renewBusy: "Making…",
    turnedOn: "Two-step sign-in is on.", turnedOff: "Two-step sign-in is off.", renewed: "Here are your new codes; the old ones no longer work.",
    wrong: "The password is wrong.", badCode: "That code is wrong or expired. Try the next one.", noSetup: "The setup timed out. Start again.",
    slow: "Too many tries. Try again in 15 minutes.", failed: "That did not work. Try again.", loading: "Loading…",
  },
} as const;

type Status = { enabled: boolean; at: string | null; recoveryLeft: number; recommended: boolean };
type Answer = { ok?: boolean; error?: string; secret?: string; uri?: string; codes?: string[] } & Partial<Status>;

async function call(method: "GET" | "POST", body?: unknown): Promise<{ status: number; j: Answer }> {
  const res = await fetch("/api/account/2fa", { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).catch(() => null);
  return { status: res?.status ?? 0, j: ((await res?.json().catch(() => ({}))) ?? {}) as Answer };
}

/**
 * Settings, Security: the acting login's own two-step sign-in (rules 1930-1937). Off: one password starts setup, the
 * QR code and the key come back once, a code from the app confirms it and the eight recovery codes show once. On: the
 * password plus a code turns it off or renews the recovery codes. Nothing typed is kept after it is sent; the secret
 * and the codes live in this component's state only until the person moves on.
 */
/** The login's two-step status from GET, or null when it could not be read. */
async function readStatus() {
  const { j } = await call("GET");
  return j.ok ? { enabled: !!j.enabled, at: j.at ?? null, recoveryLeft: j.recoveryLeft ?? 0, recommended: !!j.recommended } : null;
}

export default function TwoStepSettings({ lang, forbidden }: { lang: Lang; forbidden: string }) {
  const T = COPY[lang];
  const [st, setSt] = useState<Status | null>(null);
  // The first read failed: say so, rather than a skeleton that never ends.
  const [unread, setUnread] = useState(false);
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<"" | "start" | "confirm" | "off" | "renew">("");
  const [status, setStatus] = useState<CardStatus>(null);
  const [copied, setCopied] = useState(false);

  const show = (v: Status | null) => { setUnread(!v); if (v) setSt(v); };
  const load = async () => show(await readStatus());
  useEffect(() => { void readStatus().then(show); }, []);

  const err = (s: number, e?: string) => s === 403 ? forbidden : s === 429 ? T.slow : e === "wrong_password" ? T.wrong : e === "bad_code" ? T.badCode : e === "no_setup" ? T.noSetup : T.failed;

  async function start() {
    setBusy("start"); setStatus(null);
    const { status: s, j } = await call("POST", { action: "start", password: pw });
    setBusy(""); setPw("");
    if (j.ok && j.secret && j.uri) setSetup({ secret: j.secret, uri: j.uri });
    else setStatus({ tone: "error", text: err(s, j.error) });
  }
  async function confirm() {
    setBusy("confirm"); setStatus(null);
    const { status: s, j } = await call("POST", { action: "confirm", code });
    setBusy(""); setCode("");
    if (j.ok && j.codes) { setSetup(null); setCodes(j.codes); setStatus({ tone: "ok", text: T.turnedOn }); await load(); }
    else { if (j.error === "no_setup") setSetup(null); setStatus({ tone: "error", text: err(s, j.error) }); }
  }
  async function change(action: "disable" | "recovery") {
    setBusy(action === "disable" ? "off" : "renew"); setStatus(null);
    const { status: s, j } = await call("POST", { action, password: pw, code });
    setBusy(""); setPw(""); setCode("");
    if (!j.ok) return setStatus({ tone: "error", text: err(s, j.error) });
    if (action === "recovery" && j.codes) { setCodes(j.codes); setStatus({ tone: "ok", text: T.renewed }); }
    else setStatus({ tone: "ok", text: T.turnedOff });
    await load();
  }
  async function copyCodes() {
    if (!codes) return;
    await navigator.clipboard?.writeText(codes.join("\n")).then(() => setCopied(true), () => {});
  }

  // Rule 2003: the card keeps its title while the status loads, with a skeleton line.
  if (!st) {
    return (
      <SettingsCard title={T.title}>
        {unread ? <p role="alert" className="text-sm text-danger">{T.failed}</p> : <PanelSkeleton label={T.loading} shape="line" />}
      </SettingsCard>
    );
  }

  if (codes) {
    return (
      <SettingsCard title={T.codesTitle} sub={T.codesSub} status={status}>
        <ul dir="ltr" className="grid grid-cols-2 gap-2 font-mono text-sm sm:max-w-sm">
          {codes.map((c) => <li key={c} className="rounded border border-border px-2 py-1 text-center">{c.replace(/(.{5})(?=.)/g, "$1-")}</li>)}
        </ul>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" size="sm" onClick={copyCodes}>{copied ? T.copied : T.copy}</Button>
          <Button variant="primary" size="sm" onClick={() => { setCodes(null); setCopied(false); }}>{T.saved}</Button>
        </div>
      </SettingsCard>
    );
  }

  if (setup) {
    return (
      <SettingsCard title={T.title} sub={T.scan} onSave={confirm} dirty={code.length > 0} valid={/^\d{6}$/.test(code.replace(/\s/g, ""))} busy={busy === "confirm"} status={status} saveLabel={T.confirm} savingLabel={T.confirming}>
        <div className="flex flex-wrap items-start gap-4">
          <QrCode value={setup.uri} label={T.qr} px={180} />
          <div className="grid gap-3">
            <p className="text-sm text-foreground-muted">{T.key}: <code dir="ltr" className="break-all font-mono text-foreground">{setup.secret.replace(/(.{4})(?=.)/g, "$1 ")}</code></p>
            <Field label={T.code} required className="sm:max-w-xs">
              <Input name="code" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Button variant="ghost" size="sm" onClick={() => { setSetup(null); setStatus(null); }}>{T.cancel}</Button>
          </div>
        </div>
      </SettingsCard>
    );
  }

  if (!st.enabled) {
    return (
      <SettingsCard title={T.title} sub={T.offSub} onSave={start} dirty={pw.length > 0} busy={busy === "start"} status={status} saveLabel={T.start} savingLabel={T.starting}>
        {st.recommended && <Callout tone="notice">{T.recommend}</Callout>}
        <Field label={T.password} required className="sm:max-w-sm">
          <PasswordField lang={lang} name="mfaPassword" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
      </SettingsCard>
    );
  }

  const ready = pw.length > 0 && code.trim().length > 0;
  return (
    <SettingsCard title={T.title} sub={T.onSub(st.recoveryLeft)} status={status}>
      {st.recoveryLeft <= 2 && <Callout tone="warning">{T.lowCodes}</Callout>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={T.password} required>
          <PasswordField lang={lang} name="mfaPassword" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <Field label={T.codeOrRecovery} required>
          <Input name="code" autoComplete="one-time-code" dir="ltr" maxLength={40} value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" size="sm" loading={busy === "renew"} loadingText={T.renewBusy} aria-disabled={!ready || !!busy || undefined} onClick={() => { if (ready && !busy) void change("recovery"); }}>{T.renew}</Button>
        <Button variant="danger" size="sm" loading={busy === "off"} loadingText={T.offBusy} aria-disabled={!ready || !!busy || undefined} onClick={() => { if (ready && !busy) void change("disable"); }}>{T.off}</Button>
      </div>
    </SettingsCard>
  );
}
