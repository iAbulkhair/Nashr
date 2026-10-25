"use client";
import { useCallback, useEffect, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { PlanView } from "@/lib/plans";
import { Icon } from "./Icons";

/** The card's words, both languages side by side (rule 4629); agent and type names come from the app dictionary. */
export const GOAL_PLAN_COPY = {
  ar: {
    title: "خطة من {name}",
    goal: "الهدف",
    step: "الخطوة {n}",
    after: "بعد الخطوة {list}",
    cost: "{n} رصيد",
    total: "الإجمالي {n} رصيد",
    why: "لا يُشغَّل شيء ولا يُخصم رصيد قبل ضغطك «اعتمد». كل خطوة تُخصم حين تعمل، وكل ما تنتجه ينتظر موافقتك في صندوق الموافقة قبل الخطوة التالية.",
    approve: "اعتمد الخطة",
    pause: "أوقف مؤقتًا",
    resume: "استأنف",
    cancel: "ألغِ الخطة",
    status: { proposed: "مقترحة", approved: "قيد التنفيذ", paused: "متوقفة", done: "اكتملت", cancelled: "أُلغيت" },
    stepStatus: {
      waiting: "تنتظر",
      queued: "في الدور",
      running: "تعمل الآن",
      done: "تمت",
      failed: "توقفت",
      cancelled: "أُلغيت",
    },
    expired: "مرّ على الاقتراح أكثر من 7 أيام. اطلب من ماجد خطة جديدة بالأسعار الحالية.",
    gone: "لم تعد هذه الخطة متاحة.",
    forbidden: "هذا القرار لمن يملك صلاحية التشغيل.",
    no_credits: "الرصيد لا يغطي إجمالي الخطة.",
    agent_cap: "الخطة تتجاوز الحد الشهري لأحد الوكلاء.",
    busy: "خطوة تعمل الآن. حاول بعد لحظة.",
    slow: "طلبات كثيرة خلال ساعة. حاول لاحقًا.",
    error: "تعذّر التنفيذ. حاول مرة أخرى.",
  },
  en: {
    title: "A plan from {name}",
    goal: "Goal",
    step: "Step {n}",
    after: "after step {list}",
    cost: "{n} credits",
    total: "Total {n} credits",
    why: "Nothing runs and nothing is charged until you press Approve. Each step is charged when it runs, and what it makes waits in your inbox for your approval before the next step.",
    approve: "Approve plan",
    pause: "Pause",
    resume: "Resume",
    cancel: "Cancel plan",
    status: { proposed: "Proposed", approved: "Running", paused: "Paused", done: "Done", cancelled: "Cancelled" },
    stepStatus: {
      waiting: "Waiting",
      queued: "Queued",
      running: "Running now",
      done: "Done",
      failed: "Stopped",
      cancelled: "Cancelled",
    },
    expired: "This proposal is more than 7 days old. Ask Majed for a new plan at today's prices.",
    gone: "This plan is no longer available.",
    forbidden: "This is for a login that may run work.",
    no_credits: "Your balance does not cover the plan's total.",
    agent_cap: "The plan passes an agent's monthly cap.",
    busy: "A step is running. Try again in a moment.",
    slow: "Too many requests this hour. Try later.",
    error: "Could not do that. Try again.",
  },
} as const;

type Notice = "gone" | "forbidden" | "no_credits" | "agent_cap" | "busy" | "slow" | "error";
const POLL_MS = 15_000;
const POLLS = 40;

/**
 * Majed's plan under his reply (`make_plan`, src/lib/plans.ts): the goal, each step with its agent, type, brief (plain
 * text, never markup), cost and status, and the total. Approve is the owner's one approval (POST /api/plans/{id},
 * `generate`); Pause, Resume and Cancel act on a running plan. The card shows what is stored: it reads the plan on show,
 * takes the server's state after every action, and reads again every POLL_MS while a step is queued or running.
 */
export function GoalPlanCard({
  id,
  t,
  lang,
  canRun = true,
}: {
  id: string;
  t: AppDict;
  lang: "ar" | "en";
  /** `can(u, "generate")` */ canRun?: boolean;
}) {
  const C = GOAL_PLAN_COPY[lang];
  const [view, setView] = useState<PlanView | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const fill = (s: string, v: Record<string, string | number>) =>
    s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

  const read = useCallback(async () => {
    const r = await fetch(`/api/plans/${id}`).catch(() => null);
    if (!r) return;
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; plan?: PlanView };
    if (r.ok && j.ok && j.plan) setView(j.plan);
    else if (r.status === 404) setNotice("gone");
  }, [id]);

  useEffect(() => {
    // The first read, as HandoffCard's: state is set in the fetch's callback, never in the effect's body.
    let live = true;
    fetch(`/api/plans/${id}`)
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; plan?: PlanView };
        if (!live) return;
        if (r.ok && j.ok && j.plan) setView(j.plan);
        else if (r.status === 404) setNotice("gone");
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id]);

  const moving =
    !!view && view.status === "approved" && view.steps.some((s) => s.status === "queued" || s.status === "running");
  useEffect(() => {
    if (!moving) return;
    let n = 0;
    const timer = setInterval(() => {
      if (++n > POLLS) clearInterval(timer);
      else void read();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [moving, read]);

  async function act(action: "approve" | "pause" | "resume" | "cancel") {
    setBusy(true);
    setNotice(null);
    const r = await fetch(`/api/plans/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }).catch(() => null);
    const j = r ? ((await r.json().catch(() => ({}))) as { ok?: boolean; plan?: PlanView; error?: string }) : {};
    setBusy(false);
    if (r?.ok && j.plan) return setView(j.plan);
    if (!r) return setNotice("error");
    if (r.status === 403) return setNotice("forbidden");
    if (r.status === 429) return setNotice("slow");
    if (r.status === 404 || r.status === 410)
      return void read().then(() => setNotice(r.status === 404 ? "gone" : null));
    const e = j.error;
    setNotice(e === "no_credits" || e === "agent_cap" || e === "busy" ? e : "error");
    void read();
  }

  if (!view) return notice ? <p className="mt-3 text-xs text-foreground-muted">{C[notice]}</p> : null;
  const done = view.status === "done" || view.status === "cancelled";
  return (
    <section
      className="mt-3 overflow-hidden rounded-xl border border-foreground/25 bg-surface text-foreground"
      aria-busy={busy}
    >
      <header className="flex items-center gap-2 border-b border-foreground/5 px-3 py-2 text-sm font-semibold">
        <Icon name="plan" className="h-4 w-4" />
        {fill(C.title, { name: t.agents.majed.name })}
        <span className="ms-auto text-xs font-normal text-foreground-muted">{C.status[view.status]}</span>
      </header>
      <div className="grid gap-2 px-4 py-3 text-sm">
        <p className="min-w-0 break-words" dir="auto">
          <span className="font-semibold">{C.goal}: </span>
          {view.goal}
        </p>
        <ol className="grid gap-2">
          {view.steps.map((s, i) => (
            <li key={i} className="rounded-lg bg-foreground/5 p-2">
              <p className="flex flex-wrap items-center gap-x-2 text-xs">
                <span className="font-semibold">{fill(C.step, { n: i + 1 })}</span>
                <span>
                  {t.agents[s.agent].name} · {t.generate.types[s.type].t}
                </span>
                {s.after.length > 0 && (
                  <span className="text-foreground-muted">
                    {fill(C.after, { list: s.after.map((a) => a + 1).join(lang === "ar" ? "، " : ", ") })}
                  </span>
                )}
                <span className="tnum ms-auto text-foreground-muted">{fill(C.cost, { n: s.cost })}</span>
                <span className="text-foreground-muted">{C.stepStatus[s.status]}</span>
              </p>
              <p className="mt-1 min-w-0 whitespace-pre-wrap break-words text-xs" dir="auto">
                {s.brief}
              </p>
            </li>
          ))}
        </ol>
        <p className="tnum text-xs font-semibold">{fill(C.total, { n: view.total })}</p>
        {view.status === "proposed" && (
          <p className="text-xs text-foreground-muted">{view.expired ? C.expired : C.why}</p>
        )}
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t border-foreground/5 px-3 py-2 text-xs">
        {notice && (
          <span role="alert" className="text-danger">
            {C[notice]}
          </span>
        )}
        {canRun && !done && (
          <span className="ms-auto flex gap-1.5">
            {view.status === "proposed" && !view.expired && (
              <button type="button" disabled={busy} onClick={() => act("approve")} className="btn btn-primary btn-xs">
                <Icon name="check" className="h-3.5 w-3.5" />
                {C.approve}
              </button>
            )}
            {view.status === "approved" && (
              <button type="button" disabled={busy} onClick={() => act("pause")} className="btn btn-secondary btn-xs">
                {C.pause}
              </button>
            )}
            {view.status === "paused" && (
              <button type="button" disabled={busy} onClick={() => act("resume")} className="btn btn-primary btn-xs">
                {C.resume}
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => act("cancel")} className="btn btn-secondary btn-xs">
              {C.cancel}
            </button>
          </span>
        )}
      </footer>
    </section>
  );
}
