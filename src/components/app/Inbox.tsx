"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import { IMAGE_TYPES } from "@/lib/tasks";
import type { Task } from "@/lib/brand";
import { limitFromError } from "./LimitModal";
import { render } from "@/lib/md";
import { Icon, channelIcon } from "./Icons";
import type { Lang } from "@/lib/i18n";
import { dateFormat } from "@/lib/dates";

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
  // Tasks the owner changed in this session, layered over the server-rendered list.
  const [local, setLocal] = useState<Record<string, Task>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const view = tasks.map((x) => local[x.id] ?? x);
  /** Drop the optimistic copy of one task so the next server render is what the owner sees. */
  const forgetLocal = (id: string) => setLocal((p) => { const next = { ...p }; delete next[id]; return next; });
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
    // `view` renders `local[id] ?? task`, so an entry left over from an earlier approve would mask this task's server
    // copy for ever: the publish landed and the image was generated, but the card never showed either.
    forgetLocal(id);
    r.refresh();
  }
  async function image(id: string) {
    setImaging(id);
    const res = await fetch(`/api/tasks/${id}/image`, { method: "POST" });
    setImaging(null);
    if (!res.ok) { const j = await res.json().catch(() => ({} as { error?: string })); if (!limitFromError(j.error)) alert(i.imageFail); }
    forgetLocal(id);
    r.refresh();
  }

  const shown = view.filter((x) => filter === "all" || x.status === filter);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const dayLabel = (iso: string) => dateFormat(lang, { weekday: "long", month: "long", day: "numeric" }).format(new Date(iso));
  async function share(x: Task, body: string) {
    const text = `${x.title}\n\n${body}`;
    if (navigator.share) { try { await navigator.share({ title: x.title, text }); return; } catch { /* cancelled */ } }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  }

  // The card changes the moment the owner clicks; the server's copy replaces it when it arrives, and a failure puts the
  // old card back with a message. No page refresh: that re-read every task for each click.
  async function patch(id: string, body: Record<string, unknown>) {
    const before = view.find((x) => x.id === id);
    if (!before) return;
    const guess: Task = { ...before, ...(typeof body.status === "string" ? { status: body.status as Task["status"] } : {}), ...(typeof body.editedBody === "string" ? { editedBody: body.editedBody } : {}), ...("scheduledFor" in body ? { scheduledFor: (body.scheduledFor as string | null) ?? undefined } : {}) };
    setLocal((p) => ({ ...p, [id]: guess }));
    setEditing(null);
    setRejecting(null);
    setWhy("");
    setFailed(null);
    try {
      const res = await fetch(`/api/tasks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; task?: Task };
      if (!res.ok || !j.ok || !j.task) throw new Error("patch_failed");
      setLocal((p) => ({ ...p, [id]: j.task! }));
      window.dispatchEvent(new Event("nashr:pending-changed"));
    } catch {
      setLocal((p) => ({ ...p, [id]: before }));
      setFailed(id);
    }
  }

  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-ink/10 text-sm">
        <Link href={`/${lang}/app/chat`} className="px-4 py-2 text-ink/60 hover:text-oasis">{i.tabChat}</Link>
        <span className="border-b-2 border-oasis px-4 py-2 font-semibold text-oasis">{i.tabFeed} <span className="badge badge-accent ms-1">{t.nav.newBadge}</span></span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="page-title">{i.title}</h1>
        <div className="flex gap-1 text-sm">
          {(["pending", "approved", "rejected", "all"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`rounded-full px-3 py-1 ${filter === f ? "bg-oasis text-mist" : "bg-salt-dim"}`}>
              {i[f]} {f !== "all" && <span className="font-mono text-xs">({view.filter((x) => x.status === f).length})</span>}
            </button>
          ))}
        </div>
      </div>

      {brief && (
        <div className="mt-5 flex gap-3 rounded-xl border border-saffron/40 bg-saffron/10 p-4 text-sm" dir="auto">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-oasis font-display font-bold text-saffron" aria-hidden>{t.agents.noor.name.charAt(0)}</span>
          <div><p className="mb-1 text-xs font-semibold text-sadu-deep">{i.brief}</p><pre className="whitespace-pre-wrap font-body leading-relaxed">{brief}</pre></div>
        </div>
      )}
      {shown.length === 0 && (
        <div className="mt-10 rounded-xl border border-dashed border-ink/20 p-10 text-center text-ink/60">
          <p>{i.empty}</p>
          <Link href={`/${lang}/app/generate`} className="mt-4 inline-block rounded-full bg-saffron px-5 py-2 font-semibold text-ink">{i.regenerate}</Link>
        </div>
      )}

      <ul className="mt-6 grid gap-4">
        {shown.map((x, idx) => {
          const body = x.editedBody ?? x.body;
          const day = x.createdAt.slice(0, 10);
          const newDay = idx === 0 || shown[idx - 1].createdAt.slice(0, 10) !== day;
          const isCollapsed = !!collapsed[x.id];
          return (
            <li key={x.id} className="grid gap-4">
              {newDay && <p className="flex items-center gap-3 text-xs text-ink/70"><span className="sadu-thin h-1 flex-1 rounded-full opacity-60" /><span className="rounded-full border border-ink/10 bg-white px-3 py-1" suppressHydrationWarning>{dayLabel(x.createdAt)}</span><span className="sadu-thin h-1 flex-1 rounded-full opacity-60" /></p>}
              <article className="card overflow-hidden p-0">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink/5 px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Icon name={channelIcon(x.channel)} className="h-4 w-4 shrink-0 text-oasis" />
                  <span className="font-semibold">{(t.channelNames as Record<string, string>)[x.channel] ?? x.channel}</span>
                  <span className="text-sm text-ink/70" dir="auto">· {x.title}</span>
                </div>
                <span className="flex items-center gap-2 text-xs">
                  {x.quality && <span title={x.quality.notes} className={`tnum rounded-full px-2 py-0.5 ${x.quality.score >= 85 ? "bg-oasis/10 text-oasis" : x.quality.score >= 70 ? "bg-saffron/20 text-ink" : "bg-sadu/10 text-sadu-deep"}`} dir="ltr">{i.quality} {x.quality.score}</span>}
                  <span className={`badge ${x.status === "approved" ? "badge-primary" : x.status === "rejected" ? "badge-danger" : "badge-accent"}`}>{i[x.status]}</span>
                </span>
              </div>
              <div className="px-4 pb-3">
              {x.published && x.published.length > 0 && (
                <p className="mt-2 text-xs text-oasis">{x.published.map((p) => <a key={p.url} href={p.url} target="_blank" rel="noreferrer" className="me-3 underline">{p.status === "draft" ? i.draftOn : i.published} {p.provider} ↗</a>)}</p>
              )}
              {x.imageUrl && (
                <div className="mt-3 flex items-start gap-3">
                  {/* Deliberately not next/image. These URLs come from the image provider and from placehold.co, so
                      optimising them means allowing arbitrary remote hosts in remotePatterns and paying to proxy
                      third-party images we already pay to generate. */}
                  {/* eslint-disable-next-line @next/next/no-img-element -- third-party image host, not a local asset */}
                  <img loading="lazy" decoding="async" src={x.imageUrl} alt="" className="h-40 w-40 rounded-lg object-cover" />
                  <div className="text-xs text-ink/50">{x.imageProvider === "placeholder" && <p className="mb-1 rounded-full bg-saffron/20 px-2 py-0.5 font-semibold text-sadu-deep" dir="auto">{i.placeholder}</p>}<a href={x.imageUrl} target="_blank" rel="noreferrer" className="underline">{i.download}</a>{x.imagePrompt && <p className="mt-1 line-clamp-4" dir="ltr">{x.imagePrompt}</p>}</div>
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
                <>{!isCollapsed && <div className="prose-nashr prose-compact mt-3 text-sm text-ink/90" dir="auto" dangerouslySetInnerHTML={{ __html: render(body) }} />}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className={`tnum text-xs ${CHAR_LIMITS[x.channel] && body.length > CHAR_LIMITS[x.channel] ? "font-semibold text-sadu-deep" : "text-ink/60"}`} dir="ltr">{body.length}{CHAR_LIMITS[x.channel] ? ` / ${CHAR_LIMITS[x.channel]}` : ""}</span>
                  <span className="ms-auto flex gap-1.5">
                    <button onClick={() => setCollapsed((p) => ({ ...p, [x.id]: !isCollapsed }))} className="btn btn-secondary btn-xs">{isCollapsed ? "▾ " + i.expand : "▴ " + i.collapse}</button>
                    <button onClick={async () => { await navigator.clipboard.writeText(body); setCopied(x.id); setTimeout(() => setCopied(null), 1500); }} className="btn btn-secondary btn-xs">{copied === x.id ? i.copied : "⧉ " + i.copy}</button>
                    <button onClick={() => share(x, body)} className="btn btn-secondary btn-xs">↗ {i.share}</button>
                  </span>
                </div></>
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
              </div>
              {editing !== x.id && rejecting !== x.id && (
                <div className="flex flex-wrap items-center gap-2 border-t border-ink/5 bg-salt px-4 py-3 text-sm">
                  {failed === x.id && <p role="alert" className="w-full text-sm text-sadu-deep">{lang === "ar" ? "لم يُحفظ التغيير. تحقق من الاتصال وحاول مرة أخرى." : "The change was not saved. Check your connection and try again."}</p>}
                  {x.status !== "approved" && <button onClick={() => patch(x.id, { status: "approved" })} className="btn btn-primary btn-pill">{i.approve}</button>}
                  <button onClick={() => { setEditing(x.id); setDraft(body); }} className="btn btn-secondary btn-pill">{i.edit}</button>
                  {x.status !== "rejected" && <button onClick={() => setRejecting(x.id)} className="btn btn-danger btn-pill">{i.reject}</button>}
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
              {(editing === x.id || rejecting === x.id) && <div className="pb-3" />}
              </article>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
