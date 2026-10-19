"use client";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Activity, ActivityKind } from "@/lib/activity";
import type { By } from "@/lib/actor";
import { AGENT_IDS, agentForTask, isAgentId, type AgentId } from "@/lib/agents";
import { isTaskType } from "@/lib/tasks";
import { dateFormat } from "@/lib/dates";
import Scribble from "@/components/Scribble";
import { useToast } from "@/components/ui/Toast";
import EmptyState from "@/components/ui/EmptyState";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { emptyCopy, emptyHelp } from "@/lib/empty-copy";

type Page = { rows: Activity[]; next: string | null };

/**
 * The brand's activity log. `initial` and `next` are the first page, read on the server (`listActivity(sc(u))`), so the
 * page makes no request on mount; the filters and "Load more" ask GET /api/activity. Every note is shown as text: it is
 * a title, a file name or a setting written by a model, an outside app or the owner.
 */
export default function ActivityPanel({ t, lang, initial, next: firstNext }: { t: AppDict; lang: "ar" | "en"; initial: Activity[]; next: string | null }) {
  const a = t.activity;
  const toast = useToast();
  const [rows, setRows] = useState<Activity[]>(initial);
  const [next, setNext] = useState<string | null>(firstNext);
  const [agent, setAgent] = useState<AgentId | "">("");
  const [kind, setKind] = useState<ActivityKind | "">("");
  const [busy, setBusy] = useState(false);
  // The rate-limit refusal stays beside the filters (rule 2001); a plain failure is a toast.
  const [slow, setSlow] = useState(false);
  // A filter change is replacing the rows (rule 2003), as opposed to "Load more" adding to them.
  const [replacing, setReplacing] = useState(false);
  // The kinds the filter offers are the ones the dictionary names (the server checks the value again).
  const kinds = Object.keys(a.kinds) as ActivityKind[];

  /**
   * A filter becomes the page's only once its first page has arrived, together with its rows and cursor: when the load
   * fails, the selects, the list and "Load more" all stay on the filter that was showing, so the next page is never the
   * new filter's rows under the old filter's cursor.
   */
  async function load(f: { agent: AgentId | ""; kind: ActivityKind | "" }, before: string | null) {
    setBusy(true);
    setSlow(false);
    setReplacing(!before);
    try {
      const q = new URLSearchParams();
      if (f.agent) q.set("agent", f.agent);
      if (f.kind) q.set("kind", f.kind);
      if (before) q.set("before", before);
      const res = await fetch(`/api/activity?${q}`);
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & Partial<Page>;
      if (!res.ok || !j.ok || !Array.isArray(j.rows)) { if (res.status === 429) setSlow(true); else toast.danger(a.failed); return; } // rule 2001
      const got = j.rows;
      setRows((cur) => (before ? [...cur, ...got] : got));
      setNext(j.next ?? null);
      if (!before) { setAgent(f.agent); setKind(f.kind); }
    } catch {
      toast.danger(a.failed);
    } finally {
      setBusy(false);
      setReplacing(false);
    }
  }

  const empty = emptyCopy(lang, agent || kind ? "activityFiltered" : "activity");
  const when = dateFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
  // Majed's auto-run is the system's `auto_handoff` job: named, so the owner can tell it from the other automatic work.
  const who = (b: By) => (b.kind === "member" ? `${a.by.member}${b.email ? ` · ${b.email}` : ""}` : b.kind === "system" && b.job === "auto_handoff" ? a.autoRun : a.by[b.kind]);
  const typeOf = (r: Activity) => (r.type && isTaskType(r.type) ? t.generate.types[r.type].t : "");
  /** A comma list of task types (a handoff's `note`) as their names; anything that is not a type is left out. */
  const typesOf = (note: string | undefined) => (note ?? "").split(",").filter(isTaskType).map((x) => t.generate.types[x].t).join(lang === "ar" ? "، " : ", ");
  /** What happened, in plain words from the dictionary; the codes themselves are in the CSV. */
  function detail(r: Activity): string {
    const n = (s: string, v: number | undefined) => (v === undefined ? "" : fill(s, { n: v }));
    const media = r.media ? a.media[r.media] : "";
    const parts: string[] = (() => {
      switch (r.kind) {
        case "generated": case "routine_ran": return [typeOf(r), n(a.items, r.count)];
        case "judged": return [typeOf(r), n(a.items, r.count), n(a.score, r.score)];
        case "autofail": return [typeOf(r), n(a.items, r.count), r.autofail ?? ""];
        case "published": return [r.note ?? "", r.outcome ? fill(a.to, { p: r.outcome }) : ""];
        case "decision": return [r.outcome && Object.hasOwn(a.actions, r.outcome) ? a.actions[r.outcome as keyof typeof a.actions] : "", r.note ?? ""];
        case "image_started": case "render_done": return [media];
        case "render_failed": return [media, r.refunded ? a.refunded : a.notRefunded];
        case "routine_skipped": return [typeOf(r), r.outcome && Object.hasOwn(a.outcomes, r.outcome) ? a.outcomes[r.outcome as keyof typeof a.outcomes] : ""];
        // A refused charge names its batch type or its render; an added brand's setup is the one charge with neither.
        case "cap_reached": {
          const [spent, cap] = (r.outcome ?? "").split("/");
          return [typeOf(r) || media || a.setup, spent && cap ? fill(a.capUsed, { spent, cap }) : "", a.notCharged];
        }
        case "no_credits": return [typeOf(r) || media || a.setup, n(a.needed, r.credits), a.notCharged];
        case "onboard_charged": return [];
        case "onboard_refunded": return [n(a.credits, r.credits), a.refunded];
        case "external_draft": return [typeOf(r), r.note ?? ""];
        case "instructions_changed": return [n(a.items, r.count), r.note ?? ""];
        case "instructions_tested": return [typeOf(r), n(a.credits, r.credits)];
        case "gov_changed": case "gov_rollback": return [r.note ? fill(a.changed, { list: r.note }) : ""];
        // The reviewing agent is the row's agent; `outcome` is "flags:N", written in code.
        case "cross_reviewed": {
          const flags = Number(/^flags:(\d+)$/.exec(r.outcome ?? "")?.[1] ?? NaN);
          return [typeOf(r), n(a.items, r.count), Number.isNaN(flags) ? "" : flags ? fill(a.flags, { n: flags }) : a.noFlags];
        }
        // Majed's handoffs: `note` is the item types, written in code; each is named, with the agent who owns it.
        case "handoff_proposed": return [typesOf(r.note), n(a.items, r.count), n(a.handoffCost, r.credits), a.notCharged];
        case "handoff_declined": return [typesOf(r.note), n(a.items, r.count)];
        // `outcome` is written in code; `note` is the page's name as LinkedIn listed it.
        case "connector_changed": return [r.outcome === "linkedin:post_as:org" ? fill(a.postAsPage, { page: r.note ?? "" }) : r.outcome === "linkedin:post_as:me" ? a.postAsMe : ""];
        case "handoff_run": {
          const owner = r.type && isTaskType(r.type) ? agentForTask(r.type).id : undefined;
          const failed = (r.outcome ?? "").startsWith("failed:");
          return [typeOf(r), owner ? fill(a.handoffFor, { name: t.agents[owner].name }) : "", failed ? a.handoffFailed : n(a.items, r.count)];
        }
        default: return [r.note ?? ""];
      }
    })();
    return parts.filter(Boolean).join(" · ");
  }
  /** Credits the row's action spent; refusals say "nothing charged" in their detail instead. */
  const spent = (r: Activity) => ((r.kind === "generated" || r.kind === "image_started" || r.kind === "onboard_charged") && r.credits !== undefined ? fill(a.credits, { n: r.credits }) : "");

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="activitypanel-t1" />{a.title}</span></h1>
      <p className="mt-2 text-foreground-muted">{a.sub}</p>
      <div className="mt-6 grid gap-4">
        <div className="card flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            <span className="text-foreground-muted">{a.agent}</span>
            <select value={agent} disabled={busy} onChange={(e) => void load({ agent: isAgentId(e.target.value) ? e.target.value : "", kind }, null)} className="rounded border border-border bg-surface px-2 py-1">
              <option value="">{a.allAgents}</option>
              {AGENT_IDS.map((id) => <option key={id} value={id}>{t.agents[id].name}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-foreground-muted">{a.kind}</span>
            <select value={kind} disabled={busy} onChange={(e) => void load({ agent, kind: kinds.find((k) => k === e.target.value) ?? "" }, null)} className="rounded border border-border bg-surface px-2 py-1">
              <option value="">{a.allKinds}</option>
              {kinds.map((k) => <option key={k} value={k}>{a.kinds[k]}</option>)}
            </select>
          </label>
          <a href="/api/activity/export" download className="btn btn-secondary btn-sm ms-auto">{a.export}</a>
        </div>
        {slow && <p role="alert" className="text-sm text-danger">{a.slow}</p>}
        <section className="card" aria-busy={busy}>
          {replacing ? (
            <PanelSkeleton label={a.loading} shape="rows" />
          ) : rows.length === 0 ? (
            // Rule 2002: the filtered words when a filter is set, else the plain ones.
            <EmptyState compact title={empty.title} body={empty.body} help={agent || kind ? undefined : emptyHelp(lang, "activity")} />
          ) : (
            <ul className="divide-y divide-foreground/10">
              {rows.map((r, i) => (
                <li key={`${r.at}-${i}`} className="py-3">
                  <p className="flex flex-wrap items-center gap-x-2 text-sm">
                    <time dateTime={r.at} suppressHydrationWarning className="text-foreground-muted">{when.format(new Date(r.at))} UTC</time>
                    <span className="font-medium">{r.agent ? t.agents[r.agent].name : a.account}</span>
                    <span className="badge">{a.kinds[r.kind]}</span>
                  </p>
                  {detail(r) && <p className="mt-1 text-sm text-foreground-muted" dir="auto">{detail(r)}</p>}
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-foreground-muted">
                    <span>{a.via[r.via]}</span>
                    <span aria-hidden="true">·</span>
                    <span dir="auto">{who(r.by)}</span>
                    {spent(r) && <><span aria-hidden="true">·</span><span className="tnum">{spent(r)}</span></>}
                    {r.tasks?.length ? <><span aria-hidden="true">·</span><a href={`/${lang}/app`} className="underline">{a.inbox}</a></> : null}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {next && (
            <button type="button" onClick={() => load({ agent, kind }, next)} disabled={busy} className="btn btn-secondary btn-sm mt-3">{busy ? a.loading : a.more}</button>
          )}
        </section>
      </div>
    </div>
  );
}
