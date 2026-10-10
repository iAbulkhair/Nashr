/**
 * Reem B3, the «تقويم التسويق» card on My to-dos (spec 2026-10-05-secretary-reem-b3-calendar-read-design.md §2, plan Task 10).
 * Rule 923 (card part): the declaration text is exactly the one the saved declaration names (version 1), both languages carry
 * every key, one text per `lostReason` and per `cal_error` code the callback redirects with, no digit, price or claim of ours
 * in the copy; the card renders each of its four states as text (an event title is never markup) and only the account owner's
 * page mounts it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderToReadableStream } from "react-dom/server.edge";
import { newMember, newUser, signIn } from "./helpers/session";
import { appDict } from "@/lib/app-i18n";
import Page from "@/app/[lang]/app/todo/page";
import TodoPanel from "@/components/app/TodoPanel";
import { CalendarLinkView, sinceText, type CalState, type LinkInfo } from "@/components/app/CalendarLinkCard";
import { CAL_DECLARATION_V } from "@/lib/secretary-cal-proof";

// The app router only exists inside Next: the page's client components get a router whose refresh does nothing.
vi.mock("next/navigation", async (orig) => ({ ...(await orig<typeof import("next/navigation")>()), useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const AR_DECLARE = "أقرّ أن هذا التقويم مخصص لتسويق علامتي فقط، وأن ريم لا تقرأ غيره";
const EN_DECLARE = "I confirm this calendar is only for my brand's marketing, and that Reem reads no other.";
const LOST = ["token", "calendar", "domain", "brand", "owner"] as const;
const CAL_ERRORS = ["invalid_state", "session_mismatch", "forbidden", "denied", "brand_inactive", "token_failed", "provider_error"] as const;
const ROUTE_ERRORS = ["stale", "choices_expired", "declaration_required", "not_owned", "not_linked", "provider_error", "provider_not_configured", "forbidden"] as const;

const flat = (o: unknown, prefix = ""): Record<string, string> =>
  Object.entries(o as Record<string, unknown>).reduce<Record<string, string>>((acc, [k, v]) => (typeof v === "string" ? { ...acc, [`${prefix}${k}`]: v } : { ...acc, ...flat(v, `${prefix}${k}.`) }), {});
const card = () => readFileSync("src/components/app/CalendarLinkCard.tsx", "utf8");

const link = (over: Partial<LinkInfo> = {}): LinkInfo => ({
  provider: "gcal", account: "owner@brand.example", calendarName: "Brand marketing", proof: "domain", state: "ok", rev: 3, today: [], ...over,
});
const view = (state: CalState, lang: "ar" | "en" = "en", extra: Partial<Parameters<typeof CalendarLinkView>[0]> = {}) =>
  renderToStaticMarkup(createElement(CalendarLinkView, { t: appDict[lang], lang, providers: { gcal: true, mscal: true }, state, now: Date.parse("2026-10-10T10:00:00Z"), ...extra }));
/** The markup writes an apostrophe as an entity. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#x27;");
const text = (html: string) => html.replace(/<[^>]*>/g, "\n").replace(/\s+/g, " ");

describe("the marketing calendar card text (rule 923)", () => {
  it("the declaration is exactly the text of version 1, in both languages", () => {
    expect(CAL_DECLARATION_V).toBe(1);
    expect(appDict.ar.todo.calLink.declare).toBe(AR_DECLARE);
    expect(appDict.en.todo.calLink.declare).toBe(EN_DECLARE);
  });

  it("both languages carry the same keys, none empty, with the named words and one text per lostReason, cal_error code and route refusal", () => {
    const ar = flat(appDict.ar.todo.calLink);
    const en = flat(appDict.en.todo.calLink);
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(en).length).toBeGreaterThan(40);
    for (const [k, v] of [...Object.entries(ar), ...Object.entries(en)]) expect(v.trim(), k).not.toBe("");
    for (const k of ["connectGoogle", "connectOutlook", "soon", "badgeDomain", "badgeDeclared", "reconnect", "noCalendars", "declare"]) {
      expect(ar[k], `ar ${k}`).toBeTruthy();
      expect(en[k], `en ${k}`).toBeTruthy();
    }
    expect(ar.badgeDomain).toBe("موثّق بنطاق العلامة");
    expect(ar.badgeDeclared).toBe("بإقرار العميل");
    expect(ar.soon).toBe("قريباً");
    expect(ar.title).toBe("تقويم التسويق");
    expect(en.title).toBe("Marketing calendar");
    for (const r of LOST) {
      expect(ar[`lost.${r}`], `ar lost ${r}`).toBeTruthy();
      expect(en[`lost.${r}`], `en lost ${r}`).toBeTruthy();
    }
    for (const c of CAL_ERRORS) {
      expect(ar[`calError.${c}`], `ar cal_error ${c}`).toBeTruthy();
      expect(en[`calError.${c}`], `en cal_error ${c}`).toBeTruthy();
    }
    for (const c of ROUTE_ERRORS) {
      expect(ar[`errors.${c}`], `ar error ${c}`).toBeTruthy();
      expect(en[`errors.${c}`], `en error ${c}`).toBeTruthy();
    }
    // Every text differs between the languages (no key was left in the other language), except the product name in a button.
    for (const k of Object.keys(en)) if (k !== "declare") expect(ar[k] === en[k], k).toBe(false);
  });

  it("no digit, price, currency, customer or result of ours in any key; only the {when} slot is filled", () => {
    for (const [k, v] of [...Object.entries(flat(appDict.ar.todo.calLink)), ...Object.entries(flat(appDict.en.todo.calLink))]) {
      expect(v, k).not.toMatch(/[0-9٠-٩۰-۹]/);
      expect(v, k).not.toMatch(/\$|SAR|USD|ريال|دولار|\bprice|\bpay\b|سعر|%/i);
      expect(v, k).not.toMatch(/customer[s]? like|testimonial|guarantee|ضمان|عملاؤنا/i);
      for (const slot of v.match(/\{[^}]*\}/g) ?? []) expect(slot, k).toBe("{when}");
    }
    expect(appDict.ar.todo.calLink.lastSync).toContain("{when}");
    expect(appDict.en.todo.calLink.lastSync).toContain("{when}");
  });

  it("the not-linked line says what is read and what is never done, in both languages", () => {
    const en = appDict.en.todo.calLink.reads;
    expect(en).toMatch(/time and title/);
    expect(en).toMatch(/never writes/);
    expect(en).toMatch(/never reads your other calendars/);
    const ar = appDict.ar.todo.calLink.reads;
    expect(ar).toContain("وقت الاجتماعات وعناوينها");
    expect(ar).toContain("لا تكتب في أي تقويم");
    expect(ar).toContain("ولا تقرأ تقاويمك الأخرى");
  });
});

describe("the card source (rule 923)", () => {
  it("renders every provider text as text: no dangerouslySetInnerHTML, no eval", () => {
    const src = card();
    expect(src).not.toContain("dangerouslySetInnerHTML");
    expect(src).not.toMatch(/\beval\(|new Function\(|innerHTML/);
  });

  it("takes only a fixed code from the address, removes it with history.replaceState, and reads no secret module", () => {
    const src = card();
    expect(src).toContain("history.replaceState");
    expect(src).toContain("useSearchParams");
    expect(src).toMatch(/CAL_ERRORS as readonly string\[\]\)\.includes\(code\)/);
    expect(src).not.toMatch(/from "@\/lib\/(db|auth|secretary|secretary-cal-link|secretary-gcal|connectors\/[a-z-]+)"/);
    expect(src).not.toMatch(/localStorage|sessionStorage/);
  });

  it("writes through useOneWrite and links to the connect start routes with the page language", () => {
    const src = card();
    expect(src).toContain("useOneWrite");
    expect(src).toContain("/api/connect/${p}/start?lang=${lang}");
    expect(src).toContain('"/api/secretary/calendar-link"');
    expect(src).toContain('"/api/secretary/calendar-link/calendars"');
  });
});

describe("the four states (rule 923)", () => {
  it("Not linked: both buttons go to the start routes with the language, the unverified-app line sits with them", () => {
    for (const lang of ["ar", "en"] as const) {
      const html = view({ kind: "none" }, lang);
      const T = appDict[lang].todo.calLink;
      expect(html).toContain(`href="/api/connect/gcal/start?lang=${lang}"`);
      expect(html).toContain(`href="/api/connect/mscal/start?lang=${lang}"`);
      expect(html).toContain(T.connectGoogle);
      expect(html).toContain(T.connectOutlook);
      expect(html).toContain(esc(T.reads));
      expect(html).toContain(esc(T.googleNote));
      expect(html).not.toContain(T.soon);
    }
  });

  it("Not linked: a provider without app keys shows «Soon» and no link to its start route", () => {
    const html = view({ kind: "none" }, "ar", { providers: { gcal: false, mscal: true } });
    expect(html).not.toContain("/api/connect/gcal/start");
    expect(html).toContain("/api/connect/mscal/start");
    expect(html).toContain(`${appDict.ar.todo.calLink.connectGoogle} · ${appDict.ar.todo.calLink.soon}`);
    const none = view({ kind: "none" }, "en", { providers: { gcal: false, mscal: false } });
    expect(none).not.toContain("/api/connect/");
    expect(none.match(/· Soon/g)).toHaveLength(2);
  });

  it("Choose: one radio per calendar, the declaration box only when needed, Save disabled until picked and ticked", () => {
    const calendars = [{ choice: 0, name: "Brand marketing" }, { choice: 1, name: "<b>Team</b>" }];
    const base = { kind: "choose" as const, link: link({ state: "choose", calendarName: undefined }), calendars, needsDeclaration: true, back: false };
    const open = view(base, "en");
    expect(open.match(/type="radio"/g)).toHaveLength(2);
    expect(open).toContain(esc(EN_DECLARE));
    expect(open).toContain('type="checkbox"');
    expect(open).toMatch(/<button[^>]*disabled=""[^>]*>Save choice</);
    // The calendar's name is text, not markup.
    expect(open).not.toContain("<b>Team</b>");
    expect(open).toContain("&lt;b&gt;Team&lt;/b&gt;");
    // Picked but not ticked: still disabled. Picked and ticked: enabled.
    expect(view(base, "en", { picked: 0 })).toMatch(/<button[^>]*disabled=""[^>]*>Save choice</);
    expect(view(base, "en", { picked: 0, declared: true })).not.toMatch(/<button[^>]*disabled=""[^>]*>Save choice</);
    // A domain-proven account has no box: picking alone enables Save.
    const proven = view({ ...base, needsDeclaration: false }, "ar", { picked: 1 });
    expect(proven).not.toContain(AR_DECLARE);
    expect(proven).not.toContain('type="checkbox"');
    expect(proven).not.toMatch(/<button[^>]*disabled=""[^>]*>احفظ الاختيار</);
    // The arabic box carries the exact declaration.
    expect(view(base, "ar")).toContain(AR_DECLARE);
  });

  it("Choose: no calendars of its own says so, offers a refresh and no Save; the list still loading shows loading", () => {
    const empty = view({ kind: "choose", link: link({ state: "choose" }), calendars: [], needsDeclaration: true, back: false }, "en");
    expect(empty).toContain(appDict.en.todo.calLink.noCalendars);
    expect(empty).toContain(appDict.en.todo.calLink.refresh);
    expect(empty).not.toContain("Save choice");
    expect(empty).not.toContain('type="radio"');
    const wait = view({ kind: "choose", link: link({ state: "choose" }), calendars: null, needsDeclaration: true, back: false }, "en");
    expect(wait).toContain("Loading…");
    expect(wait).not.toContain('type="radio"');
    // Back appears only when the owner came from Linked.
    expect(view({ kind: "choose", link: link(), calendars: [], needsDeclaration: true, back: true }, "en")).toContain(">Back<");
    expect(empty).not.toContain(">Back<");
  });

  it("Linked: the name, the account, the proof badge, the sync age and today's list as text; Change and Disconnect", () => {
    const l = link({
      proof: "declaration", lastSyncAt: "2026-10-10T09:56:00Z",
      today: [{ start: "10:00", end: "10:30", title: "Review <img src=x onerror=alert(1)>" }, { start: "14:00", end: "15:00", title: "مشغول" }],
    });
    const html = view({ kind: "linked", link: l }, "en");
    const T = appDict.en.todo.calLink;
    expect(html).toContain("Brand marketing");
    expect(html).toContain("owner@brand.example");
    expect(html).toContain(T.badgeDeclared);
    expect(html).not.toContain(T.badgeDomain);
    expect(text(html)).toContain("Last synced: 4 minutes ago");
    expect(html).toContain("10:00–10:30");
    expect(html).toContain("14:00–15:00");
    // An event title is untrusted text: escaped, never markup, and its direction follows its own script.
    expect(html).not.toContain("<img");
    expect(html).toContain("Review &lt;img src=x onerror=alert(1)&gt;");
    expect(html).toMatch(/<bdi dir="auto"[^>]*>Review/);
    expect(html).toContain(T.change);
    expect(html).toContain(T.unlink);
    expect(view({ kind: "linked", link: link() }, "en")).toContain(T.badgeDomain);
    expect(view({ kind: "linked", link: link() }, "en")).toContain(T.noneToday);
    expect(view({ kind: "linked", link: link() }, "en")).toContain(T.notSynced);
  });

  it("Linked: Disconnect asks inline first and names what happens", () => {
    const html = view({ kind: "linked", link: link() }, "ar", { confirming: true });
    const T = appDict.ar.todo.calLink;
    expect(html).toContain(T.confirmUnlink);
    expect(html).toContain(T.confirmYes);
    expect(html).not.toContain(`>${T.change}<`);
  });

  it("Reconnect: one line per lostReason and «Reconnect» to the link's own provider; an unknown reason says the token one", () => {
    for (const lang of ["ar", "en"] as const) {
      const T = appDict[lang].todo.calLink;
      for (const r of LOST) {
        const html = view({ kind: "reconnect", link: link({ provider: "mscal", state: "reconnect", lostReason: r }) }, lang);
        expect(html).toContain(esc(T.lost[r]));
        expect(html).toContain(`href="/api/connect/mscal/start?lang=${lang}"`);
        expect(html).toContain(T.reconnect);
        expect(html).toContain(T.reconnectNote);
      }
      expect(view({ kind: "reconnect", link: link({ state: "reconnect", lostReason: "nope" as never }) }, lang)).toContain(esc(T.lost.token));
    }
  });

  it("a provider return error shows its fixed words above the state", () => {
    for (const c of CAL_ERRORS) {
      expect(view({ kind: "none" }, "ar", { fromError: c })).toContain(appDict.ar.todo.calLink.calError[c]);
      expect(view({ kind: "none" }, "en", { fromError: c })).toContain(appDict.en.todo.calLink.calError[c]);
    }
    expect(view({ kind: "none" }, "en")).not.toContain('role="alert"');
  });

  it("phone width and right-to-left: the card never forces a width, long names wrap, and every row can shrink", () => {
    const src = card();
    expect(src).not.toMatch(/\bw-\[|min-w-\[|\bwhitespace-nowrap\b|overflow-x-scroll/);
    expect(src).toContain("break-all");
    expect(src).toContain("break-words");
    expect(src).toContain("min-w-0");
    // Times keep their own direction inside a right-to-left line.
    expect(view({ kind: "linked", link: link({ today: [{ start: "09:00", end: "10:00", title: "x" }] }) }, "ar")).toContain('<bdi dir="ltr"');
  });

  it("sinceText writes the age in Latin digits in both languages and refuses a bad time", () => {
    const now = Date.parse("2026-10-10T10:00:00Z");
    expect(sinceText("2026-10-10T09:56:00Z", "en", now)).toBe("4 minutes ago");
    expect(sinceText("2026-10-10T09:56:00Z", "ar", now)).toMatch(/4/);
    expect(sinceText("2026-10-10T09:56:00Z", "ar", now)).not.toMatch(/[٠-٩]/);
    expect(sinceText("2026-10-10T06:00:00Z", "en", now)).toBe("4 hours ago");
    expect(sinceText("2026-10-07T10:00:00Z", "en", now)).toBe("3 days ago");
    expect(sinceText("nope", "en", now)).toBe("");
  });
});

describe("who sees the card (rule 923)", () => {
  const panel = (extra: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(TodoPanel, {
      t: appDict.en, zoneLabel: "Riyadh", sections: [], approvals: null, snoozed: 0, allClear: false, empty: true, done: [], deleted: [], tonight: false,
      canClose: true, canWrite: true, todoHref: "/en/app/todo", timed: true, briefAt: "08:00", lang: "en", inboxHref: "/en/app",
      away: { entries: [], labels: [], canEdit: false, today: "2026-10-10", last: "2027-01-01" }, ...extra,
    }));

  it("TodoPanel mounts the card only when canLinkCalendar, and never by default", () => {
    expect(panel({ canLinkCalendar: true, calProviders: { gcal: true, mscal: false } })).toContain('id="todo-calendar"');
    expect(panel({ canLinkCalendar: true, calProviders: { gcal: true, mscal: false } })).toContain("Marketing calendar");
    expect(panel({ canLinkCalendar: false, calProviders: { gcal: true, mscal: true } })).not.toContain("todo-calendar");
    expect(panel({})).not.toContain("todo-calendar");
    // It sits next to the calendar feed card.
    const html = panel({ canLinkCalendar: true });
    expect(html.indexOf('id="todo-feed"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="todo-calendar"')).toBeGreaterThan(html.indexOf('id="todo-feed"'));
  });

  it("the page passes can(u, \"calendar.link\") and the two providers' availability from the registry", () => {
    const src = readFileSync("src/app/[lang]/app/todo/page.tsx", "utf8");
    expect(src).toContain('canLinkCalendar={can(u, "calendar.link")}');
    expect(src).toContain('calProviders={{ gcal: calReady("gcal"), mscal: calReady("mscal") }}');
    expect(src).toMatch(/import \{ getProvider, isAvailable \} from "@\/lib\/connectors\/registry"/);
  });

  it("the owner's page has the card; an admin's and a member's page do not", async () => {
    const render = async (lang: "ar" | "en") => new Response(await renderToReadableStream(await Page({ params: Promise.resolve({ lang }) }))).text();
    const o = await newUser("calcard");
    await signIn(o.email);
    expect(await render("en")).toContain('id="todo-calendar"');
    expect(await render("ar")).toContain("تقويم التسويق");
    const admin = await newMember(o, "admin", "calcarda");
    await signIn(admin.email);
    expect(await render("en")).not.toContain("todo-calendar");
    const member = await newMember(o, "member", "calcardm");
    await signIn(member.email);
    expect(await render("ar")).not.toContain("todo-calendar");
    expect(await render("ar")).not.toContain("تقويم التسويق");
  });
});
