"use client";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Task } from "@/lib/brand";

export default function CalendarPanel({ t, tasks }: { t: AppDict; tasks: Task[] }) {
  const c = t.calendar;
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [sel, setSel] = useState<string>(now.toISOString().slice(0, 10));
  const first = new Date(Date.UTC(ym.y, ym.m, 1));
  const daysIn = new Date(Date.UTC(ym.y, ym.m + 1, 0)).getUTCDate();
  const startDow = first.getUTCDay();
  const key = (d: number) => `${ym.y}-${String(ym.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const approved = tasks.filter((x) => x.status === "approved");
  const byDay = new Map<string, Task[]>();
  for (const x of approved) {
    const d = x.scheduledFor ?? x.createdAt.slice(0, 10);
    byDay.set(d, [...(byDay.get(d) ?? []), x]);
  }
  const unscheduled = approved.filter((x) => !x.scheduledFor);
  const selected = byDay.get(sel) ?? [];
  const monthName = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(first);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="font-display text-3xl font-bold text-oasis">{c.title}</h1><p className="mt-1 text-ink/70">{c.sub}</p></div>
        <div className="flex items-center gap-2 text-sm">
          <button onClick={() => setYm(ym.m === 0 ? { y: ym.y - 1, m: 11 } : { y: ym.y, m: ym.m - 1 })} className="rounded-full border border-ink/20 px-3 py-1">{c.prev}</button>
          <span className="font-display font-medium" dir="ltr">{monthName}</span>
          <button onClick={() => setYm(ym.m === 11 ? { y: ym.y + 1, m: 0 } : { y: ym.y, m: ym.m + 1 })} className="rounded-full border border-ink/20 px-3 py-1">{c.next}</button>
          <button onClick={() => { setYm({ y: now.getFullYear(), m: now.getMonth() }); setSel(now.toISOString().slice(0, 10)); }} className="rounded-full bg-oasis px-3 py-1 text-mist">{c.today}</button>
        </div>
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="rounded-xl border border-ink/10 bg-white p-3" dir="ltr">
          <div className="grid grid-cols-7 text-center text-xs text-ink/50">{c.days.map((d) => <div key={d} className="py-1">{d}</div>)}</div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: startDow }).map((_, i) => <div key={"e" + i} />)}
            {Array.from({ length: daysIn }, (_, i) => i + 1).map((d) => {
              const k = key(d);
              const n = byDay.get(k)?.length ?? 0;
              const isSel = k === sel;
              const isToday = k === now.toISOString().slice(0, 10);
              return (
                <button key={k} onClick={() => setSel(k)} className={`flex aspect-square flex-col items-center justify-center rounded-lg border text-sm ${isSel ? "border-oasis bg-oasis text-mist" : isToday ? "border-saffron" : "border-ink/5 hover:bg-salt-dim"}`}>
                  <span>{d}</span>
                  {n > 0 && <span className={`mt-0.5 rounded-full px-1.5 text-[10px] ${isSel ? "bg-saffron text-ink" : "bg-oasis/10 text-oasis"}`}>{n}</span>}
                </button>
              );
            })}
          </div>
        </div>
        <aside className="rounded-xl border border-ink/10 bg-white p-4">
          <h2 className="font-mono text-sm text-oasis" dir="ltr">{sel}</h2>
          {selected.length === 0 ? <p className="mt-2 text-sm text-ink/60">{c.none}</p> : (
            <ul className="mt-2 grid gap-2">{selected.map((x) => <li key={x.id} className="rounded border border-ink/10 p-2 text-xs"><span className="text-oasis">{x.channel}</span> · {x.title}<p className="mt-1 line-clamp-3 whitespace-pre-wrap text-ink/70" dir="auto">{(x.editedBody ?? x.body).slice(0, 160)}</p></li>)}</ul>
          )}
          {unscheduled.length > 0 && <p className="mt-4 text-xs text-ink/50">{c.unscheduled}: {unscheduled.length}</p>}
        </aside>
      </div>
    </div>
  );
}
