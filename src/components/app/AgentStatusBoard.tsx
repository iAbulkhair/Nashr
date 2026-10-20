import AgentAvatar from "@/components/app/AgentAvatar";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import { Time } from "@/components/ui/Time";
import { agentById } from "@/lib/agents";
import type { ActivityKind } from "@/lib/activity";
import { STATUS_COPY, type AgentState, type AgentStatus } from "@/lib/agent-status";
import type { Lang } from "@/lib/i18n";

/** The words carry the state; the tone only backs them up (rule 1086). */
const TONE: Record<AgentState, BadgeTone> = { working: "info", waiting: "warning", done: "success", stuck: "danger" };

/**
 * Each agent's state on the app's home (rules 2553-2554): a badge in the page's language, how many of its drafts wait,
 * and a folded short log of how it got there (kind and time only, never a row's free text). No hooks, so the page
 * renders it on the server.
 */
export default function AgentStatusBoard({ lang, statuses, kinds, children }: { lang: Lang; statuses: AgentStatus[]; kinds: Record<ActivityKind, string>; children?: React.ReactNode }) {
  const c = STATUS_COPY[lang];
  return (
    <section aria-labelledby="agent-status-title" className="mb-5 rounded-xl border-[1.5px] border-border-strong bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="agent-status-title" className="font-display text-base font-bold">{c.title}</h2>
        {children}
      </div>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {statuses.map((s) => {
          const a = agentById(s.agent);
          return (
            <li key={s.agent} data-agent={s.agent} data-state={s.state ?? "quiet"} className="rounded-lg border border-border px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <AgentAvatar id={s.agent} name={a.name[lang]} className="h-7 w-7 text-xs" />
                <span className="min-w-0 flex-1 truncate font-semibold">{a.name[lang]}</span>
                {s.state ? <Badge tone={TONE[s.state]}>{c.state[s.state]}</Badge> : <span className="text-foreground-muted">{c.quiet}</span>}
              </div>
              {s.waiting > 0 && <p className="mt-1 text-foreground-muted">{c.drafts(s.waiting)}</p>}
              {s.log.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-foreground-muted">{c.how}</summary>
                  <ol className="mt-1 space-y-0.5">
                    {s.log.map((r, i) => (
                      <li key={`${r.at}-${i}`} className="flex justify-between gap-2">
                        <span>{kinds[r.kind] ?? r.kind}</span>
                        <Time value={r.at} lang={lang} style="datetime" className="shrink-0 text-foreground-muted tnum" />
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
