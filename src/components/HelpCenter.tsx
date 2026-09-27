"use client";
import { useState } from "react";
import { HELP } from "@/lib/help";
import type { Lang } from "@/lib/i18n";

export default function HelpCenter({ lang, wa, inApp = false }: { lang: Lang; wa: string | null; inApp?: boolean }) {
  const ar = lang === "ar";
  const [q, setQ] = useState("");
  const [topic, setTopic] = useState("all");
  const [sent, setSent] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const norm = (s: string) => s.toLowerCase();
  const shown = HELP.filter((t) => topic === "all" || t.id === topic).map((t) => ({ ...t, items: t.items.filter((i) => !q || norm(i.q[lang] + " " + i.a[lang]).includes(norm(q))) })).filter((t) => t.items.length);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSent("busy");
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    const res = await fetch("/api/support", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fd, lang, page: location.pathname }) });
    setSent(res.ok ? "ok" : "err");
  }
  const input = "input";
  return (
    <div className={inApp ? "" : "mx-auto max-w-4xl px-4 py-16 sm:px-6"}>
      <h1 className="page-title sm:text-4xl">{ar ? "مركز المساعدة" : "Help center"}</h1>
      <p className="mt-2 text-ink/70">{ar ? "ابحث، أو اسأل نور في الدردشة «كيف أسوي…»، أو راسلنا." : "Search, ask Noor in chat “how do I…”, or message us."}</p>
      <div className="mt-6 flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={ar ? "ابحث في المساعدة…" : "Search help…"} className="min-w-[240px] flex-1 rounded-full border border-ink/15 bg-white px-4 py-2 text-sm" />
        <button onClick={() => setTopic("all")} className={`rounded-full px-3 py-1.5 text-xs ${topic === "all" ? "bg-oasis text-mist" : "bg-salt-dim"}`}>{ar ? "الكل" : "All"}</button>
        {HELP.map((t) => <button key={t.id} onClick={() => setTopic(t.id)} className={`rounded-full px-3 py-1.5 text-xs ${topic === t.id ? "bg-oasis text-mist" : "bg-salt-dim"}`}>{t.title[lang]}</button>)}
      </div>
      <div className="mt-8 grid gap-8">
        {shown.length === 0 && <p className="text-sm text-ink/60">{ar ? "لا نتائج. اسأل نور أو راسلنا أدناه." : "No results. Ask Noor or message us below."}</p>}
        {shown.map((t) => (
          <section key={t.id}>
            <h2 className="font-display text-xl font-bold">{t.title[lang]}</h2>
            <div className="mt-2 divide-y divide-ink/10 rounded-xl border border-ink/10 bg-white px-5">
              {t.items.map((i) => <details key={i.q.en} className="py-3"><summary className="font-medium">{i.q[lang]}</summary><p className="mt-2 text-sm leading-relaxed text-ink/70" dir="auto">{i.a[lang]}</p></details>)}
            </div>
          </section>
        ))}
      </div>
      <section className="mt-12 grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl bg-oasis-deep p-6 text-mist">
          <h2 className="font-display text-xl font-bold">{ar ? "تواصل مباشر" : "Talk to us"}</h2>
          <p className="mt-2 text-sm text-mist-dim">{ar ? "نرد عليك على واتساب أو الإيميل." : "We reply on WhatsApp or email."}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {wa && <a href={wa} target="_blank" rel="noreferrer" className="rounded-full bg-saffron px-4 py-2 text-sm font-semibold text-ink">WhatsApp</a>}
          </div>
        </div>
        {sent === "ok" ? (
          <div className="rounded-2xl border border-oasis bg-white p-6 text-oasis">{ar ? "وصلتنا رسالتك. نرد على واتساب أو الإيميل." : "Got it. We'll reply on WhatsApp or email."}</div>
        ) : (
          <form onSubmit={submit} className="grid gap-3 rounded-2xl border border-ink/10 bg-salt-dim p-6">
            <h2 className="font-display text-xl font-bold">{ar ? "أرسل طلب دعم" : "Send a support request"}</h2>
            <input name="email" required type="email" dir="ltr" placeholder="Email" className={input} />
            <select name="type" className={input}><option value="question">{ar ? "سؤال" : "Question"}</option><option value="bug">{ar ? "مشكلة" : "Bug"}</option><option value="billing">{ar ? "فوترة" : "Billing"}</option><option value="feature">{ar ? "اقتراح ميزة" : "Feature request"}</option></select>
            <textarea name="message" required rows={4} placeholder={ar ? "اكتب ما حدث بالتفصيل…" : "Describe what happened…"} className={input} />
            <button disabled={sent === "busy"} className="btn btn-primary">{ar ? "أرسل" : "Send"}</button>
            {sent === "err" && <p className="text-sm text-sadu">{ar ? "لم يُرسل. حاول مرة أخرى." : "Didn't send. Try again."}</p>}
          </form>
        )}
      </section>
    </div>
  );
}
