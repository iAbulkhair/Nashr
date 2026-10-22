"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import { TASK_COST, type TaskType } from "@/lib/tasks";
import { agentById } from "@/lib/agents";
import { limitFromError, noCreditsText } from "./LimitModal";
import { scopeRefusalText } from "@/lib/scope-refusal";
import { modelErrorText } from "@/lib/provider-errors";
import type { Kpis } from "@/lib/stats";
import type { AgentMetrics } from "@/lib/evals";
import { nextArrow } from "@/lib/format";
import type { Lang } from "@/lib/i18n";
import { kpiDelta } from "@/lib/kpi-delta";
import { PLATFORM_METRICS, reportSources, socialRead, type SiteChoices } from "@/lib/report-sources";
import { PROVIDER_NAME, SALES_PROVIDERS, moneyText, type SalesProvider, type SalesSnapshot } from "@/lib/connectors/sales";
import { dateFormat } from "@/lib/dates";
import { connectError } from "@/lib/connect-errors";
import type { PerfSnapshot } from "@/lib/perf-import";
import PerformanceImport from "./PerformanceImport";
import SiteStats from "./SiteStats";
import type { SiteSnapshot } from "@/lib/site-stats";
import SocialStats from "./SocialStats";
import type { StoredSocial, XStats } from "@/lib/social-stats";
import type { NotReadItem, NotReadReason } from "@/lib/not-read";
import { READS_ADS } from "@/lib/connectors/working";
import Scribble from "@/components/Scribble";
import { Time } from "@/components/ui/Time";
import { useToast } from "@/components/ui/Toast";
import EmptyState from "@/components/ui/EmptyState";
import { emptyCopy, emptyHelp } from "@/lib/empty-copy";
import { METRICS_KEY, readStored, writeStored } from "@/lib/cookie-names";
import { useAppLink } from "@/components/app/WorkspaceContext";
import { useApiHref } from "./useBrandHref";

type Item = { id: string; type: TaskType; title: string; status: string; createdAt: string };
/**
 * Not-read reasons that ask nothing of the owner on this page: the ones every workspace that has not connected anything
 * holds, and `publish_only` (a direct Meta record that publishes, which no button here can make readable). Alone they do
 * not open the social card.
 */
export const QUIET: readonly NotReadReason[] = ["not_connected", "publish_only", "closed_to_apps", "waiting_approval"];

const METRICS = ["created", "approved", "approvalRate", "pending", "published", "images", "videos", "creditsUsed", "scheduled"] as const;
type MetricKey = (typeof METRICS)[number];
export default function ReportsPanel({ t, lang, k, items, credits, quality, range = "7", connected = [], store = null, site = null, social = null, liNoPage = false, x = null, notRead = [], socialVia = null, xConnected = false, siteChoices = null, canRead = false, canGenerate = false, canConnectors = false, syncFailure = null, perf = null, perfImport = true, perfDelete = true, owner = true, topups = true }: { t: AppDict; lang: Lang; k: Kpis; items: Item[]; credits: number; quality: AgentMetrics[]; range?: string; connected?: string[]; store?: SalesSnapshot | null; /** `getSiteSnapshot`: GA4 and Search Console totals (src/lib/site-stats.ts). */ site?: SiteSnapshot | null; /** `getSocialSnapshot`: every platform part from the last read, or a snapshot from before v2 (src/lib/social-stats.ts). */ social?: StoredSocial | null; /** `liNeedsPage`: LinkedIn is connected through Composio with no company page chosen. */ liNoPage?: boolean; /** `xReadOf(getXStats)`, without the account's id: X's last paid read (rule 744). */ x?: XStats | null; /** `notReadOf` over the page's own reads (rule 738). */ notRead?: NotReadItem[]; /** `socialRefreshPath`: the provider path the social Refresh posts to. */ socialVia?: string | null; /** `xDirect`: X is connected directly. */ xConnected?: boolean; /** `siteChoices`: the GA4 properties and Search Console sites listed at connect. */ siteChoices?: SiteChoices | null; /** `can(u, "read")`: the free refreshes (rule 735). */ canRead?: boolean; /** `can(u, "generate")`: X's paid refresh (rule 744). */ canGenerate?: boolean; /** `can(u, "connectors")`: the property choice (rule 734). */ canConnectors?: boolean; /** `getSyncFailure`: the last automatic store sync that failed, until one succeeds. */ syncFailure?: { at: string; provider: string } | null; perf?: PerfSnapshot | null; /** `can(u, "performance.import")` */ perfImport?: boolean; /** `can(u, "performance.delete")` */ perfDelete?: boolean; /** `can(u, "billing")`: picks the out-of-credits line (rule 457). */ owner?: boolean; /** `topupsSold(u.plan)` */ topups?: boolean }) {
  const href = useAppLink(lang);
  const r = useRouter();
  const apiHref = useApiHref();
  const R = t.reports;
  const toast = useToast();
  const E = emptyCopy(lang, "reports");
  const [busy, setBusy] = useState<TaskType | null>(null);
  const [msg, setMsg] = useState("");
  const [notes, setNotes] = useState("");
  const [picked, setPicked] = useState<MetricKey[]>(["created", "approved", "approvalRate", "published"]);
  const [adding, setAdding] = useState(false);
  const [series, setSeries] = useState<Record<"created" | "approved" | "published", boolean>>({ created: true, approved: true, published: true });
  // Saved tiles are read after mount (not in the initial state) so server and client render the same first frame.
  useEffect(() => { void Promise.resolve().then(() => { try { const s = readStored(localStorage, METRICS_KEY); if (s) setPicked(JSON.parse(s)); } catch { /* ignore */ } }); }, []);
  const savePicked = (p: MetricKey[]) => { setPicked(p); try { writeStored(localStorage, METRICS_KEY, JSON.stringify(p)); } catch { /* ignore */ } };

  const refusals: Record<string, string> = { no_credits: noCreditsText(t.generate, owner, topups), trial_over: t.generate.trialOver, no_brand: t.generate.noBrand, model_paused: t.generate.paused, agent_cap: t.limit.agentCapTitle, fair_use: t.limit.fairUseTitle };
  async function run(type: TaskType) {
    setBusy(type); setMsg(t.generate.running);
    // Rule 2971: a dropped connection makes fetch throw and a gateway 502 returns HTML, so res.json() throws too. `finally`
    // always clears `busy`; before, the run buttons stayed disabled with "running" frozen until a reload (as GeneratePanel).
    try {
      const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, notes }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      // Rule 2001: the finished run is a toast; the inline line keeps the running words and the refusals the owner must act on.
      if (res.ok && j.ok) { setMsg(""); toast.success(t.generate.done); r.refresh(); return; }
      limitFromError(j.error);
      // Outside what the team works on (rule 796), or too many such requests: the server wrote the answer in the owner's language.
      // Shown as text in the status line, never as HTML.
      const refused = scopeRefusalText(j);
      if (refused) { setMsg(refused); return; }
      // A mapped refusal (limits, no brand, models paused) is something the owner must act on or wait for: it stays inline.
      if (j.error && refusals[j.error]) { setMsg(refusals[j.error]); return; }
      setMsg("");
      toast.danger(modelErrorText(lang, j.error) ?? t.generate.failed);
    } catch {
      setMsg("");
      toast.danger(t.generate.failed);
    } finally {
      setBusy(null);
    }
  }

  const delta = (cur: number, prev: number) => kpiDelta(cur, prev, R.vsPrev);
  const value: Record<MetricKey, { label: string; value: string; sub?: string }> = {
    created: { label: R.created, value: String(k.created), sub: delta(k.created, k.createdPrev) },
    approved: { label: R.approved, value: String(k.approved) },
    approvalRate: { label: R.approvalRate, value: k.approvalRate === null ? "—" : `${k.approvalRate}%` },
    pending: { label: R.pending, value: String(k.pending) },
    published: { label: R.published, value: String(k.published) },
    images: { label: R.images, value: String(k.images) },
    videos: { label: R.videos, value: String(k.videos) },
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
  // Chart series tokens (rule 967): each at least 3:1 on paper, each with its own dash so the lines differ without colour.
  const colors = { created: "var(--chart-1)", approved: "var(--chart-2)", published: "var(--chart-3)" };
  const dashes = { created: undefined, approved: "6 3", published: "2 3" };
  const swatch = (key: keyof typeof colors) => <svg width="16" height="8" aria-hidden="true" className="shrink-0"><line x1="0" y1="4" x2="16" y2="4" stroke={colors[key]} strokeWidth="2" strokeDasharray={dashes[key]} /></svg>;
  const rangeHref = (rg: string) => href(`/reports?range=${rg}`);
  // The chart's day labels and the table under it (rule 1129): a calendar day, in the page's language and Western digits.
  const dayLabel = dateFormat(lang, { month: "short", day: "numeric" });

  return (
    <div className="mx-auto w-full max-w-5xl">
      {sources.banner && (
        <div className="mb-5 rounded-xl border border-border bg-surface p-4 text-sm" data-testid="sources-banner">
          <p>{sources.banner === "some" ? <><b>{R.warnSomeTitle}</b> {R.warnSomeBody}</> : <><b>{R.warnTitle}</b> {R.warnBody}</>}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {sources.missing.map((key) => <Link key={key} href={href("/settings/connections")} className="btn btn-secondary btn-xs">{R.sources[key]} · {key === "store" ? R.connectStore : R.connectNow} {nextArrow(lang)}</Link>)}
          </div>
        </div>
      )}
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="reportspanel-t1" />{R.title}</span></h1>
      <p className="mt-2 text-foreground-muted">{R.sub}</p>
      {/* Rule 1129: the chosen range is marked for screen readers as well as by fill; 44px targets on touch screens. */}
      <nav aria-label={t.ux.reports.rangeLabel} className="mt-4 flex flex-wrap gap-2">
        {(["1", "2", "7", "30", "60", "90", "ytd", "ly"] as const).map((rg) => <Link key={rg} href={rangeHref(rg)} aria-current={range === rg ? "page" : undefined} className={`inline-flex min-h-[var(--hit-min)] items-center rounded-full px-3 text-xs pointer-fine:min-h-7 ${range === rg ? "bg-inverse font-semibold text-inverse-foreground" : "border border-border text-foreground-muted hover:border-border-strong"}`}>{R.ranges[rg]}</Link>)}
        <form action={href("/reports")} className="flex items-center gap-1 text-xs"><input type="hidden" name="range" value="custom" /><input type="date" name="from" dir="ltr" className="rounded-full border border-border px-2 py-1" /><input type="date" name="to" dir="ltr" className="rounded-full border border-border px-2 py-1" /><button aria-current={range === "custom" ? "page" : undefined} className={`rounded-full px-3 py-1 ${range === "custom" ? "bg-inverse text-inverse-foreground" : "border border-border text-foreground-muted"}`}>{R.ranges.custom}</button></form>
      </nav>
      <p className="mt-2 font-mono text-xs text-foreground-muted" dir="ltr">{k.window.from} → {k.window.to}</p>
      <PerformanceImport lang={lang} initial={perf} ads={connected.filter((p) => READS_ADS.includes(p))} canImport={perfImport} canDelete={perfDelete} />
      {/* A Composio Google record opens the card before its first read, or after a read that failed for both parts, so
          the property choice and the refresh stay reachable (rules 734, 735). */}
      {((site && (site.ga || site.gsc)) || siteChoices) && <SiteStats lang={lang} site={site} properties={siteChoices ?? undefined} canChoose={canConnectors} canRefresh={canRead} />}
      {(social || x || liNoPage || socialVia || xConnected || notRead.some((i) => !QUIET.includes(i.reason))) && (
        <SocialStats lang={lang} social={social} x={x} notRead={notRead} liNoPage={liNoPage} canRefresh={canRead} socialVia={socialVia} canRefreshX={canGenerate} xConnected={xConnected} noCredits={noCreditsText(t.generate, owner, topups)} />
      )}
      {salesProvider && <StoreSales R={R.store} refusals={refusals} failed={t.generate.failed} provider={salesProvider} store={store?.provider === salesProvider ? store : null} failedAt={syncFailure?.provider === salesProvider ? syncFailure.at : null} lang={lang} />}

      <h2 className="mt-8 font-display text-xl font-bold">{R.metricsTitle}</h2>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {picked.map((key) => (
          <div key={key} className="card card-sm relative">
            <button onClick={() => savePicked(picked.filter((p) => p !== key))} className="absolute end-2 top-2 text-xs text-foreground-muted hover:text-danger" aria-label={R.removeMetric}>✕</button>
            <p className="text-xs text-foreground-muted">{value[key].label}</p>
            <p className="mt-1 font-display text-3xl font-bold text-foreground" dir="ltr">{value[key].value}</p>
            {value[key].sub && <p className="mt-0.5 text-xs text-foreground-muted" dir="auto">{value[key].sub}</p>}
          </div>
        ))}
        <button onClick={() => setAdding(!adding)} className="grid min-h-24 place-items-center rounded-xl border-2 border-dashed border-border text-sm text-foreground-muted hover:border-border-strong hover:text-foreground"><span><span className="block text-2xl">+</span>{R.addMetric}</span></button>
      </div>
      {adding && (
        <div className="card mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{R.workspaceMetrics}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {METRICS.filter((m) => !picked.includes(m)).map((m) => <button key={m} onClick={() => { savePicked([...picked, m]); }} className="btn btn-secondary btn-xs">+ {value[m].label}</button>)}
          </div>
          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-foreground-muted">{R.platformMetrics}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {PLATFORM_METRICS.map((m) => {
              // Followers unlock once a social part was read, not when a record merely exists (rule 670).
              const on = m.source === "social" ? socialRead(social) : sources.read.includes(m.source);
              // A read source's numbers live in their own card (store, campaign results, site, social), not in a tile.
              return on
                ? <a key={m.key} href={m.source === "ads" ? "#campaign-results" : m.source === "analytics" ? "#site-stats" : m.source === "social" ? "#social-stats" : "#store-sales"} className="btn btn-xs btn-secondary">✓ {R.platform[m.key as keyof typeof R.platform]} · {m.source === "ads" ? R.inResultsCard : m.source === "analytics" ? R.inSiteCard : m.source === "social" ? R.inSocialCard : R.inStoreCard}</a>
                : <Link key={m.key} href={href("/settings/connections")} className="btn btn-xs btn-secondary opacity-70">🔒 {R.platform[m.key as keyof typeof R.platform]} · {m.source === "store" ? R.connectStore : R.connectNow}</Link>;
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
          {(["created", "approved", "published"] as const).map((key) => <label key={key} className="flex items-center gap-1.5"><input type="checkbox" checked={series[key]} onChange={() => setSeries((p) => ({ ...p, [key]: !p[key] }))} />{swatch(key)}{R.series[key]}</label>)}
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full" role="img" aria-label={R.trendsTitle} aria-describedby="trend-table">
          {[0, 0.5, 1].map((f) => <g key={f}><line x1={PAD} x2={W - PAD} y1={yAt(maxY * f)} y2={yAt(maxY * f)} stroke="currentColor" strokeOpacity="0.08" /><text x={W - PAD + 4} y={yAt(maxY * f) + 4} fontSize="10" fill="currentColor" fillOpacity="0.5">{Math.round(maxY * f)}</text></g>)}
          {(["created", "approved", "published"] as const).filter((key) => series[key]).map((key) => <path key={key} d={line(key)} fill="none" stroke={colors[key]} strokeWidth="2" strokeDasharray={dashes[key]} strokeLinejoin="round" />)}
          {pts.length > 0 && [0, Math.floor(pts.length / 2), pts.length - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => <text key={i} x={xAt(i)} y={H - 6} fontSize="10" textAnchor="middle" fill="currentColor" fillOpacity="0.5" suppressHydrationWarning>{dayLabel.format(new Date(pts[i].date))}</text>)}
        </svg>
        {/* The same numbers as a table (rule 1129): the chart is a picture; this is what a screen reader and a careful
            reader use. Closed by default, so the card stays a chart. */}
        {pts.length > 0 && (
          <details className="mt-3 text-sm">
            <summary className="inline-flex min-h-[var(--hit-min)] cursor-pointer items-center text-xs font-semibold text-foreground pointer-fine:min-h-8">{t.ux.reports.table}</summary>
            <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-border">
              <table id="trend-table" className="w-full text-xs">
                <caption className="sr-only">{R.trendsTitle}</caption>
                <thead className="sticky top-0 bg-surface-muted">
                  <tr><th scope="col" className="p-2 text-start font-semibold">{t.ux.reports.date}</th>{(["created", "approved", "published"] as const).map((key) => <th key={key} scope="col" className="p-2 text-end font-semibold">{R.series[key]}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {pts.map((d) => <tr key={d.date}><th scope="row" className="p-2 text-start font-normal" suppressHydrationWarning>{dayLabel.format(new Date(d.date))}</th><td className="tnum p-2 text-end">{d.created}</td><td className="tnum p-2 text-end">{d.approved}</td><td className="tnum p-2 text-end">{d.published}</td></tr>)}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="card card-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{R.weeks}</p>
          <div className="mt-4 flex h-40 items-end gap-2" dir="ltr">
            {k.weeks.map((w) => (
              <div key={w.label} className="flex flex-1 flex-col items-center gap-1" title={`${w.label}: ${w.created} / ${w.approved}`}>
                <div className="flex w-full items-end justify-center gap-0.5" style={{ height: "128px" }}>
                  <div className="w-1/2 rounded-t bg-foreground/30" style={{ height: `${(w.created / max) * 100}%` }} />
                  <div className="w-1/2 rounded-t bg-foreground" style={{ height: `${(w.approved / max) * 100}%` }} />
                </div>
                <span className="font-mono text-xs text-foreground-muted">{w.label}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="grid gap-4">
          {lists.map((l) => (
            <div key={l.label} className="card card-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{l.label}</p>
              <ul className="mt-2 space-y-1 text-sm">
                {l.rows.length === 0 && <li className="text-foreground-muted">—</li>}
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
        <h2 className="font-display text-lg font-semibold text-foreground">{R.qualityTitle} <span className="text-sm font-normal text-foreground-muted">· {Object.entries(R.ranges).find(([key]) => key === range)?.[1] ?? R.ranges.custom}</span></h2>
        <p className="mt-1 text-xs text-foreground-muted">{R.qualitySub}</p>
        <p className="mt-1 text-xs text-foreground-muted">{R.denomNote}</p>
        <div className="mt-3 overflow-x-auto rounded-xl border border-foreground/10 bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-background-muted text-xs text-foreground-muted"><tr><th className="p-2 text-start">{R.colAgent}</th><th>{R.colItems}</th><th>{R.colApproval}</th><th>{R.colEdit}</th><th>{R.colJudge}</th><th>{R.colLow}</th><th>{R.colThumbs}</th></tr></thead>
            <tbody>
              {quality.map((a) => (
                <tr key={a.agent} className="border-t border-foreground/5 text-center">
                  <td className="p-2 text-start font-medium">{t.agents[a.agent].name} <span className="text-xs text-foreground-muted">· {t.agents[a.agent].role}</span></td>
                  <td className="font-mono" dir="ltr">{a.n}</td>
                  {/* Each rate carries its own denominator. "Items" is not the denominator of any of them. */}
                  <td className="font-mono" dir="ltr" data-testid={`q-approval-${a.agent}`}>{a.approvalRate === null ? "—" : a.approvalRate + "%"}<span className="text-foreground-muted"> · {a.decided}</span></td>
                  <td className="font-mono" dir="ltr" data-testid={`q-edit-${a.agent}`}>{a.editRate === null ? "—" : a.editRate + "%"}<span className="text-foreground-muted"> · {a.reviewedApproved}</span></td>
                  <td className={`font-mono ${a.avgScore !== null && a.avgScore < 70 ? "text-danger" : a.avgScore !== null && a.avgScore >= 85 ? "text-foreground" : ""}`} dir="ltr" data-testid={`q-judge-${a.agent}`}>{a.avgScore ?? "—"}<span className="text-foreground-muted"> · {a.judged}</span></td>
                  <td className="font-mono" dir="ltr" data-testid={`q-low-${a.agent}`}>{a.low}/{a.judged}</td>
                  <td className="font-mono" dir="ltr">{a.thumbsUp}/{a.thumbsDown}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {quality.some((a) => a.autoApproved > 0) && <p className="mt-2 text-xs text-foreground-muted" data-testid="q-auto-note"><span className="font-mono" dir="ltr">{quality.reduce((s, a) => s + a.autoApproved, 0)}</span> {R.autoNote}</p>}
        <p className="mt-2 text-xs text-foreground-muted">{R.judgeNote}</p>
      </section>

      <section className="mt-8 rounded-xl border border-border bg-background-muted p-5">
        <h2 className="font-display text-lg font-semibold text-foreground">{R.ask} <span className="text-sm font-normal text-foreground-muted">· {t.agents.dana.role}</span></h2>
        <p className="mt-1 text-xs text-foreground-muted">{store ? R.noteStore : R.note}</p>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder={t.generate.notes} className="mt-3 input" />
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {agentById("dana").tasks.map((type) => {
            const cost = TASK_COST[type];
            const can = credits >= cost && !busy;
            return (
              <button key={type} disabled={!can} onClick={() => run(type)} className={`rounded-xl border p-4 text-start transition ${busy === type ? "border-lemon bg-inverse text-inverse-muted" : "border-foreground/10 bg-surface hover:border-border-strong"} disabled:opacity-50`}>
                <div className="flex items-center justify-between"><span className="font-display font-medium">{t.generate.types[type].t}</span><span className="tnum text-xs font-semibold text-foreground" dir="ltr">{cost} {t.generate.cost}</span></div>
                <p className={`mt-1 text-xs ${busy === type ? "text-inverse-muted/75" : "text-foreground-muted"}`}>{t.generate.types[type].d}</p>
              </button>
            );
          })}
        </div>
        {msg && <p role="status" className="mt-3 rounded-lg border border-foreground/30 bg-surface p-3 text-sm text-foreground">{msg}</p>}
      </section>

      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold text-foreground">{R.items}</h2>
        {items.length === 0 ? <EmptyState compact className="mt-2" title={E.title} body={E.body} help={emptyHelp(lang, "reports")} /> : (
          <ul className="mt-3 divide-y divide-foreground/10 rounded-xl border border-foreground/10 bg-surface">
            {items.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium" dir="auto">{x.title}</p>
                  <p className="text-xs text-foreground-muted"><span>{typeLabel(x.type)}</span> · <Time value={x.createdAt} lang={lang} className="tnum" /> · {x.status}</p>
                </div>
                <div className="flex gap-2">
                  {x.type === "board_deck" && <a href={apiHref(`/api/tasks/${x.id}/pptx`)} className="btn btn-accent btn-xs">{t.inbox.pptx}</a>}
                  <Link href={href()} className="btn btn-secondary btn-xs">{R.open}</Link>
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
function StoreSales({ R, refusals, failed, provider, store, failedAt, lang }: { R: AppDict["reports"]["store"]; /** The report buttons' refusal words by error code (limits, no brand, models paused). */ refusals: Record<string, string>; failed: string; provider: SalesProvider; store: SalesSnapshot | null; failedAt: string | null; lang: Lang }) {
  const href = useAppLink(lang);
  const r = useRouter();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const [err, setErr] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [note, setNote] = useState("");
  async function draft() {
    setDrafting(true); setErr(""); setNote("");
    try {
      const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "cart_recovery" }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      // The same refusal copy as the report buttons (rule 796), shown as text. Refusals stay beside the card; any other failure is a toast (rule 2001).
      if (j.ok) { setNote(R.drafted); r.refresh(); return; }
      limitFromError(j.error);
      const refused = scopeRefusalText(j) ?? refusals[j.error ?? ""];
      if (refused) setErr(refused);
      else toast.danger(modelErrorText(lang, j.error) ?? failed);
    } catch { toast.danger(failed); } finally { setDrafting(false); }
  }
  async function sync() {
    setBusy(true); setErr("");
    const res = await fetch(`/api/connect/${provider}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync_sales" }) });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    setBusy(false);
    if (j.ok) r.refresh();
    // A store that refused access says what to reconnect: that stays beside the card. Any other failure is a toast.
    else if (j.error === "orders_access_denied" || j.error === "zid_access_denied" || j.error === "woo_access_denied") setErr(j.error === "orders_access_denied" ? R.accessDenied : j.error === "zid_access_denied" ? R.zidDenied : R.wooDenied);
    else toast.danger(j.error === "slow_down" ? connectError(lang, j.error) : j.error ?? `HTTP ${res.status}`);
  }
  const fill = (s: string, v: Record<string, number | string>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
  const name = PROVIDER_NAME[provider];
  return (
    <div id="store-sales" className="card mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl font-bold">{fill(R.title, { store: name })}</h2>
        <button onClick={sync} disabled={busy} className="btn btn-secondary btn-xs">{busy ? R.syncing : fill(R.sync, { store: name })}</button>
      </div>
      {!store ? <p className="mt-3 text-sm text-foreground-muted">{R.never}</p> : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[[R.orders, store.orders.capped ? `${store.orders.count} ${R.capped}` : String(store.orders.count)], [R.revenue, moneyText(store.orders.revenue)], [R.carts, store.carts.unavailable ? "—" : store.carts.capped ? `${store.carts.count} ${R.capped}` : String(store.carts.count)], [R.cartValue, store.carts.unavailable ? "—" : moneyText(store.carts.value)]].map(([label, v]) => (
              <div key={label} className="card card-sm"><p className="text-xs text-foreground-muted">{label}</p><p className="mt-1 font-display text-2xl font-bold text-foreground" dir="ltr">{v}</p></div>
            ))}
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {[[R.top, store.orders.top], [R.topCarts, store.carts.top]].map(([label, rows]) => (rows as { name: string; qty: number }[]).length > 0 && (
              <div key={label as string}><p className="text-xs font-semibold text-foreground-muted">{label as string}</p><ul className="mt-1 text-sm">{(rows as { name: string; qty: number }[]).slice(0, 5).map((t) => <li key={t.name} className="flex justify-between gap-2"><span dir="auto">{t.name}</span><span className="font-mono" dir="ltr">{t.qty}</span></li>)}</ul></div>
            ))}
          </div>
          <p className="mt-3 text-xs text-foreground-muted">
            {R.asOf}: <span dir="ltr" suppressHydrationWarning>{dateFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(store.at))} UTC</span>
            {store.orders.read < store.orders.count && <> · {fill(R.partial, { read: store.orders.read, count: store.orders.count })}</>}
            {store.unread > 0 && <> · {fill(R.unread, { n: store.unread })}</>}
            {!!store.orders.pending && <> · {fill(R.pending, { n: store.orders.pending })}</>}
            {store.carts.unavailable && <> · {provider === "woocommerce" ? R.wooCarts : R.cartsUnavailable}</>}
          </p>
          <p className="mt-1 text-xs text-foreground-muted">{R.note}</p>
          <p className="mt-1 text-xs text-foreground-muted">{R.auto}</p>
          {failedAt && <p className="mt-1 text-xs text-danger" role="alert">{fill(R.syncFailed, { date: dateFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(failedAt)) })}</p>}
          {store.carts.top.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button onClick={draft} disabled={drafting || busy} className="btn btn-primary btn-xs">{drafting ? R.drafting : R.draft} <span className="font-mono" dir="ltr">· {TASK_COST.cart_recovery}</span></button>
              {note && <Link href={href()} className="text-xs text-foreground underline">{note}</Link>}
            </div>
          )}
        </>
      )}
      {err && <p role="alert" className="mt-2 text-xs text-danger" dir="auto">{err}</p>}
    </div>
  );
}
