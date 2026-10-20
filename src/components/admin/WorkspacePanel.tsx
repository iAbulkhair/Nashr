"use client";
import { useCallback, useEffect, useState } from "react";
import Badge from "@/components/ui/Badge";
import EmptyState from "@/components/ui/EmptyState";
import ErrorState from "@/components/ui/ErrorState";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { Time } from "@/components/ui/Time";
import { adminFetch } from "@/lib/admin-fetch";
import { formatCount } from "@/lib/pricing";
import { formatSuspensionEnd } from "@/lib/suspension";
import type { WorkspaceView } from "@/lib/admin-workspace";
import { agentById } from "@/lib/agents";
import { STR, type Lang } from "./shared";
import { USERS_COPY } from "./users-copy";

type Load = { state: "loading" } | { state: "ready"; view: WorkspaceView } | { state: "failed"; error: "forbidden" | "not_found" | "failed" };

const TH = "p-2 text-start font-medium";

/**
 * The account sheet's Workspace tab (rules 2077-2083, docs/system/flows.md section 84): the owner, the plan with its
 * seat and brand limits, the members with their role and last sign-in, the pending invites and the brands, after
 * supastarter's admin organization page. Read only: nothing here changes anything. It loads when the tab opens (the
 * sheet renders a tab's panel only while it is chosen), so each open is one read and one audit row on the server.
 * Every value renders as text.
 */
export default function WorkspacePanel({ lang, email }: { lang: Lang; email: string }) {
  const UC = USERS_COPY[lang];
  const W = UC.ws;
  const [load, setLoad] = useState<Load>({ state: "loading" });

  const readView = useCallback(async (): Promise<Load> => {
    try {
      const r = await adminFetch(`/api/admin/users/${encodeURIComponent(email)}/workspace`, { cache: "no-store" });
      const j = (await r.json().catch(() => null)) as ({ ok?: boolean } & Partial<WorkspaceView>) | null;
      if (r.ok && j?.ok && j.owner) return { state: "ready", view: j as WorkspaceView };
      return { state: "failed", error: r.status === 403 ? "forbidden" : r.status === 404 ? "not_found" : "failed" };
    } catch {
      return { state: "failed", error: "failed" };
    }
  }, [email]);

  useEffect(() => {
    let live = true;
    void readView().then((next) => { if (live) setLoad(next); });
    return () => { live = false; };
  }, [readView]);

  const retry = async () => {
    setLoad({ state: "loading" });
    setLoad(await readView());
  };

  if (load.state === "loading") return <PanelSkeleton label={W.loading} shape="cards" count={2} />;
  if (load.state === "failed") {
    const body = load.error === "forbidden" ? W.forbidden : load.error === "not_found" ? W.notFound : undefined;
    return <ErrorState title={W.failed} body={body} retryLabel={W.retry} onRetry={load.error === "failed" ? retry : undefined} />;
  }

  const { owner, plan, members, invites, brands, openedFrom } = load.view;
  const when = (v: string | null) => (v ? <Time value={v} lang={lang} style="datetime" /> : <span className="text-foreground-muted">{W.notRecorded}</span>);
  return (
    <div className="grid gap-4 text-sm" data-testid="workspace-panel">
      <p className="text-xs text-foreground-muted">{W.readOnly}</p>
      {openedFrom && <p className="text-xs text-foreground-muted">{W.openedFrom} <bdi dir="ltr">{openedFrom}</bdi></p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <section aria-labelledby="ws-owner" className="grid content-start gap-1 rounded-card border border-border p-3">
          <h3 id="ws-owner" className="font-display font-bold text-foreground">{W.owner}</h3>
          <p><bdi dir="ltr">{owner.email}</bdi></p>
          <p dir="auto" className="text-foreground-muted">{owner.name}</p>
          {(owner.suspended || !owner.verified) && (
            <p className="flex flex-wrap gap-2">
              {owner.suspended && <Badge tone="danger"><span suppressHydrationWarning>{UC.suspendedBadge}{owner.suspendedUntil ? ` · ${UC.suspendedUntil(formatSuspensionEnd(owner.suspendedUntil, lang))}` : ""}</span></Badge>}
              {!owner.verified && <Badge tone="warning">{STR[lang].unverified}</Badge>}
            </p>
          )}
          <p className="text-xs text-foreground-muted">{W.lastSignIn}: {when(owner.lastSignInAt)}</p>
          <p className="text-xs text-foreground-muted">{W.lastActive}: {when(owner.lastActiveAt)}</p>
          <p className="text-xs text-foreground-muted">{W.created}: <Time value={owner.createdAt} lang={lang} /></p>
        </section>
        <section aria-labelledby="ws-plan" className="grid content-start gap-1 rounded-card border border-border p-3">
          <h3 id="ws-plan" className="font-display font-bold text-foreground">{W.plan}</h3>
          <p className="font-mono">{plan.plan}</p>
          <p className="tabular-nums">{W.seats(plan.seats.used, plan.seats.limit)}</p>
          <p className="tabular-nums">{W.brandCap(plan.brands.active, plan.brands.cap)}</p>
          <p className="text-xs text-foreground-muted">{W.credits}: <span className="tabular-nums">{formatCount(plan.credits)}</span></p>
          <p className="text-xs text-foreground-muted">{W.trialEnds}: <Time value={plan.trialEnds} lang={lang} /></p>
        </section>
      </div>

      <section aria-labelledby="ws-members" className="grid gap-2">
        <h3 id="ws-members" className="font-display font-bold text-foreground">{W.members} <span className="tabular-nums text-foreground-muted">({members.length})</span></h3>
        {members.length === 0 ? <EmptyState compact icon="grid" title={W.noMembers} body={W.noMembersBody} /> : (
          <div className="overflow-x-auto rounded-card border border-border">
            <table className="w-full text-xs">
              <thead className="bg-surface-muted text-foreground-muted">
                <tr><th scope="col" className={TH}>{W.email}</th><th scope="col" className={TH}>{W.role}</th><th scope="col" className={TH}>{W.invitedBy}</th><th scope="col" className={TH}>{W.joined}</th><th scope="col" className={TH}>{W.lastSignIn}</th><th scope="col" className={TH}>{W.status}</th></tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.email} className="border-t border-border">
                    <td className="p-2"><bdi dir="ltr">{m.email}</bdi><div dir="auto" className="text-foreground-muted">{m.name}</div></td>
                    <td className="p-2">{W.roles[m.role]}</td>
                    <td className="p-2"><bdi dir="ltr">{m.invitedBy}</bdi></td>
                    <td className="p-2"><Time value={m.acceptedAt} lang={lang} /></td>
                    <td className="p-2">{when(m.lastSignInAt)}</td>
                    <td className="p-2">{m.paused ? <Badge tone="warning">{W.paused}</Badge> : <Badge tone="success">{W.memberActive}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="ws-invites" className="grid gap-2">
        <h3 id="ws-invites" className="font-display font-bold text-foreground">{W.invites} <span className="tabular-nums text-foreground-muted">({invites.length})</span></h3>
        {invites.length === 0 ? <EmptyState compact icon="email" title={W.noInvites} /> : (
          <div className="overflow-x-auto rounded-card border border-border">
            <table className="w-full text-xs">
              <thead className="bg-surface-muted text-foreground-muted">
                <tr><th scope="col" className={TH}>{W.email}</th><th scope="col" className={TH}>{W.role}</th><th scope="col" className={TH}>{W.invitedBy}</th><th scope="col" className={TH}>{W.created}</th><th scope="col" className={TH}>{W.expires}</th></tr>
              </thead>
              <tbody>
                {invites.map((v) => (
                  <tr key={v.email} className="border-t border-border">
                    <td className="p-2"><bdi dir="ltr">{v.email}</bdi></td>
                    <td className="p-2">{W.roles[v.role]}</td>
                    <td className="p-2"><bdi dir="ltr">{v.invitedBy}</bdi></td>
                    <td className="p-2"><Time value={v.createdAt} lang={lang} /></td>
                    <td className="p-2"><Time value={v.expiresAt} lang={lang} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="ws-brands" className="grid gap-2">
        <h3 id="ws-brands" className="font-display font-bold text-foreground">{W.brands} <span className="tabular-nums text-foreground-muted">({brands.length})</span></h3>
        {brands.length === 0 ? <EmptyState compact icon="folder" title={W.noBrands} /> : (
          <ul className="grid gap-2">
            {brands.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-border p-2 text-xs">
                <span dir="auto" className="font-medium text-foreground">{b.name || (b.id === "default" ? W.mainBrand : b.id)}</span>
                <span className="flex items-center gap-2">
                  <Badge tone={b.status === "active" ? "success" : "neutral"}>{b.status === "active" ? W.active : W.archived}</Badge>
                  <span className="text-foreground-muted">{W.created}: <Time value={b.createdAt} lang={lang} /></span>
                </span>
                {/* Rule 2460: the brand's agent tool authority, restrictions only. */}
                <p className="w-full text-foreground-muted" data-limits={b.id}>
                  {W.limits}: {(b.limits ?? []).length === 0 ? W.allAllowed : (b.limits ?? []).map((l) => `${agentById(l.agent).name[lang]} · ${W.capNames[l.cap]} · ${W.modeNames[l.mode]}`).join(lang === "ar" ? "؛ " : "; ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
