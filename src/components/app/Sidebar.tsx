"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import type { Role } from "@/lib/auth";
import { AGENTS, type AgentId } from "@/lib/agents";
import LogoutButton from "./LogoutButton";
import LangToggle from "../LangToggle";
import ThemeToggle from "@/components/ui/ThemeToggle";
import Wordmark from "../Wordmark";
import { Icon, type IconName } from "./Icons";
import { PARTNER_COPY } from "@/lib/partner-copy";
import { adminHref } from "@/lib/admin-gate";
import { settingsHref } from "@/lib/settings-nav";
import Sheet from "@/components/ui/Sheet";
import Menu from "@/components/ui/Menu";
import NotificationCenter from "./NotificationCenter";
import { useWorkspace, WORKSPACE_EVENTS } from "./WorkspaceContext";

/** An agent's avatar sits on the agent's own colour; Faris and Majed are dark fills, so their letter is paper. */
const avatar = (id: AgentId) => ({ style: { background: `var(--color-agent-${id})` }, tone: id === "faris" || id === "majed" ? "text-inverse-foreground" : "text-accent-foreground" });

/**
 * Workspace sidebar. Noor is the one visible door; the specialists (every other agent) sit behind
 * one disclosure. Text floor 12px. No decorative badges except the localized "new" and the acting person's role.
 *
 * `user` is who is ACTING (a member sees their own name, email and role); plan and credits are the account's.
 * `show` hides owner-only entries (referrals, MCP, the partner page of an approved partner) from other roles: display
 * only, the routes enforce the same rules.
 *
 * Phase 2 (rules 1119-1122): the rows are grouped by what they are for (Work, then the agents and the threads, Brand,
 * Account and team, Help), each group a named list. The balance, the bell and the approvals badge come from the
 * WorkspaceContext the layout fills, not from three requests per navigation; outside it (a test rendering the rail alone)
 * the props are used and nothing is fetched. On a phone the rail opens in a `Sheet` (focus kept inside, Escape and the
 * backdrop close it, focus goes back to the menu button); the account menu is a `Menu` with arrow keys.
 */
export default function Sidebar({ t, lang, user, show, brandName, admin, supportWa }: { t: AppDict; lang: Lang; user: { name: string; email: string; role: Role; credits: number; plan: string }; show: { owner: boolean; refer: boolean; mcp: boolean; partner?: boolean }; brandName?: string; admin?: boolean; supportWa?: string }) {
  const path = usePathname();
  const sp = useSearchParams();
  const r = useRouter();
  const ws = useWorkspace();
  const base = `/${lang}/app`;
  const N = t.nav;
  const X = t.ux.nav;
  const [open, setOpen] = useState(false);
  const [team, setTeam] = useState(false);
  const [q, setQ] = useState("");
  const credits = ws?.credits ?? user.credits;
  const pending = ws?.pending ?? 0;
  const convs = ws?.convs ?? [];

  async function newThread(agent: AgentId) {
    const j = await (await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "…", agent }) })).json();
    if (j.ok) { setOpen(false); window.dispatchEvent(new Event(WORKSPACE_EVENTS.convs)); r.push(`${base}/chat?conv=${j.conversation.id}`); }
  }
  // The row for the screen on show (rule 968), marked with `aria-current="page"` as well as the tint. A link with a query
  // (a conversation) matches its path and every parameter it names; the plain chat row only while no conversation or
  // specialist is open, so one row at most is current.
  const active = (h: string) => {
    const [hp, hq] = h.split("?");
    if (hq !== undefined) return path === hp && [...new URLSearchParams(hq)].every(([k, v]) => sp.get(k) === v);
    if (h === base) return path === base;
    if (h === `${base}/chat`) return path === h && !sp.get("conv") && !sp.get("agent");
    return path.startsWith(h);
  };
  // 44px rows on touch screens (the phone's sheet), 36px under a mouse (rule 1120).
  const rowBox = "flex min-h-[var(--hit-min)] items-center justify-between gap-2 rounded-lg px-3 text-sm transition pointer-fine:min-h-9";
  const row = (href: string, label: React.ReactNode, icon: IconName, badge?: number) => (
    <Link href={href} onClick={() => setOpen(false)} aria-current={active(href) ? "page" : undefined} className={`${rowBox} ${active(href) ? "bg-background-muted font-semibold text-foreground" : "text-foreground-muted hover:bg-background-muted/60 hover:text-foreground"}`}>
      <span className="flex min-w-0 items-center gap-2.5"><Icon name={icon} className="h-4 w-4 shrink-0" /><span className="clip">{label}</span></span>
      {badge ? <span className="tnum rounded-full bg-inverse px-2 text-xs font-semibold text-inverse-foreground" dir="ltr">{badge}</span> : null}
    </Link>
  );
  /**
   * A named group of rows. The title is a label, not a heading: the rail sits before the screen's own h1 and h2s, so six
   * headings here (twelve with the phone sheet open) came first in a screen reader's heading list and on the same level
   * as the screen's sections; and a named section element is a region landmark, six of them inside the one nav. A `group`
   * named by its title is announced on entry ("Work, group") and leaves the outline to the page.
   */
  const group = (id: string, title: string, rows: React.ReactNode) => (
    <div role="group" aria-labelledby={id}>
      <p id={id} className="mb-1 px-3 text-xs font-semibold text-foreground-muted">{title}</p>
      <ul className="grid gap-0.5">{rows}</ul>
    </div>
  );
  const initial = (brandName || t.appName).trim().charAt(0);
  const specialists = AGENTS.filter((a) => a.id !== "noor");
  const planName = (N.plans as Record<string, string>)[user.plan] ?? user.plan;

  // The rail is drawn twice (the desktop aside, and the phone sheet while open), so every id carries the copy's prefix `p`.
  /** The brand you work on, and the bell beside it (outside the scrolling list, so its panel is never clipped). In the sheet the bell stays in the phone header. */
  const top = (bell: boolean) => (
    <div className="flex items-center gap-1 border-b-[1.5px] border-border-strong p-4 pb-3">
      <Link href={settingsHref(lang, "brands")} onClick={() => setOpen(false)} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-1 hover:bg-background-muted/60">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border-[1.5px] border-border-strong bg-background-muted font-display text-lg font-bold text-foreground" aria-hidden>{initial}</span>
        <span className="min-w-0"><span className="clip block text-sm font-semibold text-foreground" dir="auto">{brandName || (lang === "ar" ? "علامتك" : "Your brand")}</span><span className="block text-xs text-foreground-muted">{N.workspace}</span></span>
      </Link>
      {bell && <NotificationCenter t={t} lang={lang} align="start" />}
    </div>
  );

  const nav = (p: string) => (
    <nav aria-label={lang === "ar" ? "التنقل الرئيسي" : "Main navigation"} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
      {group(`${p}-work`, X.work, <>
        <li>{row(`${base}/chat`, N.main, "chat")}</li>
        <li>{row(base, N.approvals, "inbox", pending)}</li>
        <li>{row(`${base}/todo`, N.todo, "check")}</li>
        <li>{row(`${base}/calendar`, N.calendarCh, "calendar")}</li>
      </>)}

      {group(`${p}-dms`, N.dms, <>
        <li className={`${rowBox} text-foreground-muted hover:bg-background-muted/60`}>
          <Link href={`${base}/chat`} onClick={() => setOpen(false)} className="flex min-w-0 items-center gap-2.5 hover:text-foreground">
            <span style={avatar("noor").style} className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border-[1.5px] border-border-strong font-display text-xs font-bold ${avatar("noor").tone}`} aria-hidden>{t.agents.noor.name.charAt(0)}</span>
            <span className="min-w-0"><span className="clip block text-foreground">{t.agents.noor.name}</span><span className="clip block text-xs">{t.agents.noor.role}</span></span>
          </Link>
          <button type="button" onClick={() => newThread("noor")} className="btn btn-accent btn-xs" aria-label={`${N.newConv}: ${t.agents.noor.name}`}>+ {N.newConv}</button>
        </li>
        <li>
          <button type="button" onClick={() => setTeam(!team)} aria-expanded={team} aria-controls={`${p}-specialists`} className={`${rowBox} w-full text-foreground-muted hover:bg-background-muted/60 hover:text-foreground`}>
            {/* Overlapping avatars by logical margin (B-15): no space-x reversal to keep in step with the direction. */}
            <span className="flex items-center gap-2.5"><span className="flex" aria-hidden>{specialists.slice(0, 3).map((a, i) => <span key={a.id} style={avatar(a.id).style} className={`grid h-6 w-6 place-items-center rounded-full border-[1.5px] border-border-strong text-xs font-bold ${i > 0 ? "-ms-2" : ""} ${avatar(a.id).tone}`}>{t.agents[a.id].name.charAt(0)}</span>)}</span>{N.specialists} <span className="tnum text-xs" dir="ltr">({specialists.length})</span></span>
            <Icon name="chevron" className={`h-4 w-4 transition ${team ? "rotate-180" : ""}`} />
          </button>
          {team && (
            <ul id={`${p}-specialists`} className="ms-3 mt-1 grid gap-0.5 border-s border-border ps-2">
              {specialists.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-1 rounded-lg ps-2 text-sm text-foreground-muted hover:bg-background-muted/60">
                  <Link href={`${base}/chat?agent=${a.id}`} onClick={() => setOpen(false)} className="flex min-h-[var(--hit-min)] min-w-0 items-center gap-2 hover:text-foreground pointer-fine:min-h-9">
                    <span style={avatar(a.id).style} className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border-[1.5px] border-border-strong text-xs font-bold ${avatar(a.id).tone}`} aria-hidden>{t.agents[a.id].name.charAt(0)}</span>
                    <span className="min-w-0"><span className="clip block text-foreground">{t.agents[a.id].name}</span><span className="clip block text-xs">{t.agents[a.id].role}</span></span>
                  </Link>
                  <button type="button" onClick={() => newThread(a.id)} className="icon-btn" aria-label={`${N.newConv}: ${t.agents[a.id].name}`}><Icon name="plus" className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
          )}
        </li>
      </>)}

      <div role="group" aria-labelledby={`${p}-history`}>
        <p id={`${p}-history`} className="mb-1 px-3 text-xs font-semibold text-foreground-muted">{N.history}</p>
        <form role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) { setOpen(false); r.push(`${base}/conversations?q=${encodeURIComponent(q.trim())}`); } }} className="relative">
          <Icon name="search" className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-muted" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={N.searchConv} aria-label={N.searchConv} className="min-h-[var(--hit-min)] w-full rounded-lg border-[1.5px] border-border-input bg-surface pe-3 ps-8 text-sm text-foreground placeholder:text-foreground-muted focus:border-border-strong pointer-fine:min-h-9" />
        </form>
        <ul className="mt-1 grid gap-0.5">
          {convs.slice(0, 3).map((c) => <li key={c.id}>{row(`${base}/chat?conv=${c.id}`, <span dir="auto">{c.title || "…"}</span>, "chat")}</li>)}
          <li><Link href={`${base}/conversations`} onClick={() => setOpen(false)} className="flex min-h-[var(--hit-min)] items-center px-3 text-xs text-foreground-muted hover:text-foreground pointer-fine:min-h-8">{N.seeAll}</Link></li>
        </ul>
      </div>

      {group(`${p}-brand`, X.brand, <>
        <li>{row(`${base}/files`, N.files, "folder")}</li>
        <li>{row(`${base}/reports`, N.performance, "chart")}</li>
        <li>{row(`${base}/activity`, N.activity, "clock")}</li>
        <li>{row(`${base}/inspo`, N.contentInspo, "spark")}</li>
        {/* The workspace's agent instructions (rule 957). */}
        <li>{row(`${base}/instructions`, N.instructions, "strategy")}</li>
      </>)}

      {group(`${p}-account`, X.workspace, <>
        {/* One row for the whole settings area (rule 1141): members, integrations, governance, billing and the rest live
            under /settings, so the row is current on every settings page and no other row is. */}
        <li>{row(settingsHref(lang), N.settings, "settings")}</li>
        {show.refer && <li>{row(`${base}/refer`, N.refer, "gift")}</li>}
        {show.partner && <li>{row(`${base}/partner`, PARTNER_COPY[lang].nav, "growth")}</li>}
      </>)}

      {group(`${p}-help`, X.support, <>
        {/* Public page: what shipped, and the wishlist signed-in owners vote on. */}
        <li>{row(`/${lang}/updates`, N.updates, "sapling")}</li>
        <li><a href={supportWa ? `https://wa.me/${supportWa}` : `${base}/help#support`} target={supportWa ? "_blank" : undefined} rel="noreferrer" className={`${rowBox} justify-start gap-2.5 text-foreground-muted hover:bg-background-muted/60 hover:text-foreground`}><Icon name="whatsapp" className="h-4 w-4" />{N.contact}</a></li>
      </>)}
    </nav>
  );

  // The account menu. Members moved to the rail's "Account and team" group (it was listed twice); the account pages
  // point into the settings area (rule 1141).
  const links = [
    [settingsHref(lang, "account"), N.profile], [`${base}/notifications`, N.notifications], [`${base}/tasks`, N.tasks], [`${base}/generate`, N.generate], [settingsHref(lang, "billing"), N.billing], [settingsHref(lang, "brand"), N.brand], [settingsHref(lang, "brands"), N.brands],
    ...(show.mcp ? [[`${base}/mcp`, "MCP"]] : []), [`${base}/help`, N.help],
    // Founder accounts only: the console has its own shell at /{lang}/admin (rules 871, 873), never a main-nav row.
    ...(admin ? [[adminHref(lang, "overview"), N.adminPanel]] : []),
  ];
  // Rule 1204: the theme choice sits with the language in the account menu, one tap from every screen.
  const account = (
    <div className="border-t border-border p-4 pt-3">
      <Menu
        label={X.account}
        placement="top"
        className="w-full"
        items={links.map(([h, l]) => ({ key: h, href: h, label: l, onSelect: () => setOpen(false) }))}
        footer={<div className="grid gap-2 px-2"><ThemeToggle lang={lang} size="sm" className="justify-self-start" /><div className="flex items-center justify-between"><LangToggle lang={lang} size="sm" /><LogoutButton label={N.logout} lang={lang} /></div></div>}
        trigger={(props, isOpen) => (
          <button {...props} aria-label={`${X.account}: ${user.name || user.email}`} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-start text-sm text-foreground hover:bg-background-muted/60">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-background-muted font-semibold" aria-hidden>{(user.name || user.email).charAt(0).toUpperCase()}</span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5"><span className="clip" dir="auto">{user.name || user.email}</span><span className="shrink-0 rounded-full bg-background-muted px-1.5 text-xs text-foreground-muted">{t.team.roles[user.role]}</span></span>
              <span className="clip block text-xs text-foreground-muted" dir="ltr">{user.email}</span>
              <span className="block text-xs text-foreground-muted" title={show.owner ? undefined : N.sharedCredits}>{planName} · <span className="tnum font-semibold text-foreground">{credits} {N.credits}</span></span>
            </span>
            <Icon name="chevron" className={`h-4 w-4 text-foreground-muted transition ${isOpen ? "" : "rotate-180"}`} />
          </button>
        )}
      />
    </div>
  );

  return (
    <>
      <aside data-testid="app-sidebar" className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-e-[1.5px] border-border-strong bg-surface text-foreground lg:flex">{top(true)}{nav("rail")}{account}</aside>
      <header className="sticky top-0 z-40 flex items-center justify-between gap-2 border-b-[1.5px] border-border-strong bg-surface px-4 py-2 text-foreground lg:hidden">
        <Link href={`${base}/chat`} className="font-display text-xl font-bold"><Wordmark lang={lang} name={t.appName} /></Link>
        <div className="flex items-center gap-1">
          <NotificationCenter t={t} lang={lang} align="end" />
          <Link href={settingsHref(lang, "billing")} title={show.owner ? undefined : N.sharedCredits} className="tnum inline-flex min-h-[var(--hit-min)] items-center px-2 text-xs font-semibold text-foreground">{credits} {N.credits}</Link>
          <button type="button" onClick={() => setOpen(true)} aria-label={N.menu} aria-expanded={open} aria-haspopup="dialog" className="icon-btn border-[1.5px] border-border-strong text-foreground"><Icon name="menu" className="h-5 w-5" /></button>
        </div>
      </header>
      {open && (
        <Sheet lang={lang} label={N.menu} onClose={() => setOpen(false)} className="lg:hidden">
          <div className="flex min-h-full flex-col pt-10">{top(false)}{nav("sheet")}{account}</div>
        </Sheet>
      )}
    </>
  );
}
