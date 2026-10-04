"use client";
import Link from "next/link";
import { useState } from "react";
import type { Tool } from "@/lib/tools";
import type { Lang } from "@/lib/i18n";
import Scribble from "@/components/Scribble";

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
    if (!j.ok) return setErr(j.error === "rate_limited" ? (ar ? `وصلت حد ${j.limit} استخدامات اليوم. سجّل مجاناً للمزيد.` : `Daily limit of ${j.limit} reached. Sign up free for more.`) : j.error === "paused" ? (ar ? "الأدوات المجانية متوقفة مؤقتاً. عد إليها لاحقاً." : "The free tools are paused for now. Please check back later.") : ar ? "حدث خطأ، حاول مرة أخرى." : "Something failed, try again.");
    setOut(j.output);
  }
  const field = (f: Tool["fields"][number]) =>
    f.type === "textarea" ? <textarea name={f.name} rows={3} placeholder={f.placeholder?.[lang]} /> : f.type === "select" ? <select name={f.name}>{f.options!.map((o) => <option key={o}>{o}</option>)}</select> : <input name={f.name} placeholder={f.placeholder?.[lang]} />;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-2">
      <form onSubmit={onSubmit} className="grid grid-cols-[minmax(0,1fr)] gap-4">
        {tool.fields.map((f) => (
          <label key={f.name} className="grid gap-1.5 text-sm font-bold">
            <span>{f.label[lang]}</span>
            <span className="s-input font-normal"><Scribble kind="box" seed={`tool-${tool.slug}-${f.name}`} fill="paper" ring />{field(f)}</span>
          </label>
        ))}
        <button disabled={busy} className="s-btn justify-self-start"><Scribble kind="pill" seed={`tool-${tool.slug}-go`} fill="ink" shadow ring />{busy ? (ar ? "نور تكتب…" : "Noor is writing…") : ar ? "ولّد مجاناً" : "Generate free"}</button>
        {err && <p role="alert" className="text-sm font-bold text-danger">{err} {err.includes("سجّل") || err.includes("Sign up") ? <Link href={`/${lang}/app/signup`} className="text-ink underline">{ar ? "سجّل" : "Sign up"}</Link> : null}</p>}
      </form>
      <div className="s-card">
        <Scribble kind="box" seed={`tool-${tool.slug}-out`} fill="paper" />
        {out ? (
          <>
            <pre className="whitespace-pre-wrap font-body text-sm leading-relaxed" dir="auto">{out}</pre>
            <button onClick={() => navigator.clipboard.writeText(out)} className="s-chip mt-4 inline-flex items-center"><Scribble kind="pill" seed={`tool-${tool.slug}-copy`} fill="lemon" ring />{ar ? "انسخ" : "Copy"}</button>
          </>
        ) : (
          <p className="text-sm text-muted">{ar ? "النتيجة تظهر هنا." : "Output appears here."}</p>
        )}
        <div className="mt-6 border-t-[1.5px] border-ink pt-4">
          <p className="font-display font-bold">{ar ? "نور تكتب هذا لعلامتك متى طلبت." : "Noor writes this for your brand whenever you ask."}</p>
          <p className="mt-1 text-sm text-muted">{ar ? "تتعلم علامتك، تخطط أسبوعك كل يوم أحد، وتكتب المحتوى بلهجتك عندما تطلبه. 3 أيام مجاناً." : "Learns your brand, plans your week every Sunday, and writes content in your dialect when you ask. 3 days free."}</p>
          <Link href={`/${lang}/app/signup`} className="s-btn s-btn--ghost mt-3"><Scribble kind="pill" seed={`tool-${tool.slug}-try`} fill="lemon" ring />{ar ? "جرّب نور مجاناً" : "Try Noor free"}</Link>
        </div>
      </div>
    </div>
  );
}
