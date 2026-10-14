"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Tool } from "@/lib/tools";
import type { Lang } from "@/lib/i18n";
import Scribble from "@/components/Scribble";
import { COPIED_MS } from "@/components/ui/CopyButton";

/**
 * A free tool's form and its result (rule 1864). The request sits in try/catch/finally, so a dropped connection or a
 * page that is not JSON shows an error and the button always comes back. The result area is a polite live region, and
 * copying says so in words. `trial` is the plan wording from `t.pricing.trial`, passed by the tool page, so this box
 * never states a trial length of its own. "Every Sunday" matches the weekly plan cron (`0 3 * * 0`, crons.json).
 */
export default function ToolForm({ tool, lang, trial }: { tool: Tool; lang: Lang; trial: string }) {
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState<"idle" | "ok" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const ar = lang === "ar";
  const failed = ar ? "حدث خطأ، حاول مرة أخرى." : "Something failed, try again.";
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setErr(""); setOut(""); setCopied("idle");
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const res = await fetch(`/api/tools/${tool.slug}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fd) });
      const j = await res.json();
      if (!j.ok) return setErr(j.error === "rate_limited" ? (ar ? `وصلت حد ${j.limit} استخدامات اليوم. سجّل مجاناً للمزيد.` : `Daily limit of ${j.limit} reached. Sign up free for more.`) : j.error === "paused" ? (ar ? "الأدوات المجانية متوقفة مؤقتاً. عد إليها لاحقاً." : "The free tools are paused for now. Please check back later.") : failed);
      setOut(String(j.output ?? ""));
    } catch {
      setErr(failed);
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(out);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
    timer.current = setTimeout(() => setCopied("idle"), COPIED_MS);
  }
  const field = (f: Tool["fields"][number]) =>
    f.type === "textarea" ? <textarea name={f.name} rows={3} placeholder={f.placeholder?.[lang]} /> : f.type === "select" ? <select name={f.name}>{f.options!.map((o) => <option key={o}>{o}</option>)}</select> : <input name={f.name} placeholder={f.placeholder?.[lang]} />;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-2">
      <form onSubmit={onSubmit} className="grid grid-cols-[minmax(0,1fr)] gap-4">
        {tool.fields.map((f) => (
          <label key={f.name} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 text-start text-sm font-bold">
            <span>{f.label[lang]}</span>
            <span className="s-input min-w-0 font-normal"><Scribble kind="box" seed={`tool-${tool.slug}-${f.name}`} fill="paper" ring />{field(f)}</span>
          </label>
        ))}
        <button disabled={busy} className="s-btn justify-self-start"><Scribble kind="pill" seed={`tool-${tool.slug}-go`} fill="ink" shadow ring />{busy ? (ar ? "نور تكتب…" : "Noor is writing…") : ar ? "ولّد مجاناً" : "Generate free"}</button>
        {err && <p role="alert" className="text-sm font-bold text-danger">{err} {err.includes("سجّل") || err.includes("Sign up") ? <Link href={`/${lang}/app/signup`} className="text-foreground underline">{ar ? "سجّل" : "Sign up"}</Link> : null}</p>}
      </form>
      <div className="s-card">
        <Scribble kind="box" seed={`tool-${tool.slug}-out`} fill="paper" />
        <div aria-live="polite" data-tool-result>
          {out ? (
            <>
              <pre className="whitespace-pre-wrap font-body text-sm leading-relaxed" dir="auto">{out}</pre>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button type="button" onClick={copy} className="s-chip inline-flex items-center"><Scribble kind="pill" seed={`tool-${tool.slug}-copy`} fill="lemon" ring />{ar ? "انسخ" : "Copy"}</button>
                <span role="status" className="text-sm font-bold" data-copied={copied}>
                  {copied === "ok" ? (ar ? "تم النسخ" : "Copied") : copied === "failed" ? (ar ? "ما قدرنا ننسخ. حدّد النص وانسخه." : "Couldn't copy. Select the text and copy it.") : ""}
                </span>
              </div>
            </>
          ) : (
            <p className="text-sm text-foreground-muted">{busy ? (ar ? "نور تكتب…" : "Noor is writing…") : ar ? "النتيجة تظهر هنا." : "Output appears here."}</p>
          )}
        </div>
        <div className="mt-6 border-t-[1.5px] border-border-strong pt-4">
          <p className="font-display font-bold">{ar ? "نور تكتب هذا لعلامتك متى طلبت." : "Noor writes this for your brand whenever you ask."}</p>
          <p className="mt-1 text-sm text-foreground-muted">{ar ? "تتعلم علامتك، تخطط أسبوعك كل يوم أحد، وتكتب المحتوى بلهجتك عندما تطلبه." : "Learns your brand, plans your week every Sunday, and writes content in your dialect when you ask."} <span data-tool-trial>{trial}</span></p>
          <Link href={`/${lang}/app/signup`} className="s-btn s-btn--ghost mt-3"><Scribble kind="pill" seed={`tool-${tool.slug}-try`} fill="lemon" ring />{ar ? "جرّب نور مجاناً" : "Try Noor free"}</Link>
        </div>
      </div>
    </div>
  );
}
