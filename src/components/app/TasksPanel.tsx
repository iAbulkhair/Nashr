"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Schedule } from "@/lib/schedule";
import type { RoutineId, RoutineView } from "@/lib/routines";
import { TASK_COST } from "@/lib/tasks";
import ReadOnlyNote from "./ReadOnlyNote";

type Which = "weekly" | "daily" | "followups";
type ScheduleKey = "weeklyPlan" | "dailyBrief" | "followUps";

/** Declared at module scope so React keeps one component identity across renders. */
function Card({ k, busy, title, desc, on, last, which, onToggle, onRun, readOnly }: { k: AppDict["tasks"]; busy: string; title: string; desc: string; on: boolean; last?: string; which: Which; onToggle: (key: ScheduleKey) => void; onRun: (which: "weekly" | "daily") => void; readOnly: boolean }) {
  return (
      <div className="card">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-lg font-medium">{title}</h2>
            <p className="mt-1 text-sm text-ink/60">{desc}</p>
            <p className="mt-2 font-mono text-xs text-ink/50" dir="ltr">{k.lastRun}: {last ? last.slice(0, 16).replace("T", " ") : k.never}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <button onClick={() => onToggle(which === "weekly" ? "weeklyPlan" : which === "daily" ? "dailyBrief" : "followUps")} disabled={readOnly} aria-pressed={on} className={`rounded-full px-3 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${on ? "bg-oasis text-mist" : "bg-ink/10 text-ink/60"}`}>{on ? k.on : k.off}</button>
            {which !== "followups" && <button disabled={!!busy} onClick={() => onRun(which)} className="btn btn-secondary btn-xs disabled:opacity-50">{busy === which ? "…" : k.runNow}</button>}
          </div>
        </div>
      </div>
  );
}

/** One routine: who, what it produces, how often, what a run costs, when it skips, and its switch. */
function RoutineRow({ t, r, on, saving, onToggle, readOnly }: { t: AppDict; r: RoutineView; on: boolean; saving: boolean; onToggle: (id: RoutineId, on: boolean) => void; readOnly: boolean }) {
  const k = t.tasks;
  const what = t.generate.types[r.type];
  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="font-medium">{t.agents[r.agent].name} <span className="text-sm font-normal text-ink/60">· {what.t}</span></p>
        <p className="mt-1 text-sm text-ink/60">{what.d}</p>
        <p className="mt-1 text-xs text-ink/60">{r.cadence === "weekly" ? k.routineWeekly : k.routineMonthly} · {k.routineCost.replace("{n}", String(TASK_COST[r.type]))}</p>
        <p className="mt-1 text-xs text-ink/60">{k.routineWhen[r.id]}</p>
        <p className="mt-1 font-mono text-xs text-ink/50" dir="ltr">{k.lastRun}: {r.last ? r.last.slice(0, 16).replace("T", " ") : k.never}</p>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={`${t.agents[r.agent].name}: ${what.t}`} disabled={saving || readOnly} onClick={() => onToggle(r.id, !on)} className={`relative mt-1 h-6 w-11 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${on ? "bg-oasis" : "bg-ink/20"}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${on ? "start-[22px]" : "start-0.5"}`} />
      </button>
    </li>
  );
}

/**
 * `routines` and their last runs are rendered on the server, so the page makes no request on mount.
 * `readOnly` (plain members): the switches are disabled with a note; "Run now" stays, it is an explicit request.
 */
export default function TasksPanel({ t, initial, routines, readOnly = false }: { t: AppDict; initial: Schedule; routines: RoutineView[]; readOnly?: boolean }) {
  const r = useRouter();
  const k = t.tasks;
  const [s, setS] = useState(initial);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [saving, setSaving] = useState("");
  /** Saves one switch and shows what the server stored; a failure says so instead of passing silently. */
  async function put(patch: Partial<Schedule>, key: string) {
    setSaving(key); setErr("");
    try {
      const res = await fetch("/api/schedule", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; schedule?: Schedule };
      if (!res.ok || !j.ok || !j.schedule) { setErr(k.saveFailed); return; }
      setS(j.schedule);
    } catch {
      setErr(k.saveFailed);
    } finally {
      setSaving("");
    }
  }
  const toggle = (key: ScheduleKey) => put({ [key]: !s[key] }, key);
  const toggleRoutine = (id: RoutineId, on: boolean) => put({ routines: { [id]: on } }, id);
  async function run(which: "weekly" | "daily") {
    setBusy(which);
    try {
      const res = await fetch("/api/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run: which }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: string; brief?: { text: string } };
      if (!res.ok || !j.ok) { setMsg(t.generate.failed); return; }
      // `runWeekly` answers "ok:N" when it really produced items and a reason otherwise — "no_credits", "trial_over",
      // "cap_reached", "already_this_week". Prefixing all of them with "Ran:" told the owner their plan had been
      // generated when nothing had happened and no credits had moved.
      const outcome = which === "weekly" ? (j.result ?? "") : j.brief ? j.brief.text.split("\n")[1] : "off";
      const ran = which === "weekly" ? outcome.startsWith("ok:") : !!j.brief;
      setMsg(ran ? `${k.ran}: ${outcome}` : outcome === "retry:paused" ? t.generate.paused : outcome === "agent_cap" ? t.limit.agentCapTitle : `${t.generate.failed} (${outcome})`);
    } catch {
      setMsg(t.generate.failed);
    } finally {
      setBusy("");
      r.refresh();
    }
  }
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="page-title">{k.title}</h1>
      <p className="mt-2 text-ink/70">{k.sub}</p>
      {readOnly && <ReadOnlyNote text={t.readOnly.admin} />}
      <div className="mt-6 grid gap-4">
        <Card title={k.weekly} desc={k.weeklyDesc} on={s.weeklyPlan} last={s.lastWeekly} which="weekly" k={k} busy={busy} onToggle={toggle} onRun={run} readOnly={readOnly} />
        <Card title={k.daily} desc={k.dailyDesc} on={s.dailyBrief} last={s.lastDaily} which="daily" k={k} busy={busy} onToggle={toggle} onRun={run} readOnly={readOnly} />
        <Card title={k.followups} desc={k.followupsDesc} on={s.followUps !== false} which="followups" k={k} busy={busy} onToggle={toggle} onRun={run} readOnly={readOnly} />
        {/* After the three cards: the e2e suite clicks the first "Run now", and routines have none. */}
        <div className="card">
          <h2 className="font-display text-lg font-medium">{k.routines}</h2>
          <p className="mt-1 text-sm text-ink/60">{k.routinesSub}</p>
          <ul className="mt-3 divide-y divide-ink/10">
            {routines.map((x) => <RoutineRow key={x.id} t={t} r={x} on={s.routines?.[x.id] === true} saving={!!saving} onToggle={toggleRoutine} readOnly={readOnly} />)}
          </ul>
        </div>
      </div>
      <p className="mt-3 text-xs text-ink/50">{k.capNote}</p>
      {err && <p role="alert" className="mt-4 text-sm text-sadu-deep">{err}</p>}
      {msg && <p role="status" className="mt-4 rounded-lg bg-salt-dim p-3 text-sm text-oasis">{msg}</p>}
    </div>
  );
}
