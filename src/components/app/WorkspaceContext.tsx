"use client";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AgentId } from "@/lib/agents";
import { installBrandFetch } from "@/lib/brand-fetch";

/** A conversation as the rail lists it (GET /api/conversations). */
export type RailConv = { id: string; title: string; agent?: AgentId; updatedAt: string };

/** What the shell shows on every screen: the balance, the bell, the approvals badge and the recent threads. */
export type WorkspaceCounts = { credits: number; unread: number; pending: number };

export type Workspace = WorkspaceCounts & {
  /** Null until the first read: the rail draws no rows rather than "none". */
  convs: RailConv[] | null;
  setCredits: (n: number) => void;
  setUnread: (n: number) => void;
};

/** How old the counts may get before a navigation reads them again (rule 1119). Events refresh them at once. */
export const WORKSPACE_STALE_MS = 30_000;

/**
 * The window events a screen sends when it changed one of the shell's numbers (rule 1119). The approvals badge already
 * listened for `nashr:pending-changed`; the rest are new. `nashr:credits` carries the new balance as its `detail`.
 */
export const WORKSPACE_EVENTS = { pending: "nashr:pending-changed", unread: "nashr:unread-changed", convs: "nashr:convs-changed", credits: "nashr:credits" } as const;

/** Tells the shell the balance changed (a chat answer, a run), so the rail and the phone header show the same number. */
export function announceCredits(n: number) {
  if (typeof window !== "undefined" && Number.isFinite(n)) window.dispatchEvent(new CustomEvent(WORKSPACE_EVENTS.credits, { detail: n }));
}

/** Whether a navigation should read the counts again: only once they are older than WORKSPACE_STALE_MS. Pure for the tests. */
export const isStale = (readAt: number, now: number) => now - readAt >= WORKSPACE_STALE_MS;

const Ctx = createContext<Workspace | null>(null);
const BrandCtx = createContext<string | null>(null);

/**
 * The shell's shared numbers (rule 1119). The layout reads the first counts on the server in one `Promise.all`, so the rail
 * and the phone header paint with them; the threads load once after that. The rail used to fetch the bell count, the
 * pending count and the full thread list again on every navigation, three requests per click and the thread list alone up
 * to 100 reads. Now a navigation reads the counts again only when they are older than WORKSPACE_STALE_MS, and a screen that
 * changes one says so with its window event, which reads that one at once.
 */
export function WorkspaceProvider({ initial, brandId = null, children }: { initial: WorkspaceCounts; brandId?: string | null; children: React.ReactNode }) {
  // Wrapped during the first render, not in an effect: a child's effect runs before this component's, and its first fetch must carry the page's brand (rule 889).
  installBrandFetch();
  const [credits, setCredits] = useState(initial.credits);
  const [unread, setUnread] = useState(initial.unread);
  const [pending, setPending] = useState(initial.pending);
  const [convs, setConvs] = useState<RailConv[] | null>(null);
  const readAt = useRef(0);
  const path = usePathname();

  const loadPending = useCallback(() => fetch("/api/tasks?count=pending").then((r) => r.json()).then((j) => { if (j.ok) setPending(j.pending); }).catch(() => {}), []);
  const loadUnread = useCallback(() => fetch("/api/notifications?count=1").then((r) => r.json()).then((j) => { if (j.ok) setUnread(j.unread); }).catch(() => {}), []);
  const loadConvs = useCallback(() => fetch("/api/conversations").then((r) => r.json()).then((j) => { if (j.ok) setConvs(j.conversations); }).catch(() => {}), []);

  useEffect(() => {
    // First mount: the counts came from the server just now; only the threads are still to read.
    if (readAt.current === 0) { readAt.current = Date.now(); void loadConvs(); return; }
    if (!isStale(readAt.current, Date.now())) return;
    readAt.current = Date.now();
    void Promise.all([loadPending(), loadUnread(), loadConvs()]);
  }, [path, loadPending, loadUnread, loadConvs]);

  useEffect(() => {
    const onCredits = (e: Event) => { const n = (e as CustomEvent<number>).detail; if (typeof n === "number" && Number.isFinite(n)) setCredits(n); };
    const onPending = () => { void loadPending(); };
    const onUnread = () => { void loadUnread(); };
    const onConvs = () => { void loadConvs(); };
    window.addEventListener(WORKSPACE_EVENTS.pending, onPending);
    window.addEventListener(WORKSPACE_EVENTS.unread, onUnread);
    window.addEventListener(WORKSPACE_EVENTS.convs, onConvs);
    window.addEventListener(WORKSPACE_EVENTS.credits, onCredits);
    return () => {
      window.removeEventListener(WORKSPACE_EVENTS.pending, onPending);
      window.removeEventListener(WORKSPACE_EVENTS.unread, onUnread);
      window.removeEventListener(WORKSPACE_EVENTS.convs, onConvs);
      window.removeEventListener(WORKSPACE_EVENTS.credits, onCredits);
    };
  }, [loadPending, loadUnread, loadConvs]);

  const value = useMemo<Workspace>(() => ({ credits, unread, pending, convs, setCredits, setUnread }), [credits, unread, pending, convs]);
  return <BrandCtx.Provider value={brandId}><Ctx.Provider value={value}>{children}</Ctx.Provider></BrandCtx.Provider>;
}

/** The shell's numbers, or null outside the provider (a test rendering the rail alone): the caller falls back to its props. */
export function useWorkspace(): Workspace | null {
  return useContext(Ctx);
}

/**
 * The brand the layout was rendered with (`user.brandId`), or null outside the provider. On an account page that is the
 * session's stored choice; on a `/b/{id}` page it is the page's brand as of the last layout render, so it can lag after a
 * soft navigation from one brand's page to another's until the layout renders again. A shell component on an account page
 * that mutates a brand route sends it explicitly (`sessionBrandHeaders`, R-C12). On a brand page a request takes its brand
 * from the path (`installBrandFetch`'s path header wins over anything built from this value), never from here.
 */
export function useBrandId(): string | null {
  return useContext(BrandCtx);
}
