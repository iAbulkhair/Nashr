import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PLAN_SEATS, type User } from "@/lib/auth";
import { PLAN_PRICE_SAR } from "@/lib/pricing";
import { appDict } from "@/lib/app-i18n";
import { dict } from "@/lib/i18n";
import { INDUSTRY_PAGES } from "@/lib/pages-industry";
import { forgetInviteToken, readInviteToken, recallInviteToken, rememberInviteToken, withoutFragment } from "@/components/app/inviteToken";
import { teamPerms } from "@/components/app/teamPerms";
import TrialBanner from "@/components/app/TrialBanner";
import Sidebar from "@/components/app/Sidebar";
import TeamPage from "@/app/[lang]/app/team/page";
import JoinPage from "@/app/[lang]/app/join/page";
import BillingPage from "@/app/[lang]/app/billing/page";
import GovernancePage from "@/app/[lang]/app/governance/page";
import TasksPage from "@/app/[lang]/app/tasks/page";
import OnboardingPage from "@/app/[lang]/app/onboarding/page";
import BrandsPage from "@/app/[lang]/app/brands/page";
import ReferPage from "@/app/[lang]/app/refer/page";
import McpPage from "@/app/[lang]/app/mcp/page";
import InboxPage from "@/app/[lang]/app/page";
import StartPage from "@/app/[lang]/app/start/page";
import ReportsPage from "@/app/[lang]/app/reports/page";
import FilesPage from "@/app/[lang]/app/files/page";
import ChatPage from "@/app/[lang]/app/chat/page";
import { saveBrand, saveTask, type Brand } from "@/lib/brand";
import { DICT_COPY } from "@/lib/dictionary";
import { writeFile } from "@/lib/files";
import { APP_PUBLIC_ROUTES, APP_ROUTES } from "../e2e/fixtures/routes";
import { newMember, newUser, signIn, signOut } from "./helpers/session";

/**
 * The Members UI and the read-only screens (docs/superpowers/specs/2026-09-29-teams-design.md §7). The server enforces
 * every rule in the /api routes (tests/teams-core.test.ts and the route tests); these pin what each role is SHOWN, so an
 * owner-only control or owner-only data does not reappear on a member's page, and the invite token stays out of URLs.
 */

// Client components read the router; outside Next there is none. Server-only helpers (redirect, notFound) stay real.
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en/app",
  useSearchParams: () => new URLSearchParams(),
}));

const en = appDict.en;
const params = { params: Promise.resolve({ lang: "en" }) };
type AsyncPage = (p: typeof params) => Promise<ReactElement>;
const html = async (page: unknown) => renderToStaticMarkup(await (page as AsyncPage)(params));
/** React escapes apostrophes in text; compare against what the markup really contains. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let owner: User;
let admin: { email: string };
let member: { email: string };
beforeAll(async () => {
  owner = await newUser("teamui");
  admin = await newMember(owner, "admin", "uiadm");
  member = await newMember(owner, "member", "uimem");
});
afterEach(() => signOut());

describe("invite links keep the token in the URL fragment", () => {
  const tok = "a".repeat(64);
  it("reads a 64-hex token from the fragment only, and nothing malformed", () => {
    expect(readInviteToken(`#t=${tok}`)).toBe(tok);
    expect(readInviteToken(`#t=${tok.toUpperCase()}`)).toBe(tok);
    expect(readInviteToken(`#x=1&t=${tok}`)).toBe(tok);
    expect(readInviteToken("#t=abc")).toBe("");
    expect(readInviteToken(`#t=${tok}zz`)).toBe("");
    expect(readInviteToken("")).toBe("");
  });

  it("leaves the address without the fragment once read", () => {
    expect(withoutFragment({ pathname: "/ar/app/join", search: "" })).toBe("/ar/app/join");
  });

  it("keeps the token for the tab, so a language switch (which reloads without the fragment) still finds it", () => {
    const m = new Map<string, string>();
    const tab = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    expect(recallInviteToken(tab)).toBe("");
    rememberInviteToken(tok.toUpperCase(), tab);
    expect(recallInviteToken(tab)).toBe(tok);
    rememberInviteToken("not-a-token", tab);
    expect(recallInviteToken(tab), "a malformed value never replaces it").toBe(tok);
    forgetInviteToken(tab);
    expect(recallInviteToken(tab)).toBe("");
    // Blocked storage (a private window) throws: the page still works, from the fragment alone.
    const blocked = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); }, removeItem: () => { throw new Error("SecurityError"); } };
    expect(() => rememberInviteToken(tok, blocked)).not.toThrow();
    expect(recallInviteToken(blocked)).toBe("");
    expect(() => forgetInviteToken(blocked)).not.toThrow();
    const form = readFileSync("src/components/app/JoinForm.tsx", "utf8");
    expect(form).toContain("readInviteToken(window.location.hash) || recallInviteToken()");
    expect(form.match(/forgetInviteToken\(\)/g)?.length, "forgotten after an accept and after each invalid answer").toBeGreaterThanOrEqual(3);
  });

  it("the join page and form never read or build a query-string token", () => {
    const form = readFileSync("src/components/app/JoinForm.tsx", "utf8");
    const page = readFileSync("src/app/[lang]/app/join/page.tsx", "utf8");
    for (const src of [form, page]) expect(src).not.toMatch(/useSearchParams|searchParams|[?&]t=|\?token=/);
    expect(form).toContain("readInviteToken(window.location.hash)");
    expect(form).toContain("history.replaceState");
    // The token only ever leaves the browser in a JSON body.
    expect(form).toMatch(/JSON\.stringify\(\{ token: tok \}\)/);
  });

  it("/join is public in the layout and in the e2e route inventory; /team is an app route", () => {
    const layout = readFileSync("src/app/[lang]/app/layout.tsx", "utf8");
    expect(layout).toMatch(/const PUBLIC = \[[^\]]*"\/join"[^\]]*\]/);
    expect(APP_PUBLIC_ROUTES).toContain("/app/join");
    expect(APP_ROUTES.map((r) => r.path)).toContain("/app/team");
    expect(APP_ROUTES.map((r) => r.path)).not.toContain("/app/join");
  });
});

describe("Members page permissions come from can()", () => {
  const as = (actor: User["actor"]) => ({ ...owner, actor }) as User;
  const base = { name: "X", lang: "ar" as const };
  it("owner: everything but leaving", () => {
    expect(teamPerms(as({ ...base, kind: "owner", email: owner.email, role: "owner" }))).toEqual({ inviteMember: true, inviteAdmin: true, changeRole: true, removeMember: true, removeAdmin: true, viewInvites: true, cancelInvite: true, leave: false, impersonating: false });
  });
  it("admin: plain members only, no role changes", () => {
    expect(teamPerms(as({ ...base, kind: "member", email: admin.email, role: "admin" }))).toEqual({ inviteMember: true, inviteAdmin: false, changeRole: false, removeMember: true, removeAdmin: false, viewInvites: true, cancelInvite: true, leave: true, impersonating: false });
  });
  it("member: view and leave only", () => {
    expect(teamPerms(as({ ...base, kind: "member", email: member.email, role: "member" }))).toEqual({ inviteMember: false, inviteAdmin: false, changeRole: false, removeMember: false, removeAdmin: false, viewInvites: false, cancelInvite: false, leave: true, impersonating: false });
  });
  it("a founder viewing the account changes nothing in the team", () => {
    const p = teamPerms(as({ ...base, kind: "founder", email: owner.email, role: "owner", impersonating: "f@test.example" }));
    expect(p).toMatchObject({ inviteMember: false, inviteAdmin: false, changeRole: false, removeMember: false, removeAdmin: false, cancelInvite: false, leave: false, impersonating: true });
  });
  it("no actor, no user: nothing (fail closed)", () => {
    expect(Object.values(teamPerms({ ...owner, actor: undefined })).some(Boolean)).toBe(false);
    expect(Object.values(teamPerms(null)).some(Boolean)).toBe(false);
  });
});

describe("the Members page by role", () => {
  it("owner: invite form with both roles, role changes, pending invites, no leave", async () => {
    await signIn(owner.email);
    const h = await html(TeamPage);
    expect(h).toContain(`<h1 class="page-title">${en.team.title}</h1>`);
    // No mail in this environment: the form says a link is made to pass on, never that an email is sent.
    expect(h).toContain(en.team.createLink);
    expect(h).toContain(esc(en.team.inviteSubHand));
    expect(h).not.toContain(esc(en.team.inviteSub));
    expect(h).toContain(`<option value="admin">${en.team.roles.admin}</option>`);
    expect(h).toContain(en.team.pending);
    expect(h).toContain(admin.email);
    expect(h).toContain(member.email);
    expect(h).not.toContain(en.team.leaveSub);
  });

  it("admin: invites plain members only, sees pending invites, cannot change roles", async () => {
    await signIn(admin.email);
    const h = await html(TeamPage);
    expect(h).toContain(en.team.createLink);
    expect(h).not.toContain('value="admin"');
    expect(h).toContain(en.team.pending);
    expect(h).toContain(en.team.leaveSub);
  });

  it("member: the roster read-only with a note, no invites, can leave", async () => {
    await signIn(member.email);
    const h = await html(TeamPage);
    expect(h).toContain(member.email);
    expect(h).not.toContain(en.team.send);
    expect(h).not.toContain(en.team.createLink);
    expect(h).not.toContain(en.team.pending);
    expect(h).toContain(en.team.readOnly);
    expect(h).toContain(en.team.leaveSub);
  });

  it("with mail set up, the form promises an email and sends one", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("MAIL_FROM", "Noor <noor@mail.nashr.test>");
    try {
      await signIn(owner.email);
      const h = await html(TeamPage);
      expect(h).toContain(`>${en.team.send}</button>`);
      expect(h).toContain(esc(en.team.inviteSub));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a founder viewing the account gets no team controls and is told why", async () => {
    await signIn(owner.email, { imp: "founder@test.example" });
    const h = await html(TeamPage);
    expect(h).not.toContain(en.team.send);
    expect(h).not.toContain(en.team.createLink);
    expect(h).toContain(esc(en.team.impersonating));
  });
});

describe("the join page", () => {
  it("signed out: asks nothing of the server until the fragment is read", async () => {
    const h = await html(JoinPage);
    expect(h).toContain(`<h1 class="page-title">${en.join.title}</h1>`);
    expect(h).toContain(en.join.checking);
  });

  it("signed in: never joins into the current session, asks to log out first", async () => {
    await signIn(member.email);
    const h = await html(JoinPage);
    expect(h).toContain("You are signed in as");
    expect(h).toContain(member.email);
    expect(h).toContain(en.join.logout);
    expect(h).not.toContain(en.join.submit + "<");
  });
});

describe("owner-only and admin screens render read-only for lower roles", () => {
  it("billing: pay links and activation for the owner only; seats for everyone", async () => {
    // Each self-serve card carries its own tier's link, found by plan id (rule 248): the page once paired cards and links
    // by position, which would have shown Business at its price with another tier's link. Agency has no pay link.
    const LINKS = { PAY_LINK_STARTER: "https://pay.test.example/starter", PAY_LINK_PRO: "https://pay.test.example/pro", PAY_LINK_BUSINESS: "https://pay.test.example/business", PAY_LINK_AGENCY: "https://pay.test.example/agency" } as const;
    // Without SUPPORT_WHATSAPP the owner's Agency card falls back to the contact form, which is what this checks.
    const before = Object.fromEntries([...Object.keys(LINKS), "SUPPORT_WHATSAPP"].map((k) => [k, process.env[k]]));
    Object.assign(process.env, LINKS);
    delete process.env.SUPPORT_WHATSAPP;
    /** The markup of each billing card, keyed by its `data-tier`. */
    const cards = (h: string) => Object.fromEntries(h.split('data-tier="').slice(1).map((chunk) => [chunk.slice(0, chunk.indexOf('"')), chunk]));
    try {
      await signIn(owner.email);
      const o = await html(BillingPage);
      const c = cards(o);
      expect(Object.keys(c)).toEqual(["starter", "pro", "business", "agency"]);
      for (const k of ["starter", "pro", "business"] as const) {
        expect(c[k], k).toContain(`href="${LINKS[`PAY_LINK_${k.toUpperCase()}` as keyof typeof LINKS]}"`);
        expect(c[k], k).toContain(`>${PLAN_PRICE_SAR[k]} <`);
        for (const other of ["starter", "pro", "business", "agency"].filter((x) => x !== k)) expect(c[k], `${k} carries ${other}'s link`).not.toContain(`pay.test.example/${other}`);
      }
      expect(o).not.toContain(LINKS.PAY_LINK_AGENCY);
      expect(c.agency).toContain("/en/enterprise#contact");
      expect(o).toContain(en.billing.seats);
      expect(o).not.toContain(en.billing.ownerOnly);
      for (const who of [admin.email, member.email]) {
        await signIn(who);
        const h = await html(BillingPage);
        expect(h).not.toContain("pay.test.example");
        expect(h).not.toContain("wa.me");
        expect(h).not.toContain("mailto:");
        expect(h).not.toContain("/enterprise#contact");
        expect(h).toContain(en.billing.seats);
        expect(h).toContain(en.billing.ownerOnly);
      }
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("governance: owner edits; admin and member see it disabled with the owner note and no Save", async () => {
    await signIn(owner.email);
    const o = await html(GovernancePage);
    expect(o).not.toContain(en.readOnly.owner);
    expect(o).toContain(`>${en.governance.save}</button>`);
    for (const who of [admin.email, member.email]) {
      await signIn(who);
      const h = await html(GovernancePage);
      expect(h).toContain(en.readOnly.owner);
      expect(h).toContain('<fieldset disabled=""');
      expect(h).not.toContain(`>${en.governance.save}</button>`);
    }
  });

  it("scheduled tasks, brand file, brands: admin edits; a member sees the admin note", async () => {
    for (const page of [TasksPage, OnboardingPage, BrandsPage]) {
      await signIn(admin.email);
      expect(await html(page)).not.toContain(en.readOnly.admin);
      await signIn(member.email);
      expect(await html(page)).toContain(en.readOnly.admin);
    }
    await signIn(member.email);
    expect(await html(OnboardingPage)).toContain('<fieldset disabled=""');
    expect(await html(BrandsPage)).not.toContain("New brand name");
    await signIn(admin.email);
    expect(await html(BrandsPage)).toContain("New brand name");
  });

  it("refer: the referral link and counts are the owner's; nobody else is shown them", async () => {
    await signIn(owner.email);
    expect(await html(ReferPage)).toContain("/app/signup?ref=");
    for (const who of [admin.email, member.email]) {
      await signIn(who);
      const h = await html(ReferPage);
      expect(h).not.toContain("?ref=");
      expect(h).toContain(en.refer.ownerOnly);
    }
  });

  it("MCP: token controls for the owner only", async () => {
    await signIn(owner.email);
    expect(await html(McpPage)).toContain("Generate token");
    await signIn(member.email);
    const h = await html(McpPage);
    expect(h).not.toContain("Generate token");
    expect(h).not.toContain("Authorization: Bearer");
  });
});

describe("working screens offer a plain member only what the server lets a member do", () => {
  const BRAND = { name: "Roastery", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "warm", products: "beans", audience: "Riyadh", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "Riyadh", updatedAt: "2026-09-29" } as Brand;
  const withSearch = { params: Promise.resolve({ lang: "en" }), searchParams: Promise.resolve({}) };
  const page = async (p: unknown) => renderToStaticMarkup(await (p as (x: typeof withSearch) => Promise<ReactElement>)(withSearch));
  let shop: User;
  let shopAdmin: { email: string };
  let shopMember: { email: string };
  beforeAll(async () => {
    shop = await newUser("uishop");
    shopAdmin = await newMember(shop, "admin", "uishopa");
    shopMember = await newMember(shop, "member", "uishopm");
  });

  it("start: before the brand exists a member is told who sets it up, never shown a form the server refuses", async () => {
    await signIn(shopMember.email);
    const m = await page(StartPage);
    expect(m).toContain(en.start.memberTitle);
    expect(m).toContain(en.start.memberWait);
    expect(m).not.toContain(en.start.url);
    await signIn(shopAdmin.email);
    expect(await page(StartPage)).not.toContain(en.start.memberWait);
    // The chat's first-run thread builds the workspace: a member goes back to the waiting page instead.
    await signIn(shopMember.email);
    await expect(page(ChatPage)).rejects.toThrow(/NEXT_REDIRECT/);
  });

  it("rule 524: start: an owner without a brand plays the Thakeen Dictionary, with the form one link away; a member never gets it; once the brand exists the owner goes to the workspace", async () => {
    await signIn(shop.email);
    const o = await page(StartPage);
    expect(o).toContain(esc(DICT_COPY.title.en));
    expect(o).toContain(esc(en.start.manual));
    expect(o).toContain('href="/en/app/onboarding"');
    await signIn(shopMember.email);
    expect(await page(StartPage)).not.toContain(esc(DICT_COPY.title.en));
    await saveBrand(shop.email, BRAND);
    await signIn(shop.email);
    await expect(page(StartPage)).rejects.toThrow(/NEXT_REDIRECT/);
  });

  it("inbox: a member edits and rejects but is offered no Approve or Publish, and is told who approves", async () => {
    await saveBrand(shop.email, BRAND);
    await saveTask(shop.email, { id: "uiq1", type: "social", channel: "instagram", title: "Roast day", body: "Fresh beans", status: "pending", createdAt: new Date().toISOString(), lang: "en" }, true);
    await signIn(shopMember.email);
    const m = await html(InboxPage);
    expect(m).toContain(en.inbox.edit);
    expect(m).toContain(en.inbox.reject);
    expect(m).not.toContain(`>${en.inbox.approve}</button>`);
    expect(m).toContain(esc(en.inbox.waitAdmin));
    await signIn(shopAdmin.email);
    const a = await html(InboxPage);
    expect(a).toContain(`>${en.inbox.approve}</button>`);
    expect(a).not.toContain(esc(en.inbox.waitAdmin));
    // With the brand in place, the start page sends a member straight into the workspace.
    await signIn(shopMember.email);
    await expect(page(StartPage)).rejects.toThrow(/NEXT_REDIRECT/);
  });

  it("files: a member gets no catalog import and no edit or delete on core memory; an admin gets both", async () => {
    await saveBrand(shop.email, BRAND);
    await writeFile(shop.email, "brand.md", "# brand", "noor");
    await signIn(shopMember.email);
    const m = await html(FilesPage);
    expect(m).not.toContain(en.files.importCatalog);
    expect(m).toContain(esc(en.readOnly.admin));
    expect(m).not.toContain(`>${en.files.delete}</button>`); // brand.md is open first, and it is core
    await signIn(shopAdmin.email);
    const a = await html(FilesPage);
    expect(a).toContain(en.files.importCatalog);
    expect(a).toContain(`>${en.files.delete}</button>`);
    expect(a).not.toContain(esc(en.readOnly.admin));
  });

  it("reports: campaign results import is offered to an admin, and a member reads a note instead", async () => {
    await saveBrand(shop.email, BRAND);
    await signIn(shopMember.email);
    const m = await page(ReportsPage);
    expect(m).not.toContain("Drop a CSV here");
    expect(m).toContain("is for the account owner or an admin");
    await signIn(shopAdmin.email);
    const a = await page(ReportsPage);
    expect(a).toContain("Drop a CSV here");
    expect(a).not.toContain("is for the account owner or an admin");
  });

  it("MCP: a founder viewing the account is told why there is no token, not that the apps are the owner's alone", async () => {
    await signIn(shop.email, { imp: "founder@test.example" });
    const f = await html(McpPage);
    expect(f).toContain("view this account as the founder");
    expect(f).not.toContain("theirs alone");
    await signIn(shopMember.email);
    expect(await html(McpPage)).toContain("theirs alone");
  });
});

describe("account-level prompts tell other roles to ask the owner", () => {
  it("trial banner: the owner gets Activate; others get 'ask the account owner'", () => {
    const own = renderToStaticMarkup(createElement(TrialBanner, { lang: "en", days: 2, plan: "trial", owner: true }));
    const other = renderToStaticMarkup(createElement(TrialBanner, { lang: "en", days: 2, plan: "trial", owner: false }));
    expect(own).toContain("/en/app/billing");
    expect(other).not.toContain("/en/app/billing");
    expect(other).toContain("Ask the account owner");
  });

  it("sidebar: the acting person's name, email and role; Members for all; referrals only for the owner", () => {
    const render = (role: "owner" | "member", email: string) =>
      renderToStaticMarkup(createElement(Sidebar, { t: en, lang: "en", user: { name: "Sara", email, role, credits: 10, plan: "pro" }, show: { owner: role === "owner", refer: role === "owner", mcp: role === "owner" } }));
    const m = render("member", member.email);
    expect(m).toContain(member.email);
    expect(m).toContain(en.team.roles.member);
    expect(m).toContain('href="/en/app/team"');
    expect(m).not.toContain('href="/en/app/refer"');
    expect(m).toContain(esc(en.nav.sharedCredits));
    const o = render("owner", owner.email);
    expect(o).toContain(en.team.roles.owner);
    expect(o).toContain('href="/en/app/refer"');
  });
});

describe("pricing copy states the seats that exist", () => {
  it("Starter 1, Pro and Business match PLAN_SEATS, Agency is sized to the team; no seat or role line is 'coming soon'", () => {
    for (const lang of ["ar", "en"] as const) {
      const [starter, pro, business, agency] = dict[lang].pricing.plans;
      expect([starter, pro, business, agency].map((p) => p.id)).toEqual(["starter", "pro", "business", "agency"]);
      const seatWord = lang === "en" ? /\bseats?\b/i : /مقعد|مقاعد/;
      const seatLine = (features: readonly string[]) => features.find((f) => seatWord.test(f)) ?? "";
      expect(seatLine(starter.features)).toMatch(lang === "en" ? new RegExp(`\\b${PLAN_SEATS.starter} seat\\b`) : /مقعد واحد/);
      expect(seatLine(pro.features)).toContain(lang === "en" ? `${PLAN_SEATS.pro} seats` : `${PLAN_SEATS.pro} مقاعد`);
      expect(seatLine(business.features)).toContain(lang === "en" ? `${PLAN_SEATS.business} seats` : `${PLAN_SEATS.business} مقاعد`);
      // Agency seats go through the founder's seat override (the deal), so the card states no number.
      expect(seatLine(agency.features)).not.toBe("");
      expect(seatLine(agency.features)).not.toMatch(/\d/);
      const all = dict[lang].pricing.plans.flatMap((p) => p.features);
      const soon = lang === "en" ? /coming soon/i : /قريباً/;
      const people = lang === "en" ? /\b(seats?|users?|roles?)\b/i : /مقعد|مقاعد|مستخدم|أدوار|صلاحيات/;
      expect(all.filter((f) => soon.test(f) && people.test(f)), "a seat, user or role line marked coming soon").toEqual([]);
      expect(all.join(" ")).not.toMatch(/99 ?(\/|ريال\/)? ?(seat|مقعد)/i);
    }
  });

  it("the industry pages state the roles and seats that exist: no 'coming soon' team line, no editor or viewer role", () => {
    for (const lang of ["ar", "en"] as const) {
      const lines = INDUSTRY_PAGES[lang].flatMap((p) => [...p.workflows.map((w) => `${w.t} ${w.d}`), ...p.faq.map((f) => `${f.q} ${f.a}`), ...p.pains]);
      const soon = lang === "en" ? /coming soon/i : /قريباً/;
      const people = lang === "en" ? /\b(seats?|users?|roles?|team members?|members?)\b/i : /مقعد|مقاعد|مستخدم|أدوار|صلاحيات|الأعضاء|أعضاء/;
      expect(lines.filter((l) => soon.test(l) && people.test(l)), "a seat, member or role line marked coming soon").toEqual([]);
      expect(lines.filter((l) => (lang === "en" ? /\b(editor|viewer)\b/i : /محرر|مشاهد/).test(l)), "roles that do not exist").toEqual([]);
      const agencies = INDUSTRY_PAGES[lang].find((p) => p.slug === "agencies")!;
      const seatLine = agencies.workflows.map((w) => w.d).find((d) => (lang === "en" ? /\bseats\b/ : /مقاعد/).test(d)) ?? "";
      expect(seatLine).toContain(lang === "en" ? `${PLAN_SEATS.business} seats on Business` : `${PLAN_SEATS.business} مقاعد في خطة الأعمال`);
      expect(seatLine).toMatch(lang === "en" ? /on Agency, sized to your team/ : /الوكالات حسب فريقك/);
    }
  });

  it("the Arabic and English dictionaries carry the same Members and join strings", () => {
    expect(Object.keys(appDict.ar.team).sort()).toEqual(Object.keys(appDict.en.team).sort());
    expect(Object.keys(appDict.ar.join).sort()).toEqual(Object.keys(appDict.en.join).sort());
    expect(appDict.ar.join.rules.length).toBe(appDict.en.join.rules.length);
  });
});
