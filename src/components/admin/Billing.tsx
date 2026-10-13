"use client";
import { Fragment, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import FoundingPanel from "./FoundingPanel";
import { EndedNotice, OV, STR, useAdminEnded, useOverview, type MediaCheck, type SectionProps } from "./shared";

/** The provider check as plain text: green when working, red when not (a false flag, webhooks off, a Blob probe that is not ok). */
function MediaReport({ m, O }: { m: MediaCheck; O: Record<string, string> }) {
  const mark = (good: boolean, text: string) => <span className={good ? "text-foreground" : "font-semibold text-danger"}>{text}</span>;
  const at = (v: number | string | undefined) => { const d = new Date(v ?? NaN); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 16).replace("T", " ") : "—"; };
  const check = (r: Record<string, number | string> | null, num: (n: number) => string) =>
    r === null ? <span className="text-foreground-muted">not configured</span> : Object.entries(r).map(([k, v], i) => <Fragment key={k}>{i > 0 && " · "}{k} {typeof v === "number" ? num(v) : mark(false, v)}</Fragment>);
  const offRows = Object.entries(m.off);
  return (
    <div className="mt-3 grid gap-1.5 font-mono text-xs" dir="ltr" data-testid="media-check">
      <p>{(["fal", "kie", "higgsfield", "blob", "webhooks"] as const).map((k, i) => <Fragment key={k}>{i > 0 && " · "}{mark(m.configured[k], `${k}: ${m.configured[k] ? "on" : "off"}`)}</Fragment>)}</p>
      <p>blob probe: {mark(m.blob === "ok", m.blob)}</p>
      <p>models on: {m.modelsOn.join(", ")}</p>
      <p>offered now: {m.available.join(", ") || "—"}</p>
      <p>kie: {check(m.kie, (n) => `${n} credits`)} <span className="text-foreground-muted">(used this month: {m.spend.kieCredits})</span></p>
      <p>higgsfield: {check(m.higgsfield, (n) => `$${n.toFixed(3)}`)}</p>
      <p>open jobs: {Object.entries(m.open).map(([p, n]) => `${p} ${n}`).join(" · ")}</p>
      <p>{O.off}: {offRows.length === 0 ? "—" : offRows.map(([id, v], i) => <Fragment key={id}>{i > 0 && " · "}{mark(false, id)} {v.reason} → {at(v.until)}</Fragment>)}</p>
      <p className="mt-2 font-sans font-semibold text-foreground-muted">{O.lastRenders}</p>
      {m.recent.length === 0 ? <p>—</p> : (
        <div className="max-h-80 overflow-auto">
          <table className="w-full">
            <thead className="text-foreground-muted"><tr><th className="p-1 text-start">at</th><th className="text-start">model</th><th className="text-start">state</th><th className="text-start">error</th><th>kie cr</th><th>$</th><th className="text-start">id</th></tr></thead>
            <tbody>{m.recent.map((r, i) => <tr key={`${r.id}${i}`} className="border-t border-foreground/5"><td className="p-1">{at(r.at)}</td><td>{r.model}</td><td>{mark(r.state === "done", r.state)}</td><td>{r.error ?? ""}</td><td className="text-center">{r.providerCredits ?? ""}</td><td className="text-center">{r.costUsd === undefined ? "" : r.costUsd.toFixed(3)}</td><td className="text-foreground-muted">{r.id.slice(0, 8)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Founder console, Billing (/{lang}/admin/billing): revenue, render cost per model, the media provider check, plan mix and export. */
export default function Billing({ lang, keySession }: SectionProps) {
  const ended = useAdminEnded();
  const S = STR[lang];
  const O = OV[lang];
  const ov = useOverview();
  const [media, setMedia] = useState<MediaCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [mediaErr, setMediaErr] = useState("");
  // Founder-only and on demand: it writes and deletes a Blob file and asks Higgsfield for five estimates.
  async function checkMedia() {
    setChecking(true); setMediaErr("");
    try {
      const r = await adminFetch("/api/admin/media");
      const j = await r.json().catch(() => ({}));
      if (j.ok) setMedia(j); else setMediaErr(`${O.checkFailed}: HTTP ${r.status}`);
    } catch {
      setMediaErr(O.checkFailed);
    } finally {
      setChecking(false);
    }
  }
  if (ended) return <EndedNotice lang={lang} keySession={keySession} />;
  if (!ov) return <p className="text-sm text-foreground-muted">{S.loading}</p>;
  return (
        <div className="grid gap-6">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[[O.mrr, ov.revenue.mrrSar], [O.topupRev, ov.revenue.topupSarMonth], [O.arpu, ov.revenue.arpuSar ?? "—"], [O.cost, ov.revenue.modelCostUsd.toFixed(2)], [O.render, ov.revenue.renderCostUsd.toFixed(2)], [O.margin, ov.revenue.grossMarginPct === null ? "—" : `${ov.revenue.grossMarginPct}%`]].map(([l, v]) => <div key={String(l)} className="card card-sm"><p className="text-xs text-foreground-muted">{l}</p><p className="tnum font-display text-2xl font-bold text-foreground">{v}</p></div>)}
          </div>
          {/* modelUsage-section */}
          {ov.modelUsage && (
            <section className="card card-sm"><h2 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{O.llmModels} <span className="tnum font-mono" dir="ltr">{ov.modelUsage.month}</span></h2>
              {Object.keys(ov.modelUsage.models).length === 0 ? <p className="mt-2 text-sm text-foreground-muted">{O.llmNone}</p> : (
                <div className="overflow-x-auto">
                  <table className="mt-2 w-full text-xs"><thead className="text-foreground-muted"><tr><th className="p-1 text-start">{O.llmModel}</th><th className="text-end">{O.llmCalls}</th><th className="text-end">{O.usd}</th><th className="text-end">{O.llmPerCall}</th></tr></thead>
                    <tbody>{Object.entries(ov.modelUsage.models).sort((a, b) => b[1].usd - a[1].usd).map(([id, m]) => <tr key={id} className={`border-t border-foreground/5 ${id === "other" ? "text-foreground-muted" : ""}`}><td className="p-1 font-mono" dir="ltr">{id}</td><td className="tnum text-end">{m.calls}</td><td className="tnum text-end">{m.usd.toFixed(3)}</td><td className="tnum text-end">{m.calls ? (m.usd / m.calls).toFixed(4) : "—"}</td></tr>)}</tbody></table>
                </div>
              )}
              {"other" in ov.modelUsage.models && <p className="mt-1 text-xs text-foreground-muted">{O.llmOtherNote}</p>}
              <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-foreground-muted">{O.llmProviders}</h3>
              {Object.keys(ov.modelUsage.providers).length === 0 ? <p className="mt-1 text-sm text-foreground-muted">—</p> : (
                <div className="overflow-x-auto">
                  <table className="mt-2 w-full text-xs"><thead className="text-foreground-muted"><tr><th className="p-1 text-start">{O.llmProvider}</th><th className="text-end">{O.llmCalls}</th><th className="text-end">{O.usd}</th></tr></thead>
                    <tbody>{Object.entries(ov.modelUsage.providers).sort((a, b) => b[1].usd - a[1].usd).map(([id, m]) => <tr key={id} className="border-t border-foreground/5"><td className="p-1 font-mono" dir="ltr">{id}</td><td className="tnum text-end">{m.calls}</td><td className="tnum text-end">{m.usd.toFixed(3)}</td></tr>)}</tbody></table>
                </div>
              )}
              <p className="mt-2 text-xs text-foreground-muted">{O.llmCaveat}</p>
              <p className="mt-3 text-xs text-foreground-muted">{O.llmFallbacks}: <b className="tnum text-foreground">{ov.modelUsage.fallbacks}</b></p>
              {Object.keys(ov.modelUsage.rejectedPicks).length > 0 && (
                <>
                  <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-foreground-muted">{O.llmRejected}</h3>
                  <ul className="mt-2 flex flex-wrap gap-2 text-xs">{Object.entries(ov.modelUsage.rejectedPicks).map(([k, n]) => <li key={k} className="rounded-full bg-background-muted px-3 py-1"><span className="font-mono" dir="ltr">{k}</span>: <b className="tnum">{n}</b></li>)}</ul>
                </>
              )}
            </section>
          )}
          {/* modelUsage-section-end */}
          <section className="card card-sm"><h2 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{O.models}</h2>
            <div className="overflow-x-auto">
              <table className="mt-2 w-full text-xs"><thead className="text-foreground-muted"><tr><th className="p-1 text-start">{O.model}</th><th>{O.done}</th><th>{O.failed}</th><th>{O.creditsKept}</th><th>{O.usd}</th><th>{O.perCredit}</th></tr></thead>
                <tbody>{Object.entries(ov.revenue.renderByModel).map(([id, m]) => <tr key={id} className={`border-t border-foreground/5 ${m.jobs + m.failed === 0 ? "text-foreground-muted" : ""}`}><td className="p-1 font-mono" dir="ltr">{id}</td><td className="tnum text-center">{m.jobs}</td><td className={`tnum text-center ${m.failed ? "text-danger" : ""}`}>{m.failed}</td><td className="tnum text-center">{m.credits}</td><td className="tnum text-center">{m.usd.toFixed(3)}</td><td className="tnum text-center">{m.credits ? (m.usd / m.credits).toFixed(3) : "—"}</td></tr>)}</tbody></table>
            </div>
            <p className="mt-2 font-mono text-xs text-foreground-muted" dir="ltr">{Object.entries(ov.revenue.renderByProvider).map(([p, v]) => `${p} $${v.usd.toFixed(2)} (${v.jobs}/${v.failed})`).join(" · ")}</p>
            <button type="button" onClick={checkMedia} disabled={checking} className="btn btn-secondary btn-sm mt-3">{checking ? S.loading : O.check}</button>
            {mediaErr && <p className="mt-2 text-xs text-danger">{mediaErr}</p>}
            {media && <MediaReport m={media} O={O} />}
          </section>
          <section className="card card-sm"><h2 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{O.planMix}</h2>
            <ul className="mt-2 flex flex-wrap gap-2 text-sm">{Object.entries(ov.revenue.planMix).map(([k, v]) => <li key={k} className="rounded-full bg-background-muted px-3 py-1">{k}: <b className="tnum">{v}</b></li>)}</ul>
            <button type="button" onClick={() => window.open("/api/admin/export", "_blank")} className="btn btn-secondary btn-sm mt-3">{O.export}</button>
          </section>
          <FoundingPanel lang={lang} />
          <section className="card card-sm"><h2 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">{O.invoices}</h2><p className="mt-2 text-sm text-foreground-muted">{O.invoicesNote}</p></section>
        </div>
  );
}
