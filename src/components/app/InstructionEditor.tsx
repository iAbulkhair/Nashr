"use client";
import type { AppDict } from "@/lib/app-i18n";
import { isAgentId } from "@/lib/agents";
import type { Draft, Target } from "@/lib/instructions-store";
import { MAX_REFS, WORKSPACE_ITEMS } from "@/lib/instructions-safety";
import { agentsControl, fill, showRefs } from "@/lib/instructions-ui";

/** The row-level reason a save was refused, by the row's position in the list. */
export type RowErrors = Record<number, string>;

/** A switch that names what it turns on (the same shape as the Governance page's). */
function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-60 ${on ? "bg-ink" : "bg-ink/20"}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${on ? "start-[22px]" : "start-0.5"}`} />
    </button>
  );
}

/** The name an owner reads for a target: an agent's own name, or the fixed label of a group. */
export const targetLabel = (t: AppDict, target: Target): string => (isAgentId(target) ? t.agents[target].name : t.instructions.targets[target]);

/**
 * The rows of one instruction set, shared by the customer page and the founder's console (Task 11): the same row, the
 * same limits, different `targets`, `maxChars` and `allowLock`. It holds no state of its own and makes no request: the
 * page that owns the rows saves them, so `onChange` is the only thing it calls.
 *
 * - `items`: the rows as the form sends them (`Draft`); a row without an `id` is new.
 * - `maxChars`: the length of one text (600 for a workspace, 2000 for the platform); the counter and `maxLength`.
 * - `targets`: what a row can be pointed at (the eight agents and `media` for a customer; the founder adds `reviewer` and `judge`).
 * - `perAgent`: whether the plan applies named targets. Below it only "All agents" can be chosen: a row that already names agents keeps its control so it can be set to All agents (the fix `per_agent_plan` asks for).
 * - `refsOn` / `files`: whether the plan applies reference files, and the workspace file names a row may attach (up to `MAX_REFS`). A name that is no longer a file is flagged. Without `refsOn` an attached file still shows with its remove button (the fix `refs_plan` asks for), and nothing can be added.
 * - `allowLock`: the platform's "customers cannot override" flag; never offered to a customer.
 * - `errors`: the reason a save refused a row, shown under it. `refTitles`: the imported file's title by its file name.
 *
 * Every text is rendered as a value of a form field or as plain React text: an instruction or an imported title never becomes HTML.
 */
export default function InstructionEditor({ t, items, onChange, maxChars, targets, perAgent, refsOn, files, allowLock, readOnly, errors = {}, refTitles = {}, maxItems = WORKSPACE_ITEMS }: { t: AppDict; items: Draft[]; onChange: (items: Draft[]) => void; maxChars: number; targets: Target[]; perAgent: boolean; refsOn: boolean; files: string[]; allowLock: boolean; readOnly: boolean; errors?: RowErrors; refTitles?: Record<string, string>; maxItems?: number }) {
  const I = t.instructions;
  const set = (i: number, patch: Partial<Draft>) => onChange(items.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const drop = (i: number) => onChange(items.filter((_, j) => j !== i));
  /** Picking "Chosen agents" starts with the first target on, because a row needs at least one. */
  const chooseAgents = (i: number, some: boolean) => set(i, { agents: some ? [targets[0]] : "all" });
  const flip = (i: number, d: Draft, target: Target) => {
    const cur = d.agents === "all" ? [] : d.agents;
    const next = cur.includes(target) ? cur.filter((x) => x !== target) : [...cur, target];
    // Never leave a row with no target: the last chip stays on.
    if (next.length) set(i, { agents: next });
  };
  return (
    <div>
      {items.length === 0 && <p className="text-sm text-muted">{I.empty}</p>}
      <ol className="grid gap-3">
        {items.map((d, i) => {
          const n = i + 1;
          const named = d.agents !== "all";
          const refs = d.refs ?? [];
          const free = files.filter((f) => !refs.includes(f));
          const err = errors[i];
          const ctl = agentsControl(perAgent, named, readOnly);
          return (
            <li key={d.id ?? `new-${i}`} className={`rounded-xl border-[1.5px] p-3 ${d.on ? "border-ink/30" : "border-ink/15 bg-ink/5"}`}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <label className="sr-only" htmlFor={`ins-text-${i}`}>{fill(I.rowText, { n })}</label>
                  <textarea id={`ins-text-${i}`} className="input" rows={3} dir="auto" maxLength={maxChars} value={d.text} placeholder={I.rowPlaceholder} disabled={readOnly} aria-invalid={!!err} aria-describedby={err ? `ins-err-${i}` : undefined} onChange={(e) => set(i, { text: e.target.value })} />
                  <p className="tnum mt-1 text-xs text-muted" dir="ltr">{fill(I.counter, { n: d.text.length, max: maxChars })}</p>
                </div>
                <Toggle on={d.on} onChange={(v) => set(i, { on: v })} label={fill(I.rowOn, { n })} disabled={readOnly} />
              </div>
              {err && <p id={`ins-err-${i}`} role="alert" className="mt-1 text-sm text-danger">{err}</p>}

              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">{I.agents}</span>
                <select aria-label={`${I.agents} · ${fill(I.rowText, { n })}`} value={named ? "some" : "all"} disabled={ctl.disabled} onChange={(e) => chooseAgents(i, e.target.value === "some")} className="rounded border border-ink/15 bg-white px-2 py-1 disabled:opacity-60">
                  <option value="all">{I.allAgents}</option>
                  <option value="some" disabled={ctl.someDisabled}>{I.chosenAgents}</option>
                </select>
                {!perAgent && !named && <span className="text-xs text-muted">{I.perAgentLocked}</span>}
                {allowLock && (
                  <label className="ms-auto flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={d.lock === true} disabled={readOnly} onChange={(e) => set(i, { lock: e.target.checked })} />
                    {I.locked}
                  </label>
                )}
              </div>
              {named && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {targets.map((target) => {
                    const on = (d.agents as Target[]).includes(target);
                    return (
                      <button key={target} type="button" aria-pressed={on} disabled={readOnly || !perAgent} onClick={() => flip(i, d, target)} className={`rounded-full border px-3 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-60 ${on ? "border-ink bg-ink text-lilac" : "border-ink/20"}`}>{targetLabel(t, target)}</button>
                    );
                  })}
                </div>
              )}
              {named && !perAgent && <p className="mt-1 text-xs text-muted">{I.perAgentIgnored}</p>}

              {showRefs(refsOn, refs.length) && (
                <div className="mt-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted">{I.refs}</span>
                    {refs.length === 0 && <span className="text-xs text-muted">{I.refsNone}</span>}
                    {refs.map((name) => (
                      <span key={name} className="inline-flex items-center gap-1 rounded-full border border-ink/20 px-2 py-0.5 text-xs">
                        <bdi title={name}>{refTitles[name] || name}</bdi>
                        {!files.includes(name) && <span className="badge badge-danger">{I.refsMissing}</span>}
                        {!readOnly && <button type="button" aria-label={fill(I.refsRemove, { name: refTitles[name] || name })} onClick={() => set(i, { refs: refs.filter((r) => r !== name) })} className="px-0.5 hover:text-danger">×</button>}
                      </span>
                    ))}
                    {!readOnly && refsOn && refs.length < MAX_REFS && free.length > 0 && (
                      <select aria-label={`${I.refsAdd} · ${fill(I.rowText, { n })}`} value="" onChange={(e) => e.target.value && set(i, { refs: [...refs, e.target.value] })} className="rounded border border-ink/15 bg-white px-2 py-0.5 text-xs">
                        <option value="">{I.refsAdd}</option>
                        {free.map((f) => <option key={f} value={f}>{refTitles[f] || f}</option>)}
                      </select>
                    )}
                  </div>
                  {refs.length >= MAX_REFS && <p className="mt-1 text-xs text-muted">{fill(I.refsMax, { n: MAX_REFS })}</p>}
                </div>
              )}
              {!refsOn && refs.length > 0 && <p className="mt-1 text-xs text-muted">{I.refsNotApplied}</p>}

              {!readOnly && (
                <div className="mt-2 flex justify-end">
                  <button type="button" onClick={() => drop(i)} className="btn btn-danger btn-xs" aria-label={fill(I.delete, { n })}>{t.files.delete}</button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {!readOnly && (
        <button type="button" disabled={items.length >= maxItems} onClick={() => onChange([...items, { text: "", agents: "all", on: true }])} className="btn btn-secondary btn-sm mt-3">+ {I.add}</button>
      )}
    </div>
  );
}
