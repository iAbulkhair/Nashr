"use client";
import { useState } from "react";

type Labels = { vote: string; voted: string; votesLabel: string; failed: string; slowDown: string };

/**
 * Vote button for one wishlist item. The server renders it with the real count and the viewer's own state, so the
 * page is correct before any script runs; a click sends the state it wants (`on`), which makes a double click or a
 * retried request harmless.
 */
export default function WishVote({ id, votes, voted, title, labels, loginHref }: { id: string; votes: number; voted: boolean; title: string; labels: Labels; loginHref: string }) {
  const [state, setState] = useState({ votes, voted });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function click() {
    if (busy) return;
    const before = state;
    const on = !state.voted;
    setBusy(true);
    setErr("");
    setState({ voted: on, votes: Math.max(0, state.votes + (on ? 1 : -1)) });
    try {
      const r = await fetch("/api/wishlist/vote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, on }) });
      if (r.status === 401) { window.location.assign(loginHref); return; }
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; voted?: boolean; votes?: number; error?: string };
      if (!r.ok || !j.ok || typeof j.votes !== "number") { setState(before); setErr(j.error === "slow_down" ? labels.slowDown : labels.failed); return; }
      setState({ voted: !!j.voted, votes: j.votes });
    } catch {
      setState(before);
      setErr(labels.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <button
        type="button"
        onClick={click}
        aria-pressed={state.voted}
        aria-label={`${state.voted ? labels.voted : labels.vote}: ${title}`}
        className={`flex min-w-16 flex-col items-center rounded-xl border px-3 py-1.5 text-sm font-semibold transition ${state.voted ? "border-oasis bg-oasis text-mist hover:bg-oasis-deep" : "border-oasis/25 bg-white text-oasis hover:border-oasis"} ${busy ? "opacity-70" : ""}`}
      >
        <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden><path d="M2 8l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span className="tnum" dir="ltr">{state.votes}</span>
        <span className="text-xs font-medium">{state.voted ? labels.voted : labels.vote}</span>
      </button>
      {err && <p role="alert" className="max-w-28 text-center text-xs text-sadu-deep">{err}</p>}
    </div>
  );
}
