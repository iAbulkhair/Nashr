"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import { TASK_COST, type TaskType } from "@/lib/brand";
import { agentById } from "@/lib/agents";
import { limitFromError } from "./LimitModal";
import type { Kpis } from "@/lib/stats";
import type { AgentMetrics } from "@/lib/evals";
import type { Lang } from "@/lib/i18n";

type Item = { id: string; type: TaskType; title: string; status: string; createdAt: string };

export default function ReportsPanel({ t, lang, k, items, credits, quality, days = 30, connected = [] }: { t: AppDict; lang: Lang; k: Kpis; items: Item[]; credits: number; quality: AgentMetrics[]; days?: number; connected?: string[] }) {
  const r = useRouter();
  const R = t.reports;
  const [busy, setBusy] = useState<TaskType | null>(null);
  const [msg, setMsg] = useState("");
  const [notes, setNotes] = useState("");

  async function run(type: TaskType) {
    setBusy(type); setMsg(t.generate.running);
    const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, notes }) });
    const j = await res.json();
    setBusy(null);
    if (j.ok) { setMsg(t.generate.done); r.refresh(); return; }
    limitFromError(j.error);
    const map: Record<string, string> = { no_credits: t.generate.noCredits, trial_over: t.generate.trialOver, no_brand: t.generate.noBrand };
    setMsg(map[j.error] ?? t.generate.failed);
  }

  const delta = (cur: number, prev: number) => {
    if (!prev && !cur) return "";
    if (!prev) return "↑";
    const d = Math.round(((cur - prev) / prev) * 100);
    return `${d >= 0 ? "↑" : "↓"} ${Math.abs(d)}% ${R.vsPrev}`;
  };
  const tiles: { label: string; value: string; sub?: string }[] = [
    { label: R.created, value: String(k.created), sub: delta(k.created, k.createdPrev) },
    { label: R.approved, value: String(k.approved) },
    { label: R.approvalRate, value: k.approvalRate === null ? "—" : `${k.approvalRate}%` },
    { label: R.pending, value: String(k.pending) },
    { label: R.published, value: String(k.published) },
    { label: R.images, value: String(k.images) },
    { label: R.creditsUsed, value: String(k.creditsUsed), sub: delta(k.creditsUsed, k.creditsUsedPrev) },
    { label: R.scheduled, value: String(k.scheduled) },
  ];
  const max = Math.max(1, ...k.weeks.map((w) => w.created));
  const top = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const typeLabel = (x: string) => (t.generate.types as Record<string, { t: string }>)[x]?.t ?? x;
  const lists: { label: string; rows: [string, number][]; isType: boolean }[] = [
    { label: R.byType, rows: top(k.byType), isType: true },
    { label: R.byChannel, rows: top(k.byChannel), isType: false },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="page-title">{R.title}</h1>
      <p className="mt-2 text-ink/70">{R.sub}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {(["7", "30", "90"] as const).map((d) => <Link key={d} href={`/${lang}/app/reports?range=${d}`} className={`rounded-full px-3 py-1 text-xs ${String(days) === d ? "bg-oasis text-mist" : "border border-ink/15 text-ink/60 hover:border-oasis"}`}>{R.ranges[d]}</Link>)}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {([["ga", ["google"]], ["meta", ["meta"]], ["shop", ["shopify", "salla", "zid", "woocommerce"]]] as const).map(([key, provs]) => { const on = provs.some((p) => connected.includes(p)); return (
          <div key={key} className="card card-sm">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-ink/50">{R.tiles[key]}</p>
            <p className={`mt-1 text-sm ${on ? "text-oasis" : "text-ink/50"}`}>{on ? "✓" : R.notConnected}</p>
            {!on && <Link href={`/${lang}/app/integrations`} className="mt-2 inline-block text-xs font-semibold text-oasis hover:underline">{R.connectNow} →</Link>}
          </div>
        ); })}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((x) => (
          <div key={x.label} className="card card-sm">
            <p className="text-xs text-ink/60">{x.label}</p>
            <p className="mt-1 page-title" dir="ltr">{x.value}</p>
            {x.sub && <p className="mt-0.5 text-[11px] text-ink/50" dir="auto">{x.sub}</p>}
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="card card-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">{R.weeks}</p>
          <div className="mt-4 flex h-40 items-end gap-2" dir="ltr">
            {k.weeks.map((w) => (
              <div key={w.label} className="flex flex-1 flex-col items-center gap-1" title={`${w.label}: ${w.created} / ${w.approved}`}>
                <div className="flex w-full items-end justify-center gap-0.5" style={{ height: "128px" }}>
                  <div className="w-1/2 rounded-t bg-oasis/30" style={{ height: `${(w.created / max) * 100}%` }} />
                  <div className="w-1/2 rounded-t bg-oasis" style={{ height: `${(w.approved / max) * 100}%` }} />
                </div>
                <span className="font-mono text-[10px] text-ink/50">{w.label}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="grid gap-4">
          {lists.map((l) => (
            <div key={l.label} className="card card-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">{l.label}</p>
              <ul className="mt-2 space-y-1 text-sm">
                {l.rows.length === 0 && <li className="text-ink/40">—</li>}
                {l.rows.map(([name, n]) => (
                  <li key={name} className="flex items-center justify-between"><span>{l.isType ? typeLabel(name) : name}</span><span className="font-mono text-xs" dir="ltr">{n}</span></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold text-oasis">{R.qualityTitle}</h2>
        <p className="mt-1 text-xs text-ink/60">{R.qualitySub}</p>
        <div className="mt-3 overflow-x-auto rounded-xl border border-ink/10 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-salt-dim text-xs text-ink/60"><tr><th className="p-2 text-start">{R.colAgent}</th><th>{R.colItems}</th><th>{R.colApproval}</th><th>{R.colEdit}</th><th>{R.colJudge}</th><th>{R.colLow}</th><th>{R.colThumbs}</th></tr></thead>
            <tbody>
              {quality.map((a) => (
                <tr key={a.agent} className="border-t border-ink/5 text-center">
                  <td className="p-2 text-start font-medium">{t.agents[a.agent].name} <span className="text-xs text-ink/50">· {t.agents[a.agent].role}</span></td>
                  <td className="font-mono" dir="ltr">{a.n}</td>
                  <td className="font-mono" dir="ltr">{a.approvalRate === null ? "—" : a.approvalRate + "%"}</td>
                  <td className="font-mono" dir="ltr">{a.editRate === null ? "—" : a.editRate + "%"}</td>
                  <td className={`font-mono ${a.avgScore !== null && a.avgScore < 70 ? "text-sadu" : a.avgScore !== null && a.avgScore >= 85 ? "text-oasis" : ""}`} dir="ltr">{a.avgScore ?? "—"}</td>
                  <td className="font-mono" dir="ltr">{a.low}</td>
                  <td className="font-mono" dir="ltr">{a.thumbsUp}/{a.thumbsDown}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-ink/50">{R.judgeNote}</p>
      </section>

      <section className="mt-8 rounded-xl border border-oasis/20 bg-salt-dim p-5">
        <h2 className="font-display text-lg font-semibold text-oasis">{R.ask} <span className="text-sm font-normal text-ink/60">· {t.agents.dana.role}</span></h2>
        <p className="mt-1 text-xs text-ink/60">{R.note}</p>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder={t.generate.notes} className="mt-3 input" />
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {agentById("dana").tasks.map((type) => {
            const cost = TASK_COST[type];
            const can = credits >= cost && !busy;
            return (
              <button key={type} disabled={!can} onClick={() => run(type)} className={`rounded-xl border p-4 text-start transition ${busy === type ? "border-saffron bg-oasis text-mist" : "border-ink/10 bg-white hover:border-oasis"} disabled:opacity-50`}>
                <div className="flex items-center justify-between"><span className="font-display font-medium">{t.generate.types[type].t}</span><span className="font-mono text-xs text-sadu" dir="ltr">{cost} {t.generate.cost}</span></div>
                <p className={`mt-1 text-xs ${busy === type ? "text-mist-dim" : "text-ink/70"}`}>{t.generate.types[type].d}</p>
              </button>
            );
          })}
        </div>
        {msg && <p role="status" className="mt-3 rounded-lg border border-oasis/30 bg-white p-3 text-sm text-oasis">{msg}</p>}
      </section>

      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold text-oasis">{R.items}</h2>
        {items.length === 0 ? <p className="mt-2 text-sm text-ink/60">{R.empty}</p> : (
          <ul className="mt-3 divide-y divide-ink/10 rounded-xl border border-ink/10 bg-white">
            {items.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium" dir="auto">{x.title}</p>
                  <p className="text-xs text-ink/50"><span>{typeLabel(x.type)}</span> · <span className="font-mono" dir="ltr">{x.createdAt.slice(0, 10)}</span> · {x.status}</p>
                </div>
                <div className="flex gap-2">
                  {x.type === "board_deck" && <a href={`/api/tasks/${x.id}/pptx`} className="btn btn-accent btn-xs">{t.inbox.pptx}</a>}
                  <Link href={`/${lang}/app`} className="btn btn-secondary btn-xs">{R.open}</Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
