"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ADMIN_2FA_EVENT, adminFetch, type SecondFactorAsk } from "@/lib/admin-fetch";
import { FormDialog } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import Button from "@/components/ui/Button";
import QrCode from "@/components/admin/QrCode";

type Lang = "ar" | "en";

/** Every word the second factor shows (rules 1377-1379; the QR words, rule 1622). */
export const SF = {
  ar: {
    banner: "لوحة المؤسس محمية بالمفتاح أو كلمة المرور فقط. فعّل التحقق بخطوتين برمز من تطبيق المصادقة قبل الإطلاق.",
    setUp: "إعداد التحقق بخطوتين",
    on: "التحقق بخطوتين مفعّل لكل تغيير في اللوحة.",
    replace: "استبدال تطبيق المصادقة",
    step1: "امسح الرمز بتطبيق المصادقة، أو أضف المفتاح يدويًا. يعمل مع Google Authenticator و1Password وAuthy.",
    qrLabel: "رمز QR لإعداد التحقق بخطوتين في تطبيق المصادقة",
    manual: "أو أدخل هذا المفتاح يدويًا، أو افتح الرابط من الهاتف:",
    openApp: "فتح في تطبيق المصادقة",
    code: "الرمز من التطبيق (6 أرقام)",
    confirm: "تأكيد وتفعيل",
    cancel: "تراجع",
    busy: "جارٍ التحقق…",
    saveTitle: "احفظ رمز الاسترداد الآن",
    saveNote: "يظهر هذا الرمز مرة واحدة فقط. احفظه في مدير كلمات المرور. إن فقدت الهاتف فهو الطريق الوحيد للدخول، ويُلغي التفعيل الحالي فتُعيد الإعداد بعده.",
    saved: "حفظته",
    askTitle: "أدخل رمز التحقق",
    askNote: "هذا التغيير يحتاج الخطوة الثانية. أدخل الرمز الحالي من تطبيق المصادقة، أو رمز الاسترداد إن فقدت الهاتف.",
    askField: "الرمز",
    askGo: "تحقق",
    bad_code: "الرمز غير صحيح أو استُخدم للتو. انتظر الرمز التالي وحاول مرة أخرى.",
    slow_down: "محاولات كثيرة. انتظر ربع ساعة ثم حاول.",
    no_setup: "انتهت مهلة الإعداد (15 دقيقة). ابدأ من جديد.",
    no_secret_key: "لا يمكن حفظ المفتاح مشفرًا: متغير CONNECT_SECRET غير مضبوط على الخادم.",
    failed: "تعذّر الطلب. حاول مرة أخرى.",
    recovered: "استُخدم رمز الاسترداد وأُلغي التحقق بخطوتين. أعد الإعداد الآن بهاتفك الجديد.",
  },
  en: {
    banner: "The founder console is protected by the key or password alone. Turn on two-step verification with an authenticator app code before launch.",
    setUp: "Set up two-step verification",
    on: "Two-step verification is on for every console change.",
    replace: "Replace the authenticator app",
    step1: "Scan the code with your authenticator app, or add the key by hand. Works with Google Authenticator, 1Password and Authy.",
    qrLabel: "QR code to set up two-step verification in your authenticator app",
    manual: "Or enter this key by hand, or open the link on your phone:",
    openApp: "Open in the authenticator app",
    code: "Code from the app (6 digits)",
    confirm: "Confirm and turn on",
    cancel: "Cancel",
    busy: "Checking…",
    saveTitle: "Save the recovery code now",
    saveNote: "This code is shown once. Keep it in your password manager. If you lose the phone it is the only way in, and it turns the current setup off so you set it up again.",
    saved: "I saved it",
    askTitle: "Enter the verification code",
    askNote: "This change needs the second step. Enter the current code from your authenticator app, or the recovery code if you lost the phone.",
    askField: "Code",
    askGo: "Verify",
    bad_code: "Wrong code, or it was just used. Wait for the next code and try again.",
    slow_down: "Too many tries. Wait a quarter of an hour, then try again.",
    no_setup: "The setup timed out (15 minutes). Start again.",
    no_secret_key: "The key cannot be stored encrypted: CONNECT_SECRET is not set on the server.",
    failed: "The request failed. Try again.",
    recovered: "The recovery code was used and two-step verification is off. Set it up again with your new phone now.",
  },
} as const;

/** The words for an error code an /api/admin/2fa answer carries. */
export function sfError(lang: Lang, error: unknown): string {
  const S = SF[lang];
  return error === "bad_code" || error === "slow_down" || error === "no_setup" || error === "no_secret_key" ? S[error] : S.failed;
}

/**
 * The founder console's second factor on every console page (rules 1377-1379): the banner and setup while nothing is
 * enrolled, a status line with "replace" once it is, and the code prompt that `adminFetch` opens when a write answers
 * 403 `second_factor` (the write is then sent again by itself).
 */
export default function SecondFactor({ lang, enrolled }: { lang: Lang; enrolled: boolean }) {
  const S = SF[lang];
  const router = useRouter();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [ask, setAsk] = useState<SecondFactorAsk | null>(null);
  const open = useRef(false);
  const passed = useRef(false);

  useEffect(() => {
    const onAsk = (e: Event) => {
      const a = (e as CustomEvent<SecondFactorAsk>).detail;
      a.handled = true;
      // One prompt at a time: a second write asking while it is open is answered "cancelled" at once.
      if (open.current) { a.done(false); return; }
      open.current = true;
      passed.current = false;
      setAsk(a);
    };
    window.addEventListener(ADMIN_2FA_EVENT, onAsk);
    return () => window.removeEventListener(ADMIN_2FA_EVENT, onAsk);
  }, []);

  const post = (body: Record<string, string>) =>
    adminFetch("/api/admin/2fa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  async function start() {
    setNote("");
    const r = await post({ action: "start" });
    const j = await r.json().catch(() => ({}));
    if (j.ok) setSetup({ secret: j.secret, uri: j.uri });
    else if (r.status !== 401 && r.status !== 403) setNote(sfError(lang, j.error));
  }

  async function confirmSetup(data: FormData): Promise<string | null> {
    const r = await post({ action: "confirm", code: String(data.get("code") ?? "") });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) return sfError(lang, j.error);
    setRecovery(j.recovery);
    return null;
  }

  async function verify(data: FormData): Promise<string | null> {
    const r = await post({ action: "verify", code: String(data.get("code") ?? "") });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) return sfError(lang, j.error);
    passed.current = true;
    if (j.via === "recovery") { setNote(S.recovered); router.refresh(); }
    return null;
  }

  const groups = (s: string) => s.replace(/(.{4})(?=.)/g, "$1 ");

  return (
    <>
      {!enrolled ? (
        <div role="status" className="card mb-4 grid gap-2 text-sm">
          <p>{S.banner}</p>
          <p><Button size="sm" onClick={() => void start()}>{S.setUp}</Button></p>
          {note && <p role="alert" className="field-error">{note}</p>}
        </div>
      ) : (
        <p className="mb-4 flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
          <span>{S.on}</span>
          <button type="button" className="underline" onClick={() => void start()}>{S.replace}</button>
          {note && <span role="alert" className="field-error">{note}</span>}
        </p>
      )}

      {setup && !recovery && (
        <FormDialog lang={lang} title={S.setUp} submitLabel={S.confirm} cancelLabel={S.cancel} busyLabel={S.busy} onSubmit={confirmSetup} onClose={() => setSetup(null)}>
          <p className="text-sm">{S.step1}</p>
          <QrCode value={setup.uri} label={S.qrLabel} />
          <p className="text-sm text-foreground-muted">{S.manual}</p>
          <p dir="ltr" className="select-all rounded-lg bg-background-muted/60 px-3 py-2 text-center font-mono text-sm tracking-wider">{groups(setup.secret)}</p>
          <p><a className="text-sm underline" href={setup.uri}>{S.openApp}</a></p>
          <Field label={S.code}><Input name="code" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} pattern="\d{6}" required /></Field>
        </FormDialog>
      )}

      {recovery && (
        <FormDialog lang={lang} title={S.saveTitle} role="alertdialog" submitLabel={S.saved} cancelLabel={S.cancel} onSubmit={async () => null} onClose={() => { setRecovery(null); setSetup(null); router.refresh(); }}>
          <p className="text-sm">{S.saveNote}</p>
          <p dir="ltr" className="select-all rounded-lg bg-background-muted/60 px-3 py-2 text-center font-mono text-base tracking-wider">{recovery}</p>
        </FormDialog>
      )}

      {ask && (
        <FormDialog lang={lang} title={S.askTitle} description={S.askNote} submitLabel={S.askGo} cancelLabel={S.cancel} busyLabel={S.busy} onSubmit={verify} onClose={() => { open.current = false; ask.done(passed.current); setAsk(null); }}>
          <Field label={S.askField}><Input name="code" autoComplete="one-time-code" dir="ltr" maxLength={29} required /></Field>
        </FormDialog>
      )}
    </>
  );
}
