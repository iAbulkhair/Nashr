"use client";
import Link from "next/link";
import { useState } from "react";
import type { Tool } from "@/lib/tools";
import type { Lang } from "@/lib/i18n";

export default function ToolForm({ tool, lang }: { tool: Tool; lang: Lang }) {
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ar = lang === "ar";
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setErr(""); setOut("");
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    const res = await fetch(`/api/tools/${tool.slug}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fd) });
    const j = await res.json();
    setBusy(false);
    if (!j.ok) return setErr(j.error === "rate_limited" ? (ar ? `وصلت حد ${j.limit} استخدامات اليوم. سجّل مجاناً للمزيد.` : `Daily limit of ${j.limit} reached. Sign up free for more.`) : ar ? "حدث خطأ، حاول مرة أخرى." : "Something failed, try again.");
    setOut(j.output);
  }
  const input = "input";
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <form onSubmit={onSubmit} className="grid gap-3 rounded-2xl border border-ink/10 bg-salt-dim p-5">
        {tool.fields.map((f) => (
          <label key={f.name} className="grid gap-1 text-sm">
            <span>{f.label[lang]}</span>
            {f.type === "textarea" ? <textarea name={f.name} rows={3} placeholder={f.placeholder?.[lang]} className={input} /> : f.type === "select" ? <select name={f.name} className={input}>{f.options!.map((o) => <option key={o}>{o}</option>)}</select> : <input name={f.name} placeholder={f.placeholder?.[lang]} className={input} />}
          </label>
        ))}
        <button disabled={busy} className="btn btn-primary">{busy ? (ar ? "نور تكتب…" : "Noor is writing…") : ar ? "ولّد مجاناً" : "Generate free"}</button>
        {err && <p className="text-sm text-sadu">{err} {err.includes("سجّل") || err.includes("Sign up") ? <Link href={`/${lang}/app/signup`} className="underline">{ar ? "سجّل" : "Sign up"}</Link> : null}</p>}
      </form>
      <div className="rounded-2xl border border-ink/10 bg-white p-5">
        {out ? (
          <>
            <pre className="whitespace-pre-wrap font-body text-sm leading-relaxed" dir="auto">{out}</pre>
            <button onClick={() => navigator.clipboard.writeText(out)} className="mt-4 btn btn-secondary btn-pill">{ar ? "انسخ" : "Copy"}</button>
          </>
        ) : (
          <p className="text-sm text-ink/50">{ar ? "النتيجة تظهر هنا." : "Output appears here."}</p>
        )}
        <div className="mt-6 rounded-xl bg-oasis-deep p-4 text-mist">
          <p className="font-display font-medium">{ar ? "نور تسوي هذا كل يوم — تلقائياً." : "Noor does this every day — automatically."}</p>
          <p className="mt-1 text-sm text-mist-dim">{ar ? "تتعلم علامتك، تخطط أسبوعك، وتنتج المحتوى لكل قنواتك بلهجتك. 3 أيام مجاناً." : "Learns your brand, plans your week, produces content for every channel in your dialect. 3 days free."}</p>
          <Link href={`/${lang}/app/signup`} className="mt-3 inline-block rounded-full bg-saffron px-4 py-2 text-sm font-semibold text-ink">{ar ? "جرّب نور مجاناً" : "Try Noor free"}</Link>
        </div>
      </div>
    </div>
  );
}
