"use client";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import type { WorkspaceRow } from "@/lib/workspaces";
import { appHref, switchTarget } from "@/lib/ws-path";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import { Icon } from "./Icons";
import { useWsHandle } from "./WorkspaceContext";

/**
 * The workspace switcher at the top of the rail (multi-workspace M2, spec section 16; rule 2112). It is drawn only in a
 * shell rendered for a workspace handle (`MULTI_ORG` on) and only when the person holds two workspaces or more, so a
 * single workspace shows nothing new. The list is `GET /api/workspaces` (handles, names and roles, never an id);
 * picking one calls the switch route, which re-checks the handle, then a full load of its link at the same page
 * (`switchTarget`) so the whole shell is rendered for it. «New workspace» opens `/{lang}/app/workspaces`.
 */
export default function WorkspaceSwitcher({ t, lang, onNavigate }: { t: AppDict["workspaces"]; lang: Lang; onNavigate?: () => void }) {
  const handle = useWsHandle();
  const path = usePathname();
  const [rows, setRows] = useState<WorkspaceRow[] | null>(null);
  const [waiting, setWaiting] = useState(0);
  const asked = useRef(false);

  useEffect(() => {
    if (!handle) return;
    let live = true;
    fetch("/api/workspaces")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { workspaces?: WorkspaceRow[] } | null) => { if (live && Array.isArray(j?.workspaces)) setRows(j.workspaces); })
      .catch(() => {});
    return () => { live = false; };
  }, [handle]);

  // The invitations inbox (M3, rule 2753): only how many wait, and only once the menu is first opened (review B finding 9:
  // the inbox read is several Redis rounds, never spent on a page load). The list is on the workspaces page.
  function loadInvites() {
    if (asked.current) return;
    asked.current = true;
    fetch("/api/workspaces/invites")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { invites?: unknown[] } | null) => { if (Array.isArray(j?.invites)) setWaiting(j.invites.length); })
      .catch(() => {});
  }

  if (!handle || !rows || rows.length < 2) return null;
  const current = rows.find((w) => w.handle === handle) ?? rows.find((w) => w.current);

  async function open(to: string) {
    onNavigate?.();
    const r = await fetch("/api/workspaces/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: to }) }).catch(() => null);
    const j = (await r?.json().catch(() => null)) as { ok?: boolean; href?: string } | null;
    // A refused switch (the membership ended meanwhile) reloads the page on show, which answers for what is true now.
    if (j?.ok && typeof j.href === "string" && j.href.startsWith(appHref(lang))) window.location.assign(switchTarget(j.href, path));
    else window.location.reload();
  }

  const items: MenuItem[] = [
    ...rows.filter((w) => w.handle !== current?.handle).map((w) => ({
      key: w.handle,
      label: <span className="flex min-w-0 flex-1 items-center justify-between gap-2"><span className="clip" dir="auto">{w.name}</span><span className="shrink-0 text-xs">{t.roles[w.role]}</span></span>,
      onSelect: () => void open(w.handle),
    })),
    ...(waiting > 0 ? [{ key: "invites", href: appHref(lang, "/workspaces"), label: t.invites.replace("{n}", String(waiting)), onSelect: onNavigate }] : []),
    { key: "new", href: appHref(lang, "/workspaces"), label: t.create, onSelect: onNavigate },
  ];

  return (
    <div className="border-b-[1.5px] border-border-strong px-4 py-2">
      <Menu
        label={t.switcher}
        className="w-full"
        items={items}
        trigger={(props, isOpen) => (
          <button
            {...props}
            onClick={(e) => { loadInvites(); props.onClick?.(e); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") loadInvites(); props.onKeyDown?.(e); }}
            aria-label={`${t.switcher}: ${current?.name ?? ""}`} className="flex min-h-[var(--hit-min)] w-full items-center gap-2 rounded-lg px-2 text-start text-sm text-foreground hover:bg-background-muted/60 pointer-fine:min-h-9">
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-foreground-muted">{t.switcher}</span>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="clip font-semibold" dir="auto">{current?.name}</span>
                {current && <span className="shrink-0 rounded-full bg-background-muted px-1.5 text-xs text-foreground-muted">{t.roles[current.role]}</span>}
              </span>
            </span>
            <Icon name="chevron" className={`h-4 w-4 text-foreground-muted transition ${isOpen ? "" : "rotate-180"}`} />
          </button>
        )}
      />
    </div>
  );
}
