"use client";

import { useState } from "react";
import type { Dict, Lang } from "@/lib/i18n";

export default function WaitlistForm({ t, lang }: { t: Dict; lang: Lang }) {
  const w = t.waitlist;
  const [state, setState] = useState<"idle" | "sending" | "ok" | "err">("idle");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setState("sending");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: fd.get("email"), company: fd.get("company"), industry: fd.get("industry"), lang }),
      });
      setState(res.ok ? "ok" : "err");
    } catch {
      setState("err");
    }
  }

  return (
    <section id="waitlist" className="scroll-mt-20 bg-salt-dim">
      <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
        <h2 className="font-display text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{w.title}</h2>
        <p className="mt-3 text-ink/70">{w.sub}</p>
        {state === "ok" ? (
          <p role="status" className="mt-8 rounded-xl border border-oasis bg-salt p-5 font-medium text-oasis">
            {w.ok}
          </p>
        ) : (
          <form onSubmit={onSubmit} className="mt-8 grid gap-3 sm:grid-cols-[1fr_1fr_160px_auto]">
            <label className="sr-only" htmlFor="wl-email">{w.email}</label>
            <input id="wl-email" name="email" type="email" required placeholder={w.email} className="rounded-lg border border-ink/15 bg-salt px-4 py-3 text-sm" />
            <label className="sr-only" htmlFor="wl-company">{w.company}</label>
            <input id="wl-company" name="company" type="text" placeholder={w.company} className="rounded-lg border border-ink/15 bg-salt px-4 py-3 text-sm" />
            <label className="sr-only" htmlFor="wl-industry">{w.industry}</label>
            <select id="wl-industry" name="industry" className="rounded-lg border border-ink/15 bg-salt px-3 py-3 text-sm" defaultValue="">
              <option value="" disabled>{w.industry}</option>
              {w.industries.map((i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
            <button type="submit" disabled={state === "sending"} className="rounded-lg bg-oasis px-5 py-3 text-sm font-semibold text-mist transition hover:bg-oasis-deep disabled:opacity-60">
              {w.submit}
            </button>
            {state === "err" && (
              <p role="alert" className="text-sm text-sadu sm:col-span-4">
                {w.err}
              </p>
            )}
          </form>
        )}
      </div>
    </section>
  );
}
