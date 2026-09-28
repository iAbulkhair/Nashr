"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import { TASK_COST, type TaskType } from "@/lib/tasks";
import { AGENTS } from "@/lib/agents";
import { limitFromError } from "./LimitModal";
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
    // /api/generate runs a long Opus call (maxDuration 300). A dropped connection makes fetch throw and a gateway 502
    // returns HTML, so res.json() throws too. Without this, `busy` was never cleared and EVERY generate button on the
    // page stayed disabled with the status frozen on "running" until the owner reloaded.
    try {
      const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, notes }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && j.ok) {
        setMsg(g.done);
        r.push(`/${lang}/app`);
        r.refresh();
        return;
      }
      limitFromError(j.error);
      const map: Record<string, string> = { no_credits: g.noCredits, trial_over: g.trialOver, no_brand: g.noBrand, no_cart_data: g.noCartData, model_paused: g.paused };
      setMsg((j.error && map[j.error]) || g.failed);
    } catch {
      setMsg(g.failed);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="page-title">{g.title}</h1>
      <p className="mt-2 text-ink/70">{g.sub}</p>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder={g.notes} className="mt-5 input" />
      {AGENTS.map((a) => {
        const info = t.agents[a.id];
        return (
          <section key={a.id} className="mt-7">
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-oasis font-display text-base font-bold text-saffron" aria-hidden>{info.name[0]}</span>
              <div>
                <h2 className="font-display text-lg font-semibold text-oasis">{info.name} <span className="text-sm font-normal text-ink/60">· {info.role}</span></h2>
                <p className="text-xs text-ink/60">{info.blurb}</p>
              </div>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {a.tasks.map((type) => {
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
          </section>
        );
      })}
      {msg && <p role="status" className="sticky bottom-4 mt-5 rounded-lg border border-oasis/30 bg-salt-dim p-3 text-sm text-oasis">{msg}</p>}
    </div>
  );
}
