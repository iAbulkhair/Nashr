"use client";
import { useState } from "react";
import Badge from "@/components/ui/Badge";
import { adminFetch } from "@/lib/admin-fetch";
import { useAdminForm } from "./AdminForm";
import { EndedNotice, OV, STR, useAdminEnded, useOverview, type Overview, type SectionProps } from "./shared";
// Rules 2002 empty state, 2003 skeleton while the panel loads.
import { PanelSkeleton } from "@/components/ui/Skeleton";
import Callout from "@/components/ui/Callout";

/** The Margin section's words (rule 1533), both languages. */
const MG = {
  ar: { title: "الهامش", note: (f: number) => `الحسابات المدفوعة التي يقل هامشها هذا الشهر عن ${f}%: سعر الباقة الشهري بلا ضريبة القيمة المضافة، ناقص تكلفة النماذج والصور والمقاطع منذ أول الشهر (بالدولار × 3.75). للاطلاع فقط: لا يتغير شيء في الحساب.`, none: (n: number) => `لا حساب تحت الحد (${n} حساب مدفوع).`, account: "الحساب", plan: "الباقة", revenue: "الإيراد (ر.س)", model: "النماذج ($)", media: "الوسائط ($)", cost: "التكلفة (ر.س)", margin: "الهامش", last: "آخر تنبيه يومي", never: "لم يعمل بعد", lastLine: (d: string, u: number, a: number, c: number) => `${d}: ${u} تحت الحد من ${c}، نُبّهت عن ${a} جديدة`, unread: "تعذرت قراءة العدادات.", fairUse: "حد الاستخدام العادل", paused: "متوقف", lifted: "مرفوع هذا الشهر", active: "يعمل", lift: "رفع الإيقاف", reapply: "إعادة الإيقاف", liftTitle: "رفع إيقاف الاستخدام العادل لهذا الشهر", liftNote: "يعود الحساب للعمل حتى نهاية الشهر الحالي (UTC) مهما بلغت تكلفته. يُسجَّل في السجل مع السبب.", reapplyTitle: "إعادة تطبيق إيقاف الاستخدام العادل", reapplyNote: "يتوقف الحساب مجدداً إذا بلغت تكلفته حده هذا الشهر. يُسجَّل في السجل مع السبب.", done: (e: string) => `${e}: تم`, failed: (e: string, c: string) => `${e}: تعذر (${c})`, plans: { starter: "المبتدئة", pro: "الاحترافية", business: "الأعمال", agency: "الوكالات" } as Record<string, string> },
  en: { title: "Margin", note: (f: number) => `Paying accounts under ${f}% margin this month: the plan's monthly price net of VAT, minus model, image and video cost since the 1st (USD × 3.75). For information only: nothing changes on the account.`, none: (n: number) => `No account under the floor (${n} paying).`, account: "Account", plan: "Plan", revenue: "Revenue (SAR)", model: "Models ($)", media: "Media ($)", cost: "Cost (SAR)", margin: "Margin", last: "Last daily alert", never: "not run yet", lastLine: (d: string, u: number, a: number, c: number) => `${d}: ${u} under the floor of ${c}, ${a} newly alerted`, unread: "The counters could not be read.", fairUse: "Fair use", paused: "Paused", lifted: "Lifted this month", active: "Running", lift: "Lift pause", reapply: "Re-apply", liftTitle: "Lift the fair-use pause for this month", liftNote: "The account runs again until the end of this month (UTC), whatever it costs. Logged with the reason.", reapplyTitle: "Re-apply the fair-use pause", reapplyNote: "The account pauses again when its cost reaches its limit this month. Logged with the reason.", done: (e: string) => `${e}: done`, failed: (e: string, c: string) => `${e}: failed (${c})`, plans: { starter: "Starter", pro: "Pro", business: "Business", agency: "Agency" } as Record<string, string> },
} as const;

/**
 * Rule 1533: the paying accounts under the floor, live, and the last daily alert run. Rule 1733: each row says whether the
 * fair-use stop paused it (src/lib/fair-use.ts) and the founder can lift the pause for this month or put it back
 * (POST /api/admin/fair-use, with a reason and the second factor).
 */
function MarginSection({ lang, m }: { lang: "ar" | "en"; m: Overview["margin"] }) {
  const T = MG[lang];
  const [askForm, form] = useAdminForm(lang);
  const [marks, setMarks] = useState<Record<string, "paused" | "lifted" | null>>({});
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  if (m === undefined) return null;
  async function fairUse(email: string, action: "lift" | "clear") {
    const v = await askForm({
      title: action === "lift" ? T.liftTitle : T.reapplyTitle, subject: email, message: action === "lift" ? T.liftNote : T.reapplyNote,
      fields: [], submitLabel: action === "lift" ? T.lift : T.reapply,
      parse: () => ({ ok: true, value: {} }),
    });
    if (!v) return;
    setBusy(true);
    try {
      const r = await adminFetch("/api/admin/fair-use", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, action, reason: v.reason }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; fairUse?: { lifted: boolean; paused: boolean | null } };
      if (j.ok) setMarks((x) => ({ ...x, [email]: j.fairUse?.lifted ? "lifted" : j.fairUse?.paused ? "paused" : null }));
      setMsg(j.ok ? T.done(email) : T.failed(email, String(j.error ?? r.status)));
    } catch {
      setMsg(T.failed(email, "network"));
    }
    setBusy(false);
  }
  return (
    <section id="margin" className="card card-sm" data-testid="admin-margin">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{T.title}</h2>
      {!m ? <p className="mt-2 text-sm text-foreground-muted">{T.unread}</p> : (
        <>
          <p className="mt-1 text-xs text-foreground-muted">{T.note(m.floorPct)}</p>
          {m.under.length === 0 ? <p className="mt-2 text-sm">{T.none(m.checked)}</p> : (
            <div className="overflow-x-auto"><table className="mt-2 w-full text-xs">
              <thead className="text-foreground-muted"><tr>{[T.account, T.plan, T.revenue, T.model, T.media, T.cost, T.margin, T.fairUse].map((h) => <th key={h} className="p-1 text-start">{h}</th>)}</tr></thead>
              <tbody>{m.under.map((r) => (
                <tr key={r.email} className="border-t border-foreground/5">
                  <td className="p-1"><span className="block">{r.name}</span><span className="block text-foreground-muted" dir="ltr">{r.email}</span></td>
                  <td className="p-1">{T.plans[r.plan] ?? r.plan}</td>
                  <td className="tnum p-1" dir="ltr">{r.revenueSar}</td>
                  <td className="tnum p-1" dir="ltr">{r.modelUsd}</td>
                  <td className="tnum p-1" dir="ltr">{r.mediaUsd}</td>
                  <td className="tnum p-1" dir="ltr">{r.costSar}</td>
                  <td className="p-1"><Badge tone="danger" className="tnum" dir="ltr">{r.marginPct}%</Badge></td>
                  <td className="p-1">{(() => {
                    const f = Object.hasOwn(marks, r.email) ? marks[r.email] : r.fairUse ?? null;
                    return (
                      <span className="flex flex-wrap items-center gap-1" data-testid="admin-fair-use">
                        {f === "paused" ? <Badge tone="danger">{T.paused}</Badge> : f === "lifted" ? <Badge tone="warning">{T.lifted}</Badge> : <span className="text-foreground-muted">{T.active}</span>}
                        {f === "lifted"
                          ? <button type="button" className="underline" disabled={busy} onClick={() => void fairUse(r.email, "clear")}>{T.reapply}</button>
                          : f === "paused" ? <button type="button" className="underline" disabled={busy} onClick={() => void fairUse(r.email, "lift")}>{T.lift}</button> : null}
                      </span>
                    );
                  })()}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          {msg ? <p className="mt-2 text-xs" role="status">{msg}</p> : null}
          {form}
          <p className="mt-2 text-xs text-foreground-muted">{T.last}: {m.last ? <span>{T.lastLine(m.last.day, m.last.under, m.last.alerted, m.last.checked)}</span> : T.never}</p>
        </>
      )}
    </section>
  );
}

/** The scheduled jobs' heartbeats (rule 1015), each with its last batch's counts (rules 2484-2485). Exported for its render test. */
export function CronList({ crons, O }: { crons: NonNullable<Overview["crons"]>; O: (typeof OV)["en"] }) {
  return <ul className="mt-2 grid gap-2 sm:grid-cols-4 text-sm">{crons.map((c) => <li key={c.job} className="flex flex-col rounded-lg bg-background-muted p-2"><span className="flex justify-between"><span dir="ltr">{c.job}</span><b className={c.status === "stale" ? "text-danger" : ""}>{c.status === "stale" ? O.cronStale : c.status === "waiting" ? O.cronWaiting : O.cronOk}</b></span><span className="tnum text-xs text-foreground-muted" dir="ltr">{c.lastRunAt ? c.lastRunAt.slice(0, 16).replace("T", " ") + " UTC" : "—"}</span>{c.report && <span className="tnum text-xs text-foreground-muted" data-cron-report={c.job}>{O.cronReport.replace("{d}", String(c.report.alreadyDone)).replace("{p}", String(c.report.processed)).replace("{h}", String(c.report.held)).replace("{f}", String(c.report.failed)).replace("{r}", String(c.report.remaining)).replace("{t}", String(c.report.total))}</span>}</li>)}</ul>;
}

/** Founder console, Usage (/{lang}/admin/usage): active users, feature use, events per day and platform health. */
export default function Usage({ lang, keySession }: SectionProps) {
  const ended = useAdminEnded();
  const S = STR[lang];
  const O = OV[lang];
  const { ov, failed } = useOverview();
  if (ended) return <EndedNotice lang={lang} keySession={keySession} />;
  if (failed && !ov) return <Callout tone="danger">{S.loadFailed}</Callout>;
  if (!ov) return <PanelSkeleton label={S.loading} shape="cards" />;
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
            <CronList crons={ov.crons ?? []} O={O} />
            <p className="mt-2 text-xs text-foreground-muted">{O.cronNote}</p>
          </section>
        </div>
  );
}
