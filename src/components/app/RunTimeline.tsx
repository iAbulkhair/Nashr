import Badge, { type BadgeTone } from "@/components/ui/Badge";
import type { AppDict } from "@/lib/app-i18n";
import type { WorkStep } from "@/lib/work-view";

const TONE: Record<WorkStep["state"], BadgeTone> = { ok: "success", refused: "warning", error: "danger" };
const fill = (s: string, v: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

/** A step's words: the kind and what it named, from the dictionary; a tool or provider name is shown as stored. */
export function stepLabel(t: AppDict, s: WorkStep): string {
  const w = t.work;
  if (s.kind === "model") return w.model;
  if (s.kind === "tool") return fill(w.tool, { name: s.name });
  if (s.kind === "publish") return fill(w.publish, { name: s.name });
  return fill(w.check, { n: s.score ?? 0 }) + (s.rewritten ? " · " + w.rewritten : "");
}

/**
 * One run's steps in order (Thakeen v2 C9, rule 4778): the agent, what the step was, its state and its tokens. The words
 * carry the state; the tone only backs them up. No hooks, so a server page renders it and the chat renders it live.
 */
export default function RunTimeline({ steps, t }: { steps: WorkStep[]; t: AppDict }) {
  if (!steps.length) return <p className="text-xs text-foreground-muted">{t.work.empty}</p>;
  return (
    <ol className="space-y-1 text-xs" data-run-timeline>
      {steps.map((s, i) => (
        <li key={`${s.at}-${i}`} data-step={s.kind} data-state={s.state} className="flex flex-wrap items-center gap-2">
          {s.agent && <span className="font-semibold">{t.agents[s.agent].name}</span>}
          <span className="min-w-0 flex-1 truncate">{stepLabel(t, s)}</span>
          {s.tokens !== undefined && (
            <span className="tnum text-foreground-muted">{fill(t.work.tokens, { n: s.tokens })}</span>
          )}
          <Badge tone={TONE[s.state]}>{t.work.state[s.state]}</Badge>
        </li>
      ))}
    </ol>
  );
}
