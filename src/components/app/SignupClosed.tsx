"use client";
import Link from "next/link";
import { useState } from "react";
import type { Lang } from "@/lib/i18n";
import { authMessage, failureCode, postJson, succeeded } from "@/lib/auth-client";
import Button from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import { Field, Input } from "@/components/ui/Field";

/**
 * The sign-up page while `SIGNUP_MODE=invite` (rule 3526, src/lib/signup-mode.ts): no sign-up form and no Google button,
 * a plain message in the page's language, and the waitlist. The waitlist box posts to POST /api/waitlist (its own
 * per-IP limit) and asks for an address only; it never creates a login.
 */
const C = {
  ar: {
    title: "التسجيل الآن بدعوة فقط",
    body: "نفتح ذكين لعدد محدود من الحسابات. إذا وصلتك دعوة من فريق، افتح رابط الدعوة من بريدك. وإن لم تصلك دعوة، اترك بريدك في قائمة الانتظار ونراسلك أول ما نفتح.",
    email: "بريدك",
    join: "انضم لقائمة الانتظار",
    done: "تم. سجّلنا بريدك في قائمة الانتظار.",
    bad: "اكتب بريدًا صحيحًا.",
    have: "عندك حساب؟",
    login: "سجّل الدخول",
  },
  en: {
    title: "Sign-up is by invitation only",
    body: "We are opening Thakeen to a limited number of accounts. If a team invited you, open the invite link from your email. If not, leave your email on the waitlist and we will write when we open.",
    email: "Your email",
    join: "Join the waitlist",
    done: "Done. Your email is on the waitlist.",
    bad: "Enter a valid email.",
    have: "Already have an account?",
    login: "Sign in",
  },
} as const;

export default function SignupClosed({ lang }: { lang: Lang }) {
  const T = C[lang];
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [err, setErr] = useState("");
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErr(T.bad);
    if (state === "busy") return;
    setState("busy");
    const p = await postJson("/api/waitlist", { email: email.trim(), lang });
    if (succeeded(p)) return setState("done");
    setState("idle");
    const code = failureCode(p);
    setErr(code === "bad_email" ? T.bad : authMessage(code === "slow_down" ? "slow_down_signup" : code, lang));
  }
  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="page-title">{T.title}</h1>
      <p className="mt-2 text-foreground-muted">{T.body}</p>
      {state === "done" ? (
        <div className="mt-6"><Callout tone="success">{T.done}</Callout></div>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 grid gap-3" aria-label={T.join}>
          <Field label={T.email}><Input name="email" required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" /></Field>
          {err && <Callout tone="danger">{err}</Callout>}
          <Button type="submit" variant="pill" seed="signup-closed-b1" loading={state === "busy"}>{T.join}</Button>
        </form>
      )}
      <p className="mt-4 text-sm text-foreground-muted">
        {T.have} <Link href={`/${lang}/app/login`} className="font-medium text-foreground underline">{T.login}</Link>
      </p>
    </div>
  );
}
