"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication, WebAuthnAbortService, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import PartnerCodeField from "./PartnerCodeField";
import { PLAN_CREDITS } from "@/lib/pricing";
import { authMessage, failureCode, passwordChecks, postJson, succeeded, unmetRules, type Posted } from "@/lib/auth-client";
import { suspendedMessage } from "@/lib/suspension";
import { PasswordRules } from "./PasswordRules";
import PasswordField from "./PasswordField";
import { Turnstile } from "./Turnstile";
import { safeNext } from "@/lib/safe-next";
import { readInviteToken as readFragmentToken, readRevertToken, withoutFragment } from "./inviteToken";
import Scribble from "@/components/Scribble";
import Face from "@/components/home/Face";
import { SIGNUP_NEXT, shownSite } from "@/lib/signup-preview";
import Button from "@/components/ui/Button";
import { buttonClass } from "@/components/ui/button-class";
import Callout from "@/components/ui/Callout";
import { Field, Input } from "@/components/ui/Field";
import { appHref } from "@/lib/ws-path";

// Every field has a visible label (rule 1090): a placeholder is an example and disappears as soon as someone types.

/** Sign in with Google (rules 1946-1953): drawn only when it is configured; every outcome comes back as `?google=`. */
const GOOGLE = {
  ar: {
    login: "ادخل بحساب Google", signup: "سجّل بحساب Google", or: "أو",
    google_failed: "ما قدرنا نكمل الدخول بـ Google. جرّب مرة ثانية.", google_cancelled: "ألغيت الدخول بـ Google.",
    google_no_account: "ما فيه حساب بهذا البريد. سجّل حساب جديد.", google_not_linked: "هذا البريد له حساب بكلمة مرور. ادخل بكلمة المرور، وبعدين اربط Google من إعدادات الأمان.",
    google_unverified_owner: "هذا البريد عليه حساب ما تأكد بريده. ادخل بكلمة المرور وأكّد البريد، أو استرد كلمة المرور.", google_taken: "حساب Google هذا مربوط بحساب ثاني.",
  },
  en: {
    login: "Sign in with Google", signup: "Sign up with Google", or: "or",
    google_failed: "We could not finish signing in with Google. Try again.", google_cancelled: "You cancelled signing in with Google.",
    google_no_account: "No account uses this email. Sign up instead.", google_not_linked: "This email has a password login. Sign in with the password, then link Google in Security settings.",
    google_unverified_owner: "This email has an account whose address is not confirmed yet. Sign in with the password and confirm it, or reset the password.", google_taken: "This Google account is linked to another login.",
  },
} as const;
type GoogleCode = Exclude<keyof (typeof GOOGLE)["en"], "login" | "signup" | "or">;
/** The `?google=` code as a message, or "" for anything this page does not know. */
function googleMessage(code: string | null, lang: Lang): string {
  if (!code) return "";
  return code in GOOGLE[lang] && !["login", "signup", "or"].includes(code) ? GOOGLE[lang][code as GoogleCode] : code === "slow_down" ? authMessage("slow_down", lang) : authMessage("invalid", lang);
}

function GoogleButton({ lang, mode, next, refCode = "" }: { lang: Lang; mode: "login" | "signup"; next: string; refCode?: string }) {
  const q = new URLSearchParams({ mode, lang, ...(next ? { next } : {}), ...(refCode ? { ref: refCode } : {}) });
  return (
    <div className="grid gap-3">
      {/* A plain link: the start route answers with a redirect to Google, so no script is needed. */}
      <a href={`/api/auth/google/start?${q.toString()}`} className={buttonClass({ variant: "secondary", block: true })}>{GOOGLE[lang][mode]}</a>
      <p className="text-center text-xs text-foreground-muted">{GOOGLE[lang].or}</p>
    </div>
  );
}

const SU = {
  ar: { emailStep: "ابدأ مجاناً", cont: "متابعة", edit: "تعديل", rules: ["8 أحرف على الأقل", "حرف واحد على الأقل", "رقم واحد على الأقل"], trial: `تجربة 3 أيام · ${PLAN_CREDITS.trial} كريدت · بدون بطاقة دفع`, legal1: "بالمتابعة أنت توافق على", terms: "الشروط", and: "و", privacy: "سياسة الخصوصية", nameOpt: "اسمك" },
  en: { emailStep: "Start free", cont: "Continue", edit: "Edit", rules: ["At least 8 characters", "At least one letter", "At least one number"], trial: `3-day trial · ${PLAN_CREDITS.trial} credits · no card required`, legal1: "By continuing you agree to the", terms: "Terms", and: "and", privacy: "Privacy Policy", nameOpt: "Your name" },
} as const;

/** Email first, then name and password with live requirements. Phone is asked later, inside onboarding. */
export function SignupForm({ t, lang, turnstileKey = null, google = false }: { t: AppDict; lang: Lang; turnstileKey?: string | null; google?: boolean }) {
  const r = useRouter();
  const sp = useSearchParams();
  const S = SU[lang];
  const ref = sp.get("ref") ?? "";
  const site = (sp.get("url") ?? "").slice(0, 300);
  const nextParam = sp.get("next") ?? "";
  const next = safeNext(nextParam);
  const [err, setErr] = useState(() => googleMessage(sp.get("google"), lang));
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
      // A new account has one brand, "default": its start page by name, no legacy hop (rule 890).
      const after = next || appHref(lang, `/start${site.length >= 4 ? `?url=${encodeURIComponent(site)}` : ""}`, null, "default");
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
      <p className="mt-2 text-foreground-muted">{t.signup.sub}</p>
      <SignupNext lang={lang} site={shownSite(site)} />
      {google && <div className="mt-6"><GoogleButton lang={lang} mode="signup" next={next} refCode={/^[A-Za-z0-9]{6,10}$/.test(ref) ? ref : ""} /></div>}
      <form onSubmit={onSubmit} className={google ? "mt-3 grid gap-3" : "mt-6 grid gap-3"}>
        {step === 1 ? (
          <Field label={t.signup.email}><Input name="email" required autoFocus type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" /></Field>
        ) : (
          <>
            <p className="flex items-center justify-between gap-2 rounded-lg bg-background-muted px-3 py-2 text-sm"><span dir="ltr" className="clip">{email}</span><button type="button" onClick={() => setStep(1)} className="text-xs text-foreground underline">{S.edit}</button></p>
            <Field label={S.nameOpt}><Input name="name" required autoFocus autoComplete="name" /></Field>
            <Field label={t.signup.password}>
              <PasswordField lang={lang} ref={pwRef} name="password" required autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-describedby="signup-rules" />
              <PasswordRules id="signup-rules" rules={S.rules} checks={checks} lang={lang} />
            </Field>
            {turnstileKey && <Turnstile siteKey={turnstileKey} onToken={setToken} resetKey={resetKey} lang={lang} />}
          </>
        )}
        {step === 2 && <PartnerCodeField lang={lang} />}
        {err && <Callout tone="danger">{err}</Callout>}
        <Button type="submit" variant="pill" seed="authform-b1" loading={busy} aria-disabled={step === 2 && !ready ? true : undefined} aria-describedby={step === 2 ? "signup-rules" : undefined}>{step === 1 ? S.cont : t.signup.submit}</Button>
      </form>
      <p className="mt-3 text-center text-xs text-foreground-muted">{S.trial}</p>
      <p className="mt-4 text-sm text-foreground-muted">
        {t.signup.have} <Link href={`/${lang}/app/login`} className="font-medium text-foreground underline">{t.signup.login}</Link>
      </p>
      <p className="mt-2 text-xs text-foreground-muted">{S.legal1} <Link href={`/${lang}/terms`} className="underline">{S.terms}</Link> {S.and} <Link href={`/${lang}/privacy`} className="underline">{S.privacy}</Link>.</p>
    </div>
  );
}

/**
 * Above the signup form (rule 1847): when the visitor brought a site from the home page, Noor's face and «نور تقرا:
 * <site>»; always, the three steps of the next few minutes and the trial's chat messages and credits.
 */
function SignupNext({ lang, site }: { lang: Lang; site: string }) {
  const N = SIGNUP_NEXT;
  return (
    <section className="s-card mt-5 grid gap-3 text-sm" aria-label={N.h[lang]}>
      <Scribble kind="box" seed="signup-next" fill="paper" />
      {site && (
        <p className="flex items-center gap-3 font-bold">
          <Face who="noor" seed="signup-noor" small />
          <span className="min-w-0">
            {N.reads[lang]}{" "}
            <bdi dir="ltr" className="break-all font-mono" data-testid="signup-site">{site}</bdi>
          </span>
        </p>
      )}
      <p className="font-bold">{N.h[lang]}</p>
      <ol className="grid list-decimal gap-1.5 ps-5">
        {N.steps[lang].map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p className="text-foreground-muted">{N.trial[lang]}</p>
    </section>
  );
}

const MFA = {
  ar: { title: "رمز الدخول", sub: "افتح تطبيق المصادقة في جوالك واكتب الرمز اللي يطلع لذكين. ضاع جوالك؟ اكتب واحد من رموز الاسترداد.", code: "الرمز", submit: "ادخل", back: "رجوع", bad_code: "الرمز غير صحيح أو انتهى. جرّب الرمز اللي بعده.", mfa_expired: "انتهت المهلة. اكتب كلمة المرور من جديد." },
  en: { title: "Sign-in code", sub: "Open the authenticator app on your phone and type the code it shows for Thakeen. Lost your phone? Type one of your recovery codes.", code: "Code", submit: "Sign in", back: "Back", bad_code: "That code is wrong or expired. Try the next one.", mfa_expired: "Time ran out. Type your password again." },
} as const;

/** WebAuthn support never changes while the page is open, so nothing is ever signalled. */
const noChange = () => () => {};
const unknownOnServer = (): boolean | null => null;

/**
 * Whether "Sign in with a passkey" is drawn (rules 2426, 2429): passkeys on and the browser's WebAuthn support known and
 * true. `null` (always on the server and during hydration) draws nothing, so server and browser HTML agree.
 */
export const showPasskeyButton = (passkeysEnabled: boolean, supported: boolean | null): boolean => passkeysEnabled && supported === true;

/** The browser's own "no": the person dismissed the prompt, or a newer ceremony replaced this one. Never shown. */
const declined = (e: unknown): boolean => e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError");

/** The waiting autofill is replaced with fresh options this often, inside the challenge's 300 s life (rule 2408). */
export const AUTOFILL_REFRESH_MS = 270_000;
/** Settles in a row (each quicker than `AUTOFILL_PATIENT_MS`) after which the autofill stops until the button is used. */
export const AUTOFILL_MAX_FAILURES = 3;
/** The wait before the first re-arm after a failure; it doubles with each failure in a row. */
export const AUTOFILL_BACKOFF_MS = 2_000;
/** A ceremony that waited at least this long ended by the person or the browser's own timeout, not by a tight loop. */
export const AUTOFILL_PATIENT_MS = 30_000;

/**
 * What the log-in form does after its autofill ceremony settles (fix round 1 of rule 2426's conditional UI). A sign-in
 * navigates away, so nothing is re-armed. Any other end (a dismissal, a browser error, a refused options or verify call)
 * re-arms after a back-off that doubles with each failure in a row, and stops after `AUTOFILL_MAX_FAILURES`, so a browser
 * that refuses conditional requests at once never loops. A ceremony that ended with no verify answer (`"ended"`: a
 * dismissal, a browser error or timeout, refused options) after waiting `AUTOFILL_PATIENT_MS` or more starts the count
 * again: that wait was the person's or the browser's, not a loop. A verify answer that refused (`"refused"`) always
 * counts, however long the person waited first, so a passkey that keeps failing reaches the stop (and its message).
 * `rearmIn` is null when the autofill stops.
 */
export function nextAutofill(failures: number, end: "signed_in" | "refused" | "ended", waitedMs: number): { failures: number; rearmIn: number | null } {
  if (end === "signed_in") return { failures: 0, rearmIn: null };
  const inRow = (end === "ended" && waitedMs >= AUTOFILL_PATIENT_MS ? 0 : failures) + 1;
  return { failures: inRow, rearmIn: inRow >= AUTOFILL_MAX_FAILURES ? null : AUTOFILL_BACKOFF_MS * 2 ** (inRow - 1) };
}

/**
 * One passkey sign-in (spec flow C): fresh options (which set the `thakeen_pk` cookie), the browser's ceremony, then the
 * verify route. `autofill` waits for the person to pick a passkey from the address field's suggestions (conditional UI).
 * `stage` says which request answered, so the autofill can stay silent when the options are refused. `signal` cancels
 * the options request (the autofill's cleanup); the verify request is never cancelled, so a sign-in the server finished
 * is never cut in half. `picked` runs once the person chose a passkey, before the verify request.
 */
async function passkeyCeremony(autofill: boolean, signal?: AbortSignal, picked?: () => void): Promise<{ stage: "options" | "verify"; p: Posted }> {
  const o = await postJson("/api/auth/passkey/options", {}, (url, init) => fetch(url, { ...init, signal }));
  if (signal?.aborted) throw new DOMException("The options request was cancelled.", "AbortError");
  if (!succeeded(o)) return { stage: "options", p: o };
  const response = await startAuthentication({ optionsJSON: o.body.options as PublicKeyCredentialRequestOptionsJSON, useBrowserAutofill: autofill });
  picked?.();
  return { stage: "verify", p: await postJson("/api/auth/passkey/verify", { response }) };
}

export function LoginForm({ t, lang, google = false, passkeys = false }: { t: AppDict; lang: Lang; google?: boolean; passkeys?: boolean }) {
  const r = useRouter();
  const sp = useSearchParams();
  const nextParam = sp.get("next") ?? "";
  const next = safeNext(nextParam);
  const [err, setErr] = useState(() => googleMessage(sp.get("google"), lang));
  const [busy, setBusy] = useState(false);
  // Two-step sign-in (rule 1934): the password was right and the account wants a code; no session exists yet. A Google
  // sign-in that needs the code comes back here with `?mfa=1` and the challenge cookie already set.
  const [mfa, setMfa] = useState(sp.get("mfa") === "1");
  const M = MFA[lang];
  const supported = useSyncExternalStore(noChange, browserSupportsWebAuthn, unknownOnServer);
  // The autofill ceremony is re-armed by bumping `arm` (an effect dependency); `leaving` stops it once a sign-in navigates.
  const [arm, setArm] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const autofillFailures = useRef(0);
  function arrive(p: { body: Record<string, unknown> }) {
    setLeaving(true);
    // An owner who has not proved the address goes to the code page first, carrying the destination (rule 754), so a
    // `next` outside the app (the OAuth consent page) is reached after the code instead of looping back here.
    if (p.body.verify === true) { r.push(`/${lang}/app/verify?next=${encodeURIComponent(next || appHref(lang))}`); return; }
    if (next) { window.location.href = next; return; }
    r.push(appHref(lang));
    r.refresh();
  }
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const p = await postJson("/api/auth/login", Object.fromEntries(new FormData(e.currentTarget)));
      if (p.body.mfa === true) { setMfa(true); return; }
      // "Wrong email or password" only for a 401: a rate limit, a dropped connection and a server error each say so,
      // so a customer with the right password is not sent to a reset (rule 433).
      if (!succeeded(p)) return setErr(authMessage(failureCode(p), lang, { invalid: t.login.invalid, suspended: suspendedMessage(p.body.until, lang, t.login.suspended) }));
      arrive(p);
    } finally {
      setBusy(false);
    }
  }
  /** A passkey answer: the password path's redirect on success (the `verify` flag included), otherwise one line. */
  function afterPasskey(p: Posted) {
    if (succeeded(p)) return arrive(p);
    const code = failureCode(p);
    setErr(authMessage(code, lang, { passkey_failed: t.login.passkeyFailed, invalid: t.login.passkeyFailed, suspended: suspendedMessage(p.body.until, lang, t.login.suspended) }));
  }
  async function onPasskey() {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      // `busy` ends the waiting autofill (its effect's cleanup), so the two ceremonies never race for the cookie.
      afterPasskey((await passkeyCeremony(false)).p);
    } catch (e) {
      if (!declined(e)) setErr(t.login.passkeyFailed);
    } finally {
      setBusy(false);
      // The button counts as a fresh start: the autofill is armed again (not once the sign-in navigates, `leaving`).
      autofillFailures.current = 0;
      setArm((n) => n + 1);
    }
  }
  // Conditional UI (rule 2426): offered only when passkeys are on and the browser can suggest passkeys in the address
  // field. It waits in the background and never blocks the password form. Once it settles it is armed again (after a
  // back-off, `nextAutofill`), and it is replaced with fresh options before the 300 s challenge expires. A refused
  // options call and a dismissed prompt say nothing; a `passkey_failed` answer says nothing while the autofill re-arms,
  // and is shown when it stops, so a passkey that keeps failing is never met with silence.
  const onAutofill = useEffectEvent((r: { stage: "options" | "verify"; p: Posted } | null, waitedMs: number): number | null => {
    const signedIn = r?.stage === "verify" && succeeded(r.p);
    const step = nextAutofill(autofillFailures.current, signedIn ? "signed_in" : r?.stage === "verify" ? "refused" : "ended", waitedMs);
    autofillFailures.current = step.failures;
    // A sign-in navigates; another verify answer is shown, except a `passkey_failed` that is re-armed silently.
    if (r?.stage === "verify" && (signedIn || failureCode(r.p) !== "passkey_failed" || step.rearmIn === null)) afterPasskey(r.p);
    return step.rearmIn;
  });
  useEffect(() => {
    if (!passkeys || mfa || busy || leaving || autofillFailures.current >= AUTOFILL_MAX_FAILURES) return;
    let live = true;
    const started = Date.now();
    const options = new AbortController();
    const again = () => setArm((n) => n + 1);
    let backoff: ReturnType<typeof setTimeout> | undefined;
    // Fresh options before the challenge (and its cookie) expire: the bump re-runs this effect, whose cleanup cancels.
    const refresh = setTimeout(again, AUTOFILL_REFRESH_MS);
    const settle = (r: { stage: "options" | "verify"; p: Posted } | null) => {
      if (!live) return;
      clearTimeout(refresh);
      const rearmIn = onAutofill(r, Date.now() - started);
      if (rearmIn !== null) backoff = setTimeout(again, rearmIn);
    };
    void (async () => {
      let r: { stage: "options" | "verify"; p: Posted };
      try {
        const can = await browserSupportsWebAuthnAutofill();
        if (!live) return;
        if (!can) return clearTimeout(refresh);
        // Once a passkey is picked the refresh must not cut the verify request off.
        r = await passkeyCeremony(true, options.signal, () => clearTimeout(refresh));
      } catch {
        // Dismissed, refused by the browser, or cancelled by this effect's cleanup (then `live` is false and nothing runs).
        return settle(null);
      }
      settle(r);
    })();
    // Leaving the page, switching to the code step, the button or a re-arm ends the waiting ceremony and its options call.
    return () => {
      live = false;
      clearTimeout(refresh);
      clearTimeout(backoff);
      options.abort();
      WebAuthnAbortService.cancelCeremony();
    };
  }, [passkeys, mfa, busy, leaving, arm]);
  async function onCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const p = await postJson("/api/auth/login/mfa", { code: String(new FormData(e.currentTarget).get("code") ?? "") });
      if (!succeeded(p)) {
        const code = failureCode(p);
        if (code === "mfa_expired") setMfa(false);
        return setErr(authMessage(code, lang, { invalid: t.login.invalid, suspended: suspendedMessage(p.body.until, lang, t.login.suspended), bad_code: M.bad_code, mfa_expired: M.mfa_expired }));
      }
      arrive(p);
    } finally {
      setBusy(false);
    }
  }
  if (mfa) {
    return (
      <div className="mx-auto w-full max-w-md">
        <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="authform-t2" />{M.title}</span></h1>
        <p className="mt-2 text-foreground-muted">{M.sub}</p>
        <form onSubmit={onCode} className="mt-6 grid gap-3">
          <Field label={M.code}><Input name="code" required autoFocus inputMode="text" autoComplete="one-time-code" dir="ltr" maxLength={40} /></Field>
          {err && <Callout tone="danger">{err}</Callout>}
          <Button type="submit" variant="pill" seed="authform-b2" loading={busy}>{M.submit}</Button>
          <button type="button" onClick={() => { setMfa(false); setErr(""); }} className="text-center text-sm text-foreground-muted underline">{M.back}</button>
        </form>
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="authform-t2" />{t.login.title}</span></h1>
      {google && <div className="mt-6"><GoogleButton lang={lang} mode="login" next={next} /></div>}
      <form onSubmit={onSubmit} className={google ? "mt-3 grid gap-3" : "mt-6 grid gap-3"}>
        {/* `webauthn` lets the browser offer saved passkeys in the address field's suggestions (conditional UI). */}
        <Field label={t.login.email}><Input name="email" required type="email" autoComplete={passkeys ? "username webauthn" : "username"} /></Field>
        <Field label={t.login.password}><PasswordField lang={lang} name="password" required autoComplete="current-password" /></Field>
        {err && <Callout tone="danger">{err}</Callout>}
        <Button type="submit" variant="pill" seed="authform-b2" loading={busy}>{t.login.submit}</Button>
        {showPasskeyButton(passkeys, supported) && <Button type="button" variant="secondary" block onClick={onPasskey}>{t.login.passkey}</Button>}
        <Link href={`/${lang}/app/forgot`} className="text-center text-sm text-foreground-muted underline">{lang === "ar" ? "نسيت كلمة المرور؟" : "Forgot your password?"}</Link>
      </form>
      <p className="mt-4 text-sm text-foreground-muted">
        {t.login.noAccount} <Link href={`/${lang}/app/signup`} className="font-medium text-foreground underline">{t.login.signup}</Link>
      </p>
    </div>
  );
}

const PW = {
  ar: { forgotTitle: "استرداد كلمة المرور", forgotSub: "اكتب بريد حسابك ونرسل لك رابطاً صالحاً لساعة واحدة.", send: "أرسل الرابط", sentMail: "إذا كان لهذا البريد حساب فسيصله رابط خلال دقائق. تفقد البريد غير المرغوب أيضاً.", noMail: "إرسال البريد غير مفعّل حالياً في ذكين، فلن يصلك رابط. تواصل مع الدعم ونعيد تعيين كلمة مرورك يدوياً.", support: "تواصل مع الدعم على واتساب", back: "رجوع لتسجيل الدخول", resetTitle: "كلمة مرور جديدة", save: "حفظ والدخول", bad_token: "الرابط غير صالح أو انتهت صلاحيته. اطلب رابطاً جديداً.", weak_password: "كلمة المرور لا تحقق الشروط.", slow_down: "محاولات كثيرة. حاول بعد ربع ساعة.", suspended: "الحساب موقوف. تواصل مع الدعم.", bad_email: "بريد غير صحيح", email: "البريد الإلكتروني" },
  en: { forgotTitle: "Reset your password", forgotSub: "Enter your account email and we send a link valid for one hour.", send: "Send the link", sentMail: "If this email has an account, a link arrives within minutes. Check spam too.", noMail: "Email delivery is not enabled on Thakeen yet, so no link can reach you. Contact support and we reset your password manually.", support: "Contact support on WhatsApp", back: "Back to log in", resetTitle: "New password", save: "Save and log in", bad_token: "This link is invalid or expired. Request a new one.", weak_password: "The password does not meet the rules.", slow_down: "Too many attempts. Try again in 15 minutes.", suspended: "This account is suspended. Contact support.", bad_email: "Invalid email", email: "Email" },
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
      <p className="mt-2 text-foreground-muted">{S.forgotSub}</p>
      {state === "sent" || state === "nomail" ? (
        <Callout tone={state === "sent" ? "success" : "warning"} className="mt-6">
          <p>{state === "sent" ? S.sentMail : S.noMail}</p>
          {state === "nomail" && whatsapp && <a href={whatsapp} target="_blank" rel="noreferrer" className={buttonClass({ size: "md", className: "mt-3" })}>{S.support}</a>}
        </Callout>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 grid gap-3">
          <Field label={S.email}><Input name="email" required autoFocus type="email" autoComplete="email" placeholder="name@company.com" /></Field>
          {turnstileKey && <Turnstile siteKey={turnstileKey} onToken={setToken} resetKey={resetKey} lang={lang} />}
          {err && <Callout tone="danger">{err}</Callout>}
          <Button type="submit" variant="pill" seed="authform-b3" loading={state === "busy"}>{S.send}</Button>
        </form>
      )}
      <p className="mt-4 text-sm"><Link href={`/${lang}/app/login`} className="text-foreground underline">{S.back}</Link></p>
    </div>
  );
}

/**
 * The reset link is /{lang}/app/reset#t=<64 hex> (../../app/api/auth/forgot/route.ts). The token rides in the URL
 * fragment, which browsers never send to a server, so it stays out of server, proxy and edge logs and the Referer header,
 * the same way team invite links work. It is read once on the client, taken out of the address bar and history, and
 * posted in a JSON body. A `?token=` query is never read. Rules 546-547.
 *
 * Account-id R2 (rule 2744): the same page opens the REVERT link of an address move, #r=<64 hex>, mailed to the old
 * address. Nothing changes on load (mail scanners open links and run scripts): the page reads the token, takes it out
 * of the address bar and shows a confirm screen; only its one button posts the token to /api/auth/email-revert, which
 * moves the login back, ends every session and answers a one-hour reset token. The form then sets the new password with
 * it, as after a reset link.
 */
const REVERT_ASK = {
  ar: { title: "ترجّع بريد الدخول القديم؟", body: "هذا الرابط يرجّع بريد الدخول القديم لحسابك، ويطلّع كل الأجهزة، ويشيل كلمة المرور ومفاتيح المرور والتحقق بخطوتين وربط Google. اضغط الزر بس إذا كان هذا بريدك القديم وما غيّرته أنت.", go: "رجّع بريدي القديم" },
  en: { title: "Put your old sign-in email back?", body: "This link puts your old sign-in email back on your account, signs out every device and removes the password, passkeys, two-step sign-in and the Google link. Press the button only if this is your old email and you did not make the change.", go: "Undo the email change" },
} as const;

const REVERT_COPY = {
  ar: { done: "رجّعنا بريد الدخول القديم وطلّعنا كل الأجهزة. حط كلمة مرور جديدة الحين.", failed: "رابط الاسترجاع غير صالح أو انتهى أو انستخدم. تواصل مع الدعم من بريدك القديم." },
  en: { done: "Your old sign-in email is back and every device was signed out. Set a new password now.", failed: "This undo link is invalid, expired or already used. Contact support from your old email." },
} as const;

export function ResetForm({ lang }: { lang: Lang }) {
  const r = useRouter();
  const tokenRef = useRef("");
  const undoRef = useRef("");
  const [revert, setRevert] = useState<"" | "confirm" | "done" | "failed">("");
  const [undoing, setUndoing] = useState(false);
  useEffect(() => {
    tokenRef.current ||= readFragmentToken(window.location.hash);
    undoRef.current ||= readRevertToken(window.location.hash);
    if (window.location.hash) window.history.replaceState(window.history.state, "", withoutFragment(window.location));
    // Read only: the revert waits for the person's own click (onUndo).
    if (undoRef.current) setRevert("confirm");
  }, []);
  async function onUndo() {
    if (undoing || !undoRef.current) return;
    setUndoing(true);
    try {
      const p = await postJson("/api/auth/email-revert", { token: undoRef.current });
      undoRef.current = "";
      if (succeeded(p) && typeof p.body.reset === "string") {
        tokenRef.current = p.body.reset;
        setRevert("done");
      } else setRevert("failed");
    } finally {
      setUndoing(false);
    }
  }
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
      // The password is saved, and two-step sign-in is on (rule 2300): no session yet. The challenge cookie is set, so the
      // log-in page opens straight on its code step, as after a Google sign-in that needs the code.
      if (p.body.mfa === true) { r.push(`/${lang}/app/login?mfa=1`); return; }
      // bad_token, weak_password, slow_down and suspended keep their own messages; disabled, network and server errors
      // get the shared ones.
      if (!succeeded(p)) return setErr(authMessage(failureCode(p), lang, { ...(S as Record<string, string>), suspended: suspendedMessage(p.body.until, lang, S.suspended) }));
      r.push(appHref(lang));
      r.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="authform-t4" />{S.resetTitle}</span></h1>
      {revert === "confirm" ? (
        <div className="mt-6 grid gap-3">
          <Callout tone="info"><strong>{REVERT_ASK[lang].title}</strong> {REVERT_ASK[lang].body}</Callout>
          <Button type="button" variant="pill" seed="authform-b4u" loading={undoing} onClick={onUndo}>{REVERT_ASK[lang].go}</Button>
        </div>
      ) : (<>
      {revert && <div className="mt-4"><Callout tone={revert === "done" ? "info" : "danger"}>{REVERT_COPY[lang][revert]}</Callout></div>}
      <form onSubmit={onSubmit} className="mt-6 grid gap-3">
        <Field label={S.resetTitle}>
          <PasswordField lang={lang} ref={pwRef} name="password" required autoFocus autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-describedby="reset-rules" />
          <PasswordRules id="reset-rules" rules={rules} checks={checks} lang={lang} />
        </Field>
        {err && <Callout tone="danger">{err} {err === S.bad_token && <Link href={`/${lang}/app/forgot`} className="underline">{S.forgotTitle}</Link>}</Callout>}
        <Button type="submit" variant="pill" seed="authform-b4" loading={busy} aria-disabled={!ready ? true : undefined} aria-describedby="reset-rules">{S.save}</Button>
      </form>
      </>)}
    </div>
  );
}
