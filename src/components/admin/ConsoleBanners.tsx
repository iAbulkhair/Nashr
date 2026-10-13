"use client";
import { useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import { FormDialog } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import Button from "@/components/ui/Button";

type Lang = "ar" | "en";

/** Every word of the staff-identity banners (rules 1639, 1645, 1649). */
export const CB = {
  ar: {
    keyBanner: "جلسة طوارئ بالمفتاح، ادخل بحساب الموظف",
    keyNote: "المفتاح باب الطوارئ فقط. العمل اليومي بحساب الموظف وتطبيق المصادقة الخاص بك.",
    founderBanner: "انقل دخولك إلى حساب الموظف",
    founderNote: "تفتح جلسة حسابك العادي لوحة المؤسس مؤقتًا فقط. أنشئ حساب الموظف وادخل به، ثم أغلق هذا الطريق من صفحة الموظفين.",
    toSignIn: "الدخول بحساب الموظف",
    toKey: "إنشاء حساب الموظف من جلسة المفتاح",
    create: "إنشاء حساب الموظف",
    createNote: "لا يوجد حساب موظف بعد. أنشئ حسابك الأول هنا: يظهر رمز الإعداد مرة واحدة، صالح 30 دقيقة، وتكتبه في صفحة الإعداد.",
    codeFirst: "ننصح بتفعيل التحقق بخطوتين للوحة أولًا: بعده يطلب نموذج المفتاح الرمز أيضًا.",
    email: "البريد",
    name: "الاسم",
    reason: "السبب",
    reasonHint: "من 3 إلى 200 حرف، يُحفظ في سجل اللوحة.",
    go: "إنشاء",
    cancel: "تراجع",
    busy: "جارٍ الإنشاء…",
    codeTitle: "رمز الإعداد (يظهر مرة واحدة)",
    codeNote: "اكتب هذا الرمز في صفحة الإعداد مع بريدك وكلمة مرور جديدة خلال 30 دقيقة. لا يُرسل بالبريد ولا يوضع في رابط.",
    openSetup: "فتح صفحة الإعداد",
    done: "تم",
    failed: "تعذّر الإنشاء. حاول مرة أخرى.",
    exists: "يوجد حساب موظف مالك بالفعل.",
    bad_email: "البريد غير صحيح.",
    name_required: "اكتب الاسم.",
    reason_short: "السبب قصير: 3 أحرف على الأقل.",
    reason_long: "السبب طويل: 200 حرف على الأكثر.",
  },
  en: {
    keyBanner: "Break-glass key session: sign in with your staff login",
    keyNote: "The key is the emergency door only. Daily work is your staff login and your own authenticator app.",
    founderBanner: "Move to your staff login",
    founderNote: "Your customer account session opens the console for now only. Create your staff login and sign in with it, then close this path from the Staff page.",
    toSignIn: "Sign in with your staff login",
    toKey: "Create your staff login from a key session",
    create: "Create your staff login",
    createNote: "There is no staff login yet. Create the first one here: the setup code is shown once, valid for 30 minutes, and you type it on the setup page.",
    codeFirst: "Turn on two-step verification for the console first: the key form then asks for its code too.",
    email: "Email",
    name: "Name",
    reason: "Reason",
    reasonHint: "3 to 200 characters, kept in the console log.",
    go: "Create",
    cancel: "Cancel",
    busy: "Creating…",
    codeTitle: "Setup code (shown once)",
    codeNote: "Type this code on the setup page with your email and a new password within 30 minutes. It is never emailed or put in a link.",
    openSetup: "Open the setup page",
    done: "Done",
    failed: "Could not create it. Try again.",
    exists: "An owner staff login already exists.",
    bad_email: "That email is not valid.",
    name_required: "Enter the name.",
    reason_short: "The reason is too short: at least 3 characters.",
    reason_long: "The reason is too long: 200 characters at most.",
  },
} as const;

type Err = "exists" | "bad_email" | "name_required" | "reason_short" | "reason_long";
const KNOWN: readonly string[] = ["exists", "bad_email", "name_required", "reason_short", "reason_long"];

/**
 * The console's identity banners: a key session is break-glass (rule 1645), the founder's customer session is the
 * expand-only path (rule 1649), and while no owner exists a key session can create the first staff login (rule 1639).
 * Nothing shows for a staff session.
 */
export default function ConsoleBanners({ lang, keySession, founder, staff, ownerExists, consoleCode }: {
  lang: Lang;
  keySession: boolean;
  founder: boolean;
  staff: boolean;
  ownerExists: boolean;
  consoleCode: boolean;
}) {
  const S = CB[lang];
  const [form, setForm] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  if (staff) return null;

  async function create(data: FormData): Promise<string | null> {
    const r = await adminFetch("/api/admin/staff/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: String(data.get("email") ?? ""), name: String(data.get("name") ?? ""), reason: String(data.get("reason") ?? "") }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; code?: string; error?: string };
    if (!j.ok || !j.code) return j.error && KNOWN.includes(j.error) ? S[j.error as Err] : S.failed;
    setCode(j.code);
    return null;
  }

  return (
    <>
      {keySession && (
        <div role="status" className="card mb-4 grid gap-2 border-warning text-sm">
          <p className="font-semibold">{S.keyBanner}</p>
          <p className="text-foreground-muted">{S.keyNote}</p>
          {ownerExists ? (
            <p><a className="underline" href={`/${lang}/admin/login`}>{S.toSignIn}</a></p>
          ) : (
            <>
              <p>{S.createNote}</p>
              {!consoleCode && <p className="text-foreground-muted">{S.codeFirst}</p>}
              <p><Button size="sm" onClick={() => setForm(true)}>{S.create}</Button></p>
            </>
          )}
        </div>
      )}
      {!keySession && founder && (
        <div role="status" className="card mb-4 grid gap-2 border-warning text-sm">
          <p className="font-semibold">{S.founderBanner}</p>
          <p className="text-foreground-muted">{S.founderNote}</p>
          <p><a className="underline" href={ownerExists ? `/${lang}/admin/login` : `/${lang}/admin?login=1`}>{ownerExists ? S.toSignIn : S.toKey}</a></p>
        </div>
      )}
      {form && !code && (
        <FormDialog lang={lang} title={S.create} description={S.createNote} submitLabel={S.go} cancelLabel={S.cancel} busyLabel={S.busy} onSubmit={create} onClose={() => setForm(false)}>
          <Field label={S.email}><Input name="email" type="email" autoComplete="email" required /></Field>
          <Field label={S.name}><Input name="name" autoComplete="name" maxLength={80} required /></Field>
          <Field label={S.reason} hint={S.reasonHint}><Input name="reason" minLength={3} maxLength={200} required /></Field>
        </FormDialog>
      )}
      {code && (
        <FormDialog lang={lang} title={S.codeTitle} role="alertdialog" submitLabel={S.done} cancelLabel={S.cancel} onSubmit={async () => null} onClose={() => { setCode(null); setForm(false); }}>
          <p className="text-sm">{S.codeNote}</p>
          <p dir="ltr" className="select-all rounded-lg bg-background-muted/60 px-3 py-2 text-center font-mono text-base tracking-wider">{code}</p>
          <p><a className="text-sm underline" href={`/${lang}/admin/login/setup`}>{S.openSetup}</a></p>
        </FormDialog>
      )}
    </>
  );
}
