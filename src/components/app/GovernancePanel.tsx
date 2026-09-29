"use client";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Governance } from "@/lib/governance";
import { AGENT_IDS, type AgentId } from "@/lib/agents";
import { TASK_COST, type TaskType } from "@/lib/tasks";

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-oasis" : "bg-ink/20"}`}>
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

/** The cap fields as typed: "" is no cap, so clearing a field removes the cap instead of setting it to 0. */
const capText = (g: Governance) => Object.fromEntries(AGENT_IDS.map((id) => [id, g.agentCaps?.[id] === undefined ? "" : String(g.agentCaps[id])])) as Record<AgentId, string>;
/**
 * Empty or a whole number; the server clamps it to its own range and the page then shows what was stored. The fields
 * are text with a numeric keyboard, not type=number: a number field reports "" for text it cannot parse ("50e"), which
 * read as "no cap" and removed the owner's cap on save.
 */
const validCap = (v: string) => v.trim() === "" || /^\d+$/.test(v.trim());

/**
 * `spend` is this brand scope's credits per agent this month, rendered on the server from the User record, so the page
 * makes no request on mount.
 */
export default function GovernancePanel({ t, initial, spend }: { t: AppDict; initial: Governance; spend: Partial<Record<AgentId, number>> }) {
  const g = t.governance;
  const [gov, setGov] = useState<Governance>(initial);
  const [caps, setCaps] = useState<Record<AgentId, string>>(() => capText(initial));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  async function save() {
    setMsg(""); setErr("");
    // Nothing is sent while a cap is not a whole number: dropping the field and saying "Saved" hid the mistake.
    if (AGENT_IDS.some((id) => !validCap(caps[id]))) { setErr(g.capInvalid); return; }
    setBusy(true);
    try {
      // Empty sends null, which removes the cap.
      const agentCaps: Partial<Record<AgentId, number | null>> = {};
      for (const id of AGENT_IDS) agentCaps[id] = caps[id].trim() === "" ? null : Number(caps[id].trim());
      const res = await fetch("/api/governance", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...gov, agentCaps }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; governance?: Governance };
      if (!res.ok || !j.ok || !j.governance) { setErr(g.saveFailed); return; }
      // What the server stored, after its own checks, is what the page shows.
      setGov(j.governance);
      setCaps(capText(j.governance));
      setMsg(g.saved);
    } catch {
      setErr(g.saveFailed);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="page-title">{g.title}</h1>
      <p className="mt-2 text-ink/70">{g.sub}</p>
      <div className="mt-6 grid gap-4">
        <div className="card">
          <h2 className="font-display font-medium">{g.autoApprove}</h2>
          <p className="mt-1 text-sm text-ink/60">{g.autoApproveSub}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(Object.keys(TASK_COST) as TaskType[]).map((k) => {
              const on = !!gov.autoApprove[k];
              return <button key={k} onClick={() => setGov({ ...gov, autoApprove: { ...gov.autoApprove, [k]: !on } })} className={`rounded-full border px-3 py-1 text-sm ${on ? "border-oasis bg-oasis text-mist" : "border-ink/20"}`}>{t.generate.types[k].t}</button>;
            })}
          </div>
        </div>
        <Row title={g.reviewer} sub={g.reviewerSub}><Toggle on={gov.reviewer} onChange={(v) => setGov({ ...gov, reviewer: v })} /></Row>
        <Row title={g.learning} sub={g.learningSub}><Toggle on={gov.learning} onChange={(v) => setGov({ ...gov, learning: v })} /></Row>
        <Row title={g.noEmDash} sub={g.noEmDashSub}><Toggle on={gov.noEmDash} onChange={(v) => setGov({ ...gov, noEmDash: v })} /></Row>
        <Row title={g.weeklyCap} sub={g.weeklyCapSub}><input type="number" min={0} max={200} value={gov.weeklyCap} onChange={(e) => setGov({ ...gov, weeklyCap: Number(e.target.value) })} className="w-24 rounded border border-ink/15 px-2 py-1 text-sm" dir="ltr" /></Row>
        <Row title={g.notify} sub={g.notifySub}><input type="number" min={0} max={1440} value={gov.notifyMinutes} onChange={(e) => setGov({ ...gov, notifyMinutes: Number(e.target.value) })} className="w-24 rounded border border-ink/15 px-2 py-1 text-sm" dir="ltr" /></Row>
        <div className="card">
          <h2 className="font-display font-medium">{g.agentCaps}</h2>
          <p className="mt-1 text-sm text-ink/60">{g.agentCapsSub}</p>
          <ul className="mt-3 divide-y divide-ink/10">
            {AGENT_IDS.map((id) => {
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
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={busy} className="btn btn-primary btn-sm">{busy ? g.saving : g.save}</button>
          {msg && <span role="status" className="text-sm text-oasis">{msg}</span>}
          {err && <span role="alert" className="text-sm text-sadu-deep">{err}</span>}
        </div>
      </div>
    </div>
  );
}
