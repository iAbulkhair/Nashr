"use client";
import { useState } from "react";
import Link from "next/link";
import type { Lang } from "@/lib/i18n";
import Scribble from "@/components/Scribble";

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
  if (state === "ok") return <p role="status" className="s-card font-bold"><Scribble kind="box" seed="affiliate-sent" fill="lemon" />{ar ? "وصلنا طلبك. نرد خلال يوم عمل على واتساب أو الإيميل." : "Got it. We reply within one business day on WhatsApp or email."}</p>;
  return (
    <form onSubmit={onSubmit} className="s-card grid grid-cols-[minmax(0,1fr)] gap-4">
      <Scribble kind="box" seed="affiliate-form" fill="paper" heavy shadow />
      <h2 className="font-display text-xl font-bold">{ar ? "قدّم طلب الشراكة" : "Apply"}</h2>
      <span className="s-input"><Scribble kind="box" seed="affiliate-name" fill="paper" ring /><input name="name" required placeholder={ar ? "اسمك" : "Your name"} aria-label={ar ? "اسمك" : "Your name"} /></span>
      <span className="s-input"><Scribble kind="box" seed="affiliate-email" fill="paper" ring /><input name="email" required type="email" dir="ltr" placeholder="Email" aria-label="Email" /></span>
      <span className="s-input"><Scribble kind="box" seed="affiliate-phone" fill="paper" ring /><input name="phone" required dir="ltr" placeholder={ar ? "واتساب (مع رمز الدولة)" : "WhatsApp (with country code)"} aria-label={ar ? "واتساب" : "WhatsApp"} /></span>
      <span className="s-input"><Scribble kind="box" seed="affiliate-channel" fill="paper" ring /><input name="channel" required placeholder={ar ? "أين ستروّج؟ (وكالة، يوتيوب، نشرة، لينكدإن…)" : "Where will you promote? (agency, YouTube, newsletter, LinkedIn…)"} aria-label={ar ? "أين ستروّج؟" : "Where will you promote?"} /></span>
      <span className="s-input"><Scribble kind="box" seed="affiliate-audience" fill="paper" ring /><input name="audience" placeholder={ar ? "حجم جمهورك / عدد عملائك" : "Audience size / number of clients"} aria-label={ar ? "حجم جمهورك" : "Audience size"} /></span>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="consent" required data-terms-consent className="mt-1 h-4 w-4 accent-foreground" />
        <span>
          {ar ? "أوافق على " : "I agree to the "}
          <Link href={`/${lang}/affiliates/terms`} target="_blank" className="font-bold text-foreground underline">{ar ? "شروط برنامج الشركاء" : "partner programme terms"}</Link>
        </span>
      </label>
      <button disabled={state === "busy"} className="s-btn justify-self-start"><Scribble kind="pill" seed="affiliate-send" fill="ink" shadow ring />{ar ? "أرسل الطلب" : "Send application"}</button>
      {state === "consent" && <p role="alert" className="text-sm font-bold text-danger">{ar ? "وافق على شروط برنامج الشركاء لإرسال الطلب." : "Agree to the partner programme terms to send your application."}</p>}
      {state === "err" && <p role="alert" className="text-sm font-bold text-danger">{ar ? "لم يُرسل. حاول مرة أخرى." : "Didn't send. Try again."}</p>}
    </form>
  );
}
