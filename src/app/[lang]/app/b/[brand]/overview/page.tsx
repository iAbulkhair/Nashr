import Link from "next/link";
import { appScreenMeta } from "@/lib/screen-titles";
import { notFound, redirect } from "next/navigation";
import { isLang, type Lang } from "@/lib/i18n";
import { appDict } from "@/lib/app-i18n";
import { currentUser, sc } from "@/lib/auth";
import { getBrand, listLite } from "@/lib/brand";
import { kpis, kpiSince, rangeWindow } from "@/lib/stats";
import { OVERVIEW_COPY, OVERVIEW_RANGE, overviewOf, type Overview } from "@/lib/overview";
import { dateFormat } from "@/lib/dates";
import { pageHref } from "@/lib/page-href";
import { appHref } from "@/lib/brand-path";
import PageHeader from "@/components/ui/PageHeader";
import EmptyState from "@/components/ui/EmptyState";

export const dynamic = "force-dynamic";
export const generateMetadata = appScreenMeta("overview");

/** Chart series tokens (rule 967), as the Reports chart: created, approved, published. */
const COLOR = { created: "var(--chart-1)", approved: "var(--chart-2)", published: "var(--chart-3)" } as const;
type Series = keyof typeof COLOR;
const SERIES: Series[] = ["created", "approved", "published"];

/**
 * Rule 3507: the workspace overview, an extra page beside Reports (which it links to and never replaces). Server-rendered
 * SVG from `kpis` over the brand's own tasks (`sc(u)`): one `listLite` read and the waiting set, never a read per item.
 * No number here that is not a count of stored tasks; with none, the empty state and no chart.
 */
export default async function Page({ params }: PageProps<"/[lang]/app/b/[brand]/overview">) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const u = await currentUser();
  if (!u) redirect(appHref(lang, "/login"));
  const href = await pageHref(lang);
  if (!(await getBrand(sc(u)))) redirect(href("/start", u.brandId));
  const win = rangeWindow(OVERVIEW_RANGE);
  const tasks = await listLite(sc(u), kpiSince(win));
  const o = overviewOf(await kpis(sc(u), undefined, win, tasks), lang);
  const C = OVERVIEW_COPY[lang];
  const nav = appDict[lang].nav;
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <PageHeader lang={lang} title={nav.overview} sub={C.sub} seed="overview" actions={<Link href={href("/reports")} className="btn btn-secondary btn-sm">{C.reports}</Link>} />
      {o.empty ? (
        <EmptyState icon="dashboard" title={C.emptyTitle} body={C.emptyBody} action={<Link href={href("/generate")} className="btn btn-primary btn-sm">{C.emptyAction}</Link>} />
      ) : (
        <>
          <Tiles o={o} lang={lang} />
          <DailyBars o={o} lang={lang} />
          <div className="grid gap-6 md:grid-cols-2">
            <HBars title={C.funnel} rows={o.funnel.map((f) => ({ label: C[f.key], value: f.value, color: COLOR[f.key] }))} max={Math.max(1, ...o.funnel.map((f) => f.value))} />
            {o.types.length > 0 && <HBars title={C.types} rows={o.types.map(([t, n]) => ({ label: typeLabel(lang, t), value: n, color: COLOR.created }))} max={o.typesMax} />}
          </div>
        </>
      )}
    </div>
  );
}

const typeLabel = (lang: Lang, t: string) => (appDict[lang].generate.types as Record<string, { t: string }>)[t]?.t ?? t;

function Tiles({ o, lang }: { o: Overview; lang: Lang }) {
  const C = OVERVIEW_COPY[lang];
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {o.tiles.map((t) => (
        <li key={t.key} className="rounded-xl border border-border bg-surface p-4">
          <p className="text-sm text-foreground-muted">{C[t.key]}</p>
          <p className="tnum mt-1 font-display text-2xl font-bold text-foreground">{t.value}</p>
          {t.delta && <p className="tnum mt-1 text-xs text-foreground-muted" dir="auto">{t.delta}</p>}
        </li>
      ))}
    </ul>
  );
}

/** Three thin bars per day (created, approved, published), each series with its own colour and a legend. */
function DailyBars({ o, lang }: { o: Overview; lang: Lang }) {
  const C = OVERVIEW_COPY[lang];
  const W = 720, H = 180, PAD = 24;
  const n = Math.max(1, o.daily.length);
  const slot = (W - 2 * PAD) / n;
  const bar = Math.max(1, (slot - 2) / 3);
  const y = (v: number) => H - PAD - (v / o.dailyMax) * (H - 2 * PAD);
  const day = dateFormat(lang, { month: "short", day: "numeric" });
  const label = (d: string) => day.format(new Date(`${d}T00:00:00Z`));
  return (
    <section className="rounded-xl border border-border bg-surface p-4" aria-labelledby="ov-daily">
      <h2 id="ov-daily" className="card-title">{C.daily}</h2>
      <ul className="mt-2 flex flex-wrap gap-4 text-xs text-foreground-muted">
        {SERIES.map((s) => (
          <li key={s} className="flex items-center gap-1.5"><svg width="10" height="10" aria-hidden="true"><rect width="10" height="10" rx="2" fill={COLOR[s]} /></svg>{C[s]}</li>
        ))}
      </ul>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={C.dailyDesc(o.daily.length)} className="mt-3 h-auto w-full" style={{ direction: "ltr" }}>
        <line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} stroke="var(--color-border)" />
        {o.daily.map((d, i) =>
          SERIES.map((s, j) => {
            const v = d[s];
            if (!v) return null;
            const x = PAD + i * slot + 1 + j * bar;
            return <rect key={`${d.date}-${s}`} x={x.toFixed(1)} y={y(v).toFixed(1)} width={bar.toFixed(1)} height={(H - PAD - y(v)).toFixed(1)} rx="1" fill={COLOR[s]} />;
          }),
        )}
        <text x={PAD} y={H - 6} fontSize="11" fill="var(--color-foreground-muted)">{o.daily[0] ? label(o.daily[0].date) : ""}</text>
        <text x={W - PAD} y={H - 6} fontSize="11" textAnchor="end" fill="var(--color-foreground-muted)">{o.daily.at(-1) ? label(o.daily.at(-1)!.date) : ""}</text>
        <text x={PAD} y={PAD - 8} fontSize="11" fill="var(--color-foreground-muted)">{o.dailyMax}</text>
      </svg>
      {/* The same numbers as a table, for a screen reader and for anyone who wants the values. */}
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-foreground-muted">{C.table}</summary>
        <table className="mt-2 w-full text-start text-xs">
          <thead><tr><th scope="col" className="text-start">{C.day}</th>{SERIES.map((s) => <th key={s} scope="col" className="text-start">{C[s]}</th>)}</tr></thead>
          <tbody className="tnum">
            {o.daily.filter((d) => d.created || d.approved || d.published).map((d) => (
              <tr key={d.date}><td>{label(d.date)}</td>{SERIES.map((s) => <td key={s}>{d[s]}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

/** Horizontal bars with the value written beside each, so no colour or length has to be read alone. */
function HBars({ title, rows, max }: { title: string; rows: { label: string; value: number; color: string }[]; max: number }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h2 className="card-title">{title}</h2>
      <ul className="mt-3 grid gap-2">
        {rows.map((r) => (
          <li key={r.label} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-2 text-sm">
            <span className="clip text-foreground-muted" dir="auto">{r.label}</span>
            <svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" className="h-2 w-full">
              <rect width="100" height="8" rx="2" fill="var(--color-background-muted)" />
              {r.value > 0 && <rect width={Math.max(2, (r.value / max) * 100).toFixed(1)} height="8" rx="2" fill={r.color} />}
            </svg>
            <span className="tnum font-semibold text-foreground">{r.value}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
