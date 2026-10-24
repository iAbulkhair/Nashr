"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Badge from "@/components/ui/Badge";
import Callout from "@/components/ui/Callout";
import { Input, Select } from "@/components/ui/Field";
import { Time } from "@/components/ui/Time";
import { adminFetch } from "@/lib/admin-fetch";
import { adminHref } from "@/lib/admin-gate";
import { PLANS } from "@/lib/pricing";
import { roleLabel } from "@/lib/role-label";
import type { QueryCodec } from "@/lib/url-query";
import { WS_FILTERS, WS_PAGE_SIZES, parseWsQuery, wsQueryParams, type WsQuery, type WsSort, type WorkspaceRow } from "@/lib/admin-workspaces-math";
import type { WorkspaceList } from "@/lib/admin-workspaces";
import { DataTable, Pager, useUrlQuery, type Column } from "./DataTable";
import { EndedNotice, useAdminEnded, type SectionProps } from "./shared";
import { WS_COPY } from "./workspaces-copy";

/** The customers list's query in the address (rule 2007): `parseWsQuery` validates every value, the defaults stay out. */
const WS_CODEC: QueryCodec<WsQuery> = { parse: parseWsQuery, params: wsQueryParams };
const TYPED = ["q"] as const satisfies readonly (keyof WsQuery)[];

type Answer = WorkspaceList & { ok: boolean };

/**
 * GET /api/admin/workspaces (rule 3720): one page of workspaces the server filtered, sorted and counted. A slower answer to
 * an older query is dropped, so typing never shows a stale page. `refresh` asks the server to count again.
 */
function useWorkspaceList(query: WsQuery) {
  const [data, setData] = useState<WorkspaceList | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<null | "forbidden" | "failed">(null);
  const seq = useRef(0);
  const key = wsQueryParams(query).toString();
  const load = useCallback(async (refresh = false) => {
    const n = ++seq.current;
    setLoading(true);
    const p = new URLSearchParams(key);
    if (refresh) p.set("refresh", "1");
    const r = await adminFetch(`/api/admin/workspaces?${p.toString()}`, { cache: "no-store" }).catch(() => null);
    if (n !== seq.current) return;
    if (r?.status === 401) { setLoading(false); return; }
    const j = (await r?.json().catch(() => null)) as Answer | null;
    if (n !== seq.current) return;
    if (r?.ok && j?.ok) { setData(j); setFailed(null); } else setFailed(r?.status === 403 ? "forbidden" : "failed");
    setLoading(false);
  }, [key]);
  useEffect(() => { void Promise.resolve().then(() => load()); }, [load]);
  return { data, loading, failed, load };
}

/**
 * Founder console, Customers (/{lang}/admin/users, rules 3720-3724): one row per workspace (account), after the organization
 * list of supastarter's admin. The numbers are counted on the server and kept for 5 minutes (`asOf` says when); every filter,
 * sort and page runs on the server too and lives in the address. A search by a member's email lists every workspace that
 * person belongs to, with their role in each. The account controls (plan, seats, deal, allowance) stay in the accounts view.
 */
export default function Customers({ lang, keySession }: SectionProps) {
  const ended = useAdminEnded();
  const C = WS_COPY[lang];
  const { query, setQuery } = useUrlQuery(WS_CODEC, TYPED);
  const { data, loading, failed, load } = useWorkspaceList(query);
  const [text, setText] = useState(query.q);
  const [seen, setSeen] = useState(query.q);
  const [sent, setSent] = useState(query.q);
  if (query.q !== seen) {
    setSeen(query.q);
    if (query.q !== sent) { setText(query.q); setSent(query.q); }
  }
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);
  function onText(v: string) {
    setText(v);
    if (typing.current) clearTimeout(typing.current);
    typing.current = setTimeout(() => { const q = v.trim().slice(0, 120); setSent(q); setQuery({ q }); }, 300);
  }
  if (ended) return <EndedNotice lang={lang} keySession={keySession} />;

  const here = (email: string) => `${adminHref(lang, "users")}/${encodeURIComponent(email)}`;
  const count = (n: number | undefined) => (n == null ? "" : ` (${n})`);
  const facets = data?.facets;
  const showRole = !!data?.person;
  const columns: Column<WorkspaceRow, WsSort>[] = [
    {
      id: "name", header: C.cols.name, sort: "name", className: "min-w-48",
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <Link href={here(r.email)} className="min-h-[var(--hit-min)] text-start text-foreground underline pointer-fine:min-h-6"><span dir="auto">{r.name}</span></Link>
          {r.suspended && <Badge tone="danger">{C.suspendedBadge}</Badge>}
        </span>
      ),
    },
    { id: "owner", header: C.cols.owner, cell: (r) => <span><bdi dir="ltr">{r.email}</bdi>{r.ownerName && r.ownerName !== r.name ? <span dir="auto" className="block text-xs text-foreground-muted">{r.ownerName}</span> : null}</span> },
    ...(showRole ? [{ id: "role", header: C.cols.role, cell: (r: WorkspaceRow) => <Badge tone="info">{roleLabel(r.asRole, lang)}</Badge> } satisfies Column<WorkspaceRow, WsSort>] : []),
    { id: "plan", header: C.cols.plan, sort: "plan", cell: (r) => <span className="font-mono text-xs">{r.plan}</span> },
    { id: "seats", header: C.cols.seats, sort: "seats", className: "tabular-nums", cell: (r) => C.seatsOf(r.seats.used, r.seats.limit) },
    { id: "brands", header: C.cols.brands, className: "tabular-nums", cell: (r) => C.seatsOf(r.brands.active, r.brands.cap) },
    { id: "active7", header: C.cols.active7, sort: "active7", className: "tabular-nums", cell: (r) => r.active7 },
    { id: "tasks30", header: C.cols.tasks30, sort: "tasks30", className: "tabular-nums", cell: (r) => r.tasks30 },
    { id: "credits", header: C.cols.credits, sort: "credits", className: "tabular-nums", cell: (r) => C.creditsOf(r.credits.used, r.credits.allowance) },
    { id: "last", header: C.cols.last, sort: "lastActivity", cell: (r) => (r.lastActivityAt ? <Time value={r.lastActivityAt} lang={lang} style="datetime" /> : <span className="text-foreground-muted">{C.never}</span>) },
  ];

  return (
    <div className="grid gap-6">
      <div className="grid gap-3 sm:grid-cols-4">
        {([["workspaces", data?.tiles.workspaces], ["paying", data?.tiles.paying], ["trial", data?.tiles.trial], ["suspended", data?.tiles.suspended]] as const).map(([k, v]) => (
          <div key={k} className="card card-sm"><p className="text-xs text-foreground-muted">{C.tiles[k]}</p><p className="font-display text-2xl font-bold text-foreground">{v ?? "…"}</p></div>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid min-w-0 flex-1 basis-64 gap-1 text-xs text-foreground-muted">
          <span>{C.searchLabel}</span>
          <Input type="search" value={text} onChange={(e) => onText(e.target.value)} placeholder={C.searchPlaceholder} maxLength={120} />
        </label>
        <label className="grid gap-1 text-xs text-foreground-muted">
          <span>{C.planFilter}</span>
          <Select value={query.plan} onChange={(e) => setQuery({ plan: e.target.value as WsQuery["plan"] })}>
            <option value="">{C.allPlans}{count(facets?.all)}</option>
            {PLANS.map((p) => <option key={p} value={p}>{p}{count(facets?.plan[p])}</option>)}
          </Select>
        </label>
        <label className="grid gap-1 text-xs text-foreground-muted">
          <span>{C.stateFilter}</span>
          <Select value={query.filter} onChange={(e) => setQuery({ filter: e.target.value as WsQuery["filter"] })}>
            <option value="">{C.filters[""]}</option>
            {WS_FILTERS.map((f) => <option key={f} value={f}>{C.filters[f]}{count(facets?.filter[f])}</option>)}
          </Select>
        </label>
        <button type="button" disabled={loading} onClick={() => void load(true)} className="btn btn-secondary btn-xs min-h-[var(--hit-min)]">{loading ? C.refreshing : C.refresh}</button>
      </div>
      {data?.person && (
        <Callout tone="info">
          <p dir="auto">{C.person(data.person.name, data.person.email, data.matched)}</p>
        </Callout>
      )}
      {data && <p className="text-xs text-foreground-muted" aria-live="polite">{C.matched(data.matched, data.facets.all)}</p>}
      {failed && !data && <Callout tone="danger">{failed === "forbidden" ? C.forbidden : C.loadFailed} {failed === "failed" && <button type="button" onClick={() => void load()} className="underline">{C.retry}</button>}</Callout>}
      {failed && data && <Callout tone="danger">{C.loadFailed}</Callout>}
      {!(failed && !data) && (
        <DataTable
          lang={lang}
          caption={C.caption}
          columns={columns}
          rows={data?.rows ?? null}
          rowKey={(r) => r.email}
          sort={query.sort}
          dir={query.dir}
          // The same column flips its direction; a new one starts A to Z for text and newest or largest first otherwise.
          onSort={(k) => setQuery({ sort: k, dir: query.sort === k ? (query.dir === "desc" ? "asc" : "desc") : k === "name" || k === "plan" ? "asc" : "desc" })}
          loading={loading}
          rowClassName={(r) => (r.suspended ? "bg-agent-sami/20" : "")}
        />
      )}
      {data && <Pager lang={lang} page={data.page} pages={data.pages} per={data.per} sizes={WS_PAGE_SIZES} onPage={(p) => setQuery({ page: p })} onPer={(n) => setQuery({ per: n })} />}
      {data && <p className="text-xs text-foreground-muted">{C.asOf} <Time value={data.asOf} lang={lang} style="datetime" />. {C.asOfNote}</p>}
      <p className="text-sm"><Link href={`${adminHref(lang, "users")}/accounts`} className="text-foreground underline">{C.accountsLink}</Link></p>
    </div>
  );
}
