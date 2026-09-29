"use client";
import { targetsFor } from "@/lib/connectors/targets";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import { IMAGE_TYPES } from "@/lib/tasks";
import type { Task } from "@/lib/brand";
import { limitFromError } from "./LimitModal";
import { render } from "@/lib/md";
import { Icon, channelIcon } from "./Icons";
import type { Lang } from "@/lib/i18n";
import { dateFormat } from "@/lib/dates";
import { brandRules, checkText, isCustomerFacing, textOf, type Violation } from "@/lib/brand-rules";
import type { Journey } from "@/lib/journey";
import JourneyCard, { milestone } from "./JourneyCard";

const GUARD = {
  ar: { code: "كود الإعلان", codeHint: "ضعه في اسم الإعلان في مدير الإعلانات، فتقيس نور نتيجته حين تصل.", copyCode: "نسخ الكود", ok: "يطابق حارس العلامة", held: "محجوز بحارس العلامة", heldBody: "يحتوي على كلمة ممنوعة في ملف علامتك، فلا يُعتمد ولا يُنشر حتى تعدّله:", fix: "عدّل النص", live: "فحص مباشر", liveOk: "لا كلمات ممنوعة. جاهز للاعتماد.", saveDraft: "احفظ دون اعتماد", rule: "قاعدة الكلمات الممنوعة", editBrand: "ملف العلامة" },
  en: { code: "Ad code", codeHint: "Put it in the ad's name in your ads manager, and Noor measures its results when they come in.", copyCode: "Copy code", ok: "Passes brand guard", held: "Held by brand guard", heldBody: "It contains a word your brand file bans, so it cannot be approved or published until you edit it:", fix: "Fix the text", live: "Live check", liveOk: "No banned words. Ready to approve.", saveDraft: "Save without approving", rule: "Banned-words rule", editBrand: "Brand file" },
} as const;

/** The matched word inside its excerpt, highlighted (both come from the same checker the server runs). */
function Hit({ v }: { v: Violation }) {
  const i = v.excerpt.toLowerCase().indexOf(v.term.toLowerCase());
  if (i < 0) return <span dir="auto">{v.excerpt}</span>;
  return <span dir="auto">{v.excerpt.slice(0, i)}<mark className="guard-hit text-inherit">{v.excerpt.slice(i, i + v.term.length)}</mark>{v.excerpt.slice(i + v.term.length)}</span>;
}

const CHAR_LIMITS: Record<string, number> = { instagram: 2200, x: 280, snapchat: 250, tiktok: 2200, whatsapp: 1024, gbp: 1500, linkedin: 3000 };

/**
 * `canPublish` is `can(u, "publish")` from the page (approve and publish are admin and owner). Without it the inbox offers
 * what a plain member may do, edit and reject, and never a control the server would refuse: an edit is saved without
 * approving (an approved item goes back to pending), and Approve and Publish give way to a note.
 */
export default function Inbox({ t, lang, tasks, brief, connected = [], banned = "", journey, canPublish = true }: { t: AppDict; lang: Lang; tasks: Task[]; brief?: string | null; connected?: string[]; banned?: string; journey?: Journey; canPublish?: boolean }) {
  const i = t.inbox;
  const G = GUARD[lang];
  // The brand file's rules, applied here exactly as the approve and publish routes apply them.
  const rules = useMemo(() => brandRules({ banned }), [banned]);
  const held = (x: Pick<Task, "type" | "title" | "body" | "editedBody">) => (isCustomerFacing(x.type) ? checkText(rules, textOf(x)) : []);
  const [refused, setRefused] = useState<Record<string, Violation[]>>({});
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
  /** The card whose last change was refused, and why: a role refusal is never reported as a connection problem. */
  const [failed, setFailed] = useState<{ id: string; why: "forbidden" | "network" } | null>(null);
  const view = tasks.map((x) => local[x.id] ?? x);
  /** Drop the optimistic copy of one task so the next server render is what the owner sees. */
  const forgetLocal = (id: string) => setLocal((p) => { const next = { ...p }; delete next[id]; return next; });
  // The same rule the publish route enforces (src/lib/connectors/targets.ts), so a button never offers a refused target.
  // Publishing is admin and owner only (src/lib/roles.ts "publish"), so a member is offered no target at all.
  const targets = (x: Task) => (canPublish ? targetsFor(x, connected) : []);

  async function publish(id: string, provider: string) {
    setPublishing(id + provider);
    const res = await fetch(`/api/publish/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) });
    setPublishing(null);
    if (res.ok) milestone("publish");
    else {
      const j = (await res.json().catch(() => ({}))) as { error?: string; violations?: Violation[] };
      if (j.error === "brand_violation" && j.violations) setRefused((p) => ({ ...p, [id]: j.violations! }));
      else alert(res.status === 403 ? t.team.errors.forbidden : i.publishFail);
    }
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
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; task?: Task; error?: string; violations?: Violation[] };
      if (res.status === 409 && j.error === "brand_violation") {
        // Held by the brand rules on the server: put the card back as it was and, for an edit, reopen the editor.
        setLocal((p) => ({ ...p, [id]: before }));
        setRefused((p) => ({ ...p, [id]: j.violations ?? [] }));
        if (typeof body.editedBody === "string") { setEditing(id); setDraft(body.editedBody); }
        return;
      }
      if (res.status === 403) {
        // Refused for the role: say so, and give an edit back to its editor rather than dropping the typed text.
        setLocal((p) => ({ ...p, [id]: before }));
        setFailed({ id, why: "forbidden" });
        if (typeof body.editedBody === "string") { setEditing(id); setDraft(body.editedBody); }
        return;
      }
      if (!res.ok || !j.ok || !j.task) throw new Error("patch_failed");
      setLocal((p) => ({ ...p, [id]: j.task! }));
      setRefused((p) => { const n = { ...p }; delete n[id]; return n; });
      if (j.task.status === "approved" && before.status !== "approved") milestone("approve");
      if (typeof body.scheduledFor === "string") milestone("schedule");
      window.dispatchEvent(new Event("nashr:pending-changed"));
    } catch {
      setLocal((p) => ({ ...p, [id]: before }));
      setFailed({ id, why: "network" });
      if (typeof body.editedBody === "string") { setEditing(id); setDraft(body.editedBody); }
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

      {journey && <div className="mt-5"><JourneyCard journey={journey} lang={lang} /></div>}
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
          const hits = refused[x.id]?.length ? refused[x.id] : held(x);
          const guarded = rules.length > 0 && isCustomerFacing(x.type);
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
                  {guarded && <span title={hits.length ? G.held : G.ok} className={`flex items-center gap-1 rounded-full px-2 py-0.5 ${hits.length ? "bg-sadu/10 font-semibold text-sadu-deep" : "bg-oasis/10 text-oasis"}`}><Icon name="shield" className="h-3.5 w-3.5" />{hits.length ? G.held : G.ok}</span>}
                  {x.quality && <span title={x.quality.notes} className={`tnum rounded-full px-2 py-0.5 ${x.quality.score >= 85 ? "bg-oasis/10 text-oasis" : x.quality.score >= 70 ? "bg-saffron/20 text-ink" : "bg-sadu/10 text-sadu-deep"}`} dir="ltr">{i.quality} {x.quality.score}</span>}
                  <span className={`badge ${x.status === "approved" ? "badge-primary" : x.status === "rejected" ? "badge-danger" : "badge-accent"}`}>{i[x.status]}</span>
                </span>
              </div>
              <div className="px-4 pb-3">
              {x.published && x.published.length > 0 && (
                <p className="mt-2 text-xs text-oasis">{x.published.map((p) => <a key={p.url} href={p.url} target="_blank" rel="noreferrer" className="me-3 underline">{p.status === "draft" ? i.draftOn : i.published} {p.provider} ↗</a>)}</p>
              )}
              {hits.length > 0 && editing !== x.id && (
                <div role="alert" className="mt-3 rounded-lg border border-sadu/30 bg-sadu/5 p-3 text-sm">
                  <p className="flex items-center gap-1.5 font-semibold text-sadu-deep"><Icon name="shield" className="h-4 w-4" />{G.held} · <span className="font-normal">{G.rule}</span></p>
                  <p className="mt-1 text-ink/70">{G.heldBody}</p>
                  <ul className="mt-1.5 grid gap-1">{hits.map((v) => <li key={v.ruleId} className="text-xs text-ink/80"><span className="font-semibold" dir="auto">«{v.term}»</span> · <Hit v={v} /></li>)}</ul>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button onClick={() => { setEditing(x.id); setDraft(body); }} className="btn btn-primary btn-xs">{G.fix}</button>
                    <Link href={`/${lang}/app/onboarding`} className="btn btn-secondary btn-xs">{G.editBrand}</Link>
                  </div>
                </div>
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
                  {(() => {
                    const live = guarded ? held({ ...x, editedBody: draft }) : [];
                    return (
                      <>
                        {guarded && (
                          <p aria-live="polite" className={`flex flex-wrap items-center gap-1.5 text-xs ${live.length ? "text-sadu-deep" : "text-oasis"}`}>
                            <Icon name="shield" className="h-3.5 w-3.5" /><span className="font-semibold">{G.live}:</span>
                            {live.length ? live.map((v) => <span key={v.ruleId} className="guard-hit font-semibold" dir="auto">{v.term}</span>) : <span>{G.liveOk}</span>}
                          </p>
                        )}
                        {failed?.id === x.id && <p role="alert" className="text-sm text-sadu-deep">{failed.why === "forbidden" ? t.team.errors.forbidden : lang === "ar" ? "لم يُحفظ التغيير. تحقق من الاتصال وحاول مرة أخرى." : "The change was not saved. Check your connection and try again."}</p>}
                        <div className="flex flex-wrap gap-2">
                          {canPublish ? (
                            <>
                              <button disabled={live.length > 0} title={live.length ? G.held : undefined} onClick={() => patch(x.id, { editedBody: draft, status: "approved" })} className="btn btn-primary btn-pill">{i.save}</button>
                              {live.length > 0 && <button onClick={() => patch(x.id, { editedBody: draft, status: "pending" })} className="btn btn-secondary btn-pill">{G.saveDraft}</button>}
                            </>
                          ) : (
                            // A member's edit never approves: it is saved as it stands, and an approved item goes back to
                            // pending so an admin sees the new text before anything is published.
                            <button onClick={() => patch(x.id, { editedBody: draft, ...(x.status === "approved" ? { status: "pending" } : {}) })} className="btn btn-primary btn-pill">{x.status === "approved" ? i.saveReopen : i.saveEdit}</button>
                          )}
                          <button onClick={() => { setEditing(null); setFailed(null); }} className="btn btn-secondary btn-pill">{i.cancel}</button>
                        </div>
                      </>
                    );
                  })()}
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
                  {failed?.id === x.id && <p role="alert" className="w-full text-sm text-sadu-deep">{failed.why === "forbidden" ? t.team.errors.forbidden : lang === "ar" ? "لم يُحفظ التغيير. تحقق من الاتصال وحاول مرة أخرى." : "The change was not saved. Check your connection and try again."}</p>}
                  {x.status !== "approved" && canPublish && <button disabled={hits.length > 0} title={hits.length ? G.held : undefined} onClick={() => patch(x.id, { status: "approved" })} className="btn btn-primary btn-pill">{i.approve}</button>}
                  {x.status === "pending" && !canPublish && <p className="w-full text-xs text-ink/60">{i.waitAdmin}</p>}
                  <button onClick={() => { setEditing(x.id); setDraft(body); }} className="btn btn-secondary btn-pill">{i.edit}</button>
                  {x.status !== "rejected" && <button onClick={() => setRejecting(x.id)} className="btn btn-danger btn-pill">{i.reject}</button>}
                  {x.type === "board_deck" && (
                    <a href={`/api/tasks/${x.id}/pptx`} className="btn btn-accent btn-pill">{i.pptx}</a>
                  )}
                  {IMAGE_TYPES.includes(x.type) && (
                    <button disabled={imaging === x.id} onClick={() => image(x.id)} className="rounded-full border border-saffron px-4 py-1.5 disabled:opacity-50">{imaging === x.id ? i.imaging : (x.imageUrl ? "↻ " : "") + i.image}</button>
                  )}
                  {x.channel === "instagram" && connected.includes("instagram") && x.imageProvider !== "fal" && <p className="w-full text-xs text-ink/60">{i.igNeedsImage}</p>}
                  {x.adCode && (
                    <span title={G.codeHint} className="flex items-center gap-1 rounded-full border border-dashed border-oasis/40 bg-white px-2 py-1 text-xs">
                      <span className="text-ink/60">{G.code}</span>
                      <span className="font-mono font-semibold text-oasis" dir="ltr">{x.adCode}</span>
                      <button onClick={async () => { await navigator.clipboard.writeText(x.adCode!); setCopied(x.adCode!); setTimeout(() => setCopied(null), 1500); }} aria-label={G.copyCode} className="rounded-full px-1 text-oasis hover:bg-oasis/10">{copied === x.adCode ? "✓" : <Icon name="copy" className="h-3.5 w-3.5" />}</button>
                    </span>
                  )}
                  {targets(x).map((p) => (
                    <button key={p} disabled={publishing === x.id + p || hits.length > 0} onClick={() => publish(x.id, p)} className="btn btn-primary btn-pill">{publishing === x.id + p ? i.publishing : `${i.publishTo} ${p}`}</button>
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
