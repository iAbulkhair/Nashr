"use client";
import Link from "next/link";
import type { AppDict } from "@/lib/app-i18n";
import { fill } from "@/lib/fill";
import { useOneWrite } from "./useOneWrite";
import Scribble from "@/components/Scribble";
import Switch from "@/components/ui/Switch";

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
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="seriespanel-t1" />{S.title}</span></h1>
      <p className="mt-2"><Link href={backHref} className="btn btn-secondary btn-xs">{S.back}</Link></p>
      {total === 0 ? (
        <p className="mt-6 card text-sm text-muted">{S.notFound}</p>
      ) : (
        <>
          <section aria-labelledby="series-keep" className="card mt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="series-keep" className="card-title">{S.keep}</h2>
              <Switch
                checked={kept} labelledBy="series-keep" disabled={!!busy || locked}
                onChange={(next) => void send("keep", `/api/secretary/series/${id}/keep`, "PUT", { keep: next })}
              />
            </div>
            <p className="mt-2 text-xs text-muted">{S.keepHint}</p>
            {kept && !canClose && <p className="mt-1 text-xs text-muted">{S.keepOffOwner}</p>}
            {error?.key === "keep" && <p role="alert" className="mt-2 text-sm text-danger">{error.text}</p>}
          </section>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-semibold text-ink">{S.closed} <span className="tnum text-sm font-normal text-muted" dir="ltr">({total})</span></h2>
            <a href={exportHref} download className="btn btn-secondary btn-xs">{S.download}</a>
          </div>
          {rows.length < total && <p className="mt-1 text-xs text-muted">{fill(S.shown, { shown: String(rows.length), total: String(total) })}</p>}
          {rows.length === 0 ? <p className="mt-2 text-sm text-muted">{S.empty}</p> : (
            <ul className="mt-2 divide-y divide-ink/10 rounded-xl border border-ink/10 bg-white">
              {rows.map((r) => (
                <li key={r.id} className="px-4 py-3">
                  <p className="font-medium" dir="auto">{r.title}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <span>{r.due ?? T.noDue}</span>
                    {r.closedAt && <span>{S.closedAt}: {r.closedAt}</span>}
                    {r.closedBy && <span dir="auto">{r.closedBy}</span>}
                  </p>
                  {r.result && <p className="mt-1 text-sm text-ink/70" dir="auto"><span className="text-muted">{T.result}: </span>{r.result}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
