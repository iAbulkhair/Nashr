"use client";
import { useEffect, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";

export default function ReferPanel({ t, lang, code, count, earned, origin }: { t: AppDict; lang: Lang; code: string; count: number; earned: number; origin: string }) {
  const r = t.refer;
  const link = `${origin}/${lang}/app/signup?ref=${code}`;
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<"refer" | "social">("refer");
  const [done, setDone] = useState<string[]>([]);
  const [msg, setMsg] = useState("");
  useEffect(() => { fetch("/api/referral/share").then((x) => x.json()).then((j) => j.ok && setDone(j.done)); }, []);
  const post = r.socialText + " " + `${origin}/${lang}`;
  const shares: { id: string; label: string; url: string }[] = [
    { id: "x", label: "X", url: `https://twitter.com/intent/tweet?text=${encodeURIComponent(post)}` },
    { id: "linkedin", label: "LinkedIn", url: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(`${origin}/${lang}`)}` },
    { id: "whatsapp", label: "WhatsApp", url: `https://wa.me/?text=${encodeURIComponent(post)}` },
  ];
  async function shared(id: string, url: string) {
    window.open(url, "_blank", "noopener");
    const j = await (await fetch("/api/referral/share", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform: id }) })).json();
    if (j.ok) { setDone((p) => [...new Set([...p, id])]); setMsg(j.credited ? `+${j.credited} ${r.creditsWord}` : r.alreadyShared); }
  }
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="page-title">{r.title}</h1>
      <p className="mt-2 text-ink/70">{r.sub}</p>
      <div className="mt-5 flex gap-2">
        {(["refer", "social"] as const).map((k) => <button key={k} onClick={() => setTab(k)} className={`rounded-full px-4 py-1.5 text-sm ${tab === k ? "bg-oasis text-mist" : "border border-ink/15"}`}>{k === "refer" ? r.tabRefer : r.tabSocial}</button>)}
      </div>
      {msg && <p className="mt-3 text-sm text-oasis">{msg}</p>}
      {tab === "social" && (
        <div className="mt-4 card">
          <p className="text-sm text-ink/70">{r.socialSub}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {shares.map((s) => <button key={s.id} onClick={() => shared(s.id, s.url)} disabled={done.includes(s.id)} className="rounded-full border border-oasis px-4 py-2 text-sm text-oasis disabled:opacity-50">{done.includes(s.id) ? "✓ " : ""}{s.label}</button>)}
          </div>
        </div>
      )}
      <div className={`mt-4 card ${tab !== "refer" ? "hidden" : ""}`}>
        <p className="text-xs uppercase tracking-wide text-ink/50">{r.link}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="flex-1 break-all rounded bg-salt-dim px-3 py-2 text-sm" dir="ltr">{link}</code>
          <button onClick={async () => { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="btn btn-primary btn-pill">{copied ? r.copied : r.copy}</button>
          <a href={`https://wa.me/?text=${encodeURIComponent(r.shareText + " " + link)}`} target="_blank" rel="noreferrer" className="rounded-full border border-oasis px-4 py-2 text-sm text-oasis">{r.share}</a>
        </div>
        <p className="mt-3 text-xs text-ink/50">{r.code}: <span className="font-mono">{code}</span></p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div className="card"><p className="text-xs text-ink/50">{r.count}</p><p className="page-title">{count}</p></div>
        <div className="card"><p className="text-xs text-ink/50">{r.earned}</p><p className="page-title">{earned}</p></div>
      </div>
    </div>
  );
}
