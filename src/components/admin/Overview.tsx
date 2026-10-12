"use client";
import Link from "next/link";
import { adminHref } from "@/lib/admin-gate";
import { EndedNotice, OV, PlanTiles, STR, useAdminEnded, useOverview, usePlanList, type Overview as OverviewData, type SectionProps } from "./shared";

function Events({ data }: { data: OverviewData["events"] }) {
  const keys = ["signup", "chat", "generate", "approve"] as const;
  // Chart series tokens (rule 967): each at least 3:1 on paper, each with its own dash; red stays for errors only.
  const colors: Record<string, string> = { signup: "var(--chart-1)", chat: "var(--chart-2)", generate: "var(--chart-3)", approve: "var(--chart-4)" };
  const dashes: Record<string, string | undefined> = { signup: undefined, chat: "6 3", generate: "2 3", approve: "8 3 2 3" };
  const W = 640, H = 160, PAD = 24;
  const max = Math.max(1, ...data.flatMap((d) => keys.map((k) => d.counts[k] ?? 0)));
  const x = (i: number) => PAD + (data.length > 1 ? (i / (data.length - 1)) * (W - 2 * PAD) : 0);
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
  return (
    <div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs">{keys.map((k) => <span key={k} className="flex items-center gap-1"><svg width="16" height="8" aria-hidden="true" className="shrink-0"><line x1="0" y1="4" x2="16" y2="4" stroke={colors[k]} strokeWidth="2" strokeDasharray={dashes[k]} /></svg>{k}</span>)}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" role="img" aria-label="events">
        {keys.map((k) => <path key={k} d={data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.counts[k] ?? 0).toFixed(1)}`).join(" ")} fill="none" stroke={colors[k]} strokeWidth="2" strokeDasharray={dashes[k]} strokeLinejoin="round" />)}
        {data.length > 0 && [0, Math.floor(data.length / 2), data.length - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => <text key={i} x={x(i)} y={H - 6} fontSize="10" textAnchor="middle" fill="currentColor" fillOpacity="0.5">{data[i].date.slice(5)}</text>)}
      </svg>
    </div>
  );
}

/** Founder console, Overview (/{lang}/admin): the account tiles, the headline numbers, events, the funnel and the recent sign-ups. */
export default function Overview({ lang, keySession }: SectionProps) {
  const ended = useAdminEnded();
  const S = STR[lang];
  const O = OV[lang];
  const ov = useOverview();
  const { users, total } = usePlanList();
  if (ended) return <EndedNotice lang={lang} keySession={keySession} />;
  return (
    <div className="grid gap-6">
      <PlanTiles lang={lang} users={users} total={total} />
      {!ov ? <p className="text-sm text-foreground-muted">{S.loading}</p> : (
        <div className="grid gap-6">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[[O.total, ov.users.total], [O.new7, ov.users.new7d], [O.activated, `${ov.users.activated} (${ov.users.activationRate ?? "—"}%)`], [O.dau, ov.engagement.dau], [O.wau, ov.engagement.wau], [O.mau, ov.engagement.mau], [O.stickiness, ov.engagement.stickiness === null ? "—" : `${ov.engagement.stickiness}%`], [O.retention, ov.engagement.retention7 === null ? "—" : `${ov.engagement.retention7}%`], [O.mrr, ov.revenue.mrrSar], [O.topupRev, ov.revenue.topupSarMonth], [O.credits, ov.revenue.creditsUsedMonth], [O.cost, ov.revenue.modelCostUsd.toFixed(2)], [O.errors, ov.health.errors7d]].map(([l, v]) => (
              <div key={String(l)} className="card card-sm"><p className="text-xs text-foreground-muted">{l}</p><p className="tnum font-display text-2xl font-bold text-foreground">{v}</p></div>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
            <section className="card card-sm">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{O.events}</h2>
              <Events data={ov.events} />
            </section>
            <section className="card card-sm">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{O.funnel}</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {[[O.signup, ov.funnel.signups30], [O.activated30, ov.funnel.activated30], [O.generated, ov.funnel.generated30], [O.approved, ov.funnel.approved30], [O.paid, ov.funnel.paid30]].map(([l, v], i, arr) => { const base = Number(arr[0][1]) || 1; const pct = Math.round((Number(v) / base) * 100); return (
                  <li key={String(l)}><div className="flex justify-between text-xs"><span>{l}</span><span className="tnum">{v} · {pct}%</span></div><div className="mt-1 h-2 rounded-full bg-background-muted"><div className="h-full rounded-full bg-foreground" style={{ width: `${pct}%` }} /></div></li>
                ); })}
              </ul>
            </section>
          </div>
          <section className="card card-sm">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{O.recent}</h2>
            <div className="overflow-x-auto"><table className="mt-2 w-full text-xs"><thead className="text-start text-foreground-muted"><tr><th className="p-1 text-start">{S.email}</th><th>{S.plan}</th><th>{S.credits}</th><th>{O.activated}</th><th>{O.lastActive}</th><th>chat/generate/approve</th></tr></thead>
              <tbody>{ov.recent.map((u) => <tr key={u.email} className="border-t border-foreground/5"><td className="p-1"><Link href={`${adminHref(lang, "users")}?q=${encodeURIComponent(u.email)}`} className="text-foreground underline" dir="ltr">{u.email}</Link></td><td>{u.plan}</td><td className="tnum">{u.credits}</td><td>{u.activated ? "✓" : "—"}</td><td className="tnum" dir="ltr">{u.lastActive ? u.lastActive.slice(0, 16).replace("T", " ") : "—"}</td><td className="tnum">{u.events.chat ?? 0}/{u.events.generate ?? 0}/{u.events.approve ?? 0}</td></tr>)}</tbody></table></div>
          </section>
        </div>
      )}
    </div>
  );
}
