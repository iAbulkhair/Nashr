"use client";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { MemoryCard } from "@/lib/memory";
import { Icon } from "./Icons";

/** The card's words, both languages side by side (rule 4557); the agent names come from the app dictionary. */
export const MEMORY_CARD_COPY = {
  ar: {
    title: "معلومة تنتظر حفظك في ذاكرة الفريق",
    titleMember: "معلومة تنتظر قرار المالك أو المشرف",
    brand: "لكل الوكلاء",
    agent: "ملاحظات {name} فقط",
    conversation: "هذه المحادثة فقط",
    inferred: "استنتجها الوكيل، لم تقلها أنت. تأكد منها قبل الحفظ.",
    why: "لا يُحفظ شيء قبل ضغطك. المعلومة المحفوظة تُقرأ في الردود القادمة، ولا تأذن بنشر أو صرف أو تغيير ملف العلامة.",
    save: "احفظ",
    dismiss: "تجاهل",
    saved: "حُفظت في الذاكرة.",
    dismissed: "تُجوهلت.",
    gone: "لم يعد هذا الاقتراح متاحًا.",
    forbidden: "هذا القرار للمالك أو المشرف.",
    busy: "قرار آخر لهذه المعلومة قيد التنفيذ. حاول بعد لحظة.",
    full: "الذاكرة ممتلئة. احذف معلومة قديمة ثم احفظ.",
    slow: "قرارات كثيرة خلال ساعة. حاول لاحقًا.",
    error: "تعذّر الحفظ. حاول مرة أخرى.",
  },
  en: {
    title: "A fact waiting for your Save in the team's memory",
    titleMember: "A fact waiting for the owner or an admin",
    brand: "every agent",
    agent: "{name}'s own notes",
    conversation: "this conversation only",
    inferred: "The agent concluded this; you did not say it. Check it before saving.",
    why: "Nothing is kept until you press Save. A saved fact is read in later replies and never allows publishing, spending or a brand change.",
    save: "Save",
    dismiss: "Dismiss",
    saved: "Saved to memory.",
    dismissed: "Dismissed.",
    gone: "This proposal is no longer available.",
    forbidden: "This is for the owner or an admin.",
    busy: "Another answer for this fact is running. Try again in a moment.",
    full: "Memory is full. Forget an old fact, then save.",
    slow: "Too many answers this hour. Try later.",
    error: "Could not save. Try again.",
  },
} as const;

type State = "open" | "saving" | "saved" | "dismissed" | "gone" | "forbidden" | "busy" | "full" | "slow" | "error";

/**
 * A fact an agent proposed in chat (`remember`, src/lib/memory.ts): nothing is in memory yet. The fact is the model's
 * text, so it is shown as plain text (a React text node, never markup); Save keeps it as the owner's click (POST
 * /api/memory/proposals/{id}, `brand.write`), Dismiss drops it. An inferred fact says so above the buttons.
 */
export function MemoryProposalCard({
  p,
  t,
  lang,
  canWrite = true,
}: {
  p: MemoryCard;
  t: AppDict;
  lang: "ar" | "en";
  /** `can(u, "brand.write")`: a plain member sees the fact but cannot decide it */ canWrite?: boolean;
}) {
  const C = MEMORY_CARD_COPY[lang];
  // A reloaded thread carries where the proposal stands now (historyFor reads it), so a decided card stays decided.
  const [state, setState] = useState<State>(
    p.state === "saved" || p.state === "dismissed" ? p.state : p.state === "expired" ? "gone" : "open",
  );
  async function decide(decision: "save" | "dismiss") {
    setState("saving");
    const r = await fetch(`/api/memory/proposals/${p.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    }).catch(() => null);
    if (!r) return setState("error");
    if (r.ok) return setState(decision === "save" ? "saved" : "dismissed");
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    setState(
      r.status === 403
        ? "forbidden"
        : r.status === 404 || r.status === 410
          ? "gone"
          : r.status === 429
            ? "slow"
            : j.error === "claim_busy"
              ? "busy"
              : j.error === "full"
                ? "full"
                : "error",
    );
  }
  const where =
    p.scope === "agent"
      ? C.agent.replace("{name}", p.agent ? t.agents[p.agent].name : "")
      : p.scope === "conversation"
        ? C.conversation
        : C.brand;
  const done: Partial<Record<State, string>> = {
    saved: C.saved,
    dismissed: C.dismissed,
    gone: C.gone,
    forbidden: C.forbidden,
    busy: C.busy,
    full: C.full,
    slow: C.slow,
    error: C.error,
  };
  const closed = state === "saved" || state === "dismissed" || state === "gone";
  return (
    <article className="mt-3 overflow-hidden rounded-xl border border-lemon/40 bg-surface text-foreground">
      <header className="flex items-center gap-2 border-b border-foreground/5 px-3 py-2 text-xs font-semibold">
        <Icon name="shield" className="h-4 w-4 text-foreground" />
        {canWrite ? C.title : C.titleMember}
        <span className="font-normal text-foreground-muted">· {where}</span>
      </header>
      <div className="grid gap-2 px-4 py-3 text-sm">
        <p className="min-w-0 whitespace-pre-wrap break-words rounded-lg bg-foreground/5 p-2" dir="auto">
          {p.text}
        </p>
        {p.source === "inferred" && <p className="text-xs text-danger">{C.inferred}</p>}
        <p className="text-xs text-foreground-muted">{C.why}</p>
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t border-foreground/5 px-3 py-2 text-xs">
        {done[state] && (
          <span
            role="status"
            className={state === "saved" || state === "dismissed" ? "text-foreground" : "text-danger"}
          >
            {done[state]}
          </span>
        )}
        {!closed && !canWrite && <span className="ms-auto text-foreground-muted">{t.inbox.waitAdmin}</span>}
        {!closed && canWrite && (
          <span className="ms-auto flex gap-1.5">
            <button
              disabled={state === "saving"}
              onClick={() => decide("dismiss")}
              className="btn btn-secondary btn-xs"
            >
              {C.dismiss}
            </button>
            <button disabled={state === "saving"} onClick={() => decide("save")} className="btn btn-primary btn-xs">
              <Icon name="check" className="h-3.5 w-3.5" />
              {C.save}
            </button>
          </span>
        )}
      </footer>
    </article>
  );
}
