"use client";
import { useEffect, useState } from "react";
import { helpHref, helpTopicsIn } from "@/lib/help";
import type { Lang } from "@/lib/i18n";
import Scribble from "@/components/Scribble";
import ScribbleStatic from "@/components/ScribbleStatic";

/** `origin` is the canonical app origin (src/lib/origin.ts `appOrigin()`), read on the server: answers that name the MCP URL use it. */
export default function HelpCenter({ lang, wa, origin, inApp = false }: { lang: Lang; wa: string | null; origin: string; inApp?: boolean }) {
  const ar = lang === "ar";
  const HELP = helpTopicsIn(origin, lang);
  const [q, setQ] = useState("");
  const [topic, setTopic] = useState("all");
  const [sent, setSent] = useState<"idle" | "busy" | "ok" | "err">("idle");
  // Rule 2142: `/help#{slug}` opens that answer and scrolls to it, so an answer's anchor works on the index as on its topic page.
  useEffect(() => {
    const open = () => {
      // Rule 2974: a hand-typed or truncated hash such as `#%E0%A4%A` makes decodeURIComponent throw a URIError, which crashed
      // the whole help page; an undecodable hash opens nothing.
      let id = "";
      try { id = decodeURIComponent(location.hash.slice(1)); } catch { /* malformed escape */ }
      const el = id ? document.getElementById(id) : null;
      // Scrolled on the next task: opening the answer moves everything under it, and the router settles the scroll first.
      if (el instanceof HTMLDetailsElement) { el.open = true; setTimeout(() => el.scrollIntoView({ block: "start" }), 0); }
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);
  const norm = (s: string) => s.toLowerCase();
  const shown = HELP.filter((t) => topic === "all" || t.id === topic).map((t) => ({ ...t, items: t.items.filter((i) => !q || norm(i.q[lang] + " " + i.a[lang]).includes(norm(q))) })).filter((t) => t.items.length);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSent("busy");
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    // Rule 1878: a dropped connection shows the error and frees the button instead of leaving it busy.
    const res = await fetch("/api/support", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fd, lang, page: location.pathname }) }).catch(() => null);
    setSent(res?.ok ? "ok" : "err");
  }
  // Rule 1878: every field has a visible label above its box; `text-start` puts Arabic labels on the right.
  const box = (id: string, label: string, control: React.ReactNode, className = "") => (
    <label className={`grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 text-start text-sm font-bold ${className}`} data-field={id}>
      <span>{label}</span>
      <span className="s-input min-w-0 font-normal"><Scribble kind="box" seed={`help-${id}`} fill="paper" ring />{control}</span>
    </label>
  );
  const chip = (on: boolean, id: string, label: string, pick: () => void) => (
    <button key={id} type="button" onClick={pick} aria-pressed={on} className="s-chip inline-flex items-center !min-h-10 !py-1.5 !text-sm" style={{ ["--chip-on" as string]: "var(--color-background-muted)" }}>
      <Scribble kind="pill" seed={`help-topic-${id}`} fill="paper" ring />
      {label}
    </button>
  );
  return (
    <div className={inApp ? "" : "mx-auto max-w-4xl px-4 py-16 sm:px-6"}>
      <h1 className="font-display text-3xl font-bold leading-tight sm:text-4xl"><span className="s-ul"><ScribbleStatic kind="underline" seed="help-h" rtl={lang === "ar"} />{ar ? "مركز المساعدة" : "Help center"}</span></h1>
      <p className="mt-2 text-foreground-muted">{ar ? "ابحث، أو اسأل نور في الدردشة «كيف أسوي…»، أو راسلنا." : "Search, ask Noor in chat “how do I…”, or message us."}</p>
      <div role="search" className="mt-6 max-w-xl">
        {box("search", ar ? "ابحث في المساعدة" : "Search help", <input type="search" name="q" enterKeyHint="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={ar ? "مثلاً: الكريدت" : "e.g. credits"} />)}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {chip(topic === "all", "all", ar ? "الكل" : "All", () => setTopic("all"))}
        {HELP.map((t) => chip(topic === t.id, t.id, t.title[lang], () => setTopic(t.id)))}
      </div>
      <div className="mt-8 grid gap-8">
        {shown.length === 0 && <p className="text-sm text-foreground-muted">{ar ? "لا نتائج. اسأل نور أو راسلنا أدناه." : "No results. Ask Noor or message us below."}</p>}
        {shown.map((t) => (
          <section key={t.id}>
            {/* Rule 2140: each topic has its own page; the public index links it, the in-app copy stays in the app. */}
            <h2 className="font-display text-xl font-bold">{inApp ? t.title[lang] : <a href={helpHref(lang, t.id)} className="hover:underline">{t.title[lang]}</a>}</h2>
            <div className="mt-3 divide-y divide-foreground/15 border-y-[1.5px] border-border-strong">
              {t.items.map((i) => (
                <details key={i.slug} id={i.slug} className="scroll-mt-24 py-3">
                  <summary className="cursor-pointer font-bold">{i.q[lang]}</summary>
                  <p className="mt-2 text-sm leading-relaxed text-foreground-muted" dir="auto">{i.a[lang]}</p>
                  <a href={helpHref(lang, t.id, i.slug)} className="mt-2 inline-block text-xs font-bold text-foreground-muted underline">{ar ? "رابط هذه الإجابة" : "Link to this answer"}</a>
                </details>
              ))}
            </div>
          </section>
        ))}
      </div>
      <section className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <div className="s-card">
          <Scribble kind="box" seed="help-talk" fill="lilac" />
          <h2 className="font-display text-xl font-bold">{ar ? "تواصل مباشر" : "Talk to us"}</h2>
          <p className="mt-2 text-sm">{ar ? "نرد عليك على واتساب أو الإيميل." : "We reply on WhatsApp or email."}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {wa && <a href={wa} target="_blank" rel="noreferrer" className="s-btn"><Scribble kind="pill" seed="help-wa" fill="ink" shadow ring />WhatsApp</a>}
          </div>
        </div>
        {sent === "ok" ? (
          <p role="status" className="s-card font-bold"><Scribble kind="box" seed="help-sent" fill="lemon" />{ar ? "وصلتنا رسالتك. نرد على واتساب أو الإيميل." : "Got it. We'll reply on WhatsApp or email."}</p>
        ) : (
          <form onSubmit={submit} className="s-card grid grid-cols-[minmax(0,1fr)] gap-4">
            <Scribble kind="box" seed="help-form" fill="paper" />
            <h2 className="font-display text-xl font-bold">{ar ? "أرسل طلب دعم" : "Send a support request"}</h2>
            {box("email", ar ? "بريدك الإلكتروني" : "Your email", <input name="email" required type="email" inputMode="email" autoComplete="email" dir="ltr" />)}
            {box("type", ar ? "نوع الطلب" : "Request type", <select name="type"><option value="question">{ar ? "سؤال" : "Question"}</option><option value="bug">{ar ? "مشكلة" : "Bug"}</option><option value="billing">{ar ? "فوترة" : "Billing"}</option><option value="feature">{ar ? "اقتراح ميزة" : "Feature request"}</option></select>)}
            {box("message", ar ? "الرسالة" : "Message", <textarea name="message" required rows={4} placeholder={ar ? "اكتب وش صار بالتفصيل…" : "Describe what happened…"} />)}
            <button disabled={sent === "busy"} className="s-btn justify-self-start"><Scribble kind="pill" seed="help-send" fill="ink" shadow ring />{ar ? "أرسل" : "Send"}</button>
            {sent === "err" && <p role="alert" className="text-sm font-bold text-danger">{ar ? "لم يُرسل. حاول مرة أخرى." : "Didn't send. Try again."}</p>}
          </form>
        )}
      </section>
    </div>
  );
}
