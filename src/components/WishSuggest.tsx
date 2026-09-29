"use client";
import { useState } from "react";
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
    <form onSubmit={send} className="card">
      <h3 className="card-title text-oasis">{labels.title}</h3>
      <p className="mt-1 text-sm text-ink/70">{labels.sub}</p>
      <label htmlFor="wish-suggest" className="sr-only">{labels.title}</label>
      <textarea id="wish-suggest" value={text} onChange={(e) => setText(e.target.value)} maxLength={SUGGESTION_MAX} rows={3} dir="auto" placeholder={labels.placeholder} className="input mt-3 resize-y" />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-ink/60">{labels.note}</p>
        <div className="flex items-center gap-3">
          <span className="tnum text-xs text-ink/50" dir="ltr">{len}/{SUGGESTION_MAX}</span>
          <button type="submit" disabled={busy || len === 0} className="btn btn-primary btn-sm">{labels.send}</button>
        </div>
      </div>
      {msg && <p role="status" className={`mt-2 text-sm ${msg.ok ? "text-oasis" : "text-sadu-deep"}`}>{msg.t}</p>}
    </form>
  );
}
