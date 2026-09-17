"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import { TASK_COST, type TaskType } from "@/lib/brand";
import type { Lang } from "@/lib/i18n";

export default function GeneratePanel({ t, lang, credits }: { t: AppDict; lang: Lang; credits: number }) {
  const r = useRouter();
  const g = t.generate;
  const [busy, setBusy] = useState<TaskType | null>(null);
  const [msg, setMsg] = useState("");
  const [notes, setNotes] = useState("");

  async function run(type: TaskType) {
    setBusy(type);
    setMsg(g.running);
    const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, notes }) });
    const j = await res.json();
    setBusy(null);
    if (j.ok) {
      setMsg(g.done);
      r.push(`/${lang}/app`);
      r.refresh();
      return;
    }
    const map: Record<string, string> = { no_credits: g.noCredits, trial_over: g.trialOver, no_brand: g.noBrand };
    setMsg(map[j.error] ?? g.failed);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold text-oasis">{g.title}</h1>
      <p className="mt-2 text-ink/70">{g.sub}</p>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder={g.notes} className="mt-5 w-full rounded-lg border border-ink/15 bg-white px-4 py-3 text-sm" />
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {(Object.keys(TASK_COST) as TaskType[]).map((type) => {
          const cost = TASK_COST[type];
          const can = credits >= cost && !busy;
          return (
            <button key={type} disabled={!can} onClick={() => run(type)} className={`rounded-xl border p-4 text-start transition ${busy === type ? "border-saffron bg-oasis text-mist" : "border-ink/10 bg-white hover:border-oasis"} disabled:opacity-50`}>
              <div className="flex items-center justify-between">
                <span className="font-display font-medium">{g.types[type].t}</span>
                <span className="font-mono text-xs text-sadu" dir="ltr">{cost} {g.cost}</span>
              </div>
              <p className={`mt-1 text-sm ${busy === type ? "text-mist-dim" : "text-ink/70"}`}>{g.types[type].d}</p>
            </button>
          );
        })}
      </div>
      {msg && <p role="status" className="mt-5 rounded-lg border border-oasis/30 bg-salt-dim p-3 text-sm text-oasis">{msg}</p>}
    </div>
  );
}
