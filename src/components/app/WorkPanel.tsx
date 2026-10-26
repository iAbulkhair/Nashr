"use client";
import { useState } from "react";
import Badge from "@/components/ui/Badge";
import { Time } from "@/components/ui/Time";
import type { AppDict } from "@/lib/app-i18n";
import type { ContextMeter } from "@/lib/context-meter";
import type { Lang } from "@/lib/i18n";
import type { WorkRun } from "@/lib/work-view";
import RunTimeline from "./RunTimeline";

type View = { runs: WorkRun[]; meters: ContextMeter[] };
const fill = (s: string, v: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

/**
 * The work view panel (Thakeen v2 C9 + C13, rules 4778-4779): each agent's context meter, then the newest runs, each
 * folded with its steps. On the home page the server passes `initial` (read with the page, beside the inbox); in a chat
 * thread it reads GET /api/runs?conv= the first time the person opens it. The page mounts it only while RUN_LOG is on.
 */
export default function WorkPanel({
  t,
  lang,
  conv,
  initial,
}: {
  t: AppDict;
  lang: Lang;
  conv?: string;
  initial?: View;
}) {
  const [view, setView] = useState<View | null>(initial ?? null);
  const [state, setState] = useState<"idle" | "busy" | "fail">("idle");
  const w = t.work;
  const load = () => {
    if (view || state === "busy") return;
    setState("busy");
    void fetch("/api/runs" + (conv ? "?conv=" + encodeURIComponent(conv) : ""))
      .then((r) => r.json())
      .then((j: { ok?: boolean } & Partial<View>) => {
        if (!j.ok) return setState("fail");
        setView({ runs: j.runs ?? [], meters: j.meters ?? [] });
        setState("idle");
      })
      .catch(() => setState("fail"));
  };
  return (
    <details
      open={!!initial}
      onToggle={(e) => (e.currentTarget.open ? load() : undefined)}
      className="mb-5 rounded-xl border-[1.5px] border-border-strong bg-surface px-4 py-3"
      data-work-panel
    >
      <summary className="cursor-pointer font-display text-base font-bold">{initial ? w.title : w.open}</summary>
      {state === "busy" && <p className="mt-2 text-xs text-foreground-muted">{w.loading}</p>}
      {state === "fail" && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {w.failed}
        </p>
      )}
      {view && (
        <div className="mt-3 space-y-3">
          {view.meters.length > 0 && (
            <section aria-label={w.meter} className="space-y-1 text-xs" data-meters>
              <h3 className="font-semibold">{w.meter}</h3>
              {view.meters.map((m) => {
                const pct = Math.round(m.pct * 100);
                return (
                  <div key={m.agent} data-meter={m.agent} data-hot={m.hot || undefined}>
                    <span>{fill(w.meterRow, { name: t.agents[m.agent].name, pct })}</span>
                    <div
                      className="mt-0.5 h-1.5 rounded-full bg-foreground/10"
                      role="meter"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={pct}
                      aria-label={t.agents[m.agent].name}
                    >
                      <div
                        className={`h-1.5 rounded-full ${m.hot ? "bg-danger" : "bg-foreground/50"}`}
                        style={{ width: pct + "%" }}
                      />
                    </div>
                    {m.hot && <p className="mt-0.5 text-foreground-muted">{w.meterHot}</p>}
                  </div>
                );
              })}
            </section>
          )}
          {view.runs.length === 0 ? (
            <p className="text-xs text-foreground-muted">{w.empty}</p>
          ) : (
            <ul className="space-y-2">
              {view.runs.map((r) => (
                <li key={r.id} data-run={r.kind} className="rounded-lg border border-border px-3 py-2">
                  <details>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                      <span className="font-semibold">{w.kind[r.kind]}</span>
                      {r.agent && <span>{t.agents[r.agent].name}</span>}
                      <Time value={r.startedAt} lang={lang} style="datetime" className="tnum text-foreground-muted" />
                      <span className="tnum text-foreground-muted">{fill(w.ms, { n: Math.round(r.ms / 1000) })}</span>
                      {r.credits > 0 && <span className="tnum text-foreground-muted">{fill(w.charge, { n: r.credits })}</span>}
                      <Badge tone={r.ok ? "success" : "danger"}>{w.state[r.ok ? "ok" : "error"]}</Badge>
                    </summary>
                    <div className="mt-2">
                      <RunTimeline steps={r.steps} t={t} />
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </details>
  );
}
