"use client";
import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import { EndedNotice, OV, STR, useAdminEnded, type SectionProps } from "./shared";

/** Founder console, Audit log (/{lang}/admin/log): every founder action with before/after and the reason. */
export default function Log({ lang, keySession }: SectionProps) {
  const ended = useAdminEnded();
  const S = STR[lang];
  const O = OV[lang];
  const [log, setLog] = useState<{ actor?: string; email: string; what: string; reason?: string; before?: unknown; after?: unknown; at: string }[] | null>(null);
  useEffect(() => {
    adminFetch("/api/admin/log").then((r) => r.json()).then((j) => j.ok && setLog(j.log)).catch(() => {});
  }, []);
  if (ended) return <EndedNotice lang={lang} keySession={keySession} />;
  return (
        <section className="card card-sm"><h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{O.log}</h2>
          {!log ? <p className="mt-2 text-sm text-muted">{S.loading}</p> : log.length === 0 ? <p className="mt-2 text-sm text-muted">—</p> : (
            <div className="overflow-x-auto"><table className="mt-2 w-full text-xs"><thead className="text-muted"><tr><th className="p-1 text-start">at</th><th className="text-start">user</th><th className="text-start">action</th><th className="text-start">before → after</th><th className="text-start">reason</th></tr></thead>
              <tbody>{log.map((l, i) => <tr key={i} className="border-t border-ink/5"><td className="tnum p-1" dir="ltr">{l.at.slice(0, 16).replace("T", " ")}</td><td dir="ltr">{l.email}</td><td>{l.what}</td><td className="tnum" dir="ltr">{l.before !== undefined ? `${JSON.stringify(l.before)} → ${JSON.stringify(l.after)}` : ""}</td><td dir="auto">{l.reason ?? ""}</td></tr>)}</tbody></table></div>
          )}
        </section>
  );
}
