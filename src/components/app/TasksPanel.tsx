"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Schedule } from "@/lib/schedule";

type Which = "weekly" | "daily" | "followups";
type ScheduleKey = "weeklyPlan" | "dailyBrief" | "followUps";

/** Declared at module scope so React keeps one component identity across renders. */
function Card({ k, busy, title, desc, on, last, which, onToggle, onRun }: { k: AppDict["tasks"]; busy: string; title: string; desc: string; on: boolean; last?: string; which: Which; onToggle: (key: ScheduleKey) => void; onRun: (which: "weekly" | "daily") => void }) {
  return (
      <div className="card">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-lg font-medium">{title}</h2>
            <p className="mt-1 text-sm text-ink/60">{desc}</p>
            <p className="mt-2 font-mono text-xs text-ink/50" dir="ltr">{k.lastRun}: {last ? last.slice(0, 16).replace("T", " ") : k.never}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <button onClick={() => onToggle(which === "weekly" ? "weeklyPlan" : which === "daily" ? "dailyBrief" : "followUps")} className={`rounded-full px-3 py-1 text-xs font-semibold ${on ? "bg-oasis text-mist" : "bg-ink/10 text-ink/60"}`}>{on ? k.on : k.off}</button>
            {which !== "followups" && <button disabled={!!busy} onClick={() => onRun(which)} className="btn btn-secondary btn-xs disabled:opacity-50">{busy === which ? "…" : k.runNow}</button>}
          </div>
        </div>
      </div>
  );
}

export default function TasksPanel({ t, initial }: { t: AppDict; initial: Schedule }) {
  const r = useRouter();
  const k = t.tasks;
  const [s, setS] = useState(initial);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  async function toggle(key: "weeklyPlan" | "dailyBrief" | "followUps") {
    const res = await fetch("/api/schedule", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [key]: !s[key] }) });
    const j = await res.json();
    if (j.ok) setS(j.schedule);
  }
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
      setMsg(ran ? `${k.ran}: ${outcome}` : `${t.generate.failed} (${outcome})`);
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
      <div className="mt-6 grid gap-4">
        <Card title={k.weekly} desc={k.weeklyDesc} on={s.weeklyPlan} last={s.lastWeekly} which="weekly" k={k} busy={busy} onToggle={toggle} onRun={run} />
        <Card title={k.daily} desc={k.dailyDesc} on={s.dailyBrief} last={s.lastDaily} which="daily" k={k} busy={busy} onToggle={toggle} onRun={run} />
        <Card title={k.followups} desc={k.followupsDesc} on={s.followUps !== false} which="followups" k={k} busy={busy} onToggle={toggle} onRun={run} />
      </div>
      <p className="mt-3 text-xs text-ink/50">{k.capNote}</p>
      {msg && <p role="status" className="mt-4 rounded-lg bg-salt-dim p-3 text-sm text-oasis">{msg}</p>}
    </div>
  );
}
