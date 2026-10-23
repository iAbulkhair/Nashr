"use client";
import { useState } from "react";
import type { Lang } from "@/lib/i18n";
import { failureCode, postJson, succeeded } from "@/lib/auth-client";
import SettingsCard, { type CardStatus } from "./SettingsCard";

const COPY = {
  ar: {
    title: "عيّن كلمة مرور",
    sub: "دخولك ما له كلمة مرور بعد (مثلاً سجّلت بحساب Google). نرسل رابطاً صالحاً لساعة واحدة إلى بريد دخولك، وتختار منه كلمة مرور تدخل بها أيضاً. لأمان حسابك يُفك ربط Google عند تعيينها، فاربطه من جديد من هذه الصفحة إذا أردت الطريقتين.",
    to: "يصل الرابط إلى:", send: "أرسل لي الرابط", sending: "يرسل…",
    sent: "أرسلنا الرابط إلى بريدك. صالح لساعة واحدة، وتفقّد البريد غير المرغوب أيضاً.",
    noMail: "إرسال البريد غير مفعّل حالياً في ذكين، فلن يصلك رابط. تواصل مع الدعم.",
    slow: "أرسلنا روابط كثيرة لهذا البريد. حاول بعد ربع ساعة.", failed: "ما قدرنا نرسل الرابط. حاول مرة أخرى.",
    has: "لدخولك كلمة مرور بالفعل. حدّث الصفحة لتغييرها.",
  },
  en: {
    title: "Set a password",
    sub: "Your login has no password yet (for example, you signed up with Google). We email a link, valid for one hour, to your sign-in address; open it to choose a password you can also sign in with. To keep the account safe, setting it unlinks Google, so link it again from this page if you want both.",
    to: "The link goes to:", send: "Email me the link", sending: "Sending…",
    sent: "We sent the link to your email. It works for one hour; check spam too.",
    noMail: "Email delivery is not enabled on Thakeen yet, so no link can reach you. Contact support.",
    slow: "Too many links for this address. Try again in 15 minutes.", failed: "We could not send the link. Try again.",
    has: "Your login already has a password. Reload the page to change it.",
  },
} as const;

/**
 * "Set a password" (rules 3101-3102, after Supastarter's SetPassword card): shown in place of the change form when the
 * acting login's person has no password. The button posts only the language to POST /api/account/password-link, which
 * mails the forgot-password link to the session's own sign-in address; `email` here is that address, for display.
 */
export default function SetPasswordCard({ lang, email, forbidden }: { lang: Lang; email: string; forbidden: string }) {
  const T = COPY[lang];
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<CardStatus>(null);
  async function send() {
    setBusy(true); setStatus(null);
    try {
      const p = await postJson("/api/account/password-link", { lang });
      if (succeeded(p)) {
        setStatus(p.body.mail === false ? { tone: "error", text: T.noMail } : p.body.sent === true ? { tone: "ok", text: T.sent } : { tone: "error", text: T.failed });
        return;
      }
      const code = failureCode(p);
      setStatus({ tone: "error", text: p.status === 403 ? forbidden : code === "slow_down" ? T.slow : code === "has_password" ? T.has : T.failed });
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsCard title={T.title} sub={T.sub} onSave={send} dirty valid busy={busy} status={status} saveLabel={T.send} savingLabel={T.sending}>
      {email && <p className="text-sm">{T.to} <bdi dir="ltr" className="break-all font-mono">{email}</bdi></p>}
    </SettingsCard>
  );
}
