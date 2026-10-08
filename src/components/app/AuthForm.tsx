"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import PartnerCodeField from "./PartnerCodeField";
import { PLAN_CREDITS } from "@/lib/pricing";
import { authMessage, failureCode, passwordChecks, postJson, succeeded, unmetRules } from "@/lib/auth-client";
import { PasswordRules } from "./PasswordRules";
import { Turnstile } from "./Turnstile";
import { safeNext } from "@/lib/safe-next";
import { readInviteToken as readFragmentToken, withoutFragment } from "./inviteToken";
import Scribble from "@/components/Scribble";

const input = "input";

const SU = {
  ar: { emailStep: "ابدأ مجاناً", cont: "متابعة", edit: "تعديل", rules: ["8 أحرف على الأقل", "حرف واحد على الأقل", "رقم واحد على الأقل"], trial: `تجربة 3 أيام · ${PLAN_CREDITS.trial} كريدت · بدون بطاقة دفع`, legal1: "بالمتابعة أنت توافق على", terms: "الشروط", and: "و", privacy: "سياسة الخصوصية", nameOpt: "اسمك" },
  en: { emailStep: "Start free", cont: "Continue", edit: "Edit", rules: ["At least 8 characters", "At least one letter", "At least one number"], trial: `3-day trial · ${PLAN_CREDITS.trial} credits · no card required`, legal1: "By continuing you agree to the", terms: "Terms", and: "and", privacy: "Privacy Policy", nameOpt: "Your name" },
} as const;

/** Email first, then name and password with live requirements. Phone is asked later, inside onboarding. */
export function SignupForm({ t, lang, turnstileKey = null }: { t: AppDict; lang: Lang; turnstileKey?: string | null }) {
  const r = useRouter();
  const sp = useSearchParams();
  const S = SU[lang];
  const ref = sp.get("ref") ?? "";
  const site = (sp.get("url") ?? "").slice(0, 300);
  const nextParam = sp.get("next") ?? "";
  const next = safeNext(nextParam);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<1 | 2>(1);
  const [pw, setPw] = useState("");
  const pwRef = useRef<HTMLInputElement>(null);
  const [token, setToken] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const checks = passwordChecks(pw);
  const ready = checks.every(Boolean);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    if (step === 1) { if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) setStep(2); else setErr(t.signup.bad_email); return; }
    // The button stays focusable (aria-disabled), so pressing it early says which rules are still unmet.
    if (!ready) { setErr(unmetRules(checks, S.rules, lang)); pwRef.current?.focus(); return; }
    if (turnstileKey && !token) return setErr(authMessage("captcha_failed", lang));
    if (busy) return;
    setBusy(true);
    try {
      const fd = Object.fromEntries(new FormData(e.currentTarget));
      const p = await postJson("/api/auth/signup", { ...fd, email: email.trim(), lang, ref, ...(turnstileKey ? { turnstile: token } : {}) });
      if (!succeeded(p)) {
        // A Turnstile token is single use: the widget issues a new one before the next try.
        if (turnstileKey) setResetKey((k) => k + 1);
        const code = failureCode(p);
        return setErr(authMessage(code === "slow_down" ? "slow_down_signup" : code, lang, t.signup as Record<string, string>));
      }
      // The new owner proves the address first (rule 754): the verify page carries the old destination on in `next`. A carried
      // site only pre-fills the start page: the owner confirms it there before anything is read (onboard-confirm.ts).
      const after = next || `/${lang}/app/start${site.length >= 4 ? `?url=${encodeURIComponent(site)}` : ""}`;
      // `sent=0`: the first mail did not go out, so the verify page does not say it did (copy only).
      r.push(`/${lang}/app/verify?next=${encodeURIComponent(after)}${p.body.mail === false ? "&sent=0" : ""}`);
      r.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="authform-t1" />{t.signup.title}</span></h1>
      <p className="mt-2 text-ink/70">{t.signup.sub}</p>
      <form onSubmit={onSubmit} className="mt-6 grid gap-3">
        {step === 1 ? (
          <input name="email" required autoFocus type="email" autoComplete="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t.signup.email} aria-label={t.signup.email} className={input} />
        ) : (
          <>
            <p className="flex items-center justify-between gap-2 rounded-lg bg-lilac px-3 py-2 text-sm"><span dir="ltr" className="clip">{email}</span><button type="button" onClick={() => setStep(1)} className="text-xs text-ink underline">{S.edit}</button></p>
            <input name="name" required autoFocus autoComplete="name" placeholder={S.nameOpt} aria-label={S.nameOpt} className={input} />
            <input ref={pwRef} name="password" required type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={t.signup.password} aria-label={t.signup.password} aria-describedby="signup-rules" className={input} />
            <PasswordRules id="signup-rules" rules={S.rules} checks={checks} lang={lang} />
            {turnstileKey && <Turnstile siteKey={turnstileKey} onToken={setToken} resetKey={resetKey} lang={lang} />}
          </>
        )}
        {step === 2 && <PartnerCodeField lang={lang} />}
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
        <button disabled={busy} aria-disabled={step === 2 && !ready ? true : undefined} aria-describedby={step === 2 ? "signup-rules" : undefined} className="s-btn"><Scribble kind="pill" seed="authform-b1" fill="ink" shadow ring />{step === 1 ? S.cont : t.signup.submit}</button>
      </form>
      <p className="mt-3 text-center text-xs text-muted">{S.trial}</p>
      <p className="mt-4 text-sm text-ink/70">
        {t.signup.have} <Link href={`/${lang}/app/login`} className="font-medium text-ink underline">{t.signup.login}</Link>
      </p>
      <p className="mt-2 text-xs text-muted">{S.legal1} <Link href={`/${lang}/terms`} className="underline">{S.terms}</Link> {S.and} <Link href={`/${lang}/privacy`} className="underline">{S.privacy}</Link>.</p>
    </div>
  );
}

export function LoginForm({ t, lang }: { t: AppDict; lang: Lang }) {
  const r = useRouter();
  const nextParam = useSearchParams().get("next") ?? "";
  const next = safeNext(nextParam);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const p = await postJson("/api/auth/login", Object.fromEntries(new FormData(e.currentTarget)));
      // "Wrong email or password" only for a 401: a rate limit, a dropped connection and a server error each say so,
      // so a customer with the right password is not sent to a reset (rule 433).
      if (!succeeded(p)) return setErr(authMessage(failureCode(p), lang, { invalid: t.login.invalid, suspended: t.login.suspended }));
      if (next) { window.location.href = next; return; }
      r.push(`/${lang}/app`);
      r.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="authform-t2" />{t.login.title}</span></h1>
      <form onSubmit={onSubmit} className="mt-6 grid gap-3">
        <input name="email" required type="email" dir="ltr" placeholder={t.login.email} className={input} />
        <input name="password" required type="password" placeholder={t.login.password} className={input} />
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
        <button disabled={busy} className="s-btn"><Scribble kind="pill" seed="authform-b2" fill="ink" shadow ring />{t.login.submit}</button>
        <Link href={`/${lang}/app/forgot`} className="text-center text-sm text-muted underline">{lang === "ar" ? "نسيت كلمة المرور؟" : "Forgot your password?"}</Link>
      </form>
      <p className="mt-4 text-sm text-ink/70">
        {t.login.noAccount} <Link href={`/${lang}/app/signup`} className="font-medium text-ink underline">{t.login.signup}</Link>
      </p>
    </div>
  );
}

const PW = {
  ar: { forgotTitle: "استرداد كلمة المرور", forgotSub: "اكتب بريد حسابك ونرسل لك رابطاً صالحاً لساعة واحدة.", send: "أرسل الرابط", sentMail: "إذا كان لهذا البريد حساب فسيصله رابط خلال دقائق. تفقد البريد غير المرغوب أيضاً.", noMail: "إرسال البريد غير مفعّل حالياً في ذكين، فلن يصلك رابط. تواصل مع الدعم ونعيد تعيين كلمة مرورك يدوياً.", support: "تواصل مع الدعم على واتساب", back: "رجوع لتسجيل الدخول", resetTitle: "كلمة مرور جديدة", save: "حفظ والدخول", bad_token: "الرابط غير صالح أو انتهت صلاحيته. اطلب رابطاً جديداً.", weak_password: "كلمة المرور لا تحقق الشروط.", slow_down: "محاولات كثيرة. حاول بعد ربع ساعة.", suspended: "الحساب موقوف. تواصل مع الدعم.", bad_email: "بريد غير صحيح" },
  en: { forgotTitle: "Reset your password", forgotSub: "Enter your account email and we send a link valid for one hour.", send: "Send the link", sentMail: "If this email has an account, a link arrives within minutes. Check spam too.", noMail: "Email delivery is not enabled on Thakeen yet, so no link can reach you. Contact support and we reset your password manually.", support: "Contact support on WhatsApp", back: "Back to log in", resetTitle: "New password", save: "Save and log in", bad_token: "This link is invalid or expired. Request a new one.", weak_password: "The password does not meet the rules.", slow_down: "Too many attempts. Try again in 15 minutes.", suspended: "This account is suspended. Contact support.", bad_email: "Invalid email" },
} as const;

export function ForgotForm({ lang, whatsapp, turnstileKey = null }: { lang: Lang; whatsapp: string | null; turnstileKey?: string | null }) {
  const S = PW[lang];
  const [state, setState] = useState<"idle" | "busy" | "sent" | "nomail">("idle");
  const [err, setErr] = useState("");
  const [token, setToken] = useState("");
  const [resetKey, setResetKey] = useState(0);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state === "busy") return;
    setErr("");
    if (turnstileKey && !token) return setErr(authMessage("captcha_failed", lang));
    setState("busy");
    let done: "sent" | "nomail" | null = null;
    try {
      const email = String(new FormData(e.currentTarget).get("email") ?? "");
      const p = await postJson("/api/auth/forgot", { email, lang, ...(turnstileKey ? { turnstile: token } : {}) });
      if (!succeeded(p)) {
        if (turnstileKey) setResetKey((k) => k + 1);
        return setErr(authMessage(failureCode(p), lang, { bad_email: S.bad_email }));
      }
      done = p.body.mail ? "sent" : "nomail";
    } finally {
      setState(done ?? "idle");
    }
  }
  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="authform-t3" />{S.forgotTitle}</span></h1>
      <p className="mt-2 text-ink/70">{S.forgotSub}</p>
      {state === "sent" || state === "nomail" ? (
        <div role="status" className="mt-6 rounded-xl border border-ink/10 bg-ground p-4 text-sm">
          <p>{state === "sent" ? S.sentMail : S.noMail}</p>
          {state === "nomail" && whatsapp && <a href={whatsapp} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm mt-3">{S.support}</a>}
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 grid gap-3">
          <input name="email" required autoFocus type="email" autoComplete="email" dir="ltr" placeholder="name@company.com" aria-label={S.forgotTitle} className={input} />
          {turnstileKey && <Turnstile siteKey={turnstileKey} onToken={setToken} resetKey={resetKey} lang={lang} />}
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <button disabled={state === "busy"} className="s-btn"><Scribble kind="pill" seed="authform-b3" fill="ink" shadow ring />{S.send}</button>
        </form>
      )}
      <p className="mt-4 text-sm"><Link href={`/${lang}/app/login`} className="text-ink underline">{S.back}</Link></p>
    </div>
  );
}

/**
 * The reset link is /{lang}/app/reset#t=<64 hex> (../../app/api/auth/forgot/route.ts). The token rides in the URL
 * fragment, which browsers never send to a server, so it stays out of server, proxy and edge logs and the Referer header,
 * the same way team invite links work. It is read once on the client, taken out of the address bar and history, and
 * posted in a JSON body. A `?token=` query is never read. Rules 546-547.
 */
export function ResetForm({ lang }: { lang: Lang }) {
  const r = useRouter();
  const tokenRef = useRef("");
  useEffect(() => {
    tokenRef.current ||= readFragmentToken(window.location.hash);
    if (window.location.hash) window.history.replaceState(window.history.state, "", withoutFragment(window.location));
  }, []);
  const S = PW[lang], rules = SU[lang].rules;
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const pwRef = useRef<HTMLInputElement>(null);
  const checks = passwordChecks(pw);
  const ready = checks.every(Boolean);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    if (!ready) { setErr(unmetRules(checks, rules, lang)); pwRef.current?.focus(); return; }
    if (busy) return;
    setBusy(true);
    try {
      const p = await postJson("/api/auth/reset", { token: tokenRef.current, password: pw });
      // bad_token, weak_password, slow_down and suspended keep their own messages; disabled, network and server errors
      // get the shared ones.
      if (!succeeded(p)) return setErr(authMessage(failureCode(p), lang, S as Record<string, string>));
      r.push(`/${lang}/app`);
      r.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="authform-t4" />{S.resetTitle}</span></h1>
      <form onSubmit={onSubmit} className="mt-6 grid gap-3">
        <input ref={pwRef} name="password" required autoFocus type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-label={S.resetTitle} aria-describedby="reset-rules" className={input} />
        <PasswordRules id="reset-rules" rules={rules} checks={checks} lang={lang} />
        {err && <p role="alert" className="text-sm text-danger">{err} {err === S.bad_token && <Link href={`/${lang}/app/forgot`} className="underline">{S.forgotTitle}</Link>}</p>}
        <button disabled={busy} aria-disabled={!ready ? true : undefined} aria-describedby="reset-rules" className="s-btn"><Scribble kind="pill" seed="authform-b4" fill="ink" shadow ring />{S.save}</button>
      </form>
    </div>
  );
}
