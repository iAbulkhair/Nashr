"use client";
import { useEffect, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import Scribble from "@/components/Scribble";
import { useToast } from "@/components/ui/Toast";

export default function ReferPanel({ t, lang, code, count, earned, origin }: { t: AppDict; lang: Lang; code: string; count: number; earned: number; origin: string }) {
  const r = t.refer;
  const link = `${origin}/${lang}/app/signup?ref=${code}`;
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<"refer" | "social">("refer");
  const [done, setDone] = useState<string[]>([]);
  const toast = useToast();
  useEffect(() => { void fetch("/api/referral/share").then((x) => x.json()).then((j) => j.ok && setDone(j.done)); }, []);
  const post = r.socialText + " " + `${origin}/${lang}`;
  const shares: { id: string; label: string; url: string }[] = [
    { id: "x", label: "X", url: `https://twitter.com/intent/tweet?text=${encodeURIComponent(post)}` },
    { id: "linkedin", label: "LinkedIn", url: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(`${origin}/${lang}`)}` },
    { id: "whatsapp", label: "WhatsApp", url: `https://wa.me/?text=${encodeURIComponent(post)}` },
  ];
  async function shared(id: string, url: string) {
    window.open(url, "_blank", "noopener");
    const j = await fetch("/api/referral/share", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform: id }) }).then((x) => x.json()).catch(() => null);
    if (!j?.ok) toast.danger(t.team.errors.failed); // rule 2001
    else { setDone((p) => [...new Set([...p, id])]); toast.success(j.credited ? `+${j.credited} ${r.creditsWord}` : r.alreadyShared); }
  }
  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="referpanel-t1" />{r.title}</span></h1>
      <p className="mt-2 text-foreground-muted">{r.sub}</p>
      <div className="mt-5 flex gap-2">
        {(["refer", "social"] as const).map((k) => <button key={k} onClick={() => setTab(k)} className={`rounded-full px-4 py-1.5 text-sm ${tab === k ? "bg-inverse text-inverse-muted" : "border border-border"}`}>{k === "refer" ? r.tabRefer : r.tabSocial}</button>)}
      </div>
      {tab === "social" && (
        <div className="mt-4 card">
          <p className="text-sm text-foreground-muted">{r.socialSub}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {shares.map((s) => <button key={s.id} onClick={() => shared(s.id, s.url)} disabled={done.includes(s.id)} className="rounded-full border border-border-strong px-4 py-2 text-sm text-foreground disabled:opacity-50">{done.includes(s.id) ? "✓ " : ""}{s.label}</button>)}
          </div>
        </div>
      )}
      <div className={`mt-4 card ${tab !== "refer" ? "hidden" : ""}`}>
        <p className="text-xs uppercase tracking-wide text-foreground-muted">{r.link}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="flex-1 break-all rounded bg-background-muted px-3 py-2 text-sm" dir="ltr">{link}</code>
          <button onClick={async () => { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="btn btn-primary btn-pill">{copied ? r.copied : r.copy}</button>
          <a href={`https://wa.me/?text=${encodeURIComponent(r.shareText + " " + link)}`} target="_blank" rel="noreferrer" className="rounded-full border border-border-strong px-4 py-2 text-sm text-foreground">{r.share}</a>
        </div>
        <p className="mt-3 text-xs text-foreground-muted">{r.code}: <span className="font-mono">{code}</span></p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div className="card"><p className="text-xs text-foreground-muted">{r.count}</p><p className="page-title">{count}</p></div>
        <div className="card"><p className="text-xs text-foreground-muted">{r.earned}</p><p className="page-title">{earned}</p></div>
      </div>
    </div>
  );
}
