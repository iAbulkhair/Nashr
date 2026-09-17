"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";

type Ev = { step: string; status: string; detail?: string; file?: { name: string; content: string }; brand?: { name: string } };

export default function StartWizard({ t, lang }: { t: AppDict; lang: Lang }) {
  const r = useRouter();
  const s = t.start;
  const [events, setEvents] = useState<Ev[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setEvents([]);
    const res = await fetch("/api/onboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: fd.get("url"), hints: fd.get("hints") }) });
    if (!res.ok || !res.body) {
      setEvents([{ step: "error", status: "error" }]);
      setBusy(false);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done: d } = await reader.read();
      if (d) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const p of parts) {
        const line = p.replace(/^data: /, "").trim();
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as Ev;
          setEvents((prev) => {
            const i = prev.findIndex((x) => x.step === ev.step && ev.step !== "file");
            if (i >= 0) { const c = [...prev]; c[i] = ev; return c; }
            return [...prev, ev];
          });
          if (ev.step === "complete") setDone(true);
        } catch {}
      }
    }
    setBusy(false);
  }

  const label = (ev: Ev) => (ev.step === "file" ? `${s.steps.file}: ${ev.file?.name}` : (s.steps as Record<string, string>)[ev.step] ?? ev.step);
  const icon = (st: string) => (st === "running" ? "⏳" : st === "done" ? "✓" : st === "warn" ? "⚠︎" : "✕");

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-3xl font-bold text-oasis">{s.title}</h1>
      <p className="mt-2 text-ink/70">{s.sub}</p>
      {!done && (
        <form onSubmit={onSubmit} className="mt-6 grid gap-3">
          <input name="url" required dir="ltr" placeholder={s.url} className="w-full rounded-lg border border-ink/15 bg-white px-4 py-3 text-sm" />
          <textarea name="hints" rows={2} placeholder={s.hints} className="w-full rounded-lg border border-ink/15 bg-white px-4 py-3 text-sm" />
          <button disabled={busy} className="rounded-lg bg-oasis px-5 py-3 font-semibold text-mist disabled:opacity-60">{busy ? s.steps.brand + "…" : s.go}</button>
          <Link href={`/${lang}/app/onboarding`} className="text-center text-sm text-ink/60 underline">{s.manual}</Link>
        </form>
      )}
      {events.length > 0 && (
        <ol className="mt-6 grid gap-3">
          {events.filter((e) => e.step !== "complete").map((ev, i) => (
            <li key={i} className={`rounded-xl border p-4 ${ev.status === "running" ? "border-saffron bg-white" : "border-ink/10 bg-white"}`}>
              <div className="flex items-center gap-2 text-sm">
                <span className="font-mono">{icon(ev.status)}</span>
                <span className="font-medium">{label(ev)}</span>
                {ev.detail && <span className="text-ink/60">— {ev.detail}</span>}
              </div>
              {ev.file && <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-salt-dim p-3 font-body text-xs leading-relaxed" dir="auto">{ev.file.content.slice(0, 1500)}{ev.file.content.length > 1500 ? "…" : ""}</pre>}
              {ev.step === "error" && <p className="mt-2 text-sm text-sadu">{s.steps.error}</p>}
            </li>
          ))}
        </ol>
      )}
      {done && (
        <button onClick={() => { r.push(`/${lang}/app/chat`); r.refresh(); }} className="mt-6 w-full rounded-lg bg-saffron px-5 py-3 font-semibold text-ink">{s.steps.complete}</button>
      )}
    </div>
  );
}
