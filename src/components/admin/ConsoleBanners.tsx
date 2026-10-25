"use client";
import { useState } from "react";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { adminFetch } from "@/lib/admin-fetch";
import { FormDialog } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import Button from "@/components/ui/Button";

type Lang = "ar" | "en";

/** Every word of the staff-identity banners (rules 1639, 1645, 1649, 3700, 3704). */
export const CB = {
  ar: {
    keyBanner: "جلسة طوارئ بالمفتاح، ادخل بحساب الموظف",
    keyNote: "المفتاح باب الطوارئ فقط. العمل اليومي بحساب الموظف وتطبيق المصادقة الخاص بك.",
    founderBanner: "لوحة المؤسس تحتاج دخول موظف خاصًا بك",
    founderNote: "أنت داخل الآن بحسابك العادي، وهذا مؤقت. أنشئ دخول الموظف مرة واحدة: تثبت هويتك برمز من تطبيق المصادقة أو بمفتاح مرور، ثم تختار كلمة المرور وتعدّ التطبيق.",
    founderSignInNote: "حسابك العادي يفتح اللوحة مؤقتًا فقط. ادخل بحساب الموظف، ثم أغلق هذا الطريق من صفحة الموظفين.",
    toSignIn: "الدخول بحساب الموظف",
    create: "أنشئ دخول الموظف",
    createNote: "لا يوجد حساب موظف بعد. أنشئ حسابك الأول هنا: يظهر رمز الإعداد مرة واحدة، صالح 30 دقيقة، وتكتبه في صفحة الإعداد.",
    founderCreateNote: "البريد بريدك افتراضيًا، ويمكنك تغييره. بعد «إنشاء» تنتقل مباشرة إلى اختيار كلمة المرور، بلا رمز تنسخه.",
    codeFirst: "ننصح بتفعيل التحقق بخطوتين للوحة أولًا: بعده يطلب نموذج المفتاح الرمز أيضًا.",
    email: "البريد",
    name: "الاسم",
    reason: "السبب",
    reasonHint: "من 3 إلى 200 حرف، يُحفظ في سجل اللوحة.",
    reasonDefault: "إنشاء أول دخول موظف للمؤسس",
    stepCode: "رمز جديد من تطبيق المصادقة (6 أرقام)",
    stepCodeHint: "رمز لوحة المؤسس أو رمز التحقق بخطوتين لحسابك.",
    passkeyHint: "أو اترك الرمز فارغًا واضغط «إنشاء» لتثبت هويتك بمفتاح المرور.",
    noFactor: "لإثبات هويتك تحتاج تطبيق مصادقة أو مفتاح مرور. فعّل التحقق بخطوتين من إعدادات حسابك، ثم عد إلى هنا.",
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
    fresh_code: "اكتب رمزًا جديدًا من تطبيق المصادقة.",
    bad_code: "الرمز غير صحيح أو استُخدم للتو. انتظر الرمز التالي وحاول مرة أخرى.",
    slow_down: "محاولات كثيرة. حاول بعد ربع ساعة.",
    step_up_unavailable: "لا يوجد لديك تطبيق مصادقة ولا مفتاح مرور. فعّل التحقق بخطوتين من إعدادات حسابك أولًا.",
    step_up_failed: "لم يُقبل مفتاح المرور. حاول مرة أخرى أو اكتب رمز تطبيق المصادقة.",
  },
  en: {
    keyBanner: "Break-glass key session: sign in with your staff login",
    keyNote: "The key is the emergency door only. Daily work is your staff login and your own authenticator app.",
    founderBanner: "The founder console needs your own staff login",
    founderNote: "You are in with your customer account for now. Create your staff login once: prove it is you with an authenticator code or a passkey, then choose the password and set up the app.",
    founderSignInNote: "Your customer account opens the console for now only. Sign in with your staff login, then close this way in from the Staff page.",
    toSignIn: "Sign in with your staff login",
    create: "Create your staff login",
    createNote: "There is no staff login yet. Create the first one here: the setup code is shown once, valid for 30 minutes, and you type it on the setup page.",
    founderCreateNote: "The email is yours by default; you can change it. After “Create” you go straight to choosing the password, with no code to copy.",
    codeFirst: "Turn on two-step verification for the console first: the key form then asks for its code too.",
    email: "Email",
    name: "Name",
    reason: "Reason",
    reasonHint: "3 to 200 characters, kept in the console log.",
    reasonDefault: "Create the founder's first staff login",
    stepCode: "New code from your authenticator app (6 digits)",
    stepCodeHint: "The console code, or your account's two-step sign-in code.",
    passkeyHint: "Or leave the code empty and press “Create” to use your passkey.",
    noFactor: "To prove it is you, you need an authenticator app or a passkey. Turn on two-step sign-in in your account settings, then come back.",
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
    fresh_code: "Type a new code from your authenticator app.",
    bad_code: "Wrong code, or it was just used. Wait for the next code and try again.",
    slow_down: "Too many attempts. Try again in 15 minutes.",
    step_up_unavailable: "You have no authenticator app or passkey. Turn on two-step sign-in in your account settings first.",
    step_up_failed: "The passkey was not accepted. Try again, or type your authenticator code.",
  },
} as const;

type Err = "exists" | "bad_email" | "name_required" | "reason_short" | "reason_long" | "fresh_code" | "bad_code" | "slow_down" | "step_up_unavailable" | "step_up_failed";
const KNOWN: readonly string[] = ["exists", "bad_email", "name_required", "reason_short", "reason_long", "fresh_code", "bad_code", "slow_down", "step_up_unavailable", "step_up_failed"];
type Answer = { ok?: boolean; code?: string; next?: string; error?: string; options?: unknown };
/** Which proofs the founder can make for the bootstrap (rule 3700). */
export type FounderProof = { email: string; code: boolean; passkey: boolean };

async function post(body: Record<string, unknown>): Promise<{ status: number; j: Answer }> {
  const r = await adminFetch("/api/admin/staff/bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, j: ((await r.json().catch(() => ({}))) as Answer) ?? {} };
}

/**
 * The console's identity banners. A key session is break-glass (rule 1645) and, while no owner exists, can create the
 * first staff login and is shown its setup code once (rule 1639). The founder's customer session (rule 1649) gets ONE
 * path (rule 3704): no owner yet, "Create your staff login" with a fresh proof (rule 3700), then straight to the setup
 * screen (the code travels in an HttpOnly cookie, rule 3701); an owner exists, "Sign in with your staff login". No link
 * to the key form. Nothing shows for a staff session.
 */
export default function ConsoleBanners({ lang, keySession, founder, staff, ownerExists, consoleCode, founderProof }: {
  lang: Lang;
  keySession: boolean;
  founder: boolean;
  staff: boolean;
  ownerExists: boolean;
  consoleCode: boolean;
  founderProof?: FounderProof | null;
}) {
  const S = CB[lang];
  const [form, setForm] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  if (staff) return null;
  const asFounder = !keySession && founder;
  const words = (status: number, error: string | undefined) => (status === 429 ? S.slow_down : error && KNOWN.includes(error) ? S[error as Err] : S.failed);

  async function create(data: FormData): Promise<string | null> {
    const base = { email: String(data.get("email") ?? ""), name: String(data.get("name") ?? ""), reason: String(data.get("reason") ?? "") };
    if (!asFounder) {
      const { status, j } = await post(base);
      if (!j.ok || !j.code) return words(status, j.error);
      setCode(j.code);
      return null;
    }
    const typed = String(data.get("stepCode") ?? "").replace(/\s/g, "");
    let proof: Record<string, unknown> = { code: typed };
    if (!typed && founderProof?.passkey) {
      const o = await post({ action: "passkey-options" });
      if (!o.j.ok || !o.j.options) return words(o.status, o.j.error);
      try {
        const { startAuthentication } = await import("@simplewebauthn/browser");
        proof = { passkey: await startAuthentication({ optionsJSON: o.j.options as PublicKeyCredentialRequestOptionsJSON }) };
      } catch {
        return S.step_up_failed;
      }
    }
    const { status, j } = await post({ ...base, ...proof });
    if (!j.ok || j.next !== "setup") return words(status, j.error);
    window.location.assign(`/${lang}/admin/login/setup`);
    return null;
  }

  const canProve = !!founderProof && (founderProof.code || founderProof.passkey);
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
      {asFounder && (
        <div role="status" className="card mb-4 grid gap-2 border-warning text-sm" data-testid="founder-staff-banner">
          <p className="font-semibold">{ownerExists ? S.toSignIn : S.founderBanner}</p>
          <p className="text-foreground-muted">{ownerExists ? S.founderSignInNote : S.founderNote}</p>
          {ownerExists ? (
            <p><a className="underline" href={`/${lang}/admin/login`}>{S.toSignIn}</a></p>
          ) : canProve ? (
            <p><Button size="sm" onClick={() => setForm(true)}>{S.create}</Button></p>
          ) : (
            <p>{S.noFactor}</p>
          )}
        </div>
      )}
      {form && !code && (
        <FormDialog lang={lang} title={S.create} description={asFounder ? S.founderCreateNote : S.createNote} submitLabel={S.go} cancelLabel={S.cancel} busyLabel={S.busy} onSubmit={create} onClose={() => setForm(false)}>
          <Field label={S.email}><Input name="email" type="email" autoComplete="email" dir="ltr" defaultValue={asFounder ? founderProof?.email : undefined} required /></Field>
          <Field label={S.name}><Input name="name" autoComplete="name" maxLength={80} required /></Field>
          <Field label={S.reason} hint={S.reasonHint}><Input name="reason" minLength={3} maxLength={200} defaultValue={asFounder ? S.reasonDefault : undefined} required /></Field>
          {asFounder && founderProof?.code && (
            <Field label={S.stepCode} hint={founderProof.passkey ? `${S.stepCodeHint} ${S.passkeyHint}` : S.stepCodeHint}>
              <Input name="stepCode" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={8} required={!founderProof.passkey} />
            </Field>
          )}
          {asFounder && !founderProof?.code && founderProof?.passkey && <p className="text-sm text-foreground-muted">{S.passkeyHint}</p>}
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
