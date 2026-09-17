"use client";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Integration } from "@/lib/integrations";

export default function IntegrationsPanel({ t, items }: { t: AppDict; items: Integration[] }) {
  const g = t.integrations;
  const [done, setDone] = useState<Record<string, number>>({});
  const [other, setOther] = useState("");
  async function req(id: string, name: string) {
    const res = await fetch("/api/integrations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, name }) });
    const j = await res.json();
    if (j.ok) setDone((d) => ({ ...d, [id]: j.votes }));
  }
  const groups = ["commerce", "ads", "messaging", "publishing", "data", "payments"] as const;
  const badge = (s: Integration["status"]) => (s === "live" ? "bg-oasis text-mist" : s === "soon" ? "bg-saffron/20 text-ink" : "bg-ink/10 text-ink/60");
  return (
    <div>
      <h1 className="font-display text-3xl font-bold text-oasis">{g.title}</h1>
      <p className="mt-2 text-ink/70">{g.sub}</p>
      <p className="mt-2 rounded-lg border border-saffron/40 bg-saffron/10 p-3 text-sm">{g.note}</p>
      {groups.map((grp) => (
        <section key={grp} className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-sadu">{g.groups[grp]}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.filter((i) => i.group === grp).map((i) => (
              <div key={i.id} className="flex items-start justify-between gap-3 rounded-xl border border-ink/10 bg-white p-4">
                <div>
                  <p className="font-display font-medium">{i.name}</p>
                  {i.note && <p className="mt-1 text-xs text-ink/60">{i.note}</p>}
                  <span className={`mt-2 inline-block rounded px-2 py-0.5 text-[11px] ${badge(i.status)}`}>{g.status[i.status]}</span>
                </div>
                {i.status !== "live" && (
                  <button onClick={() => req(i.id, i.name)} disabled={!!done[i.id]} className="shrink-0 rounded-full border border-oasis/40 px-3 py-1 text-xs text-oasis disabled:border-ink/10 disabled:text-ink/40">{done[i.id] ? `${g.requested} · ${done[i.id]}` : g.request}</button>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
      <form onSubmit={(e) => { e.preventDefault(); if (other.trim()) { req("other:" + other.trim().toLowerCase(), other.trim()); setOther(""); } }} className="mt-8 flex max-w-md gap-2">
        <input value={other} onChange={(e) => setOther(e.target.value)} placeholder={g.other} className="flex-1 rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm" />
        <button className="rounded-lg bg-oasis px-4 py-2 text-sm font-semibold text-mist">{g.send}</button>
      </form>
    </div>
  );
}
