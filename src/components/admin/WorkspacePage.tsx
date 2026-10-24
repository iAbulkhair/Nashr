"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Badge from "@/components/ui/Badge";
import EmptyState from "@/components/ui/EmptyState";
import ErrorState from "@/components/ui/ErrorState";
import Tabs, { TabPanel } from "@/components/ui/Tabs";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { Time } from "@/components/ui/Time";
import { adminFetch } from "@/lib/admin-fetch";
import { adminHref } from "@/lib/admin-gate";
import { roleLabel } from "@/lib/role-label";
import type { WorkspaceDetail } from "@/lib/admin-workspaces";
import { EndedNotice, useAdminEnded, type SectionProps } from "./shared";
import { WSP_COPY } from "./workspaces-copy";

type Load = { state: "loading" } | { state: "ready"; detail: WorkspaceDetail } | { state: "failed"; error: "forbidden" | "not_found" | "failed" };
const TABS = ["overview", "team", "brands", "billing", "log"] as const;
type Tab = (typeof TABS)[number];
const TH = "p-2 text-start font-medium";

/**
 * Founder console, one customer workspace (/{lang}/admin/users/{email}, rules 3725-3729): Overview with the last 30 days, Team
 * with each member's numbers, Brands, Billing and the account's Log. Read only; it loads once when the page opens, so each
 * open is one read and one audit row on the server. Every value renders as text. The plan, seat, deal and allowance
 * controls stay in the accounts view, which the Billing tab links to.
 */
export default function WorkspacePage({ lang, keySession, email }: SectionProps & { email: string }) {
  const ended = useAdminEnded();
  const W = WSP_COPY[lang];
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [tab, setTab] = useState<Tab>("overview");

  const read = useCallback(async (): Promise<Load> => {
    try {
      const r = await adminFetch(`/api/admin/workspaces/${encodeURIComponent(email)}`, { cache: "no-store" });
      const j = (await r.json().catch(() => null)) as ({ ok?: boolean } & Partial<WorkspaceDetail>) | null;
      if (r.ok && j?.ok && j.view) return { state: "ready", detail: j as WorkspaceDetail };
      return { state: "failed", error: r.status === 403 ? "forbidden" : r.status === 404 ? "not_found" : "failed" };
    } catch {
      return { state: "failed", error: "failed" };
    }
  }, [email]);

  useEffect(() => {
    let live = true;
    void read().then((next) => { if (live) setLoad(next); });
    return () => { live = false; };
  }, [read]);

  if (ended) return <EndedNotice lang={lang} keySession={keySession} />;
  const back = <Link href={adminHref(lang, "users")} className="text-sm text-foreground underline">{W.back}</Link>;
  if (load.state === "loading") return <div className="grid gap-4">{back}<PanelSkeleton label={W.loading} shape="cards" count={2} /></div>;
  if (load.state === "failed") {
    const body = load.error === "forbidden" ? W.forbidden : load.error === "not_found" ? W.notFound : undefined;
    return (
      <div className="grid gap-4">
        {back}
        <ErrorState title={W.failed} body={body} retryLabel={W.retry} onRetry={load.error === "failed" ? async () => { setLoad({ state: "loading" }); setLoad(await read()); } : undefined} />
      </div>
    );
  }

  const { name, view, totals, series, team, brandLines, billing, log, complete } = load.detail;
  const when = (v: string | null) => (v ? <Time value={v} lang={lang} style="datetime" /> : <span className="text-foreground-muted">{W.notRecorded}</span>);
  const maxTasks = Math.max(1, ...series.map((d) => d.tasks));
  const brandName = (id: string) => view.brands.find((b) => b.id === id)?.name || (id === "default" ? W.brands.main : id);
  const byText = (b: WorkspaceDetail["log"][number]["by"]) => {
    const kind = (W.byKinds as Record<string, string>)[b.kind] ?? b.kind;
    return b.email ? `${kind} · ${b.email}` : kind;
  };

  return (
    <div className="grid gap-4 text-sm" data-testid="workspace-page">
      {back}
      <header className="grid gap-1">
        <h2 dir="auto" className="font-display text-xl font-bold text-foreground">{name}</h2>
        <p className="flex flex-wrap items-center gap-2 text-foreground-muted">
          <bdi dir="ltr">{view.owner.email}</bdi>
          <Badge tone="neutral">{view.plan.plan}</Badge>
          {view.owner.suspended && <Badge tone="danger">{WSP_BADGE[lang].suspended}</Badge>}
        </p>
        {view.openedFrom && <p className="text-xs text-foreground-muted">{W.openedFrom} <bdi dir="ltr">{view.openedFrom}</bdi></p>}
        <p className="text-xs text-foreground-muted">{W.readOnly}</p>
      </header>

      <Tabs idBase="wsp" label={W.tabsLabel} value={tab} onChange={setTab} items={TABS.map((id) => ({ id, label: W.tabs[id] }))} />

      <TabPanel idBase="wsp" id="overview" value={tab} className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-4">
          {([[W.active7, totals.active7], [W.tasks30, totals.tasks30], [W.credits30, totals.credits30], [W.creditsMonth, `${totals.creditsMonth} / ${totals.allowance}`]] as const).map(([l, v]) => (
            <div key={l} className="card card-sm"><p className="text-xs text-foreground-muted">{l}</p><p className="font-display text-2xl font-bold tabular-nums text-foreground">{v}</p></div>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <section aria-labelledby="wsp-owner" className="grid content-start gap-1 rounded-card border border-border p-3">
            <h3 id="wsp-owner" className="font-display font-bold text-foreground">{W.owner}</h3>
            <p><bdi dir="ltr">{view.owner.email}</bdi></p>
            <p dir="auto" className="text-foreground-muted">{view.owner.name}</p>
            <p className="text-xs text-foreground-muted">{W.createdAt}: <Time value={view.owner.createdAt} lang={lang} /></p>
          </section>
          <section aria-labelledby="wsp-plan" className="grid content-start gap-1 rounded-card border border-border p-3">
            <h3 id="wsp-plan" className="font-display font-bold text-foreground">{W.plan}</h3>
            <p className="font-mono">{view.plan.plan}</p>
            <p className="tabular-nums">{W.seats(view.plan.seats.used, view.plan.seats.limit)}</p>
            <p className="tabular-nums">{W.brandCap(view.plan.brands.active, view.plan.brands.cap)}</p>
            <p className="text-xs text-foreground-muted">{W.lastActivity}: {totals.lastActivityAt ? <Time value={totals.lastActivityAt} lang={lang} style="datetime" /> : <span>{W.never}</span>}</p>
          </section>
        </div>
        <section aria-labelledby="wsp-chart" className="grid gap-2">
          <h3 id="wsp-chart" className="font-display font-bold text-foreground">{W.chart} <span className="text-xs font-normal text-foreground-muted">({W.chartNote(totals.tasks30, totals.credits30)})</span></h3>
          <div className="flex h-24 items-end gap-0.5 rounded-card border border-border p-2" role="img" aria-label={`${W.chart}: ${W.chartNote(totals.tasks30, totals.credits30)}`}>
            {series.map((d) => (
              <span key={d.day} title={`${d.day}: ${d.tasks} / ${d.credits}`} className="min-w-0 flex-1 rounded-sm bg-inverse" style={{ height: `${d.tasks === 0 ? 2 : Math.max(6, Math.round((d.tasks / maxTasks) * 100))}%`, opacity: d.tasks === 0 ? 0.25 : 1 }} />
            ))}
          </div>
          <details className="text-xs text-foreground-muted">
            <summary className="cursor-pointer">{W.tasks} / {W.creditsWord}</summary>
            <div className="mt-2 max-h-48 overflow-auto rounded-card border border-border">
              <table className="w-full text-xs">
                <thead className="bg-surface-muted"><tr><th scope="col" className={TH}>{W.day}</th><th scope="col" className={TH}>{W.tasks}</th><th scope="col" className={TH}>{W.creditsWord}</th></tr></thead>
                <tbody>{series.filter((d) => d.tasks > 0 || d.credits > 0).map((d) => <tr key={d.day} className="border-t border-border"><td className="p-2" dir="ltr">{d.day}</td><td className="p-2 tabular-nums">{d.tasks}</td><td className="p-2 tabular-nums">{d.credits}</td></tr>)}</tbody>
              </table>
            </div>
          </details>
          {!complete && <p className="text-xs text-foreground-muted" role="note">{W.incomplete}</p>}
        </section>
      </TabPanel>

      <TabPanel idBase="wsp" id="team" value={tab} className="grid gap-4">
        <div className="overflow-x-auto rounded-card border border-border">
          <table className="w-full text-xs">
            <thead className="bg-surface-muted text-foreground-muted">
              <tr>
                <th scope="col" className={TH}>{W.team.email}</th><th scope="col" className={TH}>{W.team.role}</th><th scope="col" className={TH}>{W.team.status}</th><th scope="col" className={TH}>{W.team.joined}</th>
                <th scope="col" className={TH}>{W.team.lastSignIn}</th><th scope="col" className={TH}>{W.team.requested}</th><th scope="col" className={TH}>{W.team.completed}</th><th scope="col" className={TH}>{W.team.credits}</th><th scope="col" className={TH}>{W.team.last}</th>
              </tr>
            </thead>
            <tbody>
              {team.map((m) => (
                <tr key={m.email} className="border-t border-border">
                  <td className="p-2"><bdi dir="ltr">{m.email}</bdi><div dir="auto" className="text-foreground-muted">{m.name}</div></td>
                  <td className="p-2">{roleLabel(m.role, lang)}</td>
                  <td className="p-2">{m.status === "paused" ? <Badge tone="warning">{W.team.paused}</Badge> : m.status === "owner" ? <Badge tone="info">{W.team.owner}</Badge> : <Badge tone="success">{W.team.active}</Badge>}</td>
                  <td className="p-2"><Time value={m.joinedAt} lang={lang} /></td>
                  <td className="p-2">{when(m.lastSignInAt)}</td>
                  <td className="p-2 tabular-nums">{m.requested}</td>
                  <td className="p-2 tabular-nums">{m.completed}</td>
                  <td className="p-2 tabular-nums">{m.credits}</td>
                  <td className="p-2">{when(m.lastActionAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!complete && <p className="text-xs text-foreground-muted" role="note">{W.incomplete}</p>}
        <section aria-labelledby="wsp-invites" className="grid gap-2">
          <h3 id="wsp-invites" className="font-display font-bold text-foreground">{W.invites} <span className="tabular-nums text-foreground-muted">({view.invites.length})</span></h3>
          {view.invites.length === 0 ? <EmptyState compact icon="email" title={W.noInvites} /> : (
            <ul className="grid gap-2">
              {view.invites.map((v) => (
                <li key={v.email} className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-border p-2 text-xs">
                  <bdi dir="ltr">{v.email}</bdi>
                  <span className="flex items-center gap-2"><Badge tone="neutral">{roleLabel(v.role, lang)}</Badge><span className="text-foreground-muted">{W.expires}: <Time value={v.expiresAt} lang={lang} /></span></span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </TabPanel>

      <TabPanel idBase="wsp" id="brands" value={tab} className="grid gap-2">
        {view.brands.length === 0 ? <EmptyState compact icon="folder" title={W.noBrands} /> : (
          <div className="overflow-x-auto rounded-card border border-border">
            <table className="w-full text-xs">
              <thead className="bg-surface-muted text-foreground-muted"><tr><th scope="col" className={TH}>{W.brands.name}</th><th scope="col" className={TH}>{W.brands.status}</th><th scope="col" className={TH}>{W.brands.tasks30}</th><th scope="col" className={TH}>{W.brands.credits30}</th><th scope="col" className={TH}>{W.createdAt}</th></tr></thead>
              <tbody>
                {view.brands.map((b) => {
                  const n = brandLines.find((l) => l.id === b.id);
                  return (
                    <tr key={b.id} className="border-t border-border">
                      <td className="p-2" dir="auto">{brandName(b.id)}</td>
                      <td className="p-2"><Badge tone={b.status === "active" ? "success" : "neutral"}>{b.status === "active" ? W.brands.active : W.brands.archived}</Badge></td>
                      <td className="p-2 tabular-nums">{n?.tasks30 ?? 0}</td>
                      <td className="p-2 tabular-nums">{n?.credits30 ?? 0}</td>
                      <td className="p-2"><Time value={b.createdAt} lang={lang} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </TabPanel>

      <TabPanel idBase="wsp" id="billing" value={tab} className="grid gap-3">
        <dl className="grid gap-2 rounded-card border border-border p-3 sm:grid-cols-2">
          <div><dt className="text-xs text-foreground-muted">{W.plan}</dt><dd className="font-mono">{view.plan.plan}</dd></div>
          <div><dt className="text-xs text-foreground-muted">{W.billing.price}</dt><dd className="tabular-nums">{billing.priceSar}</dd></div>
          <div><dt className="text-xs text-foreground-muted">{W.billing.allowance}</dt><dd className="tabular-nums">{billing.allowance}</dd></div>
          <div><dt className="text-xs text-foreground-muted">{W.billing.renewed}</dt><dd>{when(billing.renewedAt)}</dd></div>
          <div><dt className="text-xs text-foreground-muted">{W.billing.trialEnds}</dt><dd><Time value={view.plan.trialEnds} lang={lang} /></dd></div>
          <div><dt className="text-xs text-foreground-muted">{W.billing.seatsOverride}</dt><dd className="tabular-nums">{billing.seatsOverride ?? W.billing.none}</dd></div>
          <div><dt className="text-xs text-foreground-muted">{W.billing.brandCapOverride}</dt><dd className="tabular-nums">{billing.brandCapOverride ?? W.billing.none}</dd></div>
          <div><dt className="text-xs text-foreground-muted">{W.billing.deal}</dt><dd>{billing.deal ? W.billing.dealOf(billing.deal.credits, billing.deal.priceSar) : W.billing.noDeal}</dd></div>
        </dl>
        <p><Link href={`${adminHref(lang, "users")}/accounts?q=${encodeURIComponent(view.owner.email)}`} className="text-foreground underline">{W.billing.link}</Link></p>
      </TabPanel>

      <TabPanel idBase="wsp" id="log" value={tab} className="grid gap-2">
        {log.length === 0 ? <EmptyState compact icon="grid" title={W.log.empty} /> : (
          <>
            <p className="text-xs text-foreground-muted">{W.log.shown(log.length)}</p>
            <div className="overflow-x-auto rounded-card border border-border">
              <table className="w-full text-xs">
                <thead className="bg-surface-muted text-foreground-muted"><tr><th scope="col" className={TH}>{W.log.at}</th><th scope="col" className={TH}>{W.log.what}</th><th scope="col" className={TH}>{W.log.by}</th><th scope="col" className={TH}>{W.log.brand}</th><th scope="col" className={TH}>{W.log.detail}</th></tr></thead>
                <tbody>
                  {log.map((l, i) => (
                    <tr key={`${l.at}-${i}`} className="border-t border-border">
                      <td className="p-2"><Time value={l.at} lang={lang} style="datetime" /></td>
                      <td className="p-2 font-mono">{l.kind}{l.type ? ` · ${l.type}` : ""}</td>
                      <td className="p-2"><bdi dir="ltr">{byText(l.by)}</bdi></td>
                      <td className="p-2" dir="auto">{brandName(l.brand)}</td>
                      <td className="p-2" dir="auto">{[l.count != null ? `×${l.count}` : "", l.credits != null ? `${l.credits}` : "", l.outcome ?? "", l.note ?? ""].filter(Boolean).join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </TabPanel>
    </div>
  );
}

const WSP_BADGE = { en: { suspended: "Suspended" }, ar: { suspended: "موقوف" } } as const;
