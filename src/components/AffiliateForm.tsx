"use client";
import { useState } from "react";
import Link from "next/link";
import type { Lang } from "@/lib/i18n";

/**
 * The public partner application. The terms box is required (rule 414): the browser will not send the form without it,
 * and the API refuses an application without consent, so nobody joins without having been shown the terms.
 */
export default function AffiliateForm({ lang }: { lang: Lang }) {
  const ar = lang === "ar";
  const [state, setState] = useState<"idle" | "busy" | "ok" | "err" | "consent">("idle");
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    if (fd.consent !== "on") return setState("consent");
    setState("busy");
    const res = await fetch("/api/affiliates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fd, consent: true, lang }) }).catch(() => null);
    setState(res?.ok ? "ok" : "err");
  }
  const input = "input";
  if (state === "ok") return <div className="rounded-2xl border border-oasis bg-white p-6 text-oasis">{ar ? "وصلنا طلبك. نرد خلال يوم عمل على واتساب أو الإيميل." : "Got it. We reply within one business day on WhatsApp or email."}</div>;
  return (
    <form onSubmit={onSubmit} className="grid gap-3 rounded-2xl border border-ink/10 bg-salt-dim p-6">
      <h2 className="font-display text-xl font-bold">{ar ? "قدّم طلب الشراكة" : "Apply"}</h2>
      <input name="name" required placeholder={ar ? "اسمك" : "Your name"} className={input} />
      <input name="email" required type="email" dir="ltr" placeholder="Email" className={input} />
      <input name="phone" required dir="ltr" placeholder={ar ? "واتساب (مع رمز الدولة)" : "WhatsApp (with country code)"} className={input} />
      <input name="channel" required placeholder={ar ? "أين ستروّج؟ (وكالة، يوتيوب، نشرة، لينكدإن…)" : "Where will you promote? (agency, YouTube, newsletter, LinkedIn…)"} className={input} />
      <input name="audience" placeholder={ar ? "حجم جمهورك / عدد عملائك" : "Audience size / number of clients"} className={input} />
      <label className="flex items-start gap-2 text-sm text-ink/80">
        <input type="checkbox" name="consent" required data-terms-consent className="mt-1" />
        <span>
          {ar ? "أوافق على " : "I agree to the "}
          <Link href={`/${lang}/affiliates/terms`} target="_blank" className="text-oasis underline">{ar ? "شروط برنامج الشركاء" : "partner programme terms"}</Link>
        </span>
      </label>
      <button disabled={state === "busy"} className="btn btn-primary">{ar ? "أرسل الطلب" : "Send application"}</button>
      {state === "consent" && <p role="alert" className="text-sm text-sadu">{ar ? "وافق على شروط برنامج الشركاء لإرسال الطلب." : "Agree to the partner programme terms to send your application."}</p>}
      {state === "err" && <p className="text-sm text-sadu">{ar ? "لم يُرسل. حاول مرة أخرى." : "Didn't send. Try again."}</p>}
    </form>
  );
}
