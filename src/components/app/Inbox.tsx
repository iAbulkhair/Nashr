"use client";
import { targetsFor } from "@/lib/connectors/targets";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Task } from "@/lib/brand";
import { hasArtwork, isOurBlobUrl, type MediaModelId } from "@/lib/media-catalog";
import MediaControls from "./MediaControls";
import { render } from "@/lib/md";
import { Icon, channelIcon } from "./Icons";
import type { Lang } from "@/lib/i18n";
import { dateFormat } from "@/lib/dates";
import { brandRules, gateTask, isCustomerFacing, type Violation } from "@/lib/brand-rules";
import type { Journey } from "@/lib/journey";
import JourneyCard, { milestone } from "./JourneyCard";
import { isAgentId } from "@/lib/agents";

const GUARD = {
  ar: { code: "كود الإعلان", codeHint: "ضعه في اسم الإعلان في مدير الإعلانات، فتقيس نور نتيجته حين تصل.", copyCode: "نسخ الكود", ok: "يطابق حارس العلامة", held: "محجوز بحارس العلامة", heldBody: "يحتوي على كلمة ممنوعة في ملف علامتك، فلا يُعتمد ولا يُنشر حتى تعدّله:", heldPh: "فيه خانات لم تُعبّأ بعد (مثل [رقم] أو [date])، فلا يُعتمد ولا يُنشر حتى تضع القيمة الحقيقية مكانها أو تحذفها:", fix: "عدّل النص", live: "فحص مباشر", liveOk: "لا كلمات ممنوعة ولا خانات فارغة. جاهز للاعتماد.", saveDraft: "احفظ دون اعتماد", rule: "قاعدة الكلمات الممنوعة", rulePh: "قاعدة الخانات الفارغة", editBrand: "ملف العلامة" },
  en: { code: "Ad code", codeHint: "Put it in the ad's name in your ads manager, and Noor measures its results when they come in.", copyCode: "Copy code", ok: "Passes brand guard", held: "Held by brand guard", heldBody: "It contains a word your brand file bans, so it cannot be approved or published until you edit it:", heldPh: "It has placeholders nobody filled in yet (like [رقم] or [date]), so it cannot be approved or published until you put in the real value or remove them:", fix: "Fix the text", live: "Live check", liveOk: "No banned words or empty placeholders. Ready to approve.", saveDraft: "Save without approving", rule: "Banned-words rule", rulePh: "Empty-placeholder rule", editBrand: "Brand file" },
} as const;

/** A second publish to the same platform, or one after a publish whose result never came back: the owner decides. */
const AGAIN = {
  ar: { already: (p: string) => `نُشر هذا العنصر على ${p} من قبل. هل يُنشر مرة ثانية؟`, unknown: (p: string) => `محاولة النشر على ${p} انتهت دون رد، فقد يكون المنشور ظهر فعلاً. تحقّق من ${p} أولاً، ثم انشر مرة أخرى إن لم تجده.`, busy: "النشر جارٍ الآن. انتظر دقيقة ثم حدّث الصفحة.", duplicate: (p: string) => `رفض ${p} هذا النص لأنه نُشر عنده من قبل. لم يُنشر شيء، والاتصال سليم. غيّر الصياغة ثم انشر.`, earlier: (p: string) => `${p} يقول إن هذا النص منشور عنده، فالمحاولة السابقة ظهرت فعلاً. سُجّلت على العنصر، ولم يُنشر شيء جديد.`, slots: "لا يُنشر كما هو: فيه خانات مثل {{1}} تُعبّأ لكل مستلم أو توجيهات تصوير مثل [VO]. انسخه إلى المكان الذي يُستخدم فيه.", again: "انشر مرة أخرى" },
  en: { already: (p: string) => `This item was already published to ${p}. Publish it again?`, unknown: (p: string) => `The publish to ${p} ended without an answer, so the post may already be live. Check ${p} first, then publish again if it is not there.`, busy: "A publish is already running. Wait a minute, then refresh.", duplicate: (p: string) => `${p} refused this text because it was already posted there. Nothing went out and the connection is fine. Change the wording, then publish.`, earlier: (p: string) => `${p} says this text is already there, so the earlier attempt went live. It is now recorded on the item; nothing new was posted.`, slots: "Not published as written: it has slots such as {{1}} filled per recipient, or script directions such as [VO]. Copy it to where it is used.", again: "Publish again" },
} as const;

/** The matched word inside its excerpt, highlighted (both come from the same checker the server runs). */
function Hit({ v }: { v: Violation }) {
  const i = v.excerpt.toLowerCase().indexOf(v.term.toLowerCase());
  if (i < 0) return <span dir="auto">{v.excerpt}</span>;
  return <span dir="auto">{v.excerpt.slice(0, i)}<mark className="guard-hit text-inherit">{v.excerpt.slice(i, i + v.term.length)}</mark>{v.excerpt.slice(i + v.term.length)}</span>;
}

const CHAR_LIMITS: Record<string, number> = { instagram: 2200, x: 280, snapchat: 250, tiktok: 2200, whatsapp: 1024, gbp: 1500, linkedin: 3000 };

/** A string from the dictionary with its {placeholders} filled. */
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
/** Notes are stored one point per line (`parseCrossVerdicts`, noor.ts). */
const noteCount = (notes: string) => notes.split("\n").filter((l) => l.trim()).length;
/**
 * Another agent's verdicts on the item, for the card (`Task.crossReview`). Never for an MCP `save_draft` draft, which
 * carries the "written outside Thakeen" chip instead; a verdict naming no known agent is left out.
 */
const verdictsOf = (x: Pick<Task, "source" | "crossReview">) => (x.source === "external" ? [] : (x.crossReview ?? []).filter((v) => isAgentId(v.by)));

/** Whether the browser has a share sheet: false on the server and in the first client render, so hydration matches. */
const noSubscribe = () => () => {};
const shareSheet = () => typeof navigator.canShare === "function";
/** Our Blob store answers ?download=1 with an attachment header, so the link saves the clip instead of playing it. */
const saveLink = (url: string) => (isOurBlobUrl(url) ? `${url}?download=1` : url);

/**
 * `canPublish` is `can(u, "publish")` from the page (approve and publish are admin and owner). Without it the inbox offers
 * what a plain member may do, edit and reject, and never a control the server would refuse: an edit is saved without
 * approving (an approved item goes back to pending), and Approve and Publish give way to a note. `owner` is
 * `can(u, "billing")`: a render short of credits offers packs and plans to the owner and tells anyone else to ask them.
 */
export default function Inbox({ t, lang, tasks, brief, connected = [], banned = "", journey, media = [], credits = 0, plan, paused, canPublish = true, owner = true }: { t: AppDict; lang: Lang; tasks: Task[]; brief?: string | null; connected?: string[]; banned?: string; journey?: Journey; media?: MediaModelId[]; credits?: number; plan?: string; paused?: boolean; canPublish?: boolean; owner?: boolean }) {
  const i = t.inbox;
  const G = GUARD[lang];
  // The brand file's rules and the empty-placeholder rule, applied here exactly as the approve route applies them.
  const hasBanned = useMemo(() => brandRules({ banned }).length > 0, [banned]);
  const held = (x: Pick<Task, "type" | "channel" | "title" | "body" | "editedBody">) => gateTask({ banned }, x);
  // What the publish route checks: stricter than approval, since no placeholder of any kind is ever published.
  const pubHeld = (x: Task) => gateTask({ banned }, x, { publish: true });
  const A = AGAIN[lang];
  const [again, setAgain] = useState<{ id: string; provider: string; kind: "already" | "unknown" | "busy" | "duplicate" | "earlier"; url?: string } | null>(null);
  const [refused, setRefused] = useState<Record<string, Violation[]>>({});
  const r = useRouter();
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "all">("pending");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const canShare = useSyncExternalStore(noSubscribe, shareSheet, () => false);
  const [saving, setSaving] = useState<string | null>(null);
  const [ready, setReady] = useState<string | null>(null);
  // Cards whose clip could not be read here (network or CORS): the button goes and the download link stays.
  const [noShare, setNoShare] = useState<Record<string, boolean>>({});
  const clips = useRef(new Map<string, File>());
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

  async function publish(id: string, provider: string, repeat = false) {
    setPublishing(id + provider);
    setAgain(null);
    const res = await fetch(`/api/publish/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(repeat ? { provider, again: true } : { provider }) }).catch(() => null);
    setPublishing(null);
    // No answer, or the platform's time limit (a 5xx with no reason): the post may be live, so the owner checks first.
    if (!res || (res.status >= 500 && res.status !== 502)) { setAgain({ id, provider, kind: "unknown" }); forgetLocal(id); r.refresh(); return; }
    if (res.ok) milestone("publish");
    else {
      const j = (await res.json().catch(() => ({}))) as { error?: string; violations?: Violation[]; url?: string };
      if (j.error === "brand_violation" && j.violations) setRefused((p) => ({ ...p, [id]: j.violations! }));
      // Already on that platform, a result nobody saw, or a publish still running: the server did not post, and the
      // owner is asked, never a silent second post (src/lib/publish-once.ts).
      else if (j.error === "already_published" || j.error === "publish_unknown" || j.error === "publish_busy" || j.error === "duplicate_post" || j.error === "earlier_live") setAgain({ id, provider, kind: j.error === "already_published" ? "already" : j.error === "publish_unknown" ? "unknown" : j.error === "duplicate_post" ? "duplicate" : j.error === "earlier_live" ? "earlier" : "busy", url: j.url });
      else alert(res.status === 403 ? t.team.errors.forbidden : i.publishFail);
    }
    // `view` renders `local[id] ?? task`, so an entry left over from an earlier approve would mask this task's server
    // copy for ever: the publish landed and the image was generated, but the card never showed either.
    forgetLocal(id);
    r.refresh();
  }

  /**
   * Save or share a clip: on a phone the share sheet offers "Save Video" to Photos. Blob URLs answer a plain GET with
   * `access-control-allow-origin: *`, so the MP4 can be read here. The file is kept after a refusal, because a slow
   * download can outlast the tap's permission to open the share sheet (NotAllowedError); the next tap shares at once.
   */
  async function saveVideo(x: Task) {
    const url = x.videoUrl;
    if (!url) return;
    const link = saveLink(url);
    let file = clips.current.get(url);
    if (!file) {
      setSaving(x.id);
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("fetch_failed");
        file = new File([await res.blob()], "video.mp4", { type: "video/mp4" });
        clips.current.set(url, file);
      } catch {
        setNoShare((p) => ({ ...p, [x.id]: true }));
      } finally {
        setSaving(null);
      }
    }
    if (!file) return window.location.assign(link);
    if (!navigator.canShare?.({ files: [file] })) {
      // A share sheet that takes no files: save the copy already in memory instead of downloading it again.
      const href = URL.createObjectURL(file);
      const a = Object.assign(document.createElement("a"), { href, download: "video.mp4" });
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
      clips.current.delete(url);
      return;
    }
    try {
      await navigator.share({ files: [file] });
      clips.current.delete(url);
      setReady(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotAllowedError") setReady(x.id);
    }
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
          const guarded = isCustomerFacing(x.type) && (hasBanned || hits.length > 0);
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
                {/* Wraps whole pills onto a new line on a phone: a card can carry the guard, the judge, two reviewers, the
                    handoff chip and the status at once. The short pills never break inside; the long handoff chip may,
                    only when it alone is wider than the row. */}
                <span className="flex flex-wrap items-center gap-2 text-xs">
                  {guarded && <span title={hits.length ? G.held : G.ok} className={`flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 ${hits.length ? "bg-sadu/10 font-semibold text-sadu-deep" : "bg-oasis/10 text-oasis"}`}><Icon name="shield" className="h-3.5 w-3.5" />{hits.length ? G.held : G.ok}</span>}
                  {x.quality && <span title={x.quality.notes} className={`tnum whitespace-nowrap rounded-full px-2 py-0.5 ${x.quality.score >= 85 ? "bg-oasis/10 text-oasis" : x.quality.score >= 70 ? "bg-saffron/20 text-ink" : "bg-sadu/10 text-sadu-deep"}`} dir="ltr">{i.quality} {x.quality.score}</span>}
                  {verdictsOf(x).map((v) => {
                    const name = t.agents[v.by].name;
                    const n = noteCount(v.notes);
                    return <span key={v.by} className={`whitespace-nowrap rounded-full px-2 py-0.5 ${v.verdict === "flag" ? "bg-saffron/20 font-semibold text-sadu-deep" : "bg-oasis/10 text-oasis"}`}>{v.verdict === "flag" ? (n === 1 ? fill(i.xNote, { name }) : fill(i.xNotes, { name, n })) : fill(i.xChecked, { name })}</span>;
                  })}
                  {x.source === "external" && <span title={i.externalHint} className="max-w-full rounded-full bg-ink/5 px-2 py-0.5 text-ink/70">{i.external}</span>}
                  {/* Made by a run of one of Majed's handoffs (`Task.parent`, set in code): back to the conversation that proposed it.
                      `parent.auto`: his auto-run started it, not a login pressing Run. */}
                  {x.source === "handoff" && x.parent && (x.parent.conv && /^[a-f0-9]{6,16}$/.test(x.parent.conv)
                    ? <Link href={`/${lang}/app/chat?conv=${x.parent.conv}`} className="max-w-full rounded-full bg-oasis/10 px-2 py-0.5 text-oasis underline-offset-2 hover:underline">{fill(x.parent.auto ? i.fromHandoffAuto : i.fromHandoff, { name: t.agents.majed.name })}</Link>
                    : <span className="max-w-full rounded-full bg-oasis/10 px-2 py-0.5 text-oasis">{fill(x.parent.auto ? i.fromHandoffAuto : i.fromHandoff, { name: t.agents.majed.name })}</span>)}
                  <span className={`badge whitespace-nowrap ${x.status === "approved" ? "badge-primary" : x.status === "rejected" ? "badge-danger" : "badge-accent"}`}>{i[x.status]}</span>
                </span>
              </div>
              <div className="px-4 pb-3">
              {x.published && x.published.length > 0 && (
                <p className="mt-2 text-xs text-oasis">{x.published.map((p, n) => (p.url ? <a key={`${p.url}${n}`} href={p.url} target="_blank" rel="noreferrer" className="me-3 underline">{p.status === "draft" ? i.draftOn : i.published} {p.provider} ↗</a> : <span key={`${p.provider}${n}`} className="me-3">{i.published} {p.provider}</span>))}</p>
              )}
              {again?.id === x.id && (
                <div role="alert" className="mt-3 rounded-lg border border-saffron/40 bg-saffron/10 p-3 text-sm">
                  <p className="text-ink/80" dir="auto">{again.kind === "busy" ? A.busy : A[again.kind](again.provider)}{again.url && <> <a href={again.url} target="_blank" rel="noreferrer" className="underline">↗</a></>}</p>
                  {(again.kind === "already" || again.kind === "unknown") && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button disabled={publishing === x.id + again.provider} onClick={() => publish(x.id, again.provider, true)} className="btn btn-primary btn-xs">{A.again}</button>
                      <button onClick={() => setAgain(null)} className="btn btn-secondary btn-xs">{i.cancel}</button>
                    </div>
                  )}
                </div>
              )}
              {hits.length > 0 && editing !== x.id && (
                <div role="alert" className="mt-3 rounded-lg border border-sadu/30 bg-sadu/5 p-3 text-sm">
                  <p className="flex items-center gap-1.5 font-semibold text-sadu-deep"><Icon name="shield" className="h-4 w-4" />{G.held} · <span className="font-normal">{[hits.some((v) => v.kind === "banned") && G.rule, hits.some((v) => v.kind === "placeholder") && G.rulePh].filter(Boolean).join(" · ")}</span></p>
                  {hits.some((v) => v.kind === "banned") && <p className="mt-1 text-ink/70">{G.heldBody}</p>}
                  {hits.some((v) => v.kind === "placeholder") && <p className="mt-1 text-ink/70">{G.heldPh}</p>}
                  <ul className="mt-1.5 grid gap-1">{hits.map((v) => <li key={v.ruleId} className="text-xs text-ink/80"><span className="font-semibold" dir="auto">«{v.term}»</span> · <Hit v={v} /></li>)}</ul>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button onClick={() => { setEditing(x.id); setDraft(body); }} className="btn btn-primary btn-xs">{G.fix}</button>
                    {hits.some((v) => v.kind === "banned") && <Link href={`/${lang}/app/onboarding`} className="btn btn-secondary btn-xs">{G.editBrand}</Link>}
                  </div>
                </div>
              )}
              {verdictsOf(x).filter((v) => v.verdict === "flag").map((v) => (
                // Model-written notes: rendered as text, never as HTML, in the item's own language.
                <div key={v.by} className="mt-3 rounded-lg border border-saffron/40 bg-saffron/10 p-3 text-sm">
                  <p className="font-semibold text-sadu-deep">{fill(i.xNotesTitle, { name: t.agents[v.by].name })}</p>
                  <p className="mt-1 whitespace-pre-line break-words leading-relaxed text-ink/90" dir="auto">{v.notes}</p>
                  <p className="mt-1.5 text-xs text-ink/60">{i.xNotesHint}</p>
                </div>
              ))}
              {x.imageUrl && (
                <div className="mt-3 flex items-start gap-3">
                  {/* Deliberately not next/image. These URLs come from our Blob store, from fal for items made before
                      the copy existed, and from placehold.co, so optimising them means allowing those remote hosts in
                      remotePatterns and paying to proxy images we already pay to generate and store. */}
                  {/* eslint-disable-next-line @next/next/no-img-element -- remote image host, not a local asset */}
                  <img loading="lazy" decoding="async" src={x.imageUrl} alt="" className="h-40 w-40 rounded-lg object-cover" />
                  <div className="text-xs text-ink/50">{x.imageProvider === "placeholder" && <p className="mb-1 rounded-full bg-saffron/20 px-2 py-0.5 font-semibold text-sadu-deep" dir="auto">{i.placeholder}</p>}<a href={x.imageUrl} target="_blank" rel="noreferrer" className="underline">{i.download}</a>{x.imagePrompt && <p className="mt-1 line-clamp-4" dir="ltr">{x.imagePrompt}</p>}</div>
                </div>
              )}
              {x.videoUrl && (
                <div className="mt-3 flex items-start gap-3">
                  {/* iOS Safari shows an empty box for preload="metadata" without a poster or a start offset. */}
                  <video controls playsInline preload="metadata" poster={hasArtwork(x) ? x.imageUrl : undefined} src={`${x.videoUrl}#t=0.1`} className="h-48 rounded-lg bg-ink/5" />
                  <div className="grid gap-1 text-xs text-ink/50">
                    <span className="flex flex-wrap items-center gap-2">
                      <a href={saveLink(x.videoUrl)} target="_blank" rel="noreferrer" className="underline">{i.videoDownload}</a>
                      {canShare && !noShare[x.id] && <button disabled={saving === x.id} onClick={() => saveVideo(x)} className="btn btn-secondary btn-xs">{saving === x.id ? `${i.videoSave}…` : i.videoSave}</button>}
                    </span>
                    {ready === x.id && <p role="status" className="text-oasis">{i.videoReady}</p>}
                    <p className="text-ink/60">{i.videoNoPublish}</p>
                    {x.videoPrompt && <p className="mt-1 line-clamp-4" dir="ltr">{x.videoPrompt}</p>}
                  </div>
                </div>
              )}
              {editing === x.id ? (
                <div className="mt-3 grid gap-2">
                  <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={10} className="w-full rounded-lg border border-ink/15 p-3 text-sm" />
                  {(() => {
                    const checking = isCustomerFacing(x.type);
                    const live = checking ? held({ ...x, editedBody: draft }) : [];
                    return (
                      <>
                        {checking && (
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
                  {/* Model pickers, image and video buttons, and the polling of a running render. It drops the local copy
                      for the reason given in publish() above; the refresh also re-renders the sidebar balance. */}
                  <MediaControls task={x} lang={lang} t={t} available={media} credits={credits} plan={plan ?? "trial"} paused={!!paused} owner={owner} onChanged={() => { forgetLocal(x.id); r.refresh(); }} />
                  {x.channel === "instagram" && connected.includes("instagram") && !hasArtwork(x) && <p className="w-full text-xs text-ink/60">{i.igNeedsImage}</p>}
                  {x.adCode && (
                    <span title={G.codeHint} className="flex items-center gap-1 rounded-full border border-dashed border-oasis/40 bg-white px-2 py-1 text-xs">
                      <span className="text-ink/60">{G.code}</span>
                      <span className="font-mono font-semibold text-oasis" dir="ltr">{x.adCode}</span>
                      <button onClick={async () => { await navigator.clipboard.writeText(x.adCode!); setCopied(x.adCode!); setTimeout(() => setCopied(null), 1500); }} aria-label={G.copyCode} className="rounded-full px-1 text-oasis hover:bg-oasis/10">{copied === x.adCode ? "✓" : <Icon name="copy" className="h-3.5 w-3.5" />}</button>
                    </span>
                  )}
                  {(() => {
                    // Publish buttons follow the publish gate, so a WhatsApp draft with {{1}} (fine to approve) never
                    // offers a Telegram post the server would refuse.
                    const pub = pubHeld(x);
                    const slotsOnly = pub.length > 0 && hits.length === 0;
                    const list = targets(x);
                    return (
                      <>
                        {list.map((p) => (
                          <button key={p} disabled={publishing === x.id + p || pub.length > 0} title={slotsOnly ? A.slots : pub.length ? G.held : undefined} onClick={() => publish(x.id, p)} className="btn btn-primary btn-pill">{publishing === x.id + p ? i.publishing : `${i.publishTo} ${p}`}</button>
                        ))}
                        {/* The reason in words, not only on hover: most owners use the inbox on a phone. */}
                        {slotsOnly && list.length > 0 && <p className="w-full text-xs text-ink/60" dir="auto">{A.slots}</p>}
                      </>
                    );
                  })()}
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
