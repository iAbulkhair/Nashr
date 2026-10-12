"use client";
import { Fragment, useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import GoldenPanel from "./GoldenPanel";
import { EndedNotice, STR, useAdminEnded, type SectionProps } from "./shared";

type TM = { type: string; n: number; approved: number; rejected: number; autoApproved: number; approvalRate: number | null; edited: number; editRate: number | null; editMagnitude: number | null; published: number; judged: number; avgScore: number | null; low: number; avgHoursToDecide: number | null };
type AM = { agent: string; n: number; decided: number; autoApproved: number; approvalRate: number | null; reviewedApproved: number; editRate: number | null; judged: number; avgScore: number | null; low: number; thumbsUp: number; thumbsDown: number; types: TM[] };

/** Founder console, Quality (/{lang}/admin/quality): agent quality over 30 days, then the golden set (GoldenPanel). */
export default function Quality({ lang, keySession }: SectionProps) {
  const ended = useAdminEnded();
  const S = STR[lang];
  const [evals, setEvals] = useState<{ agents: AM[]; users: { email: string; label: string; suspended: boolean; archived: boolean; n: number; decided: number; approvalRate: number | null; judged: number; avgScore: number | null }[] } | null>(null);
  useEffect(() => {
    adminFetch("/api/admin/evals").then((r) => r.json()).then((j) => j.ok && setEvals(j)).catch(() => {});
  }, []);
  if (ended) return <EndedNotice lang={lang} keySession={keySession} />;
  return (
    <div className="grid gap-6">
      <section className="card card-sm">
        <h2 className="font-display text-lg font-semibold text-foreground">{S.quality}</h2>
        <p className="text-xs text-foreground-muted">{S.qualityNote}</p>
        {!evals ? <p className="mt-2 text-sm text-foreground-muted">{S.loading}</p> : (
          <div className="overflow-x-auto"><table className="mt-3 w-full text-sm">
            <thead className="bg-background-muted text-left text-xs uppercase tracking-wide text-foreground-muted"><tr><th className="p-2">{S.agentType}</th><th>{S.items}</th><th>{S.approval}</th><th>{S.edited}</th><th>{S.magnitude}</th><th>{S.published}</th><th>{S.judge}</th><th>{S.low}</th><th>{S.hours}</th><th>👍/👎</th></tr></thead>
            <tbody>
              {evals.agents.map((a) => (
                <Fragment key={a.agent}>
                  <tr className="border-t border-foreground/10 bg-background/60 font-medium">
                    <td className="p-2">{a.agent}</td><td className="font-mono">{a.n}{a.autoApproved > 0 && <span className="text-foreground-muted"> ({a.autoApproved} auto)</span>}</td><td className="font-mono">{a.approvalRate ?? "—"}{a.approvalRate !== null && "%"}<span className="text-foreground-muted"> · {a.decided}</span></td><td className="font-mono">{a.editRate ?? "—"}{a.editRate !== null && "%"}<span className="text-foreground-muted"> · {a.reviewedApproved}</span></td><td></td><td></td>
                    <td className={`font-mono ${a.avgScore !== null && a.avgScore < 70 ? "text-danger" : ""}`}>{a.avgScore ?? "—"}<span className="text-foreground-muted"> · {a.judged}</span></td><td className="font-mono">{a.low}/{a.judged}</td><td></td><td className="font-mono">{a.thumbsUp}/{a.thumbsDown}</td>
                  </tr>
                  {a.types.map((x) => (
                    <tr key={a.agent + x.type} className="border-t border-foreground/5 text-foreground-muted">
                      <td className="p-2 ps-6 font-mono text-xs">{x.type}</td><td className="font-mono">{x.n}{x.autoApproved > 0 && <span className="text-foreground-muted"> ({x.autoApproved} auto)</span>}</td><td className="font-mono">{x.approvalRate ?? "—"}{x.approvalRate !== null && "%"}<span className="text-foreground-muted"> · {x.approved + x.rejected}</span></td><td className="font-mono">{x.editRate ?? "—"}{x.editRate !== null && "%"}<span className="text-foreground-muted"> · {x.approved}</span></td><td className="font-mono">{x.editMagnitude ?? "—"}{x.editMagnitude !== null && "%"}</td><td className="font-mono">{x.published}</td>
                      <td className={`font-mono ${x.avgScore !== null && x.avgScore < 70 ? "text-danger" : ""}`}>{x.avgScore ?? "—"}<span className="text-foreground-muted"> · {x.judged}</span></td><td className="font-mono">{x.low}/{x.judged}</td><td className="font-mono">{x.avgHoursToDecide ?? "—"}</td><td></td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table></div>
        )}
        {evals && evals.users.length > 0 && (
          <p className="mt-3 text-xs text-foreground-muted">{S.perWorkspace}: {evals.users.slice(0, 12).map((u) => `${u.label}${u.suspended ? " [suspended]" : ""}${u.archived ? " [archived]" : ""} (${u.n} items, approval ${u.approvalRate ?? "—"}${u.approvalRate !== null ? `% of ${u.decided}` : ""}, judge ${u.avgScore ?? "—"}${u.avgScore !== null ? ` of ${u.judged}` : ""})`).join(" · ")}</p>
        )}
      </section>
      <GoldenPanel lang={lang} />
    </div>
  );
}
