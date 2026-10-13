"use client";
import Badge from "@/components/ui/Badge";
import { EndedNotice, OV, STR, useAdminEnded, useOverview, type Overview, type SectionProps } from "./shared";

/** The Margin section's words (rule 1533), both languages. */
const MG = {
  ar: { title: "الهامش", note: (f: number) => `الحسابات المدفوعة التي يقل هامشها هذا الشهر عن ${f}%: سعر الباقة الشهري بلا ضريبة القيمة المضافة، ناقص تكلفة النماذج والصور والمقاطع منذ أول الشهر (بالدولار × 3.75). للاطلاع فقط: لا يتغير شيء في الحساب.`, none: (n: number) => `لا حساب تحت الحد (${n} حساب مدفوع).`, account: "الحساب", plan: "الباقة", revenue: "الإيراد (ر.س)", model: "النماذج ($)", media: "الوسائط ($)", cost: "التكلفة (ر.س)", margin: "الهامش", last: "آخر تنبيه يومي", never: "لم يعمل بعد", lastLine: (d: string, u: number, a: number, c: number) => `${d}: ${u} تحت الحد من ${c}، نُبّهت عن ${a} جديدة`, unread: "تعذرت قراءة العدادات.", plans: { starter: "المبتدئة", pro: "الاحترافية", business: "الأعمال", agency: "الوكالات" } as Record<string, string> },
  en: { title: "Margin", note: (f: number) => `Paying accounts under ${f}% margin this month: the plan's monthly price net of VAT, minus model, image and video cost since the 1st (USD × 3.75). For information only: nothing changes on the account.`, none: (n: number) => `No account under the floor (${n} paying).`, account: "Account", plan: "Plan", revenue: "Revenue (SAR)", model: "Models ($)", media: "Media ($)", cost: "Cost (SAR)", margin: "Margin", last: "Last daily alert", never: "not run yet", lastLine: (d: string, u: number, a: number, c: number) => `${d}: ${u} under the floor of ${c}, ${a} newly alerted`, unread: "The counters could not be read.", plans: { starter: "Starter", pro: "Pro", business: "Business", agency: "Agency" } as Record<string, string> },
} as const;

/** Rule 1533: the paying accounts under the floor, live, and the last daily alert run. Read-only. */
function MarginSection({ lang, m }: { lang: "ar" | "en"; m: Overview["margin"] }) {
  const T = MG[lang];
  if (m === undefined) return null;
  return (
    <section id="margin" className="card card-sm" data-testid="admin-margin">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{T.title}</h2>
      {!m ? <p className="mt-2 text-sm text-foreground-muted">{T.unread}</p> : (
        <>
          <p className="mt-1 text-xs text-foreground-muted">{T.note(m.floorPct)}</p>
          {m.under.length === 0 ? <p className="mt-2 text-sm">{T.none(m.checked)}</p> : (
            <div className="overflow-x-auto"><table className="mt-2 w-full text-xs">
              <thead className="text-foreground-muted"><tr>{[T.account, T.plan, T.revenue, T.model, T.media, T.cost, T.margin].map((h) => <th key={h} className="p-1 text-start">{h}</th>)}</tr></thead>
              <tbody>{m.under.map((r) => (
                <tr key={r.email} className="border-t border-foreground/5">
                  <td className="p-1"><span className="block">{r.name}</span><span className="block text-foreground-muted" dir="ltr">{r.email}</span></td>
                  <td className="p-1">{T.plans[r.plan] ?? r.plan}</td>
                  <td className="tnum p-1" dir="ltr">{r.revenueSar}</td>
                  <td className="tnum p-1" dir="ltr">{r.modelUsd}</td>
                  <td className="tnum p-1" dir="ltr">{r.mediaUsd}</td>
                  <td className="tnum p-1" dir="ltr">{r.costSar}</td>
                  <td className="p-1"><Badge tone="danger" className="tnum" dir="ltr">{r.marginPct}%</Badge></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          <p className="mt-2 text-xs text-foreground-muted">{T.last}: {m.last ? <span>{T.lastLine(m.last.day, m.last.under, m.last.alerted, m.last.checked)}</span> : T.never}</p>
        </>
      )}
    </section>
  );
}

/** Founder console, Usage (/{lang}/admin/usage): active users, feature use, events per day and platform health. */
export default function Usage({ lang, keySession }: SectionProps) {
  const ended = useAdminEnded();
  const S = STR[lang];
  const O = OV[lang];
  const ov = useOverview();
  if (ended) return <EndedNotice lang={lang} keySession={keySession} />;
  if (!ov) return <p className="text-sm text-foreground-muted">{S.loading}</p>;
  return (
        <div className="grid gap-6">
          <MarginSection lang={lang} m={ov.margin} />
          <div className="grid gap-3 sm:grid-cols-4">
            {[[O.dau, ov.engagement.dau], [O.wau, ov.engagement.wau], [O.mau, ov.engagement.mau], [O.retention, ov.engagement.retention7 === null ? "—" : `${ov.engagement.retention7}%`]].map(([l, v]) => <div key={String(l)} className="card card-sm"><p className="text-xs text-foreground-muted">{l}</p><p className="tnum font-display text-2xl font-bold text-foreground">{v}</p></div>)}
          </div>
          <section className="card card-sm"><h2 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{O.features}</h2>
            <ul className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-5 text-sm">{Object.entries(ov.features).sort((a, b) => b[1] - a[1]).map(([k, v]) => <li key={k} className="flex justify-between rounded-lg bg-background-muted px-3 py-2"><span>{k}</span><span className="tnum font-semibold">{v}</span></li>)}</ul>
          </section>
          <section className="card card-sm"><h2 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{O.events}</h2>
            <div className="overflow-x-auto"><table className="mt-2 w-full text-xs"><thead className="text-foreground-muted"><tr><th className="p-1 text-start">date</th>{["signup", "login", "onboard", "chat", "generate", "approve", "publish", "connect", "image", "error"].map((e) => <th key={e}>{e}</th>)}</tr></thead>
              <tbody>{ov.events.map((d) => <tr key={d.date} className="border-t border-foreground/5"><td className="tnum p-1" dir="ltr">{d.date.slice(5)}</td>{["signup", "login", "onboard", "chat", "generate", "approve", "publish", "connect", "image", "error"].map((e) => <td key={e} className={`tnum text-center ${e === "error" && d.counts[e] ? "text-danger" : ""}`}>{d.counts[e] ?? ""}</td>)}</tr>)}</tbody></table></div>
          </section>
          <section className="card card-sm"><h2 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{O.health}</h2>
            <div className="mt-2 grid gap-3 sm:grid-cols-4 text-sm">{[[O.errors, ov.health.errors7d], ["errors today", ov.health.errorsToday], [O.calls, ov.health.modelCalls], ["avg $/call", ov.health.avgCostPerCallUsd ?? "—"]].map(([l, v]) => <div key={String(l)} className="rounded-lg bg-background-muted px-3 py-2"><p className="text-xs text-foreground-muted">{l}</p><p className="tnum font-semibold">{v}</p></div>)}</div>
            <p className="mt-2 text-xs text-foreground-muted">Uptime and p95 latency: an external monitor on /api/health?store=1 (docs/system/flows.md, monitoring).</p>
          </section>
          <section className="card card-sm"><h2 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{O.crons}</h2>
            <ul className="mt-2 grid gap-2 sm:grid-cols-4 text-sm">{(ov.crons ?? []).map((c) => <li key={c.job} className="flex flex-col rounded-lg bg-background-muted p-2"><span className="flex justify-between"><span dir="ltr">{c.job}</span><b className={c.status === "stale" ? "text-danger" : ""}>{c.status === "stale" ? O.cronStale : c.status === "waiting" ? O.cronWaiting : O.cronOk}</b></span><span className="tnum text-xs text-foreground-muted" dir="ltr">{c.lastRunAt ? c.lastRunAt.slice(0, 16).replace("T", " ") + " UTC" : "—"}</span></li>)}</ul>
            <p className="mt-2 text-xs text-foreground-muted">{O.cronNote}</p>
          </section>
        </div>
  );
}
