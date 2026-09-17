"use client";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";

export default function ReferPanel({ t, lang, code, count, earned, origin }: { t: AppDict; lang: Lang; code: string; count: number; earned: number; origin: string }) {
  const r = t.refer;
  const link = `${origin}/${lang}/app/signup?ref=${code}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-3xl font-bold text-oasis">{r.title}</h1>
      <p className="mt-2 text-ink/70">{r.sub}</p>
      <div className="mt-6 rounded-xl border border-ink/10 bg-white p-5">
        <p className="text-xs uppercase tracking-wide text-ink/50">{r.link}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="flex-1 break-all rounded bg-salt-dim px-3 py-2 text-sm" dir="ltr">{link}</code>
          <button onClick={async () => { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="rounded-full bg-oasis px-4 py-2 text-sm font-semibold text-mist">{copied ? r.copied : r.copy}</button>
          <a href={`https://wa.me/?text=${encodeURIComponent(r.shareText + " " + link)}`} target="_blank" rel="noreferrer" className="rounded-full border border-oasis px-4 py-2 text-sm text-oasis">{r.share}</a>
        </div>
        <p className="mt-3 text-xs text-ink/50">{r.code}: <span className="font-mono">{code}</span></p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-ink/10 bg-white p-5"><p className="text-xs text-ink/50">{r.count}</p><p className="font-display text-3xl font-bold text-oasis">{count}</p></div>
        <div className="rounded-xl border border-ink/10 bg-white p-5"><p className="text-xs text-ink/50">{r.earned}</p><p className="font-display text-3xl font-bold text-oasis">{earned}</p></div>
      </div>
    </div>
  );
}
