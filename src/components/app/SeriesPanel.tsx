"use client";
import Link from "next/link";
import type { AppDict } from "@/lib/app-i18n";
import { fill } from "@/lib/fill";
import { useOneWrite } from "./useOneWrite";

/** One closed copy of a series as the page shows it: every date already formatted on the server, in the brand's zone. */
export type SeriesRow = { id: string; title: string; due: string | null; closedAt: string | null; result: string; closedBy: string | null };

/**
 * `/app/todo?series={id}`: one recurring series' closed copies (the newest at most `rows.length` of `total`), a Keep
 * history switch and a link to the CSV. An empty `total` is the not-found state: an unknown id, another brand's, or a
 * series with no closed copy. The switch is one write at a time (`useOneWrite`: PUT, then a refresh of the server
 * render); turning it off needs `todo.close`, so for anyone else it is disabled while on (display only: the route
 * answers 403). Everything the rows say is text.
 */
export default function SeriesPanel({ t, id, rows, total, kept, canWrite, canClose, backHref, exportHref }: {
  t: AppDict; id: string; rows: SeriesRow[]; total: number; kept: boolean; canWrite: boolean; canClose: boolean; backHref: string; exportHref: string;
}) {
  const T = t.todo;
  const S = T.series;
  const { busy, error, send } = useOneWrite(t, { not_found: S.notFound });
  const locked = !canWrite || (kept && !canClose);
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="page-title">{S.title}</h1>
      <p className="mt-2"><Link href={backHref} className="btn btn-secondary btn-xs">{S.back}</Link></p>
      {total === 0 ? (
        <p className="mt-6 card text-sm text-ink/60">{S.notFound}</p>
      ) : (
        <>
          <section aria-labelledby="series-keep" className="card mt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="series-keep" className="card-title">{S.keep}</h2>
              <button
                type="button" role="switch" aria-checked={kept} aria-label={S.keep} disabled={!!busy || locked}
                onClick={() => void send("keep", `/api/secretary/series/${id}/keep`, "PUT", { keep: !kept })}
                className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-60 ${kept ? "bg-oasis" : "bg-ink/20"}`}
              >
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${kept ? "start-[22px]" : "start-0.5"}`} />
              </button>
            </div>
            <p className="mt-2 text-xs text-ink/60">{S.keepHint}</p>
            {kept && !canClose && <p className="mt-1 text-xs text-ink/50">{S.keepOffOwner}</p>}
            {error?.key === "keep" && <p role="alert" className="mt-2 text-sm text-sadu">{error.text}</p>}
          </section>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-semibold text-oasis">{S.closed} <span className="tnum text-sm font-normal text-ink/50" dir="ltr">({total})</span></h2>
            <a href={exportHref} download className="btn btn-secondary btn-xs">{S.download}</a>
          </div>
          {rows.length < total && <p className="mt-1 text-xs text-ink/50">{fill(S.shown, { shown: String(rows.length), total: String(total) })}</p>}
          {rows.length === 0 ? <p className="mt-2 text-sm text-ink/60">{S.empty}</p> : (
            <ul className="mt-2 divide-y divide-ink/10 rounded-xl border border-ink/10 bg-white">
              {rows.map((r) => (
                <li key={r.id} className="px-4 py-3">
                  <p className="font-medium" dir="auto">{r.title}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink/60">
                    <span>{r.due ?? T.noDue}</span>
                    {r.closedAt && <span>{S.closedAt}: {r.closedAt}</span>}
                    {r.closedBy && <span dir="auto">{r.closedBy}</span>}
                  </p>
                  {r.result && <p className="mt-1 text-sm text-ink/70" dir="auto"><span className="text-ink/50">{T.result}: </span>{r.result}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
