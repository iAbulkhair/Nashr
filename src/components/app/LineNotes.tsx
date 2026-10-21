"use client";
import { useEffect, useRef, useState } from "react";
import type { Task } from "@/lib/brand";
import type { Lang } from "@/lib/i18n";
import { taskVersion } from "@/lib/task-version";
import { useToast } from "@/components/ui/Toast";

/**
 * Line notes on a pending draft (rule 2498; pattern 3 of docs/reports/2026-10-19-PRD-fizzy-orca_AR.md). The draft is shown line
 * by line; the owner adds a note under each line that should change, then sends them all in one revision at one draft's price
 * (POST /api/tasks/[id]/revise, src/lib/revise.ts). The notes stay on screen until the revision is saved: a refusal or a
 * failure keeps them, so nothing typed is lost.
 *
 * The lines are plain text in React (escaped), never HTML. The limits are the server's (`REVISE_MAX_NOTES` in src/lib/revise.ts,
 * `NOTE_MAX` in src/lib/task-notes.ts), repeated here because a client component cannot import those server modules.
 */
export const MAX_NOTES = 10;
export const NOTE_MAX = 300;

export const LINE_NOTES = {
  ar: {
    button: "ملاحظات على الأسطر",
    intro: "اضغط + بجانب أي سطر تريد تغييره واكتب ملاحظتك. ترسل كل الملاحظات للوكيل مرة واحدة، فيكتب نسخة جديدة تبقى بانتظار قرارك.",
    add: "أضف ملاحظة على هذا السطر",
    placeholder: "ماذا تريد أن يتغير في هذا السطر؟",
    keep: "أضف",
    remove: "احذف الملاحظة",
    count: "{n} من {max} ملاحظات",
    send: "أرسلها للوكيل ({c} كريدت)",
    sending: "الوكيل يعدّل المسودة…",
    cancel: "إلغاء",
    done: "عُدّلت المسودة حسب ملاحظاتك. راجعها ثم قرّر.",
    full: "بلغت الحد: 10 ملاحظات في المرة الواحدة.",
    errors: {
      no_credits: "رصيدك لا يكفي لهذا التعديل. لم يُخصم شيء.",
      agent_cap: "بلغ هذا الوكيل حده الشهري. لم يُخصم شيء.",
      trial_over: "انتهت الفترة التجريبية. لم يُخصم شيء.",
      fair_use: "توقفنا مؤقتاً بسبب الاستخدام الكثيف. لم يُخصم شيء.",
      changed: "تغيّرت المسودة بعد أن فتحتها. لم يُخصم شيء. ملاحظاتك محفوظة هنا، راجع النسخة الحالية ثم أرسلها من جديد.",
      not_pending: "اتُّخذ قرار في هذا العنصر قبل وصول التعديل. لم يُخصم شيء.",
      slow_down: "طلبات كثيرة في وقت قصير. حاول بعد قليل.",
      model_paused: "الوكلاء متوقفون الآن. لم يُخصم شيء.",
      bad_notes: "تغيّر نص أحد الأسطر. أغلق الملاحظات وافتحها من جديد.",
      failed: "تعذّر التعديل وأُعيد الكريدت. ملاحظاتك محفوظة هنا، حاول مرة أخرى.",
      forbidden: "دورك في الفريق لا يسمح بتعديل المسودات.",
    },
  },
  en: {
    button: "Line notes",
    intro: "Press + next to any line you want changed and write your note. All notes go to the agent at once, and it writes a new version that waits for your decision.",
    add: "Add a note on this line",
    placeholder: "What should change in this line?",
    keep: "Add",
    remove: "Remove note",
    count: "{n} of {max} notes",
    send: "Send to the agent ({c} credits)",
    sending: "The agent is revising the draft…",
    cancel: "Cancel",
    done: "The draft was revised from your notes. Review it, then decide.",
    full: "That is the limit: 10 notes at a time.",
    errors: {
      no_credits: "Not enough credits for this revision. Nothing was charged.",
      agent_cap: "This agent reached its monthly cap. Nothing was charged.",
      trial_over: "Your trial has ended. Nothing was charged.",
      fair_use: "Paused for heavy use. Nothing was charged.",
      changed: "The draft changed after you opened it. Nothing was charged. Your notes are kept here: review the current version, then send them again.",
      not_pending: "Someone decided on this item before the revision arrived. Nothing was charged.",
      slow_down: "Too many requests in a short time. Try again shortly.",
      model_paused: "The agents are paused right now. Nothing was charged.",
      bad_notes: "A line's text changed. Close the notes and open them again.",
      failed: "The revision failed and the credits were returned. Your notes are kept here: try again.",
      forbidden: "Your team role does not allow editing drafts.",
    },
  },
} as const;

type ErrorKey = keyof (typeof LINE_NOTES)["en"]["errors"];
export const errorOf = (status: number, error?: string): ErrorKey => {
  if (status === 403) return "forbidden";
  if (status === 429) return "slow_down";
  return error && Object.hasOwn(LINE_NOTES.en.errors, error) ? (error as ErrorKey) : "failed";
};

/**
 * What one answer of the revise route does to the panel: only a saved revision clears the notes; any refusal or failure keeps
 * them and shows its words. A 409 that carries the item as it is now also hands it to the card.
 */
export type SendOutcome = { clear: true; task: Task } | { clear: false; error: string; changed?: Task };
export function sendOutcome(lang: Lang, status: number, j: { ok?: boolean; task?: Task; error?: string; message?: string }): SendOutcome {
  if (status >= 200 && status < 300 && j.ok && j.task) return { clear: true, task: j.task };
  const error = j.message ?? LINE_NOTES[lang].errors[errorOf(status, j.error)];
  return status === 409 && j.task ? { clear: false, error, changed: j.task } : { clear: false, error };
}

export default function LineNotes({ task, body, lang, price, onDone, onChanged, onCancel }: { task: Task; body: string; lang: Lang; price: number; onDone: (t: Task) => void; onChanged: (t: Task) => void; onCancel: () => void }) {
  const L = LINE_NOTES[lang];
  const toast = useToast();
  const lines = body.split("\n");
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [open, setOpen] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = Object.keys(notes).length;
  // The note field takes the focus when the owner opens it with +, a click of theirs (no autofocus on load).
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open !== null) field.current?.focus(); }, [open]);

  function keep() {
    if (open === null) return;
    const v = text.trim();
    setNotes((p) => {
      const next = { ...p };
      if (v) next[open] = v.slice(0, NOTE_MAX);
      else delete next[open];
      return next;
    });
    setOpen(null);
    setText("");
  }

  async function send() {
    if (!count || sending) return;
    setSending(true);
    setError(null);
    const list = Object.entries(notes).map(([k, note]) => ({ line: Number(k), quote: lines[Number(k)], note }));
    try {
      const res = await fetch(`/api/tasks/${task.id}/revise`, { method: "POST", headers: { "Content-Type": "application/json", "x-lang": lang }, body: JSON.stringify({ version: taskVersion(task), notes: list }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; task?: Task; error?: string; message?: string };
      const out = sendOutcome(lang, res.status, j);
      if (out.clear) {
        setNotes({});
        toast.success(L.done);
        onDone(out.task);
        return;
      }
      // The item as it is now: the card shows it, and the notes stay for a second look.
      if (out.changed) onChanged(out.changed);
      setError(out.error);
    } catch {
      setError(L.errors.failed);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mt-3 grid gap-2">
      <p className="text-xs text-foreground-muted" dir="auto">{L.intro}</p>
      <ol className="grid gap-1 rounded-lg border border-border p-2 text-sm">
        {lines.map((line, n) => {
          const blank = !line.trim();
          const full = count >= MAX_NOTES && !(n in notes);
          return (
            <li key={n} className="grid gap-1">
              <div className="flex items-start gap-2">
                <span className="tnum w-6 shrink-0 pt-0.5 text-end text-xs text-foreground-muted" dir="ltr">{n + 1}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words" dir="auto">{line || "\u00a0"}</span>
                {!blank && open !== n && (
                  <button type="button" disabled={sending || full} title={full ? L.full : undefined} aria-label={L.add} onClick={() => { setOpen(n); setText(notes[n] ?? ""); }} className="btn btn-secondary btn-xs">+</button>
                )}
              </div>
              {open === n ? (
                <div className="ms-8 flex flex-wrap gap-2">
                  <input ref={field} value={text} maxLength={NOTE_MAX} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); keep(); } if (e.key === "Escape") { setOpen(null); setText(""); } }} placeholder={L.placeholder} aria-label={L.add} dir="auto" className="min-w-0 flex-1 rounded-lg border border-border p-2 text-sm" />
                  <button type="button" onClick={keep} className="btn btn-primary btn-xs">{L.keep}</button>
                  <button type="button" onClick={() => { setOpen(null); setText(""); }} className="btn btn-secondary btn-xs">{L.cancel}</button>
                </div>
              ) : n in notes ? (
                <p className="ms-8 flex items-start gap-2 rounded-md border border-dashed border-foreground/30 bg-surface px-2 py-1 text-xs text-foreground">
                  <span className="min-w-0 flex-1 break-words" dir="auto">{notes[n]}</span>
                  <button type="button" disabled={sending} aria-label={L.remove} onClick={() => setNotes((p) => { const next = { ...p }; delete next[n]; return next; })} className="rounded-full px-1 hover:bg-foreground/10">×</button>
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      {error && <p role="alert" className="text-sm text-danger" dir="auto">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={!count || sending || open !== null} onClick={send} className="btn btn-primary btn-pill">{sending ? L.sending : L.send.replace("{c}", String(price))}</button>
        <button type="button" disabled={sending} onClick={onCancel} className="btn btn-secondary btn-pill">{L.cancel}</button>
        <span className="tnum ms-auto text-xs text-foreground-muted" aria-live="polite">{L.count.replace("{n}", String(count)).replace("{max}", String(MAX_NOTES))}</span>
      </div>
    </div>
  );
}
