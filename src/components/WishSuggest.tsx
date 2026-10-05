"use client";
import { useState } from "react";
import Scribble from "@/components/Scribble";
import { SUGGESTION_MAX, SUGGESTION_MIN } from "@/lib/changelog";

type Labels = { title: string; sub: string; placeholder: string; send: string; sent: string; note: string; tooShort: string; tooLong: string; failed: string; slowDown: string };

/** Suggest a wish. It goes to the founder's review queue, never straight onto the page. */
export default function WishSuggest({ lang, labels }: { lang: "ar" | "en"; labels: Labels }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const len = text.trim().length;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (len < SUGGESTION_MIN) return setMsg({ ok: false, t: labels.tooShort });
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/wishlist/suggest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, lang }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (j.ok) { setText(""); setMsg({ ok: true, t: labels.sent }); return; }
      setMsg({ ok: false, t: j.error === "too_short" ? labels.tooShort : j.error === "too_long" ? labels.tooLong : j.error === "slow_down" ? labels.slowDown : labels.failed });
    } catch {
      setMsg({ ok: false, t: labels.failed });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={send} className="s-card">
      <Scribble kind="box" seed="wish-suggest" fill="paper" />
      <h3 className="font-display text-lg font-bold">{labels.title}</h3>
      <p className="mt-1 text-sm text-muted">{labels.sub}</p>
      <label htmlFor="wish-suggest" className="sr-only">{labels.title}</label>
      <span className="s-input mt-3"><Scribble kind="box" seed="wish-suggest-box" fill="paper" ring /><textarea id="wish-suggest" value={text} onChange={(e) => setText(e.target.value)} maxLength={SUGGESTION_MAX} rows={3} dir="auto" placeholder={labels.placeholder} /></span>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">{labels.note}</p>
        <div className="flex items-center gap-3">
          <span className="tnum text-xs text-muted" dir="ltr">{len}/{SUGGESTION_MAX}</span>
          <button type="submit" disabled={busy || len === 0} className="s-btn !min-h-10 !px-5 !text-base"><Scribble kind="pill" seed="wish-suggest-send" fill="ink" shadow ring />{labels.send}</button>
        </div>
      </div>
      {msg && <p role="status" className={`mt-2 text-sm font-bold ${msg.ok ? "text-ink" : "text-danger"}`}>{msg.t}</p>}
    </form>
  );
}
