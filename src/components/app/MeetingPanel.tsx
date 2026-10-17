"use client";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import type { AppDict } from "@/lib/app-i18n";
import { AGENT_IDS } from "@/lib/agents";
import { fill } from "@/lib/fill";
import { MEETING_NOTES_MAX, MEETING_TEXT_MAX, MEETING_TRANSCRIPT_COST } from "@/lib/pricing";
import { refusalText } from "./useOneWrite";
import { PanelSkeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";

/**
 * A title in a proposal is at most this long (`MEET_TITLE_MAX` in src/lib/secretary-meeting.ts, which is server code and so
 * not imported here; a test pins the two together). The server checks it again.
 */
const TITLE_MAX = 120;
/** The files the transcript box reads in the browser, by extension. */
const FILE_RE = /\.(txt|vtt|srt)$/i;

/** One suggested task as the owner is editing it. `dueAt` is a local day "YYYY-MM-DD" or "". */
type Draft = { ref: string; title: string; agent: string; dueAt: string; keep: boolean };
type Load = "loading" | "ready" | "failed";

/** The server's proposals (an answer is data, not trusted): only well-formed entries become rows. */
function draftsOf(list: unknown): Draft[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((p): Draft[] => {
    const o = p && typeof p === "object" ? (p as Record<string, unknown>) : null;
    if (!o || typeof o.ref !== "string" || typeof o.title !== "string" || typeof o.agent !== "string") return [];
    return [{ ref: o.ref, title: o.title, agent: o.agent, dueAt: typeof o.dueAt === "string" ? o.dueAt : "", keep: true }];
  });
}

/**
 * The follow-up after a meeting (Reem phase 3 B2b), opened from a booking item whose start has passed. The owner types notes
 * (free) or pastes or loads a transcript (`.txt`, `.vtt` or `.srt`, read in the browser into the same box; there is no upload
 * route) and Reem proposes tasks (POST /api/secretary/meeting/{id}/propose). Nothing is created by that: the proposals are
 * rows the owner edits (title, who, due day), keeps or removes, and one "Approve selected" sends the kept ones
 * (POST .../approve), which is the only thing that makes items. A task for an agent is an item waiting on that agent: the
 * agent does not run it. Pending proposals are read on open (GET .../meeting/{id}), so a set the chat proposed shows too;
 * Discard deletes the set. The text of the notes or transcript is held in component state only, sent once and cleared when
 * the proposals arrive; it is never stored or put in the address. All text is plain text (no HTML from a model or a file).
 * The credit cost is `MEETING_TRANSCRIPT_COST`, the same constant the server charges.
 */
export default function MeetingPanel({ t, itemId, onClose }: { t: AppDict; itemId: string; onClose?: () => void }) {
  const T = t.todo.meeting;
  const router = useRouter();
  const toast = useToast();
  const uid = useId();
  const [notes, setNotes] = useState("");
  const [transcript, setTranscript] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [load, setLoad] = useState<Load>("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const inflight = useRef(false);
  const base = `/api/secretary/meeting/${itemId}`;
  const words: Record<string, string> = { ...T.errors };
  const failText = (status: number, j: Record<string, unknown>) => refusalText(t, status, j.error, words);

  // Reads the pending set on open, after "Try again" and after a partial approve (`attempt` is bumped).
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    fetch(base, { cache: "no-store" })
      .then(async (r) => ({ ok: r.ok, j: (await r.json().catch(() => ({}))) as Record<string, unknown> }))
      .then(({ ok, j }) => {
        if (!live) return;
        if (!ok || !j.ok) return setLoad("failed");
        setDrafts(draftsOf(j.proposals));
        setLoad("ready");
      })
      .catch(() => live && setLoad("failed"));
    return () => { live = false; };
  }, [base, attempt]);

  /** One request at a time: the in-flight mark is a ref, set before the request, so a double click sends nothing twice. */
  async function call(key: string, url: string, method: "POST" | "DELETE", body?: unknown): Promise<{ ok: boolean; status: number; j: Record<string, unknown> } | null> {
    if (inflight.current) return null;
    inflight.current = true;
    setBusy(key);
    setError(null);
    try {
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: r.ok && j.ok === true, status: r.status, j };
    } catch {
      toast.danger(t.todo.errors.generic); // rule 2001: the request never got an answer
      return null;
    } finally {
      inflight.current = false;
      setBusy(null);
    }
  }

  async function propose(kind: "notes" | "transcript") {
    const text = kind === "notes" ? notes : transcript;
    const max = kind === "notes" ? MEETING_NOTES_MAX : MEETING_TEXT_MAX;
    if (!text.trim()) return;
    if (text.length > max) return setError(fill(T.textTooLong, { max: String(max) }));
    const r = await call(`propose:${kind}`, `${base}/propose`, "POST", { kind, text });
    if (!r) return;
    if (!r.ok) return setError(failText(r.status, r.j));
    setDrafts(draftsOf(r.j.proposals));
    if (kind === "notes") setNotes("");
    else setTranscript("");
    setFileError(null);
  }

  async function approve() {
    const kept = drafts.filter((d) => d.keep);
    if (!kept.length) return setError(T.nothingSelected);
    if (kept.some((d) => !d.title.trim())) return setError(T.errors.title_required);
    const r = await call("approve", `${base}/approve`, "POST", { kept: kept.map((d) => ({ ref: d.ref, title: d.title, agent: d.agent, dueAt: d.dueAt || null })) });
    if (!r) return;
    const created = Array.isArray(r.j.created) ? r.j.created.length : 0;
    if (r.ok) {
      setDrafts([]);
      toast.success(fill(T.approved, { n: String(created) })); // rule 2001
      router.refresh();
      return;
    }
    // Part-way: what was made stays made, and the others stay pending. The set is read again so the rows are what is stored.
    if (created > 0) {
      setError(T.errors.partial);
      setAttempt((n) => n + 1);
      router.refresh();
      return;
    }
    setError(failText(r.status, r.j));
  }

  async function discard() {
    const r = await call("discard", base, "DELETE");
    if (!r) return;
    if (!r.ok) return setError(failText(r.status, r.j));
    setDrafts([]);
    toast.success(T.discarded);
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    setFileError(null);
    if (!f) return;
    if (!FILE_RE.test(f.name)) return setFileError(T.fileBad);
    const tooBig = fill(T.fileTooBig, { max: String(MEETING_TEXT_MAX) });
    // A character is at most four bytes: a file bigger than that can never fit. A smaller one is checked by its length once read.
    if (f.size > MEETING_TEXT_MAX * 4) return setFileError(tooBig);
    const reader = new FileReader();
    reader.onload = () => {
      const s = typeof reader.result === "string" ? reader.result.replace(/^﻿/, "") : "";
      if (s.length > MEETING_TEXT_MAX) setFileError(tooBig);
      else setTranscript(s);
    };
    reader.onerror = () => setFileError(T.fileFail);
    reader.readAsText(f, "utf-8");
  }

  const edit = (ref: string, patch: Partial<Draft>) => setDrafts((all) => all.map((d) => (d.ref === ref ? { ...d, ...patch } : d)));
  const off = !!busy;
  const notesLong = notes.length > MEETING_NOTES_MAX;
  const transcriptLong = transcript.length > MEETING_TEXT_MAX;
  const keptCount = drafts.filter((d) => d.keep).length;

  return (
    <section aria-labelledby={`${uid}-title`} className="mt-3 rounded-xl border border-foreground/10 bg-surface p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${uid}-title`} className="font-semibold">{T.title}</h3>
        {onClose && <button type="button" onClick={onClose} className="btn btn-secondary btn-xs">{T.close}</button>}
      </div>
      <p className="mt-1 text-sm text-foreground-muted">{T.intro}</p>
      <p className="mt-1 text-xs text-foreground-muted">{T.agentNote}</p>
      <p className="mt-1 text-xs text-foreground-muted">{T.savedNote}</p>

      <div className="mt-4 grid gap-4">
        <div>
          <label htmlFor={`${uid}-notes`} className="text-xs text-foreground-muted">{T.notesLabel}</label>
          <textarea id={`${uid}-notes`} value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} placeholder={T.notesPh} disabled={off} dir="auto" className="input mt-1" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" disabled={off || !notes.trim() || notesLong} onClick={() => void propose("notes")} className="btn btn-primary btn-sm">{busy === "propose:notes" ? T.working : T.notesButton}</button>
            <span className="text-xs text-foreground-muted">{T.notesFree}</span>
          </div>
        </div>

        <div>
          <label htmlFor={`${uid}-transcript`} className="text-xs text-foreground-muted">{T.transcriptLabel}</label>
          <textarea id={`${uid}-transcript`} value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={6} placeholder={T.transcriptPh} disabled={off} dir="auto" className="input mt-1" />
          <div className="mt-2 grid gap-1">
            <label htmlFor={`${uid}-file`} className="text-xs text-foreground-muted">{T.fileLabel}</label>
            <input id={`${uid}-file`} type="file" accept=".txt,.vtt,.srt,text/plain,text/vtt" onChange={onFile} disabled={off} className="max-w-full text-sm" />
            {fileError && <p role="alert" className="text-sm text-danger">{fileError}</p>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" disabled={off || !transcript.trim() || transcriptLong} onClick={() => void propose("transcript")} className="btn btn-primary btn-sm">{busy === "propose:transcript" ? T.working : T.transcriptButton}</button>
            <span className="tnum text-xs text-foreground-muted">{fill(T.cost, { n: String(MEETING_TRANSCRIPT_COST) })}</span>
          </div>
          {(notesLong || transcriptLong) && <p role="alert" className="mt-2 text-sm text-danger">{fill(T.textTooLong, { max: String(notesLong ? MEETING_NOTES_MAX : MEETING_TEXT_MAX) })}</p>}
        </div>
      </div>

      <div className="mt-5" aria-live="polite">
        {load === "loading" && <PanelSkeleton label={T.loading} shape="rows" count={2} />}{/* rule 2003 */}
        {load === "failed" && (
          <div>
            <p role="alert" className="text-sm text-danger">{T.loadFailed}</p>
            <button type="button" onClick={() => { setLoad("loading"); setAttempt((n) => n + 1); }} className="btn btn-secondary btn-sm mt-2">{t.handoff.retry}</button>
          </div>
        )}
        {load === "ready" && drafts.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold">{T.proposals}</h4>
            <ul className="mt-2 grid gap-3">
              {drafts.map((d) => (
                <li key={d.ref} className="rounded-xl border border-foreground/10 p-3">
                  <div className="flex items-start gap-2">
                    <input type="checkbox" checked={d.keep} onChange={(e) => edit(d.ref, { keep: e.target.checked })} disabled={off} aria-label={T.keepLabel} className="mt-2" />
                    <label className="min-w-0 flex-1 text-xs text-foreground-muted">{T.taskLabel}
                      <input value={d.title} onChange={(e) => edit(d.ref, { title: e.target.value })} maxLength={TITLE_MAX} disabled={off} dir="auto" className="input mt-1" />
                    </label>
                  </div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <label className="text-xs text-foreground-muted">{T.agentLabel}
                      <select value={d.agent} onChange={(e) => edit(d.ref, { agent: e.target.value })} disabled={off} className="input mt-1">
                        <option value="owner">{T.owner}</option>
                        {AGENT_IDS.map((id) => <option key={id} value={id}>{t.agents[id].name}</option>)}
                      </select>
                    </label>
                    <label className="text-xs text-foreground-muted">{T.dueLabel}
                      <input type="date" value={d.dueAt} onChange={(e) => edit(d.ref, { dueAt: e.target.value })} disabled={off} dir="ltr" className="input mt-1" />
                    </label>
                  </div>
                  <div className="mt-2">
                    <button type="button" disabled={off} onClick={() => setDrafts((all) => all.filter((x) => x.ref !== d.ref))} className="btn btn-secondary btn-xs">{T.removeLabel}</button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" disabled={off || keptCount === 0} onClick={() => void approve()} className="btn btn-primary btn-sm">{busy === "approve" ? T.approving : T.approve}</button>
              <button type="button" disabled={off} onClick={() => void discard()} className="btn btn-secondary btn-sm">{busy === "discard" ? T.discarding : T.discard}</button>
            </div>
          </div>
        )}
      </div>

      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </section>
  );
}
