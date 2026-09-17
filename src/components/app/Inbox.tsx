"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import { IMAGE_TYPES, type Task } from "@/lib/brand";
import { limitFromError } from "./LimitModal";
import type { Lang } from "@/lib/i18n";

const CHAR_LIMITS: Record<string, number> = { instagram: 2200, x: 280, snapchat: 250, tiktok: 2200, whatsapp: 1024, gbp: 1500, linkedin: 3000 };

export default function Inbox({ t, lang, tasks, brief, connected = [] }: { t: AppDict; lang: Lang; tasks: Task[]; brief?: string | null; connected?: string[] }) {
  const i = t.inbox;
  const r = useRouter();
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "all">("pending");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [imaging, setImaging] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const targets = (x: Task) => {
    const out: string[] = [];
    if (x.type === "article") for (const p of ["wordpress", "shopify"]) if (connected.includes(p)) out.push(p);
    if (x.type === "social" && x.channel === "x" && connected.includes("x")) out.push("x");
    if ((x.type === "social" || x.type === "gbp" || x.type === "whatsapp") && connected.includes("telegram")) out.push("telegram");
    return out;
  };
  async function publish(id: string, provider: string) {
    setPublishing(id + provider);
    const res = await fetch(`/api/publish/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) });
    setPublishing(null);
    if (!res.ok) alert(i.publishFail);
    r.refresh();
  }
  async function image(id: string) {
    setImaging(id);
    const res = await fetch(`/api/tasks/${id}/image`, { method: "POST" });
    setImaging(null);
    if (!res.ok) { const j = await res.json().catch(() => ({} as { error?: string })); if (!limitFromError(j.error)) alert(i.imageFail); }
    r.refresh();
  }

  const shown = tasks.filter((x) => filter === "all" || x.status === filter);

  async function patch(id: string, body: Record<string, unknown>) {
    await fetch(`/api/tasks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setEditing(null);
    setRejecting(null);
    setWhy("");
    r.refresh();
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="page-title">{i.title}</h1>
        <div className="flex gap-1 text-sm">
          {(["pending", "approved", "rejected", "all"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`rounded-full px-3 py-1 ${filter === f ? "bg-oasis text-mist" : "bg-salt-dim"}`}>
              {i[f]} {f !== "all" && <span className="font-mono text-xs">({tasks.filter((x) => x.status === f).length})</span>}
            </button>
          ))}
        </div>
      </div>

      {brief && (
        <div className="mt-5 rounded-xl border border-saffron/40 bg-saffron/10 p-4 text-sm" dir="auto">
          <p className="mb-1 text-xs font-semibold text-sadu">{i.brief}</p>
          <pre className="whitespace-pre-wrap font-body leading-relaxed">{brief}</pre>
        </div>
      )}
      {shown.length === 0 && (
        <div className="mt-10 rounded-xl border border-dashed border-ink/20 p-10 text-center text-ink/60">
          <p>{i.empty}</p>
          <Link href={`/${lang}/app/generate`} className="mt-4 inline-block rounded-full bg-saffron px-5 py-2 font-semibold text-ink">{i.regenerate}</Link>
        </div>
      )}

      <ul className="mt-6 grid gap-4">
        {shown.map((x) => {
          const body = x.editedBody ?? x.body;
          return (
            <li key={x.id} className="card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="badge badge-primary">{x.channel}</span>
                  <span className="font-display font-medium">{x.title}</span>
                </div>
                <span className="flex items-center gap-2 text-xs">
                  {x.quality && <span title={x.quality.notes} className={`rounded-full px-2 py-0.5 font-mono ${x.quality.score >= 85 ? "bg-oasis/10 text-oasis" : x.quality.score >= 70 ? "bg-saffron/20 text-ink" : "bg-sadu/10 text-sadu"}`} dir="ltr">{i.quality} {x.quality.score}</span>}
                  <span className={x.status === "approved" ? "text-oasis" : x.status === "rejected" ? "text-sadu" : "text-ink/50"}>{i[x.status]}</span>
                </span>
              </div>
              {x.published && x.published.length > 0 && (
                <p className="mt-2 text-xs text-oasis">{x.published.map((p) => <a key={p.url} href={p.url} target="_blank" rel="noreferrer" className="me-3 underline">{p.status === "draft" ? i.draftOn : i.published} {p.provider} ↗</a>)}</p>
              )}
              {x.imageUrl && (
                <div className="mt-3 flex items-start gap-3">
                  <img src={x.imageUrl} alt="" className="h-40 w-40 rounded-lg object-cover" />
                  <div className="text-xs text-ink/50"><a href={x.imageUrl} target="_blank" rel="noreferrer" className="underline">{i.download}</a>{x.imagePrompt && <p className="mt-1 line-clamp-4" dir="ltr">{x.imagePrompt}</p>}</div>
                </div>
              )}
              {editing === x.id ? (
                <div className="mt-3 grid gap-2">
                  <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={10} className="w-full rounded-lg border border-ink/15 p-3 text-sm" />
                  <div className="flex gap-2">
                    <button onClick={() => patch(x.id, { editedBody: draft, status: "approved" })} className="rounded-full bg-oasis px-4 py-1.5 text-sm font-semibold text-mist">{i.save}</button>
                    <button onClick={() => setEditing(null)} className="btn btn-secondary btn-pill">{i.cancel}</button>
                  </div>
                </div>
              ) : (
                <><pre className="mt-3 whitespace-pre-wrap font-body text-sm leading-relaxed text-ink/90">{body}</pre><p className={`mt-1 font-mono text-[10px] ${CHAR_LIMITS[x.channel] && body.length > CHAR_LIMITS[x.channel] ? "text-sadu" : "text-ink/40"}`} dir="ltr">{body.length}{CHAR_LIMITS[x.channel] ? ` / ${CHAR_LIMITS[x.channel]}` : ""}</p></>
              )}
              {rejecting === x.id && (
                <div className="mt-3 grid gap-2">
                  <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder={i.why} className="w-full rounded-lg border border-ink/15 p-2 text-sm" />
                  <div className="flex gap-2">
                    <button onClick={() => patch(x.id, { status: "rejected", note: why })} className="btn btn-danger-solid btn-pill">{i.reject}</button>
                    <button onClick={() => setRejecting(null)} className="btn btn-secondary btn-pill">{i.cancel}</button>
                  </div>
                </div>
              )}
              {editing !== x.id && rejecting !== x.id && (
                <div className="mt-4 flex flex-wrap gap-2 text-sm">
                  {x.status !== "approved" && <button onClick={() => patch(x.id, { status: "approved" })} className="btn btn-primary btn-pill">{i.approve}</button>}
                  <button onClick={() => { setEditing(x.id); setDraft(body); }} className="btn btn-secondary btn-pill">{i.edit}</button>
                  {x.status !== "rejected" && <button onClick={() => setRejecting(x.id)} className="btn btn-danger btn-pill">{i.reject}</button>}
                  <button onClick={async () => { await navigator.clipboard.writeText(body); setCopied(x.id); setTimeout(() => setCopied(null), 1500); }} className="btn btn-secondary btn-pill">
                    {copied === x.id ? i.copied : i.copy}
                  </button>
                  {x.type === "board_deck" && (
                    <a href={`/api/tasks/${x.id}/pptx`} className="btn btn-accent btn-pill">{i.pptx}</a>
                  )}
                  {IMAGE_TYPES.includes(x.type) && (
                    <button disabled={imaging === x.id} onClick={() => image(x.id)} className="rounded-full border border-saffron px-4 py-1.5 disabled:opacity-50">{imaging === x.id ? i.imaging : (x.imageUrl ? "↻ " : "") + i.image}</button>
                  )}
                  {targets(x).map((p) => (
                    <button key={p} disabled={publishing === x.id + p} onClick={() => publish(x.id, p)} className="btn btn-primary btn-pill">{publishing === x.id + p ? i.publishing : `${i.publishTo} ${p}`}</button>
                  ))}
                  <label className="ms-auto flex items-center gap-1 text-xs text-ink/60">
                    {i.date}
                    <input type="date" dir="ltr" defaultValue={x.scheduledFor ?? ""} onChange={(e) => patch(x.id, { scheduledFor: e.target.value || null })} className="rounded border border-ink/15 px-2 py-1 text-xs" />
                  </label>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
