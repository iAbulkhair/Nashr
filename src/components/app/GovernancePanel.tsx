"use client";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { GovHistoryEntry, GovValue, Governance } from "@/lib/governance";
import type { By } from "@/lib/actor";
import { AGENTS, AGENT_IDS, isAgentId, type AgentId } from "@/lib/agents";
import { TASK_COST, isTaskType, type TaskType } from "@/lib/tasks";
import { dateFormat } from "@/lib/dates";
import ReadOnlyNote from "./ReadOnlyNote";

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-60 ${on ? "bg-oasis" : "bg-ink/20"}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${on ? "start-[22px]" : "start-0.5"}`} />
    </button>
  );
}

/** Declared at module scope: a component created during render is remounted on every keystroke and loses focus. */
function Row({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
      <div className="flex items-start justify-between gap-6 card">
        <div><h2 className="font-display font-medium">{title}</h2><p className="mt-1 text-sm text-ink/60">{sub}</p></div>
        <div className="shrink-0">{children}</div>
      </div>
  );
}

/**
 * The agents a monthly cap can stop: the ones that own a paid task type. Spend is charged to the agent that owns the
 * type, so an agent without one (Reem, free) would show a cap that never applies. The server still accepts a cap for
 * every agent id.
 */
const CAPPED: AgentId[] = AGENTS.filter((a) => a.tasks.length > 0).map((a) => a.id);
/** The cap fields as typed: "" is no cap, so clearing a field removes the cap instead of setting it to 0. */
const capText = (g: Governance) => Object.fromEntries(AGENT_IDS.map((id) => [id, g.agentCaps?.[id] === undefined ? "" : String(g.agentCaps[id])])) as Record<AgentId, string>;
/**
 * Empty or a whole number; the server clamps it to its own range and the page then shows what was stored. The fields
 * are text with a numeric keyboard, not type=number: a number field reports "" for text it cannot parse ("50e"), which
 * read as "no cap" and removed the owner's cap on save.
 */
const validCap = (v: string) => v.trim() === "" || /^\d+$/.test(v.trim());

/**
 * `spend` is this brand scope's credits per agent this month, rendered on the server from the User record, and
 * `history` this brand's governance changes, newest first (`listGovHistory`), so the page makes no request on mount.
 * `historyCap` is how many changes the server keeps (`CAPS.govHistory`): the list here never shows more, so it never
 * offers to restore a change the server has already dropped.
 *
 * `readOnly` (everyone but the owner): the same settings, with every control disabled by the wrapping fieldset and no
 * Save button; the history is still listed (it sits outside the fieldset) but without Restore buttons. Display only:
 * PUT /api/governance and POST /api/governance/rollback refuse these roles in code.
 */
export default function GovernancePanel({ t, lang, initial, spend, history: initialHistory, historyCap, readOnly = false }: { t: AppDict; lang: "ar" | "en"; initial: Governance; spend: Partial<Record<AgentId, number>>; history: GovHistoryEntry[]; historyCap: number; readOnly?: boolean }) {
  const g = t.governance;
  const [gov, setGov] = useState<Governance>(initial);
  const [caps, setCaps] = useState<Record<AgentId, string>>(() => capText(initial));
  const [history, setHistory] = useState<GovHistoryEntry[]>(initialHistory);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [histMsg, setHistMsg] = useState("");
  const [histErr, setHistErr] = useState("");
  /** What the server stored, after its own checks, is what the page shows; a change it recorded joins the history. */
  function applySaved(j: { governance: Governance; entry?: GovHistoryEntry | null }) {
    setGov(j.governance);
    setCaps(capText(j.governance));
    const entry = j.entry;
    if (entry) setHistory((h) => [entry, ...h].slice(0, historyCap));
  }
  async function save() {
    setMsg(""); setErr(""); setHistMsg(""); setHistErr("");
    // Nothing is sent while a cap is not a whole number: dropping the field and saying "Saved" hid the mistake.
    if (CAPPED.some((id) => !validCap(caps[id]))) { setErr(g.capInvalid); return; }
    setBusy(true);
    try {
      // Empty sends null, which removes the cap.
      const agentCaps: Partial<Record<AgentId, number | null>> = {};
      for (const id of CAPPED) agentCaps[id] = caps[id].trim() === "" ? null : Number(caps[id].trim());
      const res = await fetch("/api/governance", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...gov, agentCaps }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; governance?: Governance; entry?: GovHistoryEntry | null };
      if (!res.ok || !j.ok || !j.governance) { setErr(j.error === "busy" ? g.busy : g.saveFailed); return; }
      applySaved({ governance: j.governance, entry: j.entry });
      setMsg(g.saved);
    } catch {
      setErr(g.saveFailed);
    } finally {
      setBusy(false);
    }
  }
  /** Puts every setting back as it was before revision `id`, after the owner confirms. The server records it as a new change. */
  async function restore(id: string) {
    setMsg(""); setErr(""); setHistMsg(""); setHistErr("");
    if (!window.confirm(g.restoreConfirm)) return;
    setRestoring(id);
    try {
      const res = await fetch("/api/governance/rollback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; governance?: Governance; entry?: GovHistoryEntry | null };
      // not_found: the change has left the history (dropped past the cap, maybe by a save in another tab); retrying cannot help.
      if (!res.ok || !j.ok || !j.governance) { setHistErr(j.error === "busy" ? g.busy : j.error === "not_found" ? g.restoreGone : g.restoreFailed); return; }
      applySaved({ governance: j.governance, entry: j.entry });
      setHistMsg(j.entry ? g.restored : g.restoreNoop);
    } catch {
      setHistErr(g.restoreFailed);
    } finally {
      setRestoring(null);
    }
  }
  const when = dateFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  const who = (b: By) => (b.kind === "member" ? `${g.byMember}${b.email ? ` · ${b.email}` : ""}` : b.kind === "founder" ? g.byFounder : b.kind === "token" ? g.byToken : b.kind === "system" ? g.bySystem : g.byOwner);
  const label = (path: string) => {
    const [head, sub] = path.split(".", 2);
    if (head === "autoApprove" && isTaskType(sub)) return `${g.autoApproveShort}: ${t.generate.types[sub].t}`;
    if (head === "agentCaps" && isAgentId(sub)) return `${g.capShort}: ${t.agents[sub].name}`;
    const top: Record<string, string> = { reviewer: g.reviewer, crossReview: g.crossReview, learning: g.learning, noEmDash: g.noEmDash, weeklyCap: g.weeklyCap, notifyMinutes: g.notify };
    return Object.hasOwn(top, head) ? top[head] : path;
  };
  const value = (path: string, v: GovValue) => (v === null ? (path.startsWith("agentCaps.") ? g.noCap : "—") : typeof v === "boolean" ? (v ? g.on : g.off) : String(v));
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="page-title">{g.title}</h1>
      <p className="mt-2 text-ink/70">{g.sub}</p>
      {readOnly && <ReadOnlyNote text={t.readOnly.owner} />}
      <fieldset disabled={readOnly} className="mt-6 grid min-w-0 gap-4">
        <div className="card">
          <h2 className="font-display font-medium">{g.autoApprove}</h2>
          <p className="mt-1 text-sm text-ink/60">{g.autoApproveSub}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(Object.keys(TASK_COST) as TaskType[]).map((k) => {
              const on = !!gov.autoApprove[k];
              return <button key={k} onClick={() => setGov({ ...gov, autoApprove: { ...gov.autoApprove, [k]: !on } })} className={`rounded-full border px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-60 ${on ? "border-oasis bg-oasis text-mist" : "border-ink/20"}`}>{t.generate.types[k].t}</button>;
            })}
          </div>
        </div>
        <Row title={g.reviewer} sub={g.reviewerSub}><Toggle on={gov.reviewer} onChange={(v) => setGov({ ...gov, reviewer: v })} /></Row>
        {/* A record saved before the switch existed has no value: the server reads it as on, and so does the page. */}
        <Row title={g.crossReview} sub={g.crossReviewSub}><Toggle on={gov.crossReview !== false} onChange={(v) => setGov({ ...gov, crossReview: v })} /></Row>
        <Row title={g.learning} sub={g.learningSub}><Toggle on={gov.learning} onChange={(v) => setGov({ ...gov, learning: v })} /></Row>
        <Row title={g.noEmDash} sub={g.noEmDashSub}><Toggle on={gov.noEmDash} onChange={(v) => setGov({ ...gov, noEmDash: v })} /></Row>
        <Row title={g.weeklyCap} sub={g.weeklyCapSub}><input type="number" min={0} max={200} value={gov.weeklyCap} onChange={(e) => setGov({ ...gov, weeklyCap: Number(e.target.value) })} className="w-24 rounded border border-ink/15 px-2 py-1 text-sm" dir="ltr" /></Row>
        <Row title={g.notify} sub={g.notifySub}><input type="number" min={0} max={1440} value={gov.notifyMinutes} onChange={(e) => setGov({ ...gov, notifyMinutes: Number(e.target.value) })} className="w-24 rounded border border-ink/15 px-2 py-1 text-sm" dir="ltr" /></Row>
        <div className="card">
          <h2 className="font-display font-medium">{g.agentCaps}</h2>
          <p className="mt-1 text-sm text-ink/60">{g.agentCapsSub}</p>
          <ul className="mt-3 divide-y divide-ink/10">
            {CAPPED.map((id) => {
              const used = spend[id] ?? 0;
              const cap = gov.agentCaps?.[id];
              // A cap of 0 stops every paid request, so it reads as reached.
              const ratio = cap === undefined ? 0 : cap === 0 ? 1 : used / cap;
              return (
                <li key={id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <div>
                    <p className="font-medium">{t.agents[id].name} <span className="text-sm font-normal text-ink/60">· {t.agents[id].role}</span></p>
                    <p className="mt-0.5 flex items-center gap-2 text-xs text-ink/60">
                      <span>{g.usedThisMonth.replace("{n}", String(used))}</span>
                      {ratio >= 1 ? <span className="badge badge-danger">{g.capReached}</span> : ratio >= 0.8 ? <span className="badge badge-accent">{g.capNear}</span> : null}
                    </p>
                  </div>
                  <input type="text" className="input w-28" dir="ltr" inputMode="numeric" autoComplete="off" placeholder={g.noCap} aria-label={g.capFor.replace("{name}", t.agents[id].name)} aria-invalid={!validCap(caps[id])} value={caps[id]} onChange={(e) => setCaps({ ...caps, [id]: e.target.value })} />
                </li>
              );
            })}
          </ul>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-3">
            <button onClick={save} disabled={busy || !!restoring} className="btn btn-primary btn-sm">{busy ? g.saving : g.save}</button>
            {msg && <span role="status" className="text-sm text-oasis">{msg}</span>}
            {err && <span role="alert" className="text-sm text-sadu-deep">{err}</span>}
          </div>
        )}
      </fieldset>
      {/* Outside the fieldset: every role reads the history; only the owner gets Restore (the server checks it too). */}
      <section className="card mt-4" aria-labelledby="gov-history">
        <h2 id="gov-history" className="font-display font-medium">{g.history}</h2>
        <p className="mt-1 text-sm text-ink/60">{g.historySub}</p>
        {histMsg && <p role="status" className="mt-2 text-sm text-oasis">{histMsg}</p>}
        {histErr && <p role="alert" className="mt-2 text-sm text-sadu-deep">{histErr}</p>}
        {history.length === 0 ? (
          <p className="mt-3 text-sm text-ink/60">{g.historyEmpty}</p>
        ) : (
          <ul className="mt-3 divide-y divide-ink/10">
            {history.map((r) => (
              <li key={r.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm">
                    <time id={`gov-rev-${r.id}`} dateTime={r.at} suppressHydrationWarning>{when.format(new Date(r.at))} UTC</time>
                    <span className="text-ink/60"> · </span>
                    <span dir="auto">{who(r.by)}</span>
                    {r.rollbackOf && <span className="ms-2 badge">{g.restoreOf}</span>}
                  </p>
                  {!readOnly && <button type="button" onClick={() => restore(r.id)} disabled={busy || !!restoring} aria-describedby={`gov-rev-${r.id}`} className="btn btn-secondary btn-xs">{restoring === r.id ? g.restoring : g.restore}</button>}
                </div>
                <ul className="mt-1 grid gap-0.5 text-xs text-ink/70">
                  {r.changes.map((c) => (
                    <li key={c.path}>
                      <span dir="auto">{label(c.path)}</span>: <bdi>{value(c.path, c.before)}</bdi> {g.arrow} <bdi className="font-medium text-ink">{value(c.path, c.after)}</bdi>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
