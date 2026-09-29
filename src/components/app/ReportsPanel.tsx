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
import { kpiDelta } from "@/lib/kpi-delta";
import { PLATFORM_METRICS, reportSources } from "@/lib/report-sources";
import { PROVIDER_NAME, SALES_PROVIDERS, moneyText, type SalesProvider, type SalesSnapshot } from "@/lib/connectors/sales";
import { dateFormat } from "@/lib/dates";
import type { PerfSnapshot } from "@/lib/perf-import";
import PerformanceImport from "./PerformanceImport";
import { READS_ADS } from "@/lib/connectors/working";

type Item = { id: string; type: TaskType; title: string; status: string; createdAt: string };

const METRICS = ["created", "approved", "approvalRate", "pending", "published", "images", "creditsUsed", "scheduled"] as const;
type MetricKey = (typeof METRICS)[number];
export default function ReportsPanel({ t, lang, k, items, credits, quality, range = "7", connected = [], store = null, perf = null, perfImport = true, perfDelete = true }: { t: AppDict; lang: Lang; k: Kpis; items: Item[]; credits: number; quality: AgentMetrics[]; range?: string; connected?: string[]; store?: SalesSnapshot | null; perf?: PerfSnapshot | null; /** `can(u, "performance.import")` */ perfImport?: boolean; /** `can(u, "performance.delete")` */ perfDelete?: boolean }) {
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
    const map: Record<string, string> = { no_credits: t.generate.noCredits, trial_over: t.generate.trialOver, no_brand: t.generate.noBrand, model_paused: t.generate.paused, agent_cap: t.limit.agentCapTitle };
    setMsg(map[j.error] ?? t.generate.failed);
  }

  const delta = (cur: number, prev: number) => kpiDelta(cur, prev, R.vsPrev);
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
  // Which sources this page actually reads (report-sources.ts): a connection with no reader behind it counts as missing.
  const sources = reportSources(connected);
  // One store card per workspace: the store last synced while it is still connected, else the first connected one.
  const salesProvider = store && connected.includes(store.provider) ? store.provider : SALES_PROVIDERS.find((p) => connected.includes(p));
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
      {sources.banner && (
        <div className="mb-5 rounded-xl border border-ink/15 bg-white p-4 text-sm" data-testid="sources-banner">
          <p>{sources.banner === "some" ? <><b>{R.warnSomeTitle}</b> {R.warnSomeBody}</> : <><b>{R.warnTitle}</b> {R.warnBody}</>}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {sources.missing.map((key) => <Link key={key} href={`/${lang}/app/integrations`} className="btn btn-secondary btn-xs">{R.sources[key]} · {key === "store" ? R.connectStore : R.connectNow} →</Link>)}
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
      <PerformanceImport lang={lang} initial={perf} ads={connected.filter((p) => READS_ADS.includes(p))} canImport={perfImport} canDelete={perfDelete} />
      {salesProvider && <StoreSales R={R.store} paused={t.generate.paused} provider={salesProvider} store={store?.provider === salesProvider ? store : null} lang={lang} />}

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
            {PLATFORM_METRICS.map((m) => {
              const on = sources.read.includes(m.source);
              // A read source's numbers live in their own card (today only the store card), not in a tile.
              return on
                ? <a key={m.key} href={m.source === "ads" ? "#campaign-results" : "#store-sales"} className="btn btn-xs btn-secondary">✓ {R.platform[m.key as keyof typeof R.platform]} · {m.source === "ads" ? R.inResultsCard : R.inStoreCard}</a>
                : <Link key={m.key} href={`/${lang}/app/integrations`} className="btn btn-xs btn-secondary opacity-70">🔒 {R.platform[m.key as keyof typeof R.platform]} · {m.source === "store" ? R.connectStore : R.connectNow}</Link>;
            })}
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
        <p className="mt-1 text-xs text-ink/60">{store ? R.noteStore : R.note}</p>
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

/** Store orders and abandoned carts, as totals from the last sync. The numbers are the store's, never estimated. */
function StoreSales({ R, paused, provider, store, lang }: { R: AppDict["reports"]["store"]; paused: string; provider: SalesProvider; store: SalesSnapshot | null; lang: Lang }) {
  const r = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [note, setNote] = useState("");
  async function draft() {
    setDrafting(true); setErr(""); setNote("");
    try {
      const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "cart_recovery" }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (j.ok) { setNote(R.drafted); r.refresh(); } else { limitFromError(j.error); setErr(j.error === "model_paused" ? paused : j.error ?? `HTTP ${res.status}`); }
    } catch { setErr("failed"); } finally { setDrafting(false); }
  }
  async function sync() {
    setBusy(true); setErr("");
    const res = await fetch(`/api/connect/${provider}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync_sales" }) });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    setBusy(false);
    if (j.ok) r.refresh(); else setErr(j.error === "orders_access_denied" ? R.accessDenied : j.error === "zid_access_denied" ? R.zidDenied : j.error ?? `HTTP ${res.status}`);
  }
  const fill = (s: string, v: Record<string, number | string>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
  const name = PROVIDER_NAME[provider];
  return (
    <div id="store-sales" className="card mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl font-bold">{fill(R.title, { store: name })}</h2>
        <button onClick={sync} disabled={busy} className="btn btn-secondary btn-xs">{busy ? R.syncing : fill(R.sync, { store: name })}</button>
      </div>
      {!store ? <p className="mt-3 text-sm text-ink/60">{R.never}</p> : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[[R.orders, store.orders.capped ? `${store.orders.count} ${R.capped}` : String(store.orders.count)], [R.revenue, moneyText(store.orders.revenue)], [R.carts, store.carts.unavailable ? "—" : store.carts.capped ? `${store.carts.count} ${R.capped}` : String(store.carts.count)], [R.cartValue, store.carts.unavailable ? "—" : moneyText(store.carts.value)]].map(([label, v]) => (
              <div key={label} className="card card-sm"><p className="text-xs text-ink/60">{label}</p><p className="mt-1 font-display text-2xl font-bold text-oasis" dir="ltr">{v}</p></div>
            ))}
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {[[R.top, store.orders.top], [R.topCarts, store.carts.top]].map(([label, rows]) => (rows as { name: string; qty: number }[]).length > 0 && (
              <div key={label as string}><p className="text-xs font-semibold text-ink/60">{label as string}</p><ul className="mt-1 text-sm">{(rows as { name: string; qty: number }[]).slice(0, 5).map((t) => <li key={t.name} className="flex justify-between gap-2"><span dir="auto">{t.name}</span><span className="font-mono" dir="ltr">{t.qty}</span></li>)}</ul></div>
            ))}
          </div>
          <p className="mt-3 text-xs text-ink/50">
            {R.asOf}: <span dir="ltr" suppressHydrationWarning>{dateFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(store.at))} UTC</span>
            {store.orders.read < store.orders.count && <> · {fill(R.partial, { read: store.orders.read, count: store.orders.count })}</>}
            {store.unread > 0 && <> · {fill(R.unread, { n: store.unread })}</>}
            {store.carts.unavailable && <> · {R.cartsUnavailable}</>}
          </p>
          <p className="mt-1 text-xs text-ink/40">{R.note}</p>
          {store.carts.top.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button onClick={draft} disabled={drafting || busy} className="btn btn-primary btn-xs">{drafting ? R.drafting : R.draft} <span className="font-mono" dir="ltr">· {TASK_COST.cart_recovery}</span></button>
              {note && <Link href={`/${lang}/app`} className="text-xs text-oasis underline">{note}</Link>}
            </div>
          )}
        </>
      )}
      {err && <p className="mt-2 text-xs text-sadu" dir="auto">{err}</p>}
    </div>
  );
}
