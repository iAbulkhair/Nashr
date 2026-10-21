"use client";
import Link from "next/link";
import { useId, useState } from "react";
import type { ApprovalDict } from "@/lib/approval-dict";
import type { ChatItem } from "@/lib/chat";
import { isAgentId } from "@/lib/agents";
import { render } from "@/lib/md";
import { taskVersion } from "@/lib/task-version";
import { CHANNEL_LIMITS } from "@/lib/channel-limits";
import CopyButton from "@/components/ui/CopyButton";
import Badge from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { Icon, channelIcon } from "./Icons";
import { useAppLink, WORKSPACE_EVENTS } from "./WorkspaceContext";

/** A string from the dictionary with its {placeholders} filled. */
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

/**
 * A generated item inside the chat (rule 1124): channel header, rendered body, count vs limit, copy, approve with undo.
 * Approving is admin and owner only (`canApprove` = `can(u, "publish")` from the page); a member sees a note instead of
 * the button. An item another agent flagged in the cross-agent review (`item.xflag`) shows each reviewer's pill and,
 * instead of Approve, a link to the inbox, where the notes are: it is never approved from here unread.
 *
 * Phase 2: moved out of ChatPanel (which still exports it as `ItemCard`), the channel limits shared with the inbox, the
 * body's toggle says whether it is open, a disabled Approve names its reason with `aria-describedby`, and Copy says
 * "Copied" (or that the browser refused) instead of failing silently.
 *
 * Phase 5b: `t` is the slice of the app dictionary the card reads (`ApprovalDict`), so the public home page sends only
 * that; with `demo` the card is a sample whose buttons write nothing.
 */
export default function ApprovalCard({ item, t, lang, onApproved, canApprove = true, demo = false }: { item: ChatItem; t: ApprovalDict; lang: "ar" | "en"; onApproved?: (id: string) => void; canApprove?: boolean; /** the home page's gallery (rule 1222): Approve and Undo change only this card, nothing is sent or saved */ demo?: boolean }) {
  const href = useAppLink(lang);
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState(item.status);
  const [err, setErr] = useState("");
  const [undoAt, setUndoAt] = useState(0);
  const [held, setHeld] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const toast = useToast();
  const limit = CHANNEL_LIMITS[item.channel];
  const ar = lang === "ar";
  const chName = (t.channelNames as Record<string, string>)[item.channel] ?? item.channel;
  async function setState(next: "approved" | "pending") {
    if (saving) return;
    // A sample on the public home page has no task behind it: the card shows the approval and its undo, and nothing else.
    if (demo) {
      setStatus(next);
      if (next === "approved") { setUndoAt(Date.now()); setTimeout(() => setUndoAt((v) => (Date.now() - v >= 4000 ? 0 : v)), 4200); }
      else setUndoAt(0);
      return;
    }
    setErr(""); setSaving(true);
    try {
      // The version of the text on this card (src/lib/task-version.ts): an approval is refused when the item changed since.
      const r = await fetch(`/api/tasks/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: next, version: taskVersion(item) }) }).catch(() => null);
      if (!r) { toast.danger(t.chat.approveFail); return; } // rule 2001: a plain failure is a toast
      if (!r.ok) {
        // The brand rules hold this item on the server: say which word, and send the owner to the inbox to fix it.
        const j = (await r.json().catch(() => ({}))) as { error?: string; violations?: { term: string }[] };
        if (r.status === 409 && j.error === "brand_violation") { setHeld((j.violations ?? []).map((v) => v.term)); return; }
        // Edited in the inbox, or given an image, after this card was written: it is reviewed there, where the current
        // version is shown.
        if (r.status === 409 && j.error === "changed") { setErr(ar ? "تغيّر هذا العنصر بعد كتابة هذه البطاقة، فلم يُعتمد. راجع النسخة الحالية في صندوق الموافقة." : "This item changed after this card was written, so it was not approved. Review the current version in the inbox."); return; }
        if (r.status === 403) setErr(t.team.errors.forbidden); else toast.danger(t.chat.approveFail);
        return;
      }
      setStatus(next);
      // The sidebar badge listens for this; approving from a chat card must move it as the inbox does.
      window.dispatchEvent(new Event(WORKSPACE_EVENTS.pending));
      if (next === "approved") { setUndoAt(Date.now()); onApproved?.(item.id); setTimeout(() => setUndoAt((v) => (Date.now() - v >= 4000 ? 0 : v)), 4200); }
      else setUndoAt(0);
    } finally { setSaving(false); }
  }
  const over = !!limit && item.body.length > limit;
  const flags = (item.xflag ?? []).filter((f) => isAgentId(f.by));
  const flagged = flags.length > 0 && status !== "approved";
  const blocked = over || held.length > 0;
  return (
    <article className="mt-3 overflow-hidden rounded-xl border border-border bg-surface text-foreground" aria-labelledby={`${id}-h`}>
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs">
        <span id={`${id}-h`} className="flex min-w-0 items-center gap-2 font-semibold"><Icon name={channelIcon(item.channel)} className="h-4 w-4 text-foreground" />{chName}<span className="clip font-normal text-foreground-muted" dir="auto">· {item.title}</span></span>
        <span className="flex flex-wrap items-center justify-end gap-1.5">
          {flags.map((f) => <Badge key={f.by} tone="danger" className="whitespace-nowrap">{f.n === 1 ? fill(t.inbox.xNote, { name: t.agents[f.by].name }) : fill(t.inbox.xNotes, { name: t.agents[f.by].name, n: f.n })}</Badge>)}
          <span className={`badge whitespace-nowrap ${status === "approved" ? "badge-primary" : "badge-accent"}`}>{status === "approved" ? t.inbox.approved : t.inbox.pending}</span>
        </span>
      </header>
      {/* Model output: through render() in src/lib/md.ts, never raw. */}
      {open && <div id={`${id}-body`} className="prose-nashr prose-compact px-4 py-3 text-sm" dir="auto" dangerouslySetInnerHTML={{ __html: render(item.body) }} />}
      <footer className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2 text-xs">
        <span id={`${id}-count`} className={`tnum ${over ? "font-semibold text-foreground" : "text-foreground-muted"}`} dir="ltr">{item.body.length}{limit ? ` / ${limit}` : ""}</span>
        {over && <Badge id={`${id}-over`} tone="danger">{ar ? "النص أطول من حد القناة" : "Text exceeds the channel limit"}</Badge>}
        {err && <span role="alert" className="text-danger">{err}</span>}
        {held.length > 0 && <span role="alert" id={`${id}-held`} className="flex items-center gap-1 font-semibold text-danger"><Icon name="shield" className="h-3.5 w-3.5" /><span dir="auto">{ar ? `محجوز بحارس العلامة: ${held.join("، ")}` : `Held by brand guard: ${held.join(", ")}`}</span> · <Link href={href()} className="underline">{ar ? "عدّله في صندوق الموافقة" : "Fix it in the inbox"}</Link></span>}
        {undoAt > 0 && status === "approved" && <span role="status" className="flex items-center gap-2 text-foreground"><Icon name="check" className="h-4 w-4" />{t.chat.approved} · <button type="button" onClick={() => setState("pending")} className="min-h-[var(--hit-min)] underline pointer-fine:min-h-0">{t.chat.undo}</button></span>}
        {flagged && <Badge tone="warning">{t.chat.xflagHint}</Badge>}
        <span className="ms-auto flex flex-wrap gap-1.5">
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={`${id}-body`} className="btn btn-secondary btn-xs">{open ? (ar ? "طيّ" : "Collapse") : (ar ? "عرض" : "Expand")}</button>
          <CopyButton text={item.body} lang={lang} label={status === "approved" ? `${t.chat.copyTo} ${chName}` : t.inbox.copy} />
          {status !== "approved" && !canApprove && <span className="self-center text-foreground-muted">{t.inbox.waitAdmin}</span>}
          {flagged && canApprove && <Link href={href()} className="btn btn-primary btn-xs">{t.chat.readNotes}</Link>}
          {status !== "approved" && canApprove && !flagged && <button type="button" onClick={() => setState("approved")} disabled={blocked || saving} aria-busy={saving || undefined} aria-describedby={over ? `${id}-over` : held.length > 0 ? `${id}-held` : undefined} className="btn btn-primary btn-xs"><Icon name="check" className="h-3.5 w-3.5" />{t.inbox.approve}</button>}
        </span>
      </footer>
    </article>
  );
}
