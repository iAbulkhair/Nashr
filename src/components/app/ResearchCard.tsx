"use client";
import { useEffect, useState } from "react";
import type { ResearchCard as Card } from "@/lib/research";

/** The card's words, both languages side by side (rule 4806). */
export const RESEARCH_COPY = {
  ar: {
    title: "{name} يطلب البحث في الويب",
    cost: "{n} رصيد عند التشغيل",
    why: "لا يُبحث ولا يُخصم شيء قبل موافقتك. النتائج نصوص من صفحات خارجية يذكر الوكيل مصدرها.",
    approve: "وافق على البحث",
    dismiss: "تجاهل",
    go: "وافقتُ على البحث عن «{q}». أكمل.",
    approved: "تمت الموافقة، وطلبتُ من {name} أن يكمل.",
    ran: "تم البحث.",
    dismissed: "تم تجاهل الطلب.",
    gone: "لم يعد هذا الطلب متاحًا.",
    forbidden: "الموافقة لمن يملك صلاحية تشغيل العمل.",
    slow: "طلبات كثيرة خلال ساعة. حاول لاحقًا.",
    error: "تعذّر الحفظ. حاول مرة أخرى.",
  },
  en: {
    title: "{name} asks to search the web",
    cost: "{n} credit when it runs",
    why: "Nothing is searched or charged before you approve. Results are text from outside pages, and the agent names each source.",
    approve: "Approve the search",
    dismiss: "Dismiss",
    go: "I approved the search for «{q}». Go ahead.",
    approved: "Approved; I asked {name} to go ahead.",
    ran: "Searched.",
    dismissed: "Dismissed.",
    gone: "This request is no longer available.",
    forbidden: "Approving is for a login that may start work.",
    slow: "Too many requests this hour. Try later.",
    error: "Could not save. Try again.",
  },
} as const;

type Notice = "gone" | "forbidden" | "slow" | "error";

const fill = (s: string, v: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

export function ResearchCard({
  id,
  name,
  lang,
  canRun = true,
  onApproved,
}: {
  id: string;
  name: string;
  lang: "ar" | "en";
  /** `can(u, "generate")` */ canRun?: boolean;
  onApproved: (text: string) => void;
}) {
  const C = RESEARCH_COPY[lang];
  const [card, setCard] = useState<Card | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // State is set in the fetch's callback, never in the effect's body (as GoalPlanCard).
    let live = true;
    fetch(`/api/chat/research/${id}`)
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; research?: Card };
        if (!live) return;
        if (r.ok && j.ok && j.research) setCard(j.research);
        else if (r.status === 404) setNotice("gone");
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id]);

  async function act(action: "approve" | "dismiss") {
    setBusy(true);
    setNotice(null);
    const r = await fetch(`/api/chat/research/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }).catch(() => null);
    const j = r ? ((await r.json().catch(() => ({}))) as { ok?: boolean; research?: Card }) : {};
    setBusy(false);
    if (r?.ok && j.ok && j.research) {
      setCard(j.research);
      if (action === "approve") onApproved(fill(C.go, { q: j.research.query }));
      return;
    }
    setNotice(
      !r
        ? "error"
        : r.status === 404 || r.status === 409
          ? "gone"
          : r.status === 403
            ? "forbidden"
            : r.status === 429
              ? "slow"
              : "error",
    );
  }

  if (!card) return notice ? <p className="mt-2 text-xs text-foreground-muted">{C[notice]}</p> : null;
  return (
    <div className="mt-2 rounded-lg border border-border bg-surface p-3 text-sm">
      <p className="font-medium">{fill(C.title, { name })}</p>
      <p className="mt-1" dir="auto">
        «{card.query}»
      </p>
      <p className="mt-1 text-xs text-foreground-muted">
        {fill(C.cost, { n: card.credits })} · {C.why}
      </p>
      {card.state === "open" && canRun && (
        <div className="mt-2 flex gap-2">
          <button type="button" disabled={busy} onClick={() => void act("approve")} className="btn btn-primary btn-xs">
            {C.approve}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act("dismiss")}
            className="btn btn-secondary btn-xs"
          >
            {C.dismiss}
          </button>
        </div>
      )}
      {card.state !== "open" && (
        <p className="mt-2 text-xs text-foreground-muted">
          {card.state === "approved" ? fill(C.approved, { name }) : C[card.state]}
        </p>
      )}
      {notice && <p className="mt-2 text-xs text-foreground-muted">{C[notice]}</p>}
    </div>
  );
}
