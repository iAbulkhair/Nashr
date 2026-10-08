"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Lang } from "@/lib/i18n";
import Scribble from "@/components/Scribble";
import LogoutButton from "./LogoutButton";
import { authMessage, failureCode, succeeded } from "@/lib/auth-client";
import { safeNext } from "@/lib/safe-next";
import { retryWait, typedDigits, waitLabel } from "@/lib/verify-client";

const input = "input";

const V = {
  ar: {
    title: "تحقق من بريدك",
    sentTo: "أرسلنا رمزاً من 6 أرقام إلى",
    codeLabel: "الرمز المكوّن من 6 أرقام",
    confirm: "تأكيد",
    resend: "إرسال رمز جديد",
    wrong: (n: number) => (n === 1 ? "الرمز غير صحيح. باقي محاولة واحدة" : n === 2 ? "الرمز غير صحيح. باقي محاولتان" : `الرمز غير صحيح. باقي ${n} محاولات`),
    sixDigits: "اكتب الرمز المكوّن من 6 أرقام.",
    ended: "انتهى الرمز. اطلب رمزاً جديداً",
    changeLink: "البريد خطأ؟ غيّره",
    changeLabel: "البريد الصحيح",
    changeSend: "تغيير البريد وإرسال رمز",
    cancel: "إلغاء",
    mailOff: "لا نستطيع إرسال البريد الآن. راسلنا على واتساب",
    support: "راسلنا على واتساب",
    notSent: "لم نرسل الرمز بعد. اضغط «إرسال رمز جديد».",
    sendFailed: "تعذّر إرسال الرمز. حاول مرة أخرى بعد قليل.",
    tooMany: "محاولات كثيرة. حاول مرة أخرى لاحقاً.",
    exists: "هذا البريد مسجّل لدينا. جرّب بريداً آخر.",
    badEmail: "اكتب بريداً صحيحاً.",
    sameEmail: "هذا هو البريد الحالي. اكتب البريد الصحيح.",
    notAllowed: "لا يمكن تغيير البريد لهذا الحساب.",
    logout: "خروج",
  },
  en: {
    title: "Check your email",
    sentTo: "We sent a 6-digit code to",
    codeLabel: "The 6-digit code",
    confirm: "Confirm",
    resend: "Send a new code",
    wrong: (n: number) => `Wrong code. ${n} ${n === 1 ? "try" : "tries"} left`,
    sixDigits: "Type the 6-digit code.",
    ended: "This code has ended. Ask for a new one",
    changeLink: "Wrong email? Change it",
    changeLabel: "The right email",
    changeSend: "Change email and send a code",
    cancel: "Cancel",
    mailOff: "We cannot send email right now. Message us on WhatsApp",
    support: "Message us on WhatsApp",
    notSent: "The code has not been sent yet. Press “Send a new code”.",
    sendFailed: "We could not send the code. Try again shortly.",
    tooMany: "Too many tries. Try again later.",
    exists: "That email already has an account. Try another.",
    badEmail: "Type a valid email.",
    sameEmail: "That is the current email. Type the right one.",
    notAllowed: "The email cannot be changed on this account.",
    logout: "Log out",
  },
} as const;

type Reply = { status: number; body: Record<string, unknown>; retry: string | null };

/** POST JSON and never throw (`postJson` in auth-client.ts drops the `Retry-After` header, which the countdown needs). */
async function post(url: string, data: unknown): Promise<Reply> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const body: unknown = await res.json().catch(() => ({}));
    return { status: res.status, body: body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}, retry: res.headers.get("Retry-After") };
  } catch {
    return { status: 0, body: {}, retry: null };
  }
}

/**
 * The code page for an owner who has not proved the address (rule 754). `autoSend` is set when no code is waiting (a login
 * that lands here), so the page asks for one once on open; right after signup the first code is already on its way.
 * `mailOn` false means this deploy cannot send mail: the WhatsApp line shows at once. The code and the address are never
 * put in a URL; the code goes in a JSON body and is not logged.
 */
export default function VerifyForm({ lang, email, canChangeEmail, autoSend, mailOn, whatsapp, next }: { lang: Lang; email: string; canChangeEmail: boolean; autoSend: boolean; mailOn: boolean; whatsapp: string | null; next: string }) {
  const r = useRouter();
  const S = V[lang];
  const dest = safeNext(next) || `/${lang}/app`;
  const login = `/${lang}/app/login`;
  const [shown, setShown] = useState(email);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [wait, setWait] = useState(0);
  const [mailDown, setMailDown] = useState(!mailOn);
  const [changing, setChanging] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [moving, setMoving] = useState(false);
  const sentOnce = useRef(false);

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  async function sendCode() {
    if (sending) return;
    setSending(true);
    setErr("");
    setInfo("");
    const p = await post("/api/auth/verify/send", {});
    setSending(false);
    if (succeeded(p)) {
      setMailDown(false);
      setWait(typeof p.body.resendIn === "number" ? Math.ceil(p.body.resendIn) : 60);
      return;
    }
    if (p.status === 401) return r.replace(login);
    if (p.status === 409 && p.body.error === "already_verified") return window.location.assign(dest);
    if (p.status === 503 && p.body.error === "mail_unavailable") return setMailDown(true);
    if (p.status === 429) {
      setWait(retryWait(p.retry));
      return;
    }
    setErr(p.body.error === "send_failed" ? S.sendFailed : authMessage(failureCode(p), lang));
  }

  useEffect(() => {
    if (!autoSend || !mailOn || sentOnce.current) return;
    sentOnce.current = true;
    void sendCode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setErr("");
    const digits = typedDigits(code);
    if (digits.length !== 6) return setErr(S.sixDigits);
    setBusy(true);
    const p = await post("/api/auth/verify/check", { code: digits });
    if (succeeded(p)) return window.location.assign(dest);
    setBusy(false);
    if (p.status === 401) return r.replace(login);
    if (p.status === 429) return setErr(S.tooMany);
    const reason = p.body.error;
    if (reason === "expired" || reason === "locked") {
      setCode("");
      return setErr(S.ended);
    }
    if (reason === "wrong_code") return setErr(typeof p.body.attemptsLeft === "number" ? S.wrong(p.body.attemptsLeft) : S.sixDigits);
    setErr(authMessage(failureCode(p), lang));
  }

  async function onChangeEmail(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (moving) return;
    setErr("");
    const to = newEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return setErr(S.badEmail);
    setMoving(true);
    const p = await post("/api/auth/verify/email", { email: to });
    setMoving(false);
    if (!succeeded(p)) {
      if (p.status === 401) return r.replace(login);
      if (p.status === 429) return setErr(S.tooMany);
      const reason = p.body.error;
      if (reason === "exists") return setErr(S.exists);
      if (reason === "bad_email") return setErr(S.badEmail);
      if (reason === "same_email") return setErr(S.sameEmail);
      if (reason === "not_allowed") return setErr(S.notAllowed);
      return setErr(authMessage(failureCode(p), lang));
    }
    // The session is now for the new address. A code that was not sent leaves the resend button open at once.
    setShown(typeof p.body.email === "string" ? p.body.email : to);
    setChanging(false);
    setNewEmail("");
    setCode("");
    if (p.body.mail === false) {
      setWait(0);
      setInfo(S.notSent);
    } else {
      setMailDown(false);
      setWait(60);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="verify-t1" />{S.title}</span></h1>
      <p className="mt-2 text-ink/70">
        {S.sentTo} <span dir="ltr" className="clip font-medium text-ink">{shown}</span>
      </p>
      {mailDown && (
        <div role="status" className="mt-4 rounded-xl border border-ink/10 bg-ground p-4 text-sm">
          <p>{S.mailOff}</p>
          {whatsapp && <a href={whatsapp} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm mt-3">{S.support}</a>}
        </div>
      )}
      <form onSubmit={onSubmit} className="mt-6 grid gap-3">
        <input
          name="code"
          required
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={12}
          dir="ltr"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="••••••"
          aria-label={S.codeLabel}
          className={`${input} text-center text-xl tracking-[0.4em]`}
        />
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
        {info && <p role="status" className="text-sm text-ink/70">{info}</p>}
        <button disabled={busy} className="s-btn"><Scribble kind="pill" seed="verify-b1" fill="ink" shadow ring />{S.confirm}</button>
      </form>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <button type="button" onClick={sendCode} disabled={wait > 0 || sending} className="btn btn-secondary btn-sm">
          {wait > 0 ? `${S.resend} ${waitLabel(wait, lang)}` : S.resend}
        </button>
        {canChangeEmail && !changing && (
          <button type="button" onClick={() => { setChanging(true); setErr(""); }} className="text-ink underline">{S.changeLink}</button>
        )}
      </div>
      {canChangeEmail && changing && (
        <form onSubmit={onChangeEmail} className="mt-4 grid gap-3">
          <input name="email" required autoFocus type="email" autoComplete="email" dir="ltr" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="name@company.com" aria-label={S.changeLabel} className={input} />
          <div className="flex flex-wrap items-center gap-3">
            <button disabled={moving} className="btn btn-secondary btn-sm">{S.changeSend}</button>
            <button type="button" onClick={() => { setChanging(false); setErr(""); }} className="text-sm text-ink underline">{S.cancel}</button>
          </div>
        </form>
      )}
      <p className="mt-6 text-sm"><LogoutButton label={S.logout} lang={lang} className="text-sm text-ink/70 underline hover:text-ink" /></p>
    </div>
  );
}
