"use client";
import { useState } from "react";
import Link from "next/link";
import type { AppDict } from "@/lib/app-i18n";
import type { AutoQueued } from "@/lib/handoff-auto";
import type { GovHistoryEntry, GovValue, Governance } from "@/lib/governance";
import type { By } from "@/lib/actor";
import { AGENTS, AGENT_IDS, isAgentId, type AgentId } from "@/lib/agents";
import { TASK_COST, isTaskType, type TaskType } from "@/lib/tasks";
import { dateFormat } from "@/lib/dates";
import { ASKABLE, TOOL_CAPS, authorityOf, fullPolicy, isToolCap, type AuthorityMode, type ToolCap } from "@/lib/tool-authority";
import ReadOnlyNote from "./ReadOnlyNote";
import { useConfirm } from "./ConfirmDialog";
import Scribble from "@/components/Scribble";
import Switch from "@/components/ui/Switch";
import EmptyState from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";

/** Declared at module scope: a component created during render is remounted on every keystroke and loses focus. */
function Row({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
      <div className="flex items-start justify-between gap-6 card">
        <div><h2 className="font-display font-medium">{title}</h2><p className="mt-1 text-sm text-foreground-muted">{sub}</p></div>
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
/** A string from the dictionary with its {placeholders} filled. */
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
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
 *
 * `queue`: what Majed's auto-run may start next in this brand (`autoQueue`, rendered on the server), listed under the
 * switch with Decline for the logins that may decline (`canDecline` = `can(u, "drafts")`, checked again by the route),
 * so an item whose card scrolled out of its thread can still be kept from starting.
 */
export default function GovernancePanel({ t, lang, initial, spend, history: initialHistory, historyCap, readOnly = false, queue: initialQueue = [], canDecline = false }: { t: AppDict; lang: "ar" | "en"; initial: Governance; spend: Partial<Record<AgentId, number>>; history: GovHistoryEntry[]; historyCap: number; readOnly?: boolean; queue?: AutoQueued[]; canDecline?: boolean }) {
  const g = t.governance;
  const toast = useToast();
  const [gov, setGov] = useState<Governance>(initial);
  const [caps, setCaps] = useState<Record<AgentId, string>>(() => capText(initial));
  const [history, setHistory] = useState<GovHistoryEntry[]>(initialHistory);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [histErr, setHistErr] = useState("");
  const [queue, setQueue] = useState<AutoQueued[]>(initialQueue);
  const [declining, setDeclining] = useState<string | null>(null);
  const [queueErr, setQueueErr] = useState("");
  // The owner confirmed switching Majed's auto-run on in this page's dialog: only then does Save send the server the
  // confirmation it requires for that change (PUT /api/governance refuses it otherwise).
  const [autoConfirmed, setAutoConfirmed] = useState(false);
  const [ask, confirmDialog] = useConfirm();
  /** The auto-run question, the same from the switch and from a restore that would turn it back on. */
  const askAutoHandoff = () => ask({ title: g.autoHandoff, message: g.autoHandoffConfirm, confirmLabel: t.dialog.confirm, cancelLabel: t.dialog.back });
  /** A refused save or restore, in the owner's words: the server's typed codes. */
  const refusal = (code: unknown, fallback: string) => (code === "busy" ? g.busy : code === "auto_handoff_needs_cap" ? g.autoHandoffNeedsCap : code === "auto_handoff_confirm" ? g.autoHandoffConfirmNeeded : fallback);
  /**
   * The switch: turning it on asks first, in plain words; turning it off needs nothing. The settings are read again
   * after the answer (the updater form), not taken from before the question.
   */
  async function toggleAuto(on: boolean) {
    if (on && !(await askAutoHandoff())) return;
    setAutoConfirmed(on);
    setGov((cur) => ({ ...cur, majedAutoHandoff: on }));
  }
  /** What the server stored, after its own checks, is what the page shows; a change it recorded joins the history. */
  function applySaved(j: { governance: Governance; entry?: GovHistoryEntry | null }) {
    setGov(j.governance);
    setCaps(capText(j.governance));
    const entry = j.entry;
    if (entry) setHistory((h) => [entry, ...h].slice(0, historyCap));
  }
  async function save() {
    setErr(""); setHistErr("");
    // Nothing is sent while a cap is not a whole number: dropping the field and saying "Saved" hid the mistake.
    if (CAPPED.some((id) => !validCap(caps[id]))) { setErr(g.capInvalid); return; }
    setBusy(true);
    try {
      // Empty sends null, which removes the cap.
      const agentCaps: Partial<Record<AgentId, number | null>> = {};
      for (const id of CAPPED) agentCaps[id] = caps[id].trim() === "" ? null : Number(caps[id].trim());
      const confirm = gov.majedAutoHandoff === true && autoConfirmed ? { confirmAutoHandoff: true } : {};
      // Every agent and capability, `on` included: the server keeps a stored entry the patch does not name.
      const res = await fetch("/api/governance", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...gov, agentCaps, toolPolicy: fullPolicy(gov.toolPolicy), ...confirm }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; governance?: Governance; entry?: GovHistoryEntry | null };
      if (!res.ok || !j.ok || !j.governance) {
        // rule 2001: a plain failure is a toast; a typed refusal (busy, cap, confirm) stays inline, the owner acts on it.
        const said = refusal(j.error, g.saveFailed);
        if (said === g.saveFailed) toast.danger(said); else setErr(said);
        return;
      }
      applySaved({ governance: j.governance, entry: j.entry });
      setAutoConfirmed(false);
      toast.success(g.saved);
    } catch {
      toast.danger(g.saveFailed);
    } finally {
      setBusy(false);
    }
  }
  /**
   * Puts every setting back as it was before revision `id`, after the owner confirms. The server records it as a new
   * change. A restore that would switch Majed's auto-run back on is refused until the owner confirms that too, in the
   * same words as the switch; then it is sent once more with the confirmation.
   */
  async function restore(id: string) {
    setErr(""); setHistErr("");
    if (!(await ask({ title: g.history, message: g.restoreConfirm, confirmLabel: g.restore, cancelLabel: t.dialog.back, destructive: true }))) return;
    setRestoring(id);
    try {
      const send = (confirmAutoHandoff: boolean) => fetch("/api/governance/rollback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(confirmAutoHandoff ? { id, confirmAutoHandoff } : { id }) });
      type Reply = { ok?: boolean; error?: string; governance?: Governance; entry?: GovHistoryEntry | null };
      let res = await send(false);
      let j = (await res.json().catch(() => ({}))) as Reply;
      if (j.error === "auto_handoff_confirm") {
        if (!(await askAutoHandoff())) return;
        res = await send(true);
        j = (await res.json().catch(() => ({}))) as Reply;
      }
      // not_found: the change has left the history (dropped past the cap, maybe by a save in another tab); retrying cannot help.
      if (!res.ok || !j.ok || !j.governance) {
        const said = j.error === "not_found" ? g.restoreGone : refusal(j.error, g.restoreFailed);
        if (said === g.restoreFailed || said === g.restoreGone) toast.danger(said); else setHistErr(said);
        return;
      }
      applySaved({ governance: j.governance, entry: j.entry });
      toast.success(j.entry ? g.restored : g.restoreNoop);
    } catch {
      toast.danger(g.restoreFailed);
    } finally {
      setRestoring(null);
    }
  }
  /**
   * Decline one queued item through the same route as the chat card's Decline. An item that already ran, was declined
   * or is gone is no longer waiting either way, so it leaves the list too.
   */
  async function declineQueued(q: AutoQueued) {
    setQueueErr("");
    const k = `${q.id}:${q.item}`;
    setDeclining(k);
    try {
      const r = await fetch(`/api/handoffs/${q.id}/decline`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ item: q.item }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      const settled = r.ok && j.ok;
      if (settled || ["done", "declined", "running", "not_found"].includes(j.error ?? "")) {
        setQueue((l) => l.filter((x) => `${x.id}:${x.item}` !== k));
        toast.success(settled ? g.autoQueueDeclined : g.autoQueueGone);
        return;
      }
      const H = t.handoff.errors;
      const said = r.status === 403 ? H.forbidden : j.error && Object.hasOwn(H, j.error) ? H[j.error as keyof typeof H] : H.failed;
      if (said === H.failed) toast.danger(said); else setQueueErr(said);
    } catch {
      toast.danger(t.handoff.errors.failed);
    } finally {
      setDeclining(null);
    }
  }
  const when = dateFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  const who = (b: By) => (b.kind === "member" ? `${g.byMember}${b.email ? ` · ${b.email}` : ""}` : b.kind === "founder" ? g.byFounder : b.kind === "token" ? g.byToken : b.kind === "system" ? g.bySystem : g.byOwner);
  /** One agent's mode for one capability, set in the page's state; `on` removes the stored value. */
  const setMode = (id: AgentId, cap: ToolCap, m: AuthorityMode) => setGov((cur) => {
    const row = { ...(cur.toolPolicy?.[id] ?? {}) };
    if (m === "on") delete row[cap]; else row[cap] = m;
    return { ...cur, toolPolicy: { ...(cur.toolPolicy ?? {}), [id]: row } };
  });
  const label = (path: string) => {
    const [head, sub, cap] = path.split(".", 3);
    if (head === "toolPolicy" && isAgentId(sub) && isToolCap(cap)) return `${g.authorityShort}: ${fill(g.authorityFor, { cap: g.caps[cap], name: t.agents[sub].name })}`;
    if (head === "autoApprove" && isTaskType(sub)) return `${g.autoApproveShort}: ${t.generate.types[sub].t}`;
    if (head === "agentCaps" && isAgentId(sub)) return `${g.capShort}: ${t.agents[sub].name}`;
    const top: Record<string, string> = { reviewer: g.reviewer, crossReview: g.crossReview, learning: g.learning, noEmDash: g.noEmDash, weeklyCap: g.weeklyCap, notifyMinutes: g.notify, majedAutoHandoff: g.autoHandoff };
    return Object.hasOwn(top, head) ? top[head] : path;
  };
  const value = (path: string, v: GovValue) => (v === null ? (path.startsWith("agentCaps.") ? g.noCap : "—") : typeof v === "boolean" ? (v ? g.on : g.off) : typeof v === "string" ? g.modes[v] : String(v));
  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="governancepanel-t1" />{g.title}</span></h1>
      <p className="mt-2 text-foreground-muted">{g.sub}</p>
      {readOnly && <ReadOnlyNote text={t.readOnly.owner} />}
      <fieldset disabled={readOnly} className="mt-6 grid min-w-0 gap-4">
        <div className="card">
          <h2 className="font-display font-medium">{g.autoApprove}</h2>
          <p className="mt-1 text-sm text-foreground-muted">{g.autoApproveSub}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(Object.keys(TASK_COST) as TaskType[]).map((k) => {
              const on = !!gov.autoApprove[k];
              return <button key={k} onClick={() => setGov({ ...gov, autoApprove: { ...gov.autoApprove, [k]: !on } })} className={`rounded-full border px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-60 ${on ? "border-border-strong bg-inverse text-inverse-muted" : "border-border"}`}>{t.generate.types[k].t}</button>;
            })}
          </div>
        </div>
        <Row title={g.reviewer} sub={g.reviewerSub}><Switch label={g.reviewer} checked={gov.reviewer} onChange={(v) => setGov({ ...gov, reviewer: v })} /></Row>
        {/* A record saved before the switch existed has no value: the server reads it as on, and so does the page. */}
        <Row title={g.crossReview} sub={g.crossReviewSub}><Switch label={g.crossReview} checked={gov.crossReview !== false} onChange={(v) => setGov({ ...gov, crossReview: v })} /></Row>
        <Row title={g.learning} sub={g.learningSub}><Switch label={g.learning} checked={gov.learning} onChange={(v) => setGov({ ...gov, learning: v })} /></Row>
        <Row title={g.noEmDash} sub={g.noEmDashSub}><Switch label={g.noEmDash} checked={gov.noEmDash} onChange={(v) => setGov({ ...gov, noEmDash: v })} /></Row>
        <Row title={g.weeklyCap} sub={g.weeklyCapSub}><input type="number" min={0} max={200} value={gov.weeklyCap} onChange={(e) => setGov({ ...gov, weeklyCap: Number(e.target.value) })} className="w-24 rounded border border-border px-2 py-1 text-sm" dir="ltr" /></Row>
        <Row title={g.notify} sub={g.notifySub}><input type="number" min={0} max={1440} value={gov.notifyMinutes} onChange={(e) => setGov({ ...gov, notifyMinutes: Number(e.target.value) })} className="w-24 rounded border border-border px-2 py-1 text-sm" dir="ltr" /></Row>
        <div className="card">
          <h2 className="font-display font-medium">{g.agentCaps}</h2>
          <p className="mt-1 text-sm text-foreground-muted">{g.agentCapsSub}</p>
          <ul className="mt-3 divide-y divide-foreground/10">
            {CAPPED.map((id) => {
              const used = spend[id] ?? 0;
              const cap = gov.agentCaps?.[id];
              // A cap of 0 stops every paid request, so it reads as reached.
              const ratio = cap === undefined ? 0 : cap === 0 ? 1 : used / cap;
              return (
                <li key={id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <div>
                    <p className="font-medium">{t.agents[id].name} <span className="text-sm font-normal text-foreground-muted">· {t.agents[id].role}</span></p>
                    <p className="mt-0.5 flex items-center gap-2 text-xs text-foreground-muted">
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
        {/* Rule 2335: what each agent may do from a conversation. A record saved before it existed reads as all allowed. */}
        <div className="card">
          <h2 className="font-display font-medium">{g.authority}</h2>
          <p className="mt-1 text-sm text-foreground-muted">{g.authoritySub}</p>
          <ul className="mt-3 divide-y divide-foreground/10">
            {AGENT_IDS.map((id) => (
              <li key={id} className="py-3">
                <p className="font-medium">{t.agents[id].name} <span className="text-sm font-normal text-foreground-muted">· {t.agents[id].role}</span></p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {TOOL_CAPS.map((cap) => (
                    <label key={cap} className="flex min-w-0 items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 text-foreground-muted">{g.caps[cap]}</span>
                      <select className="input w-40 shrink-0 py-1 text-sm" value={authorityOf(gov.toolPolicy, id, cap)} onChange={(e) => setMode(id, cap, e.target.value as AuthorityMode)} aria-label={fill(g.authorityFor, { cap: g.caps[cap], name: t.agents[id].name })}>
                        <option value="on">{g.modes.on}</option>
                        {ASKABLE.includes(cap) && <option value="ask">{g.modes.ask}</option>}
                        <option value="off">{g.modes.off}</option>
                      </select>
                    </label>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
        {/* After the caps it depends on. Off for a record saved before the switch existed. Turning it on asks first. */}
        <Row title={g.autoHandoff} sub={g.autoHandoffSub}><Switch label={g.autoHandoff} checked={gov.majedAutoHandoff === true} onChange={toggleAuto} disabled={!!restoring} /></Row>
        {!readOnly && (
          <div className="flex items-center gap-3">
            <button onClick={save} disabled={busy || !!restoring} className="btn btn-primary btn-sm">{busy ? g.saving : g.save}</button>
            {err && <span role="alert" className="text-sm text-danger">{err}</span>}
          </div>
        )}
      </fieldset>
      {/* Outside the fieldset: declining is a draft decision (members may), not a settings change. */}
      {gov.majedAutoHandoff === true && queue.length > 0 && (
        <section className="card mt-4" aria-labelledby="gov-auto-queue">
          <h2 id="gov-auto-queue" className="font-display font-medium">{g.autoQueue}</h2>
          <p className="mt-1 text-sm text-foreground-muted">{g.autoQueueSub}</p>
          {queueErr && <p role="alert" className="mt-2 text-sm text-danger">{queueErr}</p>}
          <ul className="mt-3 divide-y divide-foreground/10">
            {queue.map((q) => {
              const k = `${q.id}:${q.item}`;
              return (
                <li key={k} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{fill(t.handoff.to, { agent: t.agents[q.agent].name, type: t.generate.types[q.type].t })}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-foreground-muted">
                      <span className="tnum">{fill(t.handoff.cost, { n: q.cost })}</span>
                      <time id={`gov-q-${k}`} dateTime={q.createdAt} suppressHydrationWarning>{when.format(new Date(q.createdAt))} UTC</time>
                      <Link href={`/${lang}/app/chat${q.conv ? `?conv=${q.conv}` : ""}`} className="underline">{g.autoQueueOpen}</Link>
                    </p>
                  </div>
                  {canDecline && <button type="button" onClick={() => declineQueued(q)} disabled={declining !== null} aria-describedby={`gov-q-${k}`} className="btn btn-secondary btn-xs">{declining === k ? g.autoQueueDeclining : t.handoff.decline}</button>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {/* Outside the fieldset: every role reads the history; only the owner gets Restore (the server checks it too). */}
      <section className="card mt-4" aria-labelledby="gov-history">
        <h2 id="gov-history" className="font-display font-medium">{g.history}</h2>
        <p className="mt-1 text-sm text-foreground-muted">{g.historySub}</p>
        {histErr && <p role="alert" className="mt-2 text-sm text-danger">{histErr}</p>}
        {history.length === 0 ? (
          // rule 2002
          <EmptyState compact className="mt-3" title={g.historyEmpty} />
        ) : (
          <ul className="mt-3 divide-y divide-foreground/10">
            {history.map((r) => (
              <li key={r.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm">
                    <time id={`gov-rev-${r.id}`} dateTime={r.at} suppressHydrationWarning>{when.format(new Date(r.at))} UTC</time>
                    <span className="text-foreground-muted"> · </span>
                    <span dir="auto">{who(r.by)}</span>
                    {r.rollbackOf && <span className="ms-2 badge">{g.restoreOf}</span>}
                  </p>
                  {!readOnly && <button type="button" onClick={() => restore(r.id)} disabled={busy || !!restoring} aria-describedby={`gov-rev-${r.id}`} className="btn btn-secondary btn-xs">{restoring === r.id ? g.restoring : g.restore}</button>}
                </div>
                <ul className="mt-1 grid gap-0.5 text-xs text-foreground-muted">
                  {r.changes.map((c) => (
                    <li key={c.path}>
                      <span dir="auto">{label(c.path)}</span>: <bdi>{value(c.path, c.before)}</bdi> {g.arrow} <bdi className="font-medium text-foreground">{value(c.path, c.after)}</bdi>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
      {/* Outside the fieldset too: a disabled fieldset would disable the dialog's buttons with it. */}
      {confirmDialog}
    </div>
  );
}
