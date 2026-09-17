"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Notif } from "@/lib/notifications";

export default function NotificationsPanel({ t, initial }: { t: AppDict; initial: Notif[] }) {
  const N = t.notifications;
  const [items, setItems] = useState(initial);
  useEffect(() => {
    if (!initial.some((n) => !n.read)) return;
    const id = setTimeout(() => { fetch("/api/notifications", { method: "POST" }).then(() => setItems((p) => p.map((n) => ({ ...n, read: true })))); }, 1500);
    return () => clearTimeout(id);
  }, [initial]);
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold text-oasis">{N.title}</h1>
      <p className="mt-2 text-ink/70">{N.sub}</p>
      {items.length === 0 ? <p className="mt-6 rounded-xl border border-ink/10 bg-white p-6 text-sm text-ink/60">{N.empty}</p> : (
        <ul className="mt-6 divide-y divide-ink/10 rounded-xl border border-ink/10 bg-white">
          {items.map((n) => (
            <li key={n.id} className={`flex flex-wrap items-start justify-between gap-3 px-4 py-3 ${n.read ? "" : "bg-saffron/5"}`}>
              <div className="min-w-0">
                <p className="text-xs text-ink/50"><span className="rounded bg-oasis/10 px-1.5 py-0.5 text-oasis">{N.kinds[n.kind]}</span>{n.agent && <span className="ms-2">{t.agents[n.agent].name}</span>}<span className="ms-2 font-mono" dir="ltr">{n.at.slice(0, 16).replace("T", " ")}</span></p>
                <p className="mt-1 font-medium" dir="auto">{n.title}</p>
                <p className="text-sm text-ink/70" dir="auto">{n.body}</p>
              </div>
              <Link href={n.href} className="rounded-full border border-oasis/40 px-3 py-1 text-xs text-oasis hover:bg-oasis hover:text-mist">{N.open}</Link>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-ink/50">{N.note}</p>
    </div>
  );
}
