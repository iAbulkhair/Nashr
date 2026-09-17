"use client";
import { useState } from "react";
import type { Lang } from "@/lib/i18n";

export default function AffiliateForm({ lang }: { lang: Lang }) {
  const ar = lang === "ar";
  const [state, setState] = useState<"idle" | "busy" | "ok" | "err">("idle");
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState("busy");
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    const res = await fetch("/api/affiliates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fd, lang }) });
    setState(res.ok ? "ok" : "err");
  }
  const input = "input";
  if (state === "ok") return <div className="rounded-2xl border border-oasis bg-white p-6 text-oasis">{ar ? "وصلنا طلبك. نرد خلال يوم عمل على واتساب أو الإيميل." : "Got it. We reply within one business day on WhatsApp or email."}</div>;
  return (
    <form onSubmit={onSubmit} className="grid gap-3 rounded-2xl border border-ink/10 bg-salt-dim p-6">
      <h2 className="font-display text-xl font-bold">{ar ? "قدّم طلب الشراكة" : "Apply"}</h2>
      <input name="name" required placeholder={ar ? "اسمك" : "Your name"} className={input} />
      <input name="email" required type="email" dir="ltr" placeholder="Email" className={input} />
      <input name="phone" required dir="ltr" placeholder={ar ? "واتساب +966…" : "WhatsApp +966…"} className={input} />
      <input name="channel" required placeholder={ar ? "أين ستروّج؟ (وكالة، يوتيوب، نشرة، لينكدإن…)" : "Where will you promote? (agency, YouTube, newsletter, LinkedIn…)"} className={input} />
      <input name="audience" placeholder={ar ? "حجم جمهورك / عدد عملائك" : "Audience size / number of clients"} className={input} />
      <button disabled={state === "busy"} className="btn btn-primary">{ar ? "أرسل الطلب" : "Send application"}</button>
      {state === "err" && <p className="text-sm text-sadu">{ar ? "لم يُرسل. حاول مرة أخرى." : "Didn't send. Try again."}</p>}
    </form>
  );
}
