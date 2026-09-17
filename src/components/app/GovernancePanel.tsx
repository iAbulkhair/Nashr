"use client";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Governance } from "@/lib/governance";
import { TASK_COST, type TaskType } from "@/lib/brand";

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-oasis" : "bg-ink/20"}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${on ? "start-[22px]" : "start-0.5"}`} />
    </button>
  );
}

export default function GovernancePanel({ t, initial }: { t: AppDict; initial: Governance }) {
  const g = t.governance;
  const [gov, setGov] = useState<Governance>(initial);
  const [msg, setMsg] = useState("");
  async function save() {
    const res = await fetch("/api/governance", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(gov) });
    if (res.ok) setMsg(g.saved);
  }
  const Row = ({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) => (
    <div className="flex items-start justify-between gap-6 card">
      <div><h2 className="font-display font-medium">{title}</h2><p className="mt-1 text-sm text-ink/60">{sub}</p></div>
      <div className="shrink-0">{children}</div>
    </div>
  );
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
        <div className="flex items-center gap-3">
          <button onClick={save} className="btn btn-primary">{g.save}</button>
          {msg && <span role="status" className="text-sm text-oasis">{msg}</span>}
        </div>
      </div>
    </div>
  );
}
