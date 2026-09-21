"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import { TASK_COST, type TaskType } from "@/lib/tasks";
import { agentById } from "@/lib/agents";
import { limitFromError } from "./LimitModal";
import type { Kpis } from "@/lib/stats";
import type { AgentMetrics } from "@/lib/evals";
import type { Lang } from "@/lib/i18n";

type Item = { id: string; type: TaskType; title: string; status: string; createdAt: string };

const METRICS = ["created", "approved", "approvalRate", "pending", "published", "images", "creditsUsed", "scheduled"] as const;
type MetricKey = (typeof METRICS)[number];
const PLATFORM_METRICS: { key: string; provs: string[] }[] = [
  { key: "visitors", provs: ["google"] }, { key: "sessions", provs: ["google"] }, { key: "adSpend", provs: ["meta", "snapchat", "tiktok", "google"] }, { key: "roas", provs: ["meta", "snapchat", "tiktok", "google"] }, { key: "orders", provs: ["shopify", "salla", "zid", "woocommerce"] }, { key: "revenue", provs: ["shopify", "salla", "zid", "woocommerce"] }, { key: "followers", provs: ["instagram", "tiktok", "snapchat", "x"] },
];
const SOURCES: { key: string; provs: string[] }[] = [
  { key: "analytics", provs: ["google"] }, { key: "ads", provs: ["meta", "snapchat", "tiktok", "google"] }, { key: "store", provs: ["shopify", "salla", "zid", "woocommerce"] }, { key: "social", provs: ["instagram", "tiktok", "snapchat", "x", "linkedin"] },
];

export default function ReportsPanel({ t, lang, k, items, credits, quality, range = "7", connected = [] }: { t: AppDict; lang: Lang; k: Kpis; items: Item[]; credits: number; quality: AgentMetrics[]; range?: string; connected?: string[] }) {
  const r = useRouter();
  const R = t.reports;
  const [busy, setBusy] = useState<TaskType | null>(null);
  const [msg, setMsg] = useState("");
  const [notes, setNotes] = useState("");
  const [picked, setPicked] = useState<MetricKey[]>(["created", "approved", "approvalRate", "published"]);
  const [adding, setAdding] = useState(false);
  const [series, setSeries] = useState<Record<"created" | "approved" | "published", boolean>>({ created: true, approved: true, published: true });
  // Saved tiles are read after mount (not in the initial state) so server and client render the same first frame.
  useEffect(() => { void Promise.resolve().then(() => { try { const s = localStorage.getItem("nashr:metrics"); if (s) setPicked(JSON.parse(s)); } catch { /* ignore */ } }); }, []);
  const savePicked = (p: MetricKey[]) => { setPicked(p); try { localStorage.setItem("nashr:metrics", JSON.stringify(p)); } catch { /* ignore */ } };

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
  const value: Record<MetricKey, { label: string; value: string; sub?: string }> = {
    created: { label: R.created, value: String(k.created), sub: delta(k.created, k.createdPrev) },
    approved: { label: R.approved, value: String(k.approved) },
    approvalRate: { label: R.approvalRate, value: k.approvalRate === null ? "—" : `${k.approvalRate}%` },
    pending: { label: R.pending, value: String(k.pending) },
    published: { label: R.published, value: String(k.published) },
    images: { label: R.images, value: String(k.images) },
    creditsUsed: { label: R.creditsUsed, value: String(k.creditsUsed), sub: delta(k.creditsUsed, k.creditsUsedPrev) },
    scheduled: { label: R.scheduled, value: String(k.scheduled) },
  };
  const missing = SOURCES.filter((s) => !s.provs.some((p) => connected.includes(p)));
  const top = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const typeLabel = (x: string) => (t.generate.types as Record<string, { t: string }>)[x]?.t ?? x;
  const max = Math.max(1, ...k.weeks.map((w) => w.created));
  const lists: { label: string; rows: [string, number][]; isType: boolean }[] = [
    { label: R.byType, rows: top(k.byType), isType: true },
    { label: R.byChannel, rows: top(k.byChannel), isType: false },
  ];
  // trends chart (SVG)
  const W = 720, H = 200, PAD = 28;
  const pts = k.daily;
  const maxY = Math.max(1, ...pts.map((d) => Math.max(series.created ? d.created : 0, series.approved ? d.approved : 0, series.published ? d.published : 0)));
  const xAt = (i: number) => PAD + (pts.length > 1 ? (i / (pts.length - 1)) * (W - 2 * PAD) : (W - 2 * PAD) / 2);
  const yAt = (v: number) => H - PAD - (v / maxY) * (H - 2 * PAD);
  const line = (key: "created" | "approved" | "published") => pts.map((d, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(d[key]).toFixed(1)}`).join(" ");
  const colors = { created: "var(--color-inverse-muted)", approved: "var(--color-primary)", published: "var(--color-accent)" };
  const rangeHref = (rg: string) => `/${lang}/app/reports?range=${rg}`;

  return (
    <div className="mx-auto max-w-5xl">
      {missing.length > 0 && (
        <div className="mb-5 rounded-xl border border-ink/15 bg-white p-4 text-sm">
          <p><b>{R.warnTitle}</b> {R.warnBody}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {missing.map((s) => <Link key={s.key} href={`/${lang}/app/integrations`} className="btn btn-secondary btn-xs">{R.sources[s.key as keyof typeof R.sources]} · {R.connectNow} →</Link>)}
          </div>
        </div>
      )}
      <h1 className="page-title">{R.title}</h1>
      <p className="mt-2 text-ink/70">{R.sub}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {(["1", "2", "7", "30", "60", "90", "ytd", "ly"] as const).map((rg) => <Link key={rg} href={rangeHref(rg)} className={`rounded-full px-3 py-1 text-xs ${range === rg ? "bg-ink text-salt" : "border border-ink/15 text-ink/60 hover:border-oasis"}`}>{R.ranges[rg]}</Link>)}
        <form action={`/${lang}/app/reports`} className="flex items-center gap-1 text-xs"><input type="hidden" name="range" value="custom" /><input type="date" name="from" dir="ltr" className="rounded-full border border-ink/15 px-2 py-1" /><input type="date" name="to" dir="ltr" className="rounded-full border border-ink/15 px-2 py-1" /><button className={`rounded-full px-3 py-1 ${range === "custom" ? "bg-ink text-salt" : "border border-ink/15 text-ink/60"}`}>{R.ranges.custom}</button></form>
      </div>
      <p className="mt-2 font-mono text-xs text-ink/50" dir="ltr">{k.window.from} → {k.window.to}</p>

      <h2 className="mt-8 font-display text-xl font-bold">{R.metricsTitle}</h2>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {picked.map((key) => (
          <div key={key} className="card card-sm relative">
            <button onClick={() => savePicked(picked.filter((p) => p !== key))} className="absolute end-2 top-2 text-xs text-ink/30 hover:text-sadu" aria-label={R.removeMetric}>✕</button>
            <p className="text-xs text-ink/60">{value[key].label}</p>
            <p className="mt-1 font-display text-3xl font-bold text-oasis" dir="ltr">{value[key].value}</p>
            {value[key].sub && <p className="mt-0.5 text-xs text-ink/50" dir="auto">{value[key].sub}</p>}
          </div>
        ))}
        <button onClick={() => setAdding(!adding)} className="grid min-h-24 place-items-center rounded-xl border-2 border-dashed border-ink/15 text-sm text-ink/50 hover:border-oasis hover:text-oasis"><span><span className="block text-2xl">+</span>{R.addMetric}</span></button>
      </div>
      {adding && (
        <div className="card mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">{R.workspaceMetrics}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {METRICS.filter((m) => !picked.includes(m)).map((m) => <button key={m} onClick={() => { savePicked([...picked, m]); }} className="btn btn-secondary btn-xs">+ {value[m].label}</button>)}
          </div>
          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink/60">{R.platformMetrics}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {PLATFORM_METRICS.map((m) => { const on = m.provs.some((p) => connected.includes(p)); return <Link key={m.key} href={`/${lang}/app/integrations`} className={`btn btn-xs ${on ? "btn-primary" : "btn-secondary opacity-70"}`}>{on ? "+" : "🔒"} {R.platform[m.key as keyof typeof R.platform]}{!on && ` · ${R.connectNow}`}</Link>; })}
          </div>
        </div>
      )}

      <div className="card mt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-xl font-bold">{R.trendsTitle}</h2>
          <div className="flex gap-2"><button onClick={() => setSeries({ created: true, approved: true, published: true })} className="btn btn-secondary btn-xs">{R.showAll}</button><button onClick={() => setSeries({ created: false, approved: false, published: false })} className="btn btn-secondary btn-xs">{R.hideAll}</button></div>
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-xs">
          {(["created", "approved", "published"] as const).map((key) => <label key={key} className="flex items-center gap-1.5"><input type="checkbox" checked={series[key]} onChange={() => setSeries((p) => ({ ...p, [key]: !p[key] }))} /><span className="inline-block h-2 w-4 rounded" style={{ background: colors[key] }} />{R.series[key]}</label>)}
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full" role="img" aria-label={R.trendsTitle}>
          {[0, 0.5, 1].map((f) => <g key={f}><line x1={PAD} x2={W - PAD} y1={yAt(maxY * f)} y2={yAt(maxY * f)} stroke="currentColor" strokeOpacity="0.08" /><text x={W - PAD + 4} y={yAt(maxY * f) + 4} fontSize="10" fill="currentColor" fillOpacity="0.5">{Math.round(maxY * f)}</text></g>)}
          {(["created", "approved", "published"] as const).filter((key) => series[key]).map((key) => <path key={key} d={line(key)} fill="none" stroke={colors[key]} strokeWidth="2" strokeLinejoin="round" />)}
          {pts.length > 0 && [0, Math.floor(pts.length / 2), pts.length - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => <text key={i} x={xAt(i)} y={H - 6} fontSize="10" textAnchor="middle" fill="currentColor" fillOpacity="0.5">{pts[i].date.slice(5)}</text>)}
        </svg>
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
                <span className="font-mono text-xs text-ink/50">{w.label}</span>
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
        {/* The table is computed over the selected range. Its title used to say "last 30 days" whatever was selected,
            so on the default 7-day view it described a period four times longer than the numbers under it. */}
        <h2 className="font-display text-lg font-semibold text-oasis">{R.qualityTitle} <span className="text-sm font-normal text-ink/50">· {Object.entries(R.ranges).find(([key]) => key === range)?.[1] ?? R.ranges.custom}</span></h2>
        <p className="mt-1 text-xs text-ink/60">{R.qualitySub}</p>
        <p className="mt-1 text-xs text-ink/50">{R.denomNote}</p>
        <div className="mt-3 overflow-x-auto rounded-xl border border-ink/10 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-salt-dim text-xs text-ink/60"><tr><th className="p-2 text-start">{R.colAgent}</th><th>{R.colItems}</th><th>{R.colApproval}</th><th>{R.colEdit}</th><th>{R.colJudge}</th><th>{R.colLow}</th><th>{R.colThumbs}</th></tr></thead>
            <tbody>
              {quality.map((a) => (
                <tr key={a.agent} className="border-t border-ink/5 text-center">
                  <td className="p-2 text-start font-medium">{t.agents[a.agent].name} <span className="text-xs text-ink/50">· {t.agents[a.agent].role}</span></td>
                  <td className="font-mono" dir="ltr">{a.n}</td>
                  {/* Each rate carries its own denominator. "Items" is not the denominator of any of them. */}
                  <td className="font-mono" dir="ltr" data-testid={`q-approval-${a.agent}`}>{a.approvalRate === null ? "—" : a.approvalRate + "%"}<span className="text-ink/40"> · {a.decided}</span></td>
                  <td className="font-mono" dir="ltr" data-testid={`q-edit-${a.agent}`}>{a.editRate === null ? "—" : a.editRate + "%"}<span className="text-ink/40"> · {a.reviewedApproved}</span></td>
                  <td className={`font-mono ${a.avgScore !== null && a.avgScore < 70 ? "text-sadu" : a.avgScore !== null && a.avgScore >= 85 ? "text-oasis" : ""}`} dir="ltr" data-testid={`q-judge-${a.agent}`}>{a.avgScore ?? "—"}<span className="text-ink/40"> · {a.judged}</span></td>
                  <td className="font-mono" dir="ltr" data-testid={`q-low-${a.agent}`}>{a.low}/{a.judged}</td>
                  <td className="font-mono" dir="ltr">{a.thumbsUp}/{a.thumbsDown}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {quality.some((a) => a.autoApproved > 0) && <p className="mt-2 text-xs text-ink/50" data-testid="q-auto-note"><span className="font-mono" dir="ltr">{quality.reduce((s, a) => s + a.autoApproved, 0)}</span> {R.autoNote}</p>}
        <p className="mt-2 text-xs text-ink/50">{R.judgeNote}</p>
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
