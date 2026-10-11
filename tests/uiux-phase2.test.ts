// UI/UX phase 2 (docs/reports/2026-10-10-supastarter-uiux-report.md §4-§7): the shell, the loading and empty states,
// the chat, the calendar, the reports chart and the phase 1 leftovers. Rules 1110-1130, listed in
// docs/system/tests/1110-uiux-phase2.md. Source-reading checks (no DOM in this suite), static renders and the pure helpers.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { menuIndex } from "@/components/ui/Menu";
import { tabStep } from "@/components/ui/Tabs";
import { Skeleton, SkeletonText, LoadingRegion } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import ErrorState from "@/components/ui/ErrorState";
import PageHeader from "@/components/ui/PageHeader";
import ScribbleStatic from "@/components/ScribbleStatic";
import CopyButton, { COPIED_MS } from "@/components/ui/CopyButton";
import { Icon } from "@/components/app/Icons";
import { bellCount, BELL_LIST } from "@/components/app/NotificationCenter";
import { isStale, WORKSPACE_STALE_MS, WORKSPACE_EVENTS } from "@/components/app/WorkspaceContext";
import { enterSends, COMPOSER_MAX_PX } from "@/components/app/ChatPanel";
import { dayIn, arrowShift } from "@/components/app/CalendarPanel";
import { CHANNEL_LIMITS, overLimit } from "@/lib/channel-limits";
import { appDict } from "@/lib/app-i18n";

const read = (f: string) => readFileSync(f, "utf8");
const ARABIC_DIGITS = /[٠-٩۰-۹]/;

describe("rule 1110: the confirm dialog lives in ui/ and can run the action behind a busy button", () => {
  const src = read("src/components/ui/ConfirmDialog.tsx");
  it("the old app path re-exports the ui dialog, so no caller changes", () => {
    expect(read("src/components/app/ConfirmDialog.tsx")).toMatch(/from "@\/components\/ui\/ConfirmDialog"/);
  });
  it("run() keeps the dialog open and busy: cancel is disabled, Escape is refused, the confirm button says aria-busy", () => {
    expect(src).toMatch(/run\?: \(\) => Promise<string \| null \| void>/);
    expect(src).toMatch(/onCancel=\{\(e\) => \{ if \(busy\) e\.preventDefault\(\); \}\}/);
    expect(src).toMatch(/onClick=\{\(e\) => press\(e, false\)\} disabled=\{busy\}/);
    expect(src).toMatch(/aria-busy=\{busy \|\| undefined\}/);
  });
});

describe("rule 1111: Sheet is a native modal dialog that returns focus and locks the page behind", () => {
  const src = read("src/components/ui/Sheet.tsx");
  it("opens with showModal, is named, gives focus back to its opener and restores the page's scroll", () => {
    expect(src).toContain("d.showModal()");
    expect(src).toContain("aria-label={label}");
    expect(src).toMatch(/if \(opener\?\.isConnected\) opener\.focus\(\)/);
    expect(src).toMatch(/root\.style\.overflow = before/);
  });
  it("a backdrop press closes only when it began on the backdrop; sides are logical; close is a 44px icon button", () => {
    expect(src).toMatch(/downOnBackdrop\.current && e\.target === e\.currentTarget/);
    expect(src).toMatch(/side === "start" \? "ms-0 me-auto/);
    expect(src).toMatch(/className="icon-btn absolute end-2 top-2"/);
  });
});

describe("rule 1112: Menu follows the menu-button pattern and its keys wrap", () => {
  it("ArrowDown and ArrowUp wrap, Home and End jump, anything else is not a move, an empty menu has no focus", () => {
    expect(menuIndex("ArrowDown", 2, 3)).toBe(0);
    expect(menuIndex("ArrowUp", 0, 3)).toBe(2);
    expect(menuIndex("Home", 2, 3)).toBe(0);
    expect(menuIndex("End", 0, 3)).toBe(2);
    expect(menuIndex("a", 0, 3)).toBeNull();
    expect(menuIndex("ArrowDown", 0, 0)).toBeNull();
  });
  it("the trigger says aria-haspopup=menu and its state; rows are menuitems", () => {
    const src = read("src/components/ui/Menu.tsx");
    expect(src).toContain('"aria-haspopup": "menu"');
    expect(src).toContain('role="menu"');
    expect(src).toContain('role="menuitem"');
  });
});

describe("rule 1113: Tabs move the way the arrow points, in both directions", () => {
  it("ArrowRight is the next tab in English and the previous one in Arabic", () => {
    expect(tabStep("ArrowRight", 0, 3, false)).toBe(1);
    expect(tabStep("ArrowRight", 0, 3, true)).toBe(2);
    expect(tabStep("ArrowLeft", 0, 3, true)).toBe(1);
    expect(tabStep("End", 0, 3, true)).toBe(2);
    expect(tabStep("Enter", 0, 3, false)).toBeNull();
  });
  it("tablist, tab with aria-selected and aria-controls, and a tabpanel", () => {
    const src = read("src/components/ui/Tabs.tsx");
    expect(src).toContain('role="tablist"');
    expect(src).toContain('role="tab"');
    expect(src).toContain("aria-selected=");
    expect(src).toContain("aria-controls=");
    expect(src).toContain('role="tabpanel"');
  });
});

describe("rule 1114: PageHeader and ScribbleStatic render on the server in the page's direction", () => {
  it("neither is a client component", () => {
    expect(read("src/components/ui/PageHeader.tsx")).not.toMatch(/^"use client"/m);
    expect(read("src/components/ScribbleStatic.tsx")).not.toMatch(/^"use client"/m);
  });
  it("a header renders its title in an h1 with the scribble, the sub line and the actions", () => {
    const html = renderToStaticMarkup(h(PageHeader, { lang: "ar", title: "التقويم", sub: "أسبوعك", seed: "calendar", actions: h("button", null, "x") }));
    expect(html).toMatch(/<h1 class="page-title">/);
    expect(html).toContain("<svg");
    expect(html).toContain("أسبوعك");
  });
  it("the same seed draws differently right to left than left to right", () => {
    const ar = renderToStaticMarkup(h(ScribbleStatic, { kind: "underline", seed: "t", rtl: true }));
    const en = renderToStaticMarkup(h(ScribbleStatic, { kind: "underline", seed: "t", rtl: false }));
    expect(ar).toContain("<svg");
    expect(ar).not.toBe(en);
  });
});

describe("rule 1115: loading screens, skeletons, and the card and line height on the tokens", () => {
  it("a skeleton is hidden from screen readers; the region around it is one polite busy status", () => {
    expect(renderToStaticMarkup(h(Skeleton))).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(h(SkeletonText, { lines: 2 }))).toContain('aria-hidden="true"');
    const region = renderToStaticMarkup(h(LoadingRegion, { label: "Loading", children: h(Skeleton) }));
    expect(region).toMatch(/role="status" aria-live="polite" aria-busy="true"/);
    expect(region).toContain('<span class="sr-only">Loading</span>');
  });
  it("each signed-in area that waits on the server has a loading.tsx on RouteLoading", () => {
    // Billing moved into the settings area in UI/UX phase 3 (rule 1140), its loading screen with it.
    for (const dir of ["", "/chat", "/calendar", "/reports", "/notifications", "/conversations", "/activity", "/settings/billing", "/files"]) {
      const f = `src/app/[lang]/app${dir}/loading.tsx`;
      expect(existsSync(f), f).toBe(true);
      expect(read(f), f).toContain("<RouteLoading");
    }
    // loading.tsx gets no params: the language comes from the URL.
    expect(read("src/components/app/RouteLoading.tsx")).toContain("useParams");
  });
  it(".card and the body's line height read the tokens; scroll-padding clears the sticky phone header", () => {
    const g = read("src/app/globals.css");
    expect(g).toMatch(/\.card \{[^}]*var\(--radius-card\)/);
    expect(g).toMatch(/line-height: var\(--leading-body\)/);
    expect(g).toContain("scroll-padding-block");
  });
});

describe("rule 1116: empty and failed states say what happened; the profile no longer waits forever (B-12)", () => {
  it("EmptyState is content, not a live region; ErrorState is an alert with Try again", () => {
    const empty = renderToStaticMarkup(h(EmptyState, { title: "Nothing yet" }));
    expect(empty).toContain("Nothing yet");
    expect(empty).not.toMatch(/role="(status|alert)"/);
    const err = renderToStaticMarkup(h(ErrorState, { title: "Could not load", retryLabel: "Try again", onRetry: () => {} }));
    expect(err).toContain('role="alert"');
    expect(err).toContain("Try again");
  });
  // The profile page left in UI/UX phase 3 (rule 1140): its settings pages render on the server from the record, so there
  // is no client read to fail; the credit card moved to billing and keeps the formatted trial end.
  it("the credit card shows the trial end as a formatted date", () => {
    const src = read("src/components/app/settings/CreditUsageCard.tsx");
    expect(src).toContain("formatTime(user.trialEnds, lang)");
    expect(src).not.toMatch(/Ends \$\{user\.trialEnds\.slice/);
  });
});

describe("rule 1117: CopyButton says the result", () => {
  it("names the icon-only button, announces in a status, and resets after COPIED_MS", () => {
    const html = renderToStaticMarkup(h(CopyButton, { text: "x", lang: "ar", label: "انسخ الرد", iconOnly: true }));
    expect(html).toContain('aria-label="انسخ الرد"');
    expect(html).toContain('role="status"');
    expect(html).toContain("icon-btn");
    expect(COPIED_MS).toBe(1500);
  });
});

describe("rule 1118: directional icons mirror in a right-to-left page", () => {
  it("mirror adds rtl:-scale-x-100, and only when asked", () => {
    expect(renderToStaticMarkup(h(Icon, { name: "send", mirror: true }))).toContain("rtl:-scale-x-100");
    expect(renderToStaticMarkup(h(Icon, { name: "send" }))).not.toContain("rtl:-scale-x-100");
  });
});

describe("rule 1119: the shell's counts are read once on the server and shared", () => {
  it("the layout reads brand, notifications and approvals in one Promise.all and wraps the tree in WorkspaceProvider", () => {
    const layout = read("src/app/[lang]/app/layout.tsx");
    // Since rule 1177 the impersonation banner reads the session's founder actor, so the cookie read left this round.
    expect(layout).toMatch(/await Promise\.all\(\[getBrand\(sc\(user\)\), listNotifs\(user\.email\), pendingCount\(sc\(user\)\)\]\)/);
    expect(layout).toMatch(/<WorkspaceProvider initial=\{\{ credits: user\.credits, unread, pending: toApprove \}\}>/);
  });
  it("counts are re-read only when 30 seconds old or a screen announces a change", () => {
    expect(WORKSPACE_STALE_MS).toBe(30_000);
    expect(isStale(0, 29_999)).toBe(false);
    expect(isStale(0, 30_000)).toBe(true);
    expect(WORKSPACE_EVENTS.unread).toBe("nashr:unread-changed");
    expect(WORKSPACE_EVENTS.pending).toBe("nashr:pending-changed");
  });
});

describe("rules 1120-1121: the rail is grouped, the phone menu is a Sheet, the account menu is a Menu", () => {
  const src = read("src/components/app/Sidebar.tsx");
  it("groups are named sections; the active row is aria-current; rows are 44px on touch screens", () => {
    expect(src).toMatch(/<section aria-labelledby=\{id\}>/);
    expect(src).toContain('aria-current={active(href) ? "page" : undefined}');
    expect(src).toContain("min-h-[var(--hit-min)]");
  });
  it("the phone menu opens a Sheet from a labelled button; no global Escape listener is left", () => {
    expect(src).toContain("<Sheet");
    expect(src).toMatch(/aria-label=\{N\.menu\} aria-expanded=\{open\} aria-haspopup="dialog"/);
    expect(src).not.toMatch(/addEventListener\("keydown"/);
    expect(src).toContain("<Menu");
  });
  it("overlapping avatars use a logical margin (B-15)", () => {
    expect(src).toContain('"-ms-2"');
    expect(src).not.toMatch(/-ml-2|-mr-2/);
  });
});

describe("rule 1122: the bell names its count and loads its list only when opened", () => {
  it("bellCount caps at 99+ and never goes negative; the panel shows BELL_LIST rows", () => {
    expect(bellCount(0)).toBe("0");
    expect(bellCount(7)).toBe("7");
    expect(bellCount(150)).toBe("99+");
    expect(bellCount(-3)).toBe("0");
    expect(BELL_LIST).toBe(8);
  });
  it("opening reads the list in the click handler, not in an effect; marking read is a button", () => {
    const src = read("src/components/app/NotificationCenter.tsx");
    expect(src).toMatch(/function toggle\(\) \{[\s\S]*?if \(!open\) void load\(\);/);
    expect(src).toContain("onClick={markAll}");
    expect(src).toContain("aria-expanded={open}");
  });
});

describe("rule 1123: the notifications page marks nothing read on its own", () => {
  const src = read("src/components/app/NotificationsPanel.tsx");
  it("no timer marks all read; the button does, and failure is an alert", () => {
    expect(src).not.toContain("setTimeout");
    expect(src).toMatch(/onClick=\{markAll\}>\{U\.markAll\}/);
    expect(src).toContain('role="alert" className="field-error');
  });
  it("unread rows say so to screen readers and times go through Time", () => {
    expect(src).toMatch(/<span className="sr-only"> \(\{U\.unread\}\)<\/span>/);
    expect(src).toContain('<Time value={n.at} lang={lang} style="datetime"');
    expect(src).not.toMatch(/\.slice\(0, 1[06]\)/);
  });
});

describe("rule 1124: one approval card and one channel-limit list for chat and inbox", () => {
  it("Meta's limit is the same in both, and overLimit compares against it", () => {
    expect(CHANNEL_LIMITS.meta).toBe(63206);
    expect(CHANNEL_LIMITS.x).toBe(280);
    expect(read("src/components/app/Inbox.tsx")).toContain("CHANNEL_LIMITS");
    expect(overLimit("x", 281)).toBeTruthy();
    expect(overLimit("x", 280)).toBeFalsy();
  });
  it("ChatPanel's ItemCard is the ApprovalCard, whose body goes through render and whose toggle says aria-expanded", () => {
    expect(read("src/components/app/ChatPanel.tsx")).toContain("export const ItemCard = ApprovalCard;");
    const card = read("src/components/app/ApprovalCard.tsx");
    expect(card).toMatch(/from "@\/lib\/md"/);
    expect(card).toContain("aria-expanded=");
  });
});

describe("rule 1125: the composer is a growing textarea; Enter sends only with a keyboard", () => {
  it("Enter sends; Shift+Enter, an input method composing, and touch screens add a line", () => {
    expect(enterSends({ key: "Enter", shiftKey: false }, false)).toBe(true);
    expect(enterSends({ key: "Enter", shiftKey: true }, false)).toBe(false);
    expect(enterSends({ key: "Enter", shiftKey: false, isComposing: true }, false)).toBe(false);
    expect(enterSends({ key: "Enter", shiftKey: false, keyCode: 229 }, false)).toBe(false);
    expect(enterSends({ key: "Enter", shiftKey: false }, true)).toBe(false);
    expect(enterSends({ key: "a", shiftKey: false }, false)).toBe(false);
  });
  it("the box grows to COMPOSER_MAX_PX and sticks to the bottom on a phone", () => {
    expect(COMPOSER_MAX_PX).toBe(160);
    const src = read("src/components/app/ChatPanel.tsx");
    expect(src).toContain("<textarea");
    expect(src).toMatch(/sticky bottom-0[^"]*lg:static/);
    expect(src).toContain('aria-describedby="chat-enter-hint"');
  });
});

describe("rule 1126: Stop, copy and retry", () => {
  const src = read("src/components/app/ChatPanel.tsx");
  it("the request carries an AbortController signal; a stop shows the honest note and runs no recovery", () => {
    expect(src).toContain("signal: ac.signal");
    expect(src).toContain("ctl.current?.abort();");
    expect(src).toMatch(/if \(stopped\.current\) \{ setStoppedNote\(true\); return; \}/);
  });
  it("the stop note says the reply may still be saved and counted, in both languages", () => {
    for (const lang of ["ar", "en"] as const) expect(appDict[lang].ux.chat.stopped.length, lang).toBeGreaterThan(10);
    expect(appDict.en.ux.chat.stopped).toMatch(/save it \(and it is counted\)/);
    expect(appDict.ar.ux.chat.stopped).toContain("(ويُحسب)");
  });
  it("each answer has a CopyButton and the last one a retry", () => {
    expect(src).toContain("<CopyButton");
    expect(src).toContain("retryAt(");
  });
});

describe("rule 1127: the agent picker is toggle buttons and a specialists Menu, not tabs", () => {
  it("no tablist or listbox remains in the chat picker", () => {
    const src = read("src/components/app/ChatPanel.tsx");
    expect(src).not.toContain('role="tablist"');
    expect(src).not.toContain('role="listbox"');
    expect(src).toMatch(/role="group"/);
    expect(src).toContain("aria-pressed=");
  });
});

describe("rule 1128: the calendar's today, arrows and views", () => {
  it("today is the brand's day, not the browser's or UTC's", () => {
    // 22:30 UTC on 10 October is already 11 October in Riyadh.
    expect(dayIn(new Date("2026-10-10T22:30:00Z"))).toBe("2026-10-11");
    expect(dayIn(new Date("2026-10-10T22:30:00Z"), "UTC")).toBe("2026-10-10");
  });
  it("arrow keys move along the reading direction", () => {
    expect(arrowShift("ArrowRight", false)).toBe(1);
    expect(arrowShift("ArrowRight", true)).toBe(-1);
    expect(arrowShift("ArrowLeft", true)).toBe(1);
    expect(arrowShift("Enter", true)).toBe(0);
  });
  it("week, month and agenda are Tabs; the month grid is not forced left to right; today is aria-current", () => {
    const src = read("src/components/app/CalendarPanel.tsx");
    expect(src).toContain('idBase="cal"');
    expect(src).toContain("<TabPanel");
    expect(src).toContain('aria-current={');
    expect(src).not.toMatch(/dir="ltr"[^>]*grid-cols-7/);
  });
});

describe("rule 1129: the reports chart has words, a table and a marked range", () => {
  const src = read("src/components/app/ReportsPanel.tsx");
  it("the range pills are a nav whose current pill is aria-current", () => {
    expect(src).toMatch(/<nav aria-label=\{t\.ux\.reports\.rangeLabel\}/);
    expect(src).toMatch(/aria-current=\{range === rg \? "page" : undefined\}/);
  });
  it("the chart points at a data table; days are formatted, never sliced", () => {
    expect(src).toContain('aria-describedby="trend-table"');
    expect(src).toContain('<table id="trend-table"');
    expect(src).not.toMatch(/\.date\.slice\(5\)/);
    expect(src).not.toMatch(/createdAt\.slice\(0, 10\)/);
  });
  it("the series still use the chart tokens", () => {
    expect(src).toContain('created: "var(--chart-1)", approved: "var(--chart-2)", published: "var(--chart-3)"');
  });
});

describe("rule 1130: the hand-built switches use the shared Switch", () => {
  it("tasks, chat allowance and series render ui/Switch, and none draws its own thumb", () => {
    for (const f of ["src/components/app/TasksPanel.tsx", "src/components/app/ChatAllowanceCard.tsx", "src/components/app/SeriesPanel.tsx"]) {
      const src = read(f);
      expect(src, f).toContain('import Switch from "@/components/ui/Switch";');
      expect(src, f).toMatch(/<Switch\s/);
      expect(src, f).not.toContain('role="switch"');
      expect(src, f).not.toContain("start-[22px]");
    }
  });
});

describe("phase 2 dictionary: every ux string exists in both languages with Western digits", () => {
  it("the ux slices have the same keys in Arabic and English", () => {
    const keys = (o: unknown, p = ""): string[] => (o && typeof o === "object" ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => (typeof v === "string" ? [p + k] : keys(v, `${p}${k}.`))) : []);
    expect(keys(appDict.ar.ux).sort()).toEqual(keys(appDict.en.ux).sort());
    const strings = (o: unknown): string[] => (typeof o === "string" ? [o] : o && typeof o === "object" ? Object.values(o).flatMap(strings) : []);
    for (const s of strings(appDict.ar.ux)) expect(s).not.toMatch(ARABIC_DIGITS);
  });
});
