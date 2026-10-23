"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import { authMessage, failureCode, postJson, succeeded } from "@/lib/auth-client";
import { readMagicToken } from "@/lib/magic-token";
import { suspendedMessage } from "@/lib/suspension";
import { appHref } from "@/lib/ws-path";
import Scribble from "@/components/Scribble";
import Button from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import { Field, Input } from "@/components/ui/Field";
import { Turnstile } from "./Turnstile";
import { withoutFragment } from "./inviteToken";

/**
 * The magic link's two screens (rules 3415-3417), drawn only while AUTH_ENGINE=better-auth: the log-in form's "Email link"
 * tab (`MagicRequest`) and the page the mailed link opens (`MagicLanding`, `/{lang}/app/magic#t=…`).
 */
export const MAGIC_COPY = {
  ar: {
    sub: "نرسل لبريدك رابطاً تدخل به بدون كلمة المرور، صالحاً لمدة 15 دقيقة ولمرة واحدة.",
    email: "البريد الإلكتروني",
    send: "أرسل رابط الدخول",
    sent: "إذا كان لهذا البريد حساب يقدر يدخل الحين فسيصله رابط الدخول خلال دقائق. تفقد البريد غير المرغوب أيضاً.",
    noMail: "إرسال البريد غير مفعّل حالياً في ذكين، فلن يصلك رابط. ادخل بكلمة المرور.",
    bad_email: "بريد غير صحيح",
    title: "رابط الدخول",
    landing: "اضغط الزر لتدخل إلى حسابك في ذكين.",
    go: "ادخل",
    missing: "الرابط ناقص. افتح الرابط من رسالة البريد كما هو، أو اطلب رابطاً جديداً.",
    bad_token: "الرابط غير صالح أو انتهت صلاحيته أو استُخدم من قبل. اطلب رابطاً جديداً.",
    again: "اطلب رابطاً جديداً",
  },
  en: {
    sub: "We email you a link that signs you in without the password. It works once, for 15 minutes.",
    email: "Email",
    send: "Send the sign-in link",
    sent: "If this email has an account that can sign in now, the link arrives within minutes. Check spam too.",
    noMail: "Email delivery is not enabled on Thakeen yet, so no link can reach you. Sign in with the password.",
    bad_email: "Invalid email",
    title: "Sign-in link",
    landing: "Press the button to sign in to your Thakeen account.",
    go: "Sign in",
    missing: "This link is incomplete. Open the link from the email as it is, or request a new one.",
    bad_token: "This link is invalid, expired or already used. Request a new one.",
    again: "Request a new link",
  },
} as const;

/**
 * The "Email link" tab of the log-in form (rule 3417): one address, Turnstile when configured, and the same answer for
 * every address (`{ok: true, mail}`), as the reset form. POST /api/better-auth/sign-in/magic-link.
 */
export function MagicRequest({ lang, turnstileKey = null }: { lang: Lang; turnstileKey?: string | null }) {
  const S = MAGIC_COPY[lang];
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
      const p = await postJson("/api/better-auth/sign-in/magic-link", { email, lang, ...(turnstileKey ? { turnstile: token } : {}) });
      if (!succeeded(p)) {
        if (turnstileKey) setResetKey((k) => k + 1);
        return setErr(authMessage(failureCode(p), lang, { bad_email: S.bad_email }));
      }
      done = p.body.mail ? "sent" : "nomail";
    } finally {
      setState(done ?? "idle");
    }
  }
  if (state === "sent" || state === "nomail") return <Callout tone={state === "sent" ? "success" : "warning"}>{state === "sent" ? S.sent : S.noMail}</Callout>;
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <p className="text-sm text-foreground-muted">{S.sub}</p>
      <Field label={S.email}><Input name="email" required type="email" autoComplete="username" placeholder="name@company.com" /></Field>
      {turnstileKey && <Turnstile siteKey={turnstileKey} onToken={setToken} resetKey={resetKey} lang={lang} />}
      {err && <Callout tone="danger">{err}</Callout>}
      <Button type="submit" variant="pill" seed="authform-b5" loading={state === "busy"}>{S.send}</Button>
    </form>
  );
}

/**
 * The page a sign-in link opens (rule 3416). The token is read from the fragment once, then taken out of the address bar
 * and history (rule 546). Nothing happens on load: mail scanners open links and run scripts, and a link is single use,
 * so only the person's own press posts it to POST /api/auth/magic. The answers are the log-in form's: a session (the
 * verify page first for an owner who owes the address code, rule 754), the two-step code step (`?mfa=1`, the challenge
 * cookie is set), or one line.
 */
export function MagicLanding({ lang, login }: { lang: Lang; login: AppDict["login"] }) {
  const S = MAGIC_COPY[lang];
  const r = useRouter();
  const tokenRef = useRef("");
  const [state, setState] = useState<"reading" | "ready" | "missing" | "busy" | "leaving">("reading");
  const [err, setErr] = useState("");
  useEffect(() => {
    tokenRef.current ||= readMagicToken(window.location.hash);
    if (window.location.hash) window.history.replaceState(window.history.state, "", withoutFragment(window.location));
    setState(tokenRef.current ? "ready" : "missing");
  }, []);
  async function onGo() {
    if (state !== "ready" || !tokenRef.current) return;
    setState("busy");
    setErr("");
    let next: "ready" | "missing" | "leaving" = "missing";
    try {
      const p = await postJson("/api/auth/magic", { token: tokenRef.current });
      // Any answer from the server used the link (or found it dead): it is never posted twice.
      if (p.status !== 0) tokenRef.current = "";
      if (p.body.mfa === true) { next = "leaving"; r.push(`/${lang}/app/login?mfa=1`); return; }
      if (succeeded(p)) {
        next = "leaving";
        if (p.body.verify === true) { r.push(`/${lang}/app/verify?next=${encodeURIComponent(appHref(lang))}`); return; }
        r.push(appHref(lang));
        r.refresh();
        return;
      }
      if (p.status === 0) next = "ready";
      setErr(authMessage(failureCode(p), lang, { bad_token: S.bad_token, invalid: S.bad_token, suspended: suspendedMessage(p.body.until, lang, login.suspended) }));
    } finally {
      setState(next);
    }
  }
  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="magic-t1" />{S.title}</span></h1>
      {state === "missing" && !err && <div className="mt-6"><Callout tone="warning">{S.missing}</Callout></div>}
      {(state === "ready" || state === "busy") && (
        <div className="mt-6 grid gap-3">
          <p className="text-foreground-muted">{S.landing}</p>
          {err && <Callout tone="danger">{err}</Callout>}
          <Button type="button" variant="pill" seed="magic-b1" loading={state === "busy"} onClick={onGo}>{S.go}</Button>
        </div>
      )}
      {state === "missing" && err && <div className="mt-6"><Callout tone="danger">{err}</Callout></div>}
      {state === "missing" && <p className="mt-4 text-sm"><Link href={`/${lang}/app/login?tab=link`} className="text-foreground underline">{S.again}</Link></p>}
    </div>
  );
}
