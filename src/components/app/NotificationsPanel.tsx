"use client";
import Link from "next/link";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Notif } from "@/lib/notifications";
import Scribble from "@/components/Scribble";
import Button from "@/components/ui/Button";
import { buttonClass } from "@/components/ui/button-class";
import EmptyState from "@/components/ui/EmptyState";
import { Time } from "@/components/ui/Time";
import { useAppLink, useWorkspace, useWsHandle, WORKSPACE_EVENTS } from "./WorkspaceContext";
import { Times, markOneRead } from "./NotificationCenter";
import { SETTINGS_COPY, settingsHref } from "@/lib/settings-nav";
import { inWorkspace } from "@/lib/ws-path";

/**
 * Every notification (rule 1123). Unread ones carry a dot, a bold title and the word "unread" for screen readers, and
 * stay unread until the person presses "Mark all as read": the page used to mark everything read 1.5 seconds after it
 * opened, so a glance cleared the bell before anything was read. The time is the brand's local date and time in Western
 * digits (`Time`), not a sliced ISO string in UTC.
 */
export default function NotificationsPanel({ t, lang, initial }: { t: AppDict; lang: "ar" | "en"; initial: Notif[] }) {
  const N = t.notifications;
  const U = t.ux.notif;
  const ws = useWorkspace();
  const href = useAppLink(lang);
  const handle = useWsHandle();
  const [items, setItems] = useState(initial);
  const [said, setSaid] = useState("");
  const [failed, setFailed] = useState(false);
  const unread = items.filter((n) => !n.read).length;
  async function markAll() {
    setFailed(false);
    const r = await fetch("/api/notifications", { method: "POST" }).catch(() => null);
    if (!r?.ok) { setFailed(true); return; }
    setItems((p) => p.map((n) => ({ ...n, read: true })));
    ws?.setUnread(0);
    window.dispatchEvent(new Event(WORKSPACE_EVENTS.unread));
    setSaid(U.marked);
  }
  /** One entry read (rule 1966): its own button, or opening it. The count comes back from the server. */
  async function readOne(n: Notif, say: boolean) {
    if (n.read) return;
    setFailed(false);
    setItems((p) => p.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    const left = await markOneRead(n.id);
    if (left === null) { if (say) { setItems((p) => p.map((x) => (x.id === n.id ? { ...x, read: false } : x))); setFailed(true); } return; }
    ws?.setUnread(left);
    if (say) setSaid(U.markedOne);
  }
  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="page-title"><span className="s-ul"><Scribble kind="underline" seed="notificationspanel-t1" />{N.title}</span></h1>
          <p className="mt-2 text-foreground-muted">{N.sub}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Rule 1144: what reaches the bell and the inbox is chosen in Settings, Notifications. */}
          <Link href={settingsHref(href, "notifications")} className={buttonClass({ variant: "ghost", size: "sm" })}>{SETTINGS_COPY[lang].prefsLink}</Link>
          {unread > 0 && <Button variant="secondary" size="sm" onClick={markAll}>{U.markAll}</Button>}
        </div>
      </div>
      <p role="status" className="sr-only">{said}</p>
      {failed && <p role="alert" className="field-error mt-3">{U.failed}</p>}
      {items.length === 0 ? <EmptyState className="mt-6" icon="bell" title={N.empty} /> : (
        <ul className="mt-6 divide-y divide-border rounded-card border border-border bg-surface">
          {items.map((n) => (
            <li key={n.id} className={`flex flex-wrap items-start justify-between gap-3 px-4 py-3 ${n.read ? "" : "bg-surface-muted"}`}>
              <div className="flex min-w-0 flex-1 gap-2.5">
                <span aria-hidden className={`mt-2 h-2 w-2 shrink-0 rounded-full ${n.read ? "bg-transparent" : "bg-foreground"}`} />
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground-muted">
                    <span className="rounded bg-background-muted px-1.5 py-0.5 text-foreground">{N.kinds[n.kind]}</span>
                    {n.agent && <span>{t.agents[n.agent].name}</span>}
                    <Time value={n.at} lang={lang} style="datetime" className="tnum" />
                  </p>
                  <p className={`mt-1 ${n.read ? "font-medium" : "font-bold"}`} dir="auto">{n.title}<Times count={n.count} label={U.times} />{!n.read && <span className="sr-only"> ({U.unread})</span>}</p>
                  <p className="whitespace-pre-line text-sm text-foreground-muted" dir="auto">{n.body}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!n.read && <button type="button" onClick={() => void readOne(n, true)} className="inline-flex min-h-[var(--hit-min)] items-center rounded-full px-3 text-xs text-foreground underline-offset-2 hover:underline pointer-fine:min-h-8">{U.markOne}</button>}
                <Link href={inWorkspace(n.href, handle)} onClick={() => void readOne(n, false)} className="inline-flex min-h-[var(--hit-min)] items-center rounded-full border border-border-input px-3 text-xs text-foreground hover:bg-inverse hover:text-inverse-muted pointer-fine:min-h-8">{N.open}</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-foreground-muted">{N.note}</p>
    </div>
  );
}
