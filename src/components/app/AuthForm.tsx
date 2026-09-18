"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";

const input = "input";

const SU = {
  ar: { emailStep: "ابدأ مجاناً", cont: "متابعة", edit: "تعديل", rules: ["8 أحرف على الأقل", "حرف واحد على الأقل", "رقم واحد على الأقل"], trial: "تجربة 3 أيام · 50 كريدت · بدون بطاقة دفع", legal1: "بالمتابعة أنت توافق على", terms: "الشروط", and: "و", privacy: "سياسة الخصوصية", nameOpt: "اسمك" },
  en: { emailStep: "Start free", cont: "Continue", edit: "Edit", rules: ["At least 8 characters", "At least one letter", "At least one number"], trial: "3-day trial · 50 credits · no card required", legal1: "By continuing you agree to the", terms: "Terms", and: "and", privacy: "Privacy Policy", nameOpt: "Your name" },
} as const;

/** Email first, then name and password with live requirements. Phone is asked later, inside onboarding. */
export function SignupForm({ t, lang }: { t: AppDict; lang: Lang }) {
  const r = useRouter();
  const sp = useSearchParams();
  const S = SU[lang];
  const ref = sp.get("ref") ?? "";
  const site = (sp.get("url") ?? "").slice(0, 300);
  const nextParam = sp.get("next") ?? "";
  const next = /^\/(?![\/\\])/.test(nextParam) ? nextParam : "";
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<1 | 2>(1);
  const [pw, setPw] = useState("");
  const checks = [pw.length >= 8, /\p{L}/u.test(pw), /\d/.test(pw)];
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    if (step === 1) { if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) setStep(2); else setErr((t.signup as Record<string, string>).bad_email ?? "bad_email"); return; }
    if (!checks.every(Boolean)) return;
    setBusy(true);
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    const res = await fetch("/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fd, email: email.trim(), lang, ref }) });
    const j = await res.json();
    setBusy(false);
    if (!j.ok) return setErr((t.signup as Record<string, string>)[j.error] ?? j.error);
    if (next) { window.location.assign(next); return; }
    r.push(site.length >= 4 ? `/${lang}/app/chat?onboard=${encodeURIComponent(site)}` : `/${lang}/app/start`);
    r.refresh();
  }
  return (
    <div className="mx-auto max-w-md">
      <h1 className="page-title">{t.signup.title}</h1>
      <p className="mt-2 text-ink/70">{t.signup.sub}</p>
      <form onSubmit={onSubmit} className="mt-6 grid gap-3">
        {step === 1 ? (
          <input name="email" required autoFocus type="email" autoComplete="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t.signup.email} aria-label={t.signup.email} className={input} />
        ) : (
          <>
            <p className="flex items-center justify-between gap-2 rounded-lg bg-salt-dim px-3 py-2 text-sm"><span dir="ltr" className="clip">{email}</span><button type="button" onClick={() => setStep(1)} className="text-xs text-oasis underline">{S.edit}</button></p>
            <input name="name" required autoFocus autoComplete="name" placeholder={S.nameOpt} aria-label={S.nameOpt} className={input} />
            <input name="password" required type="password" autoComplete="new-password" minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} placeholder={t.signup.password} aria-label={t.signup.password} className={input} />
            <ul className="grid gap-1 text-xs" aria-live="polite">{S.rules.map((rule, i) => <li key={rule} className={`flex items-center gap-2 ${checks[i] ? "text-oasis" : "text-ink/60"}`}><span aria-hidden className={`h-1.5 w-1.5 rounded-full ${checks[i] ? "bg-oasis" : "bg-ink/30"}`} />{rule}</li>)}</ul>
          </>
        )}
        {err && <p role="alert" className="text-sm text-sadu-deep">{err}</p>}
        <button disabled={busy || (step === 2 && !checks.every(Boolean))} className="btn btn-primary">{step === 1 ? S.cont : t.signup.submit}</button>
      </form>
      <p className="mt-3 text-center text-xs text-ink/60">{S.trial}</p>
      <p className="mt-4 text-sm text-ink/70">
        {t.signup.have} <Link href={`/${lang}/app/login`} className="font-medium text-oasis underline">{t.signup.login}</Link>
      </p>
      <p className="mt-2 text-xs text-ink/60">{S.legal1} <Link href={`/${lang}/terms`} className="underline">{S.terms}</Link> {S.and} <Link href={`/${lang}/privacy`} className="underline">{S.privacy}</Link>.</p>
    </div>
  );
}

export function LoginForm({ t, lang }: { t: AppDict; lang: Lang }) {
  const r = useRouter();
  const nextParam = useSearchParams().get("next") ?? "";
  const next = /^\/(?![\/\\])/.test(nextParam) ? nextParam : "";
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fd) });
    setBusy(false);
    if (!res.ok) { const j = await res.json().catch(() => ({} as { error?: string })); return setErr(j.error === "suspended" ? t.login.suspended : t.login.invalid); }
    if (next) { window.location.href = next; return; }
    r.push(`/${lang}/app`);
    r.refresh();
  }
  return (
    <div className="mx-auto max-w-md">
      <h1 className="page-title">{t.login.title}</h1>
      <form onSubmit={onSubmit} className="mt-6 grid gap-3">
        <input name="email" required type="email" dir="ltr" placeholder={t.login.email} className={input} />
        <input name="password" required type="password" placeholder={t.login.password} className={input} />
        {err && <p role="alert" className="text-sm text-sadu">{err}</p>}
        <button disabled={busy} className="btn btn-primary">{t.login.submit}</button>
        <Link href={`/${lang}/app/forgot`} className="text-center text-sm text-ink/60 underline">{lang === "ar" ? "نسيت كلمة المرور؟" : "Forgot your password?"}</Link>
      </form>
      <p className="mt-4 text-sm text-ink/70">
        {t.login.noAccount} <Link href={`/${lang}/app/signup`} className="font-medium text-oasis underline">{t.login.signup}</Link>
      </p>
    </div>
  );
}

const PW = {
  ar: { forgotTitle: "استرداد كلمة المرور", forgotSub: "اكتب بريد حسابك ونرسل لك رابطاً صالحاً لساعة واحدة.", send: "أرسل الرابط", sentMail: "إذا كان لهذا البريد حساب فسيصله رابط خلال دقائق. تفقد البريد غير المرغوب أيضاً.", noMail: "إرسال البريد غير مفعّل حالياً في نشر، فلن يصلك رابط. تواصل مع الدعم ونعيد تعيين كلمة مرورك يدوياً.", support: "تواصل مع الدعم على واتساب", back: "رجوع لتسجيل الدخول", resetTitle: "كلمة مرور جديدة", save: "حفظ والدخول", bad_token: "الرابط غير صالح أو انتهت صلاحيته. اطلب رابطاً جديداً.", weak_password: "كلمة المرور لا تحقق الشروط.", slow_down: "محاولات كثيرة. حاول بعد ربع ساعة.", suspended: "الحساب موقوف. تواصل مع الدعم.", bad_email: "بريد غير صحيح" },
  en: { forgotTitle: "Reset your password", forgotSub: "Enter your account email and we send a link valid for one hour.", send: "Send the link", sentMail: "If this email has an account, a link arrives within minutes. Check spam too.", noMail: "Email delivery is not enabled on Nashr yet, so no link can reach you. Contact support and we reset your password manually.", support: "Contact support on WhatsApp", back: "Back to log in", resetTitle: "New password", save: "Save and log in", bad_token: "This link is invalid or expired. Request a new one.", weak_password: "The password does not meet the rules.", slow_down: "Too many attempts. Try again in 15 minutes.", suspended: "This account is suspended. Contact support.", bad_email: "Invalid email" },
} as const;

export function ForgotForm({ lang, whatsapp }: { lang: Lang; whatsapp: string | null }) {
  const S = PW[lang];
  const [state, setState] = useState<"idle" | "busy" | "sent" | "nomail">("idle");
  const [err, setErr] = useState("");
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState("busy"); setErr("");
    const email = String(new FormData(e.currentTarget).get("email") ?? "");
    const r = await fetch("/api/auth/forgot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, lang }) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { setState("idle"); return setErr(S.bad_email); }
    setState(j.mail ? "sent" : "nomail");
  }
  return (
    <div className="mx-auto max-w-md">
      <h1 className="page-title">{S.forgotTitle}</h1>
      <p className="mt-2 text-ink/70">{S.forgotSub}</p>
      {state === "sent" || state === "nomail" ? (
        <div role="status" className="mt-6 rounded-xl border border-ink/10 bg-salt p-4 text-sm">
          <p>{state === "sent" ? S.sentMail : S.noMail}</p>
          {state === "nomail" && whatsapp && <a href={whatsapp} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm mt-3">{S.support}</a>}
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 grid gap-3">
          <input name="email" required autoFocus type="email" autoComplete="email" dir="ltr" placeholder="name@company.com" aria-label={S.forgotTitle} className={input} />
          {err && <p role="alert" className="text-sm text-sadu-deep">{err}</p>}
          <button disabled={state === "busy"} className="btn btn-primary">{S.send}</button>
        </form>
      )}
      <p className="mt-4 text-sm"><Link href={`/${lang}/app/login`} className="text-oasis underline">{S.back}</Link></p>
    </div>
  );
}

export function ResetForm({ lang }: { lang: Lang }) {
  const r = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const S = PW[lang], rules = SU[lang].rules;
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const checks = [pw.length >= 8, /\p{L}/u.test(pw), /\d/.test(pw)];
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!checks.every(Boolean)) return;
    setBusy(true); setErr("");
    const res = await fetch("/api/auth/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password: pw }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!j.ok) return setErr((S as Record<string, string>)[j.error] ?? S.bad_token);
    r.push(`/${lang}/app`);
    r.refresh();
  }
  return (
    <div className="mx-auto max-w-md">
      <h1 className="page-title">{S.resetTitle}</h1>
      <form onSubmit={onSubmit} className="mt-6 grid gap-3">
        <input name="password" required autoFocus type="password" autoComplete="new-password" minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} aria-label={S.resetTitle} className={input} />
        <ul className="grid gap-1 text-xs" aria-live="polite">{rules.map((rule, i) => <li key={rule} className={`flex items-center gap-2 ${checks[i] ? "text-oasis" : "text-ink/60"}`}><span aria-hidden className={`h-1.5 w-1.5 rounded-full ${checks[i] ? "bg-oasis" : "bg-ink/30"}`} />{rule}</li>)}</ul>
        {err && <p role="alert" className="text-sm text-sadu-deep">{err} {err === S.bad_token && <Link href={`/${lang}/app/forgot`} className="underline">{S.forgotTitle}</Link>}</p>}
        <button disabled={busy || !checks.every(Boolean)} className="btn btn-primary">{S.save}</button>
      </form>
    </div>
  );
}
