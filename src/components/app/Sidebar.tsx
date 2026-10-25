"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import type { AppDict } from "@/lib/app-i18n";
import type { Lang } from "@/lib/i18n";
import type { Role } from "@/lib/auth";
import { AGENTS, type AgentId } from "@/lib/agents";
import LogoutButton from "./LogoutButton";
import LangToggle from "../LangToggle";
import ThemeToggle from "@/components/ui/ThemeToggle";
import Wordmark from "../Wordmark";
import { Icon, type IconName } from "./Icons";
import PersonAvatar from "./PersonAvatar";
import { PARTNER_COPY } from "@/lib/partner-copy";
import { adminHref } from "@/lib/admin-gate";
import { settingsHref } from "@/lib/settings-nav";
import Sheet from "@/components/ui/Sheet";
import Menu from "@/components/ui/Menu";
import NotificationCenter from "./NotificationCenter";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import { useAppLink, useBrandId, useWorkspace, WORKSPACE_EVENTS } from "./WorkspaceContext";
import { sessionBrandHeaders } from "@/lib/brand-fetch";
import { brandFromPath } from "@/lib/brand-path";
import BrandSwitcher, { type SwitcherBrand } from "./BrandSwitcher";
import { railCookie } from "@/lib/rail";

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
 *
 * The folding rail (rules 3123-3127): on a desktop the rail folds to icons only (w-16) and back with one button at its
 * top, a real `<button>` with `aria-expanded` and a label that says what it does next. Folded, every row keeps its name as
 * `aria-label` and `title` (the approvals count rides in the label), the bell stays, and the account menu opens from the
 * avatar. The choice is a cookie on this browser (`railCookie`, src/lib/rail.ts) that the layout reads and passes as
 * `collapsed`, so the first paint has the chosen width. The arrow is the directional `next` icon, mirrored in Arabic and
 * turned to point at the rail's own edge while open. The phone header and its sheet never fold.
 */
export default function Sidebar({ t, lang, user, show, brandName, workspaceLogo, admin, supportWa, collapsed = false }: { t: AppDict; lang: Lang; user: { name: string; email: string; role: Role; credits: number; plan: string; avatar?: string | null }; show: { owner: boolean; refer: boolean; mcp: boolean; partner?: boolean }; brandName?: string; workspaceLogo?: string | null; admin?: boolean; supportWa?: string; collapsed?: boolean }) {
  const path = usePathname();
  const sp = useSearchParams();
  const r = useRouter();
  const ws = useWorkspace();
  // The one link builder (rules 889, 2113): the page's workspace and brand. Every row is built with it, never by
  // appending to a prefix: an account path (`/refer`, `/integrations`) under `/b/{id}` would be no page.
  const sessionBrand = useBrandId();
  const to = useAppLink(lang);
  const toSession = useAppLink(lang, sessionBrand);
  const base = to();
  const N = t.nav;
  const X = t.ux.nav;
  const [open, setOpen] = useState(false);
  const [folded, setFolded] = useState(collapsed);
  /** Fold or unfold the desktop rail and remember it on this browser (rule 3124). */
  const toggleFold = () => {
    const next = !folded;
    setFolded(next);
    try { document.cookie = railCookie(next, window.location.protocol === "https:"); } catch { /* the rail still folds for this page */ }
  };
  const [team, setTeam] = useState(false);
  const [q, setQ] = useState("");
  const credits = ws?.credits ?? user.credits;
  const pending = ws?.pending ?? 0;
  const convs = ws?.convs ?? [];

  // One create at a time: a second tap while the first is in flight would make a second empty conversation.
  const [creating, setCreating] = useState(false);
  async function newThread(agent: AgentId) {
    if (creating) return;
    setCreating(true);
    // A dropped connection or a non-JSON 5xx answers nothing: the buttons come back and the person taps again.
    const j = await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json", ...sessionBrandHeaders(sessionBrand) }, body: JSON.stringify({ title: "…", agent }) })
      .then((res) => res.json())
      .catch(() => null)
      .finally(() => setCreating(false));
    // The conversation was created in the brand of this page (the fetch wrapper's header) or, on an account page, the
    // session's (`sessionBrandHeaders`), so it opens in that brand: the legacy path would 307 to the stored choice, which
    // another tab may have changed (ruling P10).
    if (j?.ok) { setOpen(false); window.dispatchEvent(new Event(WORKSPACE_EVENTS.convs)); r.push(toSession(`/chat?conv=${j.conversation.id}`)); }
  }
  // The brand switcher's list (rule 893), asked for when the menu is first opened: the brands, whether this login may add
  // one (owner or admin under the plan's cap; display only, POST /api/brands is the check). Once per mount, not on every
  // open; a pick (the list or the cap may have changed) and a failed read let the next open ask again.
  const [brandList, setBrandList] = useState<{ brands: SwitcherBrand[]; canAdd: boolean } | null>(null);
  const brandsAsked = useRef(false);
  const loadBrands = useCallback(async () => {
    if (brandsAsked.current) return;
    brandsAsked.current = true;
    try {
      const j = await (await fetch("/api/brands")).json();
      if (j.ok) setBrandList({ brands: j.brands, canAdd: (user.role === "owner" || user.role === "admin") && Number(j.count) < Number(j.cap) });
      else brandsAsked.current = false;
    } catch { brandsAsked.current = false; /* the menu keeps showing the current brand */ }
  }, [user.role]);
  // The row for the screen on show (rule 968), marked with `aria-current="page"` as well as the tint. A link with a query
  // (a conversation) matches its path and every parameter it names; the plain chat row only while no conversation or
  // specialist is open, so one row at most is current.
  const active = (h: string) => {
    const [hp, hq] = h.split("?");
    if (hq !== undefined) return path === hp && [...new URLSearchParams(hq)].every(([k, v]) => sp.get(k) === v);
    if (h === base) return path === base;
    if (h === to("/chat")) return path === h && !sp.get("conv") && !sp.get("agent");
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
  /** The fold button (rule 3125): says what it will do, points at the rail's edge while open and away from it while folded. */
  const foldButton = (
    <button type="button" onClick={toggleFold} aria-expanded={!folded} aria-controls="app-rail" aria-label={folded ? X.expand : X.collapse} title={folded ? X.expand : X.collapse} data-testid="rail-fold" className="icon-btn shrink-0 text-foreground-muted hover:text-foreground">
      <Icon name="next" mirror className={`h-4 w-4 ${folded ? "" : "rotate-180"}`} />
    </button>
  );
  /** A folded row (rule 3126): the icon alone, its name as `aria-label` and `title`; a count is in the label and drawn small. */
  const iconRow = (href: string, label: string, icon: IconName, badge?: number) => {
    const name = badge ? `${label} (${badge})` : label;
    return (
      <Link href={href} aria-label={name} title={name} aria-current={active(href) ? "page" : undefined} className={`relative grid h-10 w-10 place-items-center rounded-lg transition ${active(href) ? "bg-background-muted text-foreground" : "text-foreground-muted hover:bg-background-muted/60 hover:text-foreground"}`}>
        <Icon name={icon} className="h-5 w-5" />
        {badge ? <span aria-hidden className="tnum absolute -end-1 -top-1 min-w-4 rounded-full bg-inverse px-1 text-center text-xs font-semibold leading-4 text-inverse-foreground" dir="ltr">{badge}</span> : null}
      </Link>
    );
  };
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
  const specialists = AGENTS.filter((a) => a.id !== "noor");
  const planName = (N.plans as Record<string, string>)[user.plan] ?? user.plan;

  // The rail is drawn twice (the desktop aside, and the phone sheet while open), so every id carries the copy's prefix `p`.
  /** The brand you work on, and the bell beside it (outside the scrolling list, so its panel is never clipped). In the sheet the bell stays in the phone header. */
  const top = (bell: boolean) => (
    <>
    {/* Above the brand: the workspace switcher (multi-workspace M2), drawn only with two workspaces or more. */}
    <WorkspaceSwitcher t={t.workspaces} lang={lang} onNavigate={() => setOpen(false)} />
    <div className="flex items-center gap-1 border-b-[1.5px] border-border-strong p-4 pb-3">
      <BrandSwitcher lang={lang} brands={brandList?.brands ?? null} current={{ id: brandFromPath(path) ?? sessionBrand ?? "default", name: brandName || (lang === "ar" ? "علامتك" : "Your brand") }} canAdd={brandList?.canAdd ?? false} sub={N.workspace} logo={workspaceLogo} onOpen={loadBrands} onPicked={() => { setOpen(false); brandsAsked.current = false; }} />
      {bell && <NotificationCenter t={t} lang={lang} align="start" />}
      {/* Only the desktop rail folds (the phone sheet draws the top without the bell). */}
      {bell && foldButton}
    </div>
    </>
  );


  const nav = (p: string) => (
    <nav aria-label={lang === "ar" ? "التنقل الرئيسي" : "Main navigation"} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
      {group(`${p}-work`, X.work, <>
        <li>{row(to("/chat"), N.main, "chat")}</li>
        <li>{row(base, N.approvals, "inbox", pending)}</li>
        <li>{row(to("/todo"), N.todo, "check")}</li>
        <li>{row(to("/calendar"), N.calendarCh, "calendar")}</li>
      </>)}

      {group(`${p}-dms`, N.dms, <>
        <li className={`${rowBox} text-foreground-muted hover:bg-background-muted/60`}>
          <Link href={to("/chat")} onClick={() => setOpen(false)} className="flex min-w-0 items-center gap-2.5 hover:text-foreground">
            <span style={avatar("noor").style} className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border-[1.5px] border-border-strong font-display text-xs font-bold ${avatar("noor").tone}`} aria-hidden>{t.agents.noor.name.charAt(0)}</span>
            <span className="min-w-0"><span className="clip block text-foreground">{t.agents.noor.name}</span><span className="clip block text-xs">{t.agents.noor.role}</span></span>
          </Link>
          <button type="button" disabled={creating} onClick={() => newThread("noor")} className="btn btn-accent btn-xs" aria-label={`${N.newConv}: ${t.agents.noor.name}`}>+ {N.newConv}</button>
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
                  <Link href={to(`/chat?agent=${a.id}`)} onClick={() => setOpen(false)} className="flex min-h-[var(--hit-min)] min-w-0 items-center gap-2 hover:text-foreground pointer-fine:min-h-9">
                    <span style={avatar(a.id).style} className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border-[1.5px] border-border-strong text-xs font-bold ${avatar(a.id).tone}`} aria-hidden>{t.agents[a.id].name.charAt(0)}</span>
                    <span className="min-w-0"><span className="clip block text-foreground">{t.agents[a.id].name}</span><span className="clip block text-xs">{t.agents[a.id].role}</span></span>
                  </Link>
                  <button type="button" disabled={creating} onClick={() => newThread(a.id)} className="icon-btn" aria-label={`${N.newConv}: ${t.agents[a.id].name}`}><Icon name="plus" className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
          )}
        </li>
      </>)}

      <div role="group" aria-labelledby={`${p}-history`}>
        <p id={`${p}-history`} className="mb-1 px-3 text-xs font-semibold text-foreground-muted">{N.history}</p>
        <form role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) { setOpen(false); r.push(to(`/conversations?q=${encodeURIComponent(q.trim())}`)); } }} className="relative">
          <Icon name="search" className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-muted" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={N.searchConv} aria-label={N.searchConv} className="min-h-[var(--hit-min)] w-full rounded-lg border-[1.5px] border-border-input bg-surface pe-3 ps-8 text-sm text-foreground placeholder:text-foreground-muted focus:border-border-strong pointer-fine:min-h-9" />
        </form>
        <ul className="mt-1 grid gap-0.5">
          {convs.slice(0, 3).map((c) => <li key={c.id}>{row(to(`/chat?conv=${c.id}`), <span dir="auto">{c.title || "…"}</span>, "chat")}</li>)}
          <li><Link href={to("/conversations")} onClick={() => setOpen(false)} className="flex min-h-[var(--hit-min)] items-center px-3 text-xs text-foreground-muted hover:text-foreground pointer-fine:min-h-8">{N.seeAll}</Link></li>
        </ul>
      </div>

      {group(`${p}-brand`, X.brand, <>
        <li>{row(to("/files"), N.files, "folder")}</li>
        {/* Rule 3507: the overview charts, beside the full reports. */}
        <li>{row(to("/overview"), N.overview, "dashboard")}</li>
        <li>{row(to("/reports"), N.performance, "chart")}</li>
        <li>{row(to("/activity"), N.activity, "clock")}</li>
        <li>{row(to("/inspo"), N.contentInspo, "spark")}</li>
        {/* The workspace's agent instructions (rule 957). */}
        <li>{row(to("/instructions"), N.instructions, "strategy")}</li>
      </>)}

      {group(`${p}-account`, X.workspace, <>
        {/* One row for the whole settings area (rule 1141): members, integrations, governance, billing and the rest live
            under /settings, so the row is current on every settings page and no other row is. */}
        <li>{row(settingsHref(to), N.settings, "settings")}</li>
        {show.refer && <li>{row(to("/refer"), N.refer, "gift")}</li>}
        {show.partner && <li>{row(to("/partner"), PARTNER_COPY[lang].nav, "growth")}</li>}
      </>)}

      {group(`${p}-help`, X.support, <>
        {/* Public page: what shipped, and the wishlist signed-in owners vote on. */}
        <li>{row(`/${lang}/updates`, N.updates, "sapling")}</li>
        <li><a href={supportWa ? `https://wa.me/${supportWa}` : to("/help#support")} target={supportWa ? "_blank" : undefined} rel="noreferrer" className={`${rowBox} justify-start gap-2.5 text-foreground-muted hover:bg-background-muted/60 hover:text-foreground`}><Icon name="whatsapp" className="h-4 w-4" />{N.contact}</a></li>
      </>)}
    </nav>
  );

  /** The folded rail (rules 3125-3126): the fold button and the bell, then every destination row as an icon. */
  const compact = (
    <>
      <div className="flex flex-col items-center gap-1 border-b-[1.5px] border-border-strong py-3">
        {foldButton}
        <NotificationCenter t={t} lang={lang} align="start" />
      </div>
      <nav aria-label={lang === "ar" ? "التنقل الرئيسي" : "Main navigation"} className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-3">
        <ul className="grid gap-1">
          <li>{iconRow(to("/chat"), N.main, "chat")}</li>
          <li>{iconRow(base, N.approvals, "inbox", pending)}</li>
          <li>{iconRow(to("/todo"), N.todo, "check")}</li>
          <li>{iconRow(to("/calendar"), N.calendarCh, "calendar")}</li>
        </ul>
        <ul className="grid gap-1 border-t border-border pt-1">
          <li>{iconRow(to("/conversations"), N.history, "search")}</li>
          <li>{iconRow(to("/files"), N.files, "folder")}</li>
          <li>{iconRow(to("/reports"), N.performance, "chart")}</li>
          <li>{iconRow(to("/activity"), N.activity, "clock")}</li>
          <li>{iconRow(to("/inspo"), N.contentInspo, "spark")}</li>
          <li>{iconRow(to("/instructions"), N.instructions, "strategy")}</li>
        </ul>
        <ul className="grid gap-1 border-t border-border pt-1">
          <li>{iconRow(settingsHref(to), N.settings, "settings")}</li>
          {show.refer && <li>{iconRow(to("/refer"), N.refer, "gift")}</li>}
          {show.partner && <li>{iconRow(to("/partner"), PARTNER_COPY[lang].nav, "growth")}</li>}
          <li>{iconRow(`/${lang}/updates`, N.updates, "sapling")}</li>
        </ul>
      </nav>
    </>
  );
  // The account menu. Members moved to the rail's "Account and team" group (it was listed twice); the account pages
  // point into the settings area (rule 1141).
  const links = [
    [settingsHref(to, "account"), N.profile], [to("/notifications"), N.notifications], [to("/tasks"), N.tasks], [to("/generate"), N.generate], [settingsHref(to, "billing"), N.billing], [settingsHref(to, "brand"), N.brand], [settingsHref(to, "brands"), N.brands],
    ...(show.mcp ? [[to("/mcp"), "MCP"]] : []), [to("/help"), N.help],
    // Founder accounts only: the console has its own shell at /{lang}/admin (rules 871, 873), never a main-nav row.
    ...(admin ? [[adminHref(lang, "overview"), N.adminPanel]] : []),
  ];
  // Rule 1204: the theme choice sits with the language in the account menu, one tap from every screen.
  const account = (iconOnly: boolean) => (
    <div className={iconOnly ? "flex justify-center border-t border-border py-3" : "border-t border-border p-4 pt-3"}>
      <Menu
        label={X.account}
        placement="top"
        className={iconOnly ? "" : "w-full"}
        items={links.map(([h, l]) => ({ key: h, href: h, label: l, onSelect: () => setOpen(false) }))}
        footer={<div className="grid gap-2 px-2"><ThemeToggle lang={lang} size="sm" className="justify-self-start" /><div className="flex items-center justify-between"><LangToggle lang={lang} size="sm" /><LogoutButton label={N.logout} lang={lang} /></div></div>}
        trigger={(props, isOpen) => iconOnly ? (
          // Folded: the avatar alone; the name, plan and balance are in its label and tooltip.
          <button {...props} aria-label={`${X.account}: ${user.name || user.email}, ${planName}, ${credits} ${N.credits}`} title={`${user.name || user.email} · ${planName} · ${credits} ${N.credits}`} className="grid h-10 w-10 place-items-center rounded-lg hover:bg-background-muted/60">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-background-muted text-sm font-semibold text-foreground" aria-hidden>{(user.name || user.email).charAt(0).toUpperCase()}</span>
          </button>
        ) : (
          <button {...props} aria-label={`${X.account}: ${user.name || user.email}`} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-start text-sm text-foreground hover:bg-background-muted/60">
            <PersonAvatar src={user.avatar} name={user.name} email={user.email} size={32} />
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
      <aside id="app-rail" data-testid="app-sidebar" data-folded={folded ? "true" : undefined} className={`sticky top-0 hidden h-dvh shrink-0 flex-col border-e-[1.5px] border-border-strong bg-surface text-foreground lg:flex ${folded ? "w-16" : "w-64"}`}>{folded ? <>{compact}{account(true)}</> : <>{top(true)}{nav("rail")}{account(false)}</>}</aside>
      <header className="sticky top-0 z-40 flex items-center justify-between gap-2 border-b-[1.5px] border-border-strong bg-surface px-4 py-2 text-foreground lg:hidden">
        <Link href={to("/chat")} className="font-display text-xl font-bold"><Wordmark lang={lang} name={t.appName} /></Link>
        <div className="flex items-center gap-1">
          <NotificationCenter t={t} lang={lang} align="end" />
          <Link href={settingsHref(to, "billing")} title={show.owner ? undefined : N.sharedCredits} className="tnum inline-flex min-h-[var(--hit-min)] items-center px-2 text-xs font-semibold text-foreground">{credits} {N.credits}</Link>
          <button type="button" onClick={() => setOpen(true)} aria-label={N.menu} aria-expanded={open} aria-haspopup="dialog" className="icon-btn border-[1.5px] border-border-strong text-foreground"><Icon name="menu" className="h-5 w-5" /></button>
        </div>
      </header>
      {open && (
        <Sheet lang={lang} label={N.menu} onClose={() => setOpen(false)} className="lg:hidden">
          <div className="flex min-h-full flex-col pt-10">{top(false)}{nav("sheet")}{account(false)}</div>
        </Sheet>
      )}
    </>
  );
}
