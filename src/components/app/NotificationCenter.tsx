"use client";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import type { Notif } from "@/lib/notifications";
import { Icon } from "./Icons";
import { Time } from "@/components/ui/Time";
import { Skeleton } from "@/components/ui/Skeleton";
import { useWorkspace, WORKSPACE_EVENTS } from "./WorkspaceContext";

/** The badge's text: the count up to 99, then "99+", so a long backlog never widens the bell. Pure for the tests. */
export const bellCount = (n: number) => (n > 99 ? "99+" : String(Math.max(0, Math.floor(n))));

/** How many notifications the popover lists; the page lists them all. */
export const BELL_LIST = 8;

/**
 * The bell (rule 1122): a button that says how many are unread in its name ("Notifications, 3 unread"), not only in the
 * red dot, and opens a panel with the latest BELL_LIST. The list is read when the panel opens, not on every navigation.
 * Unread rows carry a dot, bold title and the word "unread" for screen readers. "Mark all as read" is a button, not a side
 * effect of looking: the old page marked everything read 1.5 seconds after it opened. Escape or a click outside closes the
 * panel and gives focus back to the bell. `align` keeps the panel on screen: "start" in the rail, "end" in the phone header.
 */
export default function NotificationCenter({ t, lang, align = "start", fallbackUnread = 0 }: { t: AppDict; lang: Lang; align?: "start" | "end"; fallbackUnread?: number }) {
  const U = t.ux.notif;
  const ws = useWorkspace();
  const unread = ws?.unread ?? fallbackUnread;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notif[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [said, setSaid] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();

  async function load() {
    setFailed(false);
    const r = await fetch("/api/notifications").catch(() => null);
    const j = r ? ((await r.json().catch(() => ({}))) as { ok?: boolean; notifications?: Notif[]; unread?: number }) : {};
    if (!j.ok || !j.notifications) { setFailed(true); return; }
    setItems(j.notifications.slice(0, BELL_LIST));
    if (typeof j.unread === "number") ws?.setUnread(j.unread);
  }
  async function markAll() {
    const r = await fetch("/api/notifications", { method: "POST" }).catch(() => null);
    if (!r?.ok) { setSaid(U.failed); return; }
    setItems((p) => p?.map((n) => ({ ...n, read: true })) ?? p);
    ws?.setUnread(0);
    window.dispatchEvent(new Event(WORKSPACE_EVENTS.unread));
    setSaid(U.marked);
  }

  function toggle() {
    // The list is read when the panel opens (an event, not an effect), so opening costs one request and nothing else does.
    if (!open) void load();
    setOpen(!open);
  }
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const name = unread > 0 ? `${U.title}, ${U.unreadN.replace("{n}", bellCount(unread))}` : U.title;
  return (
    <div ref={box} className="relative" onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); btn.current?.focus(); } }}>
      <button ref={btn} type="button" onClick={toggle} aria-expanded={open} aria-controls={open ? `${id}-panel` : undefined} aria-label={name} title={name} className="icon-btn relative text-foreground">
        <Icon name="bell" className="h-5 w-5" />
        {unread > 0 && <span aria-hidden className="tnum absolute -top-0.5 end-0 min-w-5 rounded-full bg-danger px-1 text-center text-xs font-semibold leading-5 text-inverse-foreground" dir="ltr">{bellCount(unread)}</span>}
      </button>
      {open && (
        <section id={`${id}-panel`} aria-label={U.title} className={`absolute top-full z-50 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-xl border-[1.5px] border-border-strong bg-popover text-foreground ${align === "start" ? "start-0" : "end-0"}`}>
          <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold">{U.title}</h2>
            {unread > 0 && <button type="button" onClick={markAll} className="min-h-[var(--hit-min)] rounded-lg px-2 text-xs font-semibold text-foreground underline-offset-2 hover:underline pointer-fine:min-h-8">{U.markAll}</button>}
          </header>
          <p role="status" className="sr-only">{said}</p>
          {failed ? (
            <p role="alert" className="px-3 py-4 text-sm text-danger">{U.failed}</p>
          ) : items === null ? (
            <div className="grid gap-3 px-3 py-4" aria-busy="true"><span className="sr-only">{t.ux.loading}</span><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-1/2" /></div>
          ) : items.length === 0 ? (
            <p className="px-3 py-4 text-sm text-foreground-muted">{U.none}</p>
          ) : (
            <ul className="max-h-[60dvh] divide-y divide-border overflow-y-auto">
              {items.map((n) => (
                <li key={n.id}>
                  <Link href={n.href} onClick={() => setOpen(false)} className="flex gap-2 px-3 py-2.5 hover:bg-background-muted/60">
                    <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read ? "bg-transparent" : "bg-foreground"}`} />
                    <span className="min-w-0 flex-1">
                      <span className={`block text-sm ${n.read ? "" : "font-semibold"}`} dir="auto">{n.title}{!n.read && <span className="sr-only"> ({U.unread})</span>}</span>
                      <span className="block text-xs text-foreground-muted"><span>{t.notifications.kinds[n.kind]}</span> · <Time value={n.at} lang={lang} style="datetime" /></span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <footer className="border-t border-border px-3 py-2 text-sm">
            <Link href={`/${lang}/app/notifications`} onClick={() => setOpen(false)} className="inline-flex min-h-[var(--hit-min)] items-center font-semibold text-foreground underline-offset-2 hover:underline pointer-fine:min-h-8">{U.seeAll}</Link>
          </footer>
        </section>
      )}
    </div>
  );
}
