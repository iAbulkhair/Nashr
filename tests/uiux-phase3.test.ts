import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { jar, json, newMember, newUser, signIn, signOut } from "./helpers/session";
import { currentUser, getUser, saveUser, sc } from "@/lib/auth";
import { db } from "@/lib/db";
import { appDict } from "@/lib/app-i18n";
import { LEGACY_SETTINGS, SETTINGS_COPY, SETTINGS_SECTIONS, legacySettingsPath, settingsHref } from "@/lib/settings-nav";
import { EMAIL_LEVELS, emailAllowed, inAppAllowed, legacyEmails, parsePrefs, prefsFrom, prefsFromLevel, readPrefs, readPrefsMany, storedFrom, type NotifyPrefs } from "@/lib/notify-prefs";
import { listNotifs, pushNotifs } from "@/lib/notifications";
import { checkoutState, lastCheckoutKey, paymentHistory, paymobAccountKeys } from "@/lib/billing";
import { paymentsKey } from "@/lib/partners";
import { proxy } from "@/proxy";
import { saveEnabled } from "@/components/app/settings/SettingsCard";
import SettingsCard from "@/components/app/settings/SettingsCard";
import SettingsNav, { sectionOf } from "@/components/app/settings/SettingsNav";
import PlanCard from "@/components/app/settings/PlanCard";
import PaymentHistory from "@/components/app/settings/PaymentHistory";
import AccountSettings from "@/components/app/settings/AccountSettings";
import BrandExtras, { sitemapValid } from "@/components/app/settings/BrandExtras";
import SecuritySettings from "@/components/app/settings/SecuritySettings";
import DangerZone from "@/components/app/settings/DangerZone";
import NotifyPrefsSettings from "@/components/app/settings/NotifyPrefsSettings";
import Sidebar from "@/components/app/Sidebar";
import * as sessionsRoute from "@/app/api/account/sessions/route";
import * as prefsRoute from "@/app/api/notifications/prefs/route";
import * as statusRoute from "@/app/api/billing/status/route";

/**
 * UI/UX phase 3, Settings and Billing (rules 1140-1158, docs/system/tests/1140-uiux-phase3.md): the settings area and its
 * redirects, one card one Save, notification preferences per type and channel (an expand of the stored shape), signing
 * out other devices, the billing page's plan cards, the Paymob return poll and the payment history.
 */
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  usePathname: () => "/en/app/settings/billing",
  useSearchParams: () => new URLSearchParams(),
}));

const read = (f: string) => readFileSync(f, "utf8");
const FOUNDER = "founder-phase3@test.example";
const PAYMOB = {
  PAYMOB_SECRET_KEY: "sk_test_fake_secret_for_unit_tests",
  PAYMOB_PUBLIC_KEY: "pk_test_fake_public_for_unit_tests",
  PAYMOB_HMAC_SECRET: "fake-hmac-secret-for-unit-tests",
  PAYMOB_INTEGRATION_ID_CARD: "111111",
  PAYMOB_INTEGRATION_ID_MOTO: "222222",
};
const paymobOn = () => { for (const [k, v] of Object.entries(PAYMOB)) vi.stubEnv(k, v); };
const paymobOff = () => { for (const k of Object.keys(PAYMOB)) vi.stubEnv(k, ""); };
beforeEach(() => { vi.stubEnv("ADMIN_EMAILS", FOUNDER); });
afterEach(() => { vi.unstubAllEnvs(); signOut(); });

describe("rule 1140: one settings area, one page per section, its own navigation", () => {
  it("has ten sections, each a page under /{lang}/app/settings, inside one layout", () => {
    expect(SETTINGS_SECTIONS).toEqual(["account", "security", "notifications", "brand", "brands", "members", "billing", "connections", "governance", "danger"]);
    for (const s of SETTINGS_SECTIONS) expect(existsSync(`src/app/[lang]/app/settings/${s}/page.tsx`), s).toBe(true);
    expect(existsSync("src/app/[lang]/app/settings/page.tsx")).toBe(true);
    expect(read("src/app/[lang]/app/settings/layout.tsx")).toMatch(/<SettingsNav lang=\{lang\} \/>/);
    expect(settingsHref("ar")).toBe("/ar/app/settings");
    expect(settingsHref("en", "billing")).toBe("/en/app/settings/billing");
  });
  it("the old pages left: the proxy answers their paths", () => {
    for (const old of Object.keys(LEGACY_SETTINGS)) expect(existsSync(`src/app/[lang]/app/${old}/page.tsx`), old).toBe(false);
    expect(existsSync("src/components/app/ProfilePanel.tsx")).toBe(false);
  });
  it("the column marks one section as the page on show; the list carries every section's line", () => {
    const col = renderToStaticMarkup(h(SettingsNav, { lang: "en" }));
    expect(col.match(/aria-current="page"/g)).toHaveLength(1);
    expect(col.match(/<a[^>]*aria-current="page"[^>]*>/)![0]).toContain('href="/en/app/settings/billing"');
    const list = renderToStaticMarkup(h(SettingsNav, { lang: "ar", variant: "list" }));
    for (const s of SETTINGS_SECTIONS) expect(list).toContain(SETTINGS_COPY.ar.sections[s].sub);
    expect(sectionOf("/ar/app/settings/security")).toBe("security");
    expect(sectionOf("/ar/app/settings")).toBeNull();
    expect(sectionOf("/ar/app/settings/nope")).toBeNull();
  });
  it("names every section in both languages, and differently", () => {
    for (const s of SETTINGS_SECTIONS) {
      expect(SETTINGS_COPY.ar.sections[s].name, s).not.toBe(SETTINGS_COPY.en.sections[s].name);
      expect(SETTINGS_COPY.ar.sections[s].name, s).toMatch(/[؀-ۿ]/);
    }
  });
});

describe("rule 1141: the old routes redirect for one release; the rail and the account menu point into settings", () => {
  it("maps each old page path, and nothing else", () => {
    expect(legacySettingsPath("/ar/app/profile")).toBe("/ar/app/settings/account");
    expect(legacySettingsPath("/en/app/team/")).toBe("/en/app/settings/members");
    expect(legacySettingsPath("/en/app/onboarding")).toBe("/en/app/settings/brand");
    expect(legacySettingsPath("/en/app/integrations")).toBe("/en/app/settings/connections");
    expect(legacySettingsPath("/en/app/billing")).toBe("/en/app/settings/billing");
    for (const p of ["/en/app/team/x", "/fr/app/team", "/en/app/notifications", "/en/app/settings/billing", "/api/billing", "/en/app"]) expect(legacySettingsPath(p), p).toBeNull();
  });
  it("a temporary redirect that keeps the query string (a Paymob return, an integration error)", () => {
    const res = proxy(new NextRequest("https://thakeen.test/en/app/billing?paymob=return"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe("/en/app/settings/billing?paymob=return");
    const team = proxy(new NextRequest("https://thakeen.test/ar/app/team"));
    expect(team.status).toBe(307);
    expect(new URL(team.headers.get("location")!).pathname).toBe("/ar/app/settings/members");
    // The feed stays where the bell's "see all" goes.
    expect(proxy(new NextRequest("https://thakeen.test/en/app/notifications")).status).not.toBe(307);
  });
  it("no loading.tsx wraps a settings page that redirects a signed-in user (the phase 2 fix, rule 1115)", () => {
    // A loading.tsx above a page puts it inside a Suspense boundary, and a redirect() there is streamed as a 200 meta
    // refresh instead of a 307. The old paths redirect in the proxy, so none of that applies to them. Inside the area:
    // no loading.tsx on the frame or the index (it would wrap every section), and a section with one redirects only the
    // signed-out visitor, which the app layout above the boundary already sends to login.
    expect(existsSync("src/app/[lang]/app/settings/loading.tsx")).toBe(false);
    for (const s of SETTINGS_SECTIONS) {
      if (!existsSync(`src/app/[lang]/app/settings/${s}/loading.tsx`)) continue;
      const redirects = read(`src/app/[lang]/app/settings/${s}/page.tsx`).match(/redirect\([^;]*\)/g) ?? [];
      for (const r of redirects) expect(r, s).toBe("redirect(`/${lang}/app/login`)");
    }
    expect(existsSync("src/app/[lang]/app/settings/billing/loading.tsx")).toBe(true);
  });
  it("the rail has one Settings row in place of members, integrations and governance; the menu links into settings", () => {
    const html = renderToStaticMarkup(h(Sidebar, { t: appDict.en, lang: "en", user: { name: "Sara", email: "s@test.example", role: "owner", credits: 10, plan: "pro" }, show: { owner: true, refer: true, mcp: true } }));
    expect(html).toContain('href="/en/app/settings"');
    for (const old of ["team", "integrations", "governance", "profile", "billing", "onboarding", "brands"]) expect(html, old).not.toContain(`href="/en/app/${old}"`);
    expect(html).toContain('href="/en/app/settings/billing"');
    expect(html).toContain('href="/en/app/settings/brands"');
  });
});

describe("rule 1142: one setting, one card, one Save", () => {
  it("Save is pressable only when changed, valid and not already saving", () => {
    expect(saveEnabled({ dirty: true, valid: true, busy: false })).toBe(true);
    expect(saveEnabled({ dirty: false, valid: true, busy: false })).toBe(false);
    expect(saveEnabled({ dirty: true, valid: false, busy: false })).toBe(false);
    expect(saveEnabled({ dirty: true, valid: true, busy: true })).toBe(false);
  });
  it("an unchanged card's Save stays focusable but says it cannot be pressed; a card is its own form", () => {
    const off = renderToStaticMarkup(h(SettingsCard, { title: "Name", onSave: () => {}, saveLabel: "Save" }));
    expect(off).toMatch(/<form [^>]*novalidate/i);
    expect(off).toContain('aria-disabled="true"');
    expect(off).not.toMatch(/<button[^>]* disabled=""/);
    const on = renderToStaticMarkup(h(SettingsCard, { title: "Name", onSave: () => {}, saveLabel: "Save", dirty: true }));
    expect(on).not.toContain('aria-disabled="true"');
    const ro = renderToStaticMarkup(h(SettingsCard, { title: "Name", note: "Ask the owner" }));
    expect(ro).not.toContain("<form");
    expect(ro).toContain("Ask the owner");
  });
});

describe("rule 1143: Account", () => {
  it("the owner sees name, language and phone; a member has no phone card; the email is never a field", () => {
    const owner = renderToStaticMarkup(h(AccountSettings, { lang: "en", forbidden: "x", initial: { name: "A", email: "o@test.example", lang: "en", phone: "+966500000123", owner: true } }));
    expect(owner).toContain('name="phone"');
    expect(owner).toContain('name="name"');
    expect(owner).not.toContain('name="email"');
    expect(owner).toContain("o@test.example");
    const member = renderToStaticMarkup(h(AccountSettings, { lang: "ar", forbidden: "x", initial: { name: "M", email: "m@test.example", lang: "ar", phone: "", owner: false } }));
    expect(member).not.toContain('name="phone"');
    expect(member).toContain('name="name"');
  });
});

describe("rules 1144-1148: notification preferences per type and channel (expand of profile:{scope})", () => {
  const all = prefsFromLevel("all");
  it("1148: every old level reads as it did and writes back to itself", () => {
    for (const l of EMAIL_LEVELS) {
      expect(prefsFrom({ emails: l }), l).toEqual(prefsFromLevel(l));
      expect(storedFrom(prefsFromLevel(l)).emails, l).toBe(l);
      expect(prefsFrom(storedFrom(prefsFromLevel(l))), l).toEqual(prefsFromLevel(l));
    }
    expect(prefsFrom(null)).toEqual(all);
    expect(prefsFrom({})).toEqual(all);
    // A record from a future shape is read through the old field, never half-applied.
    expect(prefsFrom({ emails: "none", notify: { v: 2 } as never })).toEqual(prefsFromLevel("none"));
  });
  it("1148: the old field written next to the new shape is the nearest old level", () => {
    expect(legacyEmails({ ...all, brief: "none", email: { reminders: false, evening: false } })).toBe("none");
    expect(legacyEmails(all)).toBe("all");
    expect(legacyEmails({ ...all, email: { reminders: true, evening: false } })).toBe("important");
    expect(legacyEmails({ ...all, brief: "none", email: { reminders: true, evening: false } })).toBe("important");
    const s = storedFrom({ ...all, inApp: { ...all.inApp, reports: false } });
    expect(s).toMatchObject({ emails: "all", notify: { v: 1, inApp: { reports: false } } });
  });
  it("1147: the email senders keep each old level's meaning and read the new switches", () => {
    const imp = prefsFromLevel("important");
    expect([emailAllowed(imp, "brief", false), emailAllowed(imp, "brief", true), emailAllowed(imp, "reminders"), emailAllowed(imp, "evening")]).toEqual([false, true, true, false]);
    const none = prefsFromLevel("none");
    expect([emailAllowed(none, "brief", true), emailAllowed(none, "reminders"), emailAllowed(none, "evening")]).toEqual([false, false, false]);
    expect([emailAllowed(all, "brief"), emailAllowed(all, "reminders"), emailAllowed(all, "evening")]).toEqual([true, true, true]);
    for (const f of ["src/app/api/cron/daily/route.ts", "src/lib/secretary-remind.ts", "src/lib/secretary-evening.ts", "src/lib/secretary-series.ts"]) {
      const src = read(f);
      expect(src, f).toContain("emailAllowed(");
      expect(src, f).not.toMatch(/\.emails \?\? "all"/);
    }
  });
  it("1148: a brand with no choice of its own reads the account's; one round for every scope", async () => {
    const u = await newUser("np");
    await db.set(`profile:${u.email}`, { emails: "none" });
    await db.set(`profile:brand-x-${u.email}`, {});
    await db.set(`profile:brand-y-${u.email}`, storedFrom({ ...all, brief: "important" }));
    const m = await readPrefsMany([`brand-x-${u.email}`, `brand-y-${u.email}`], u.email);
    expect(m.get(`brand-x-${u.email}`)).toEqual(prefsFromLevel("none"));
    expect(m.get(`brand-y-${u.email}`)!.brief).toBe("important");
    expect(read("src/lib/notify-prefs.ts")).toMatch(/db\.mget<StoredProfile>\(/);
  });
  it("1146: a switched-off kind is claimed and answered but kept out of the bell; account notices always arrive", async () => {
    const u = await newUser("bell");
    await db.set(`profile:${u.email}`, storedFrom({ ...all, inApp: { ...all.inApp, reminders: false } }));
    const out = await pushNotifs(u.email, [
      { n: { kind: "todo", title: "A to-do", body: "b", href: "/en/app/todo" }, fingerprint: "p3-todo" },
      { n: { kind: "credits", title: "Credits low", body: "b", href: "/en/app/settings/billing" }, fingerprint: "p3-credits" },
    ]);
    expect(out.map((x) => x?.kind)).toEqual(["todo", "credits"]);
    expect((await listNotifs(u.email)).map((n) => n.kind)).toEqual(["credits"]);
    // The claim holds: a second run does not push it either.
    expect((await pushNotifs(u.email, [{ n: { kind: "todo", title: "A to-do", body: "b", href: "/x" }, fingerprint: "p3-todo" }]))[0]).toBeNull();
    expect(inAppAllowed({ ...all, inApp: { ...all.inApp, approvals: false } }, "trial")).toBe(true);
    expect(inAppAllowed({ ...all, inApp: { ...all.inApp, approvals: false } }, "pending")).toBe(false);
  });
  it("1145: parsePrefs refuses a missing or mistyped part and drops anything else", () => {
    expect(parsePrefs(null)).toBeNull();
    expect(parsePrefs({ brief: "loud", email: all.email, inApp: all.inApp })).toBeNull();
    expect(parsePrefs({ brief: "all", email: { reminders: true }, inApp: all.inApp })).toBeNull();
    expect(parsePrefs({ brief: "all", email: all.email, inApp: { ...all.inApp, reports: "no" } })).toBeNull();
    expect(parsePrefs({ ...all, scope: "someone-else", email: { ...all.email, extra: true } })).toEqual(all);
  });
  it("1145: PUT /api/notifications/prefs signs in, is the owner's, writes the session's own scope in both shapes", async () => {
    const body: NotifyPrefs = { ...all, brief: "important", inApp: { ...all.inApp, updates: false } };
    expect((await prefsRoute.PUT(json("/api/notifications/prefs", "PUT", body))).status).toBe(401);
    const owner = await newUser("npo");
    const m = await newMember(owner);
    await signIn(m.email);
    expect((await prefsRoute.PUT(json("/api/notifications/prefs", "PUT", body))).status).toBe(403);
    await signIn(owner.email);
    expect((await prefsRoute.PUT(json("/api/notifications/prefs", "PUT", { brief: "all" }))).status).toBe(400);
    const res = await prefsRoute.PUT(json("/api/notifications/prefs", "PUT", { ...body, scope: "victim@test.example", email: { ...body.email } }));
    expect(res.status).toBe(200);
    const scope = sc((await currentUser())!);
    expect(await db.get(`profile:${scope}`)).toEqual({ emails: "important", notify: { v: 1, brief: "important", email: body.email, inApp: body.inApp } });
    expect(await db.get("profile:victim@test.example")).toBeNull();
    expect(await readPrefs(scope, owner.email)).toEqual(body);
  });
  it("1144: the page reads the session's scope; anyone but the owner sees the choices without a Save", () => {
    expect(read("src/app/[lang]/app/settings/notifications/page.tsx")).toContain("readPrefs(sc(u), u.email)");
    const ro = renderToStaticMarkup(h(NotifyPrefsSettings, { lang: "en", initial: all, canEdit: false }));
    expect(ro).not.toContain('type="submit"');
    const edit = renderToStaticMarkup(h(NotifyPrefsSettings, { lang: "ar", initial: all, canEdit: true }));
    expect(edit.match(/type="submit"/g)!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("rule 1149: Danger zone", () => {
  it("log out for everyone; delete only for who may, never for a founder viewing the account", () => {
    const base = { lang: "en" as const, email: "o@test.example", logoutLabel: "Log out", failText: { forbidden: "no", failed: "failed" } };
    const owner = renderToStaticMarkup(h(DangerZone, { ...base, canDelete: true, impersonating: false, owner: true }));
    expect(owner).toContain("Log out");
    const founder = renderToStaticMarkup(h(DangerZone, { ...base, canDelete: false, impersonating: true, owner: true }));
    expect(founder).toContain("Log out");
    expect(owner.match(/<button/g)!.length).toBeGreaterThan(founder.match(/<button/g)!.length);
    expect(read("src/app/[lang]/app/settings/danger/page.tsx")).toMatch(/can\(u, "account\.delete"\)/);
  });
});

describe("rule 1150: sign out other devices", () => {
  const post = (password: string) => sessionsRoute.POST(json("/api/account/sessions", "POST", { password }));
  it("refuses a visitor and a wrong password, and then changes nothing", async () => {
    expect((await post("abc12345")).status).toBe(401);
    const u = await newUser("so");
    const other = await signIn(u.email);
    await signIn(u.email);
    expect((await post("wrong-pass")).status).toBe(401);
    jar().set("thakeen_session", other);
    expect((await currentUser())?.email).toBe(u.email);
  });
  it("the owner's other sessions end, a legacy bare-string one included; this device stays, with a new session", async () => {
    const u = await newUser("so");
    await saveUser({ ...(await getUser(u.email))!, sessionsAfter: undefined });
    const legacy = "a".repeat(64);
    await db.set(`session:${legacy}`, u.email);
    const other = await signIn(u.email);
    const mine = await signIn(u.email);
    expect((await post("abc12345")).status).toBe(200);
    const now = jar().get("thakeen_session")!;
    expect(now).not.toBe(mine);
    expect((await currentUser())?.email).toBe(u.email);
    for (const t of [other, mine, legacy]) { jar().set("thakeen_session", t); expect(await currentUser(), t.slice(0, 6)).toBeNull(); }
  });
  it("a member's sign-out ends the member's other sessions only, never the owner's", async () => {
    const owner = await newUser("so");
    const m = await newMember(owner);
    const ownerSession = await signIn(owner.email);
    const memberOther = await signIn(m.email);
    await signIn(m.email);
    expect((await post(m.password)).status).toBe(200);
    expect((await currentUser())?.actor?.email).toBe(m.email);
    jar().set("thakeen_session", memberOther);
    expect(await currentUser()).toBeNull();
    jar().set("thakeen_session", ownerSession);
    expect((await currentUser())?.email).toBe(owner.email);
  });
  it("a member cannot use the owner's password; a founder viewing the account is refused", async () => {
    const owner = await newUser("so");
    const m = await newMember(owner);
    await signIn(m.email);
    // newMember and newUser share a password in fixtures, so give the owner another one first.
    const bcrypt = (await import("bcryptjs")).default;
    await saveUser({ ...(await getUser(owner.email))!, passHash: await bcrypt.hash("owner-only-9", 4) });
    expect((await post("owner-only-9")).status).toBe(401);
    await signIn(owner.email, { imp: FOUNDER });
    expect((await post("owner-only-9")).status).toBe(403);
  });
  it("is rate limited per login, and no session list is invented", () => {
    const src = read("src/app/api/account/sessions/route.ts");
    expect(src).toContain("const bucket = `signoutothers:${a.email}`;");
    expect(src).toMatch(/allow\(bucket, SIGN_OUT_OTHERS_PER_HOUR, WINDOW\.hour\)/);
    expect(src).not.toMatch(/db\.(keys|scan)\(/);
    expect(read("src/lib/roles.ts")).toMatch(/"sessions\.revoke": "member"/);
  });
});

describe("rule 1151: the new password shows the sign-up rules live", () => {
  it("links the rules list to the field and uses the shared checks", () => {
    const html = renderToStaticMarkup(h(SecuritySettings, { lang: "en", rules: appDict.en.join.rules, may: true, owner: true, forbidden: "x" }));
    expect(html).toContain('id="settings-pw-rules"');
    expect(html.match(/<input[^>]*name="newPassword"[^>]*>/)![0]).toMatch(/aria-describedby="[^"]*settings-pw-rules/);
    expect(read("src/components/app/settings/SecuritySettings.tsx")).toContain('import { passwordChecks } from "@/lib/auth-client";');
    const founder = renderToStaticMarkup(h(SecuritySettings, { lang: "ar", rules: appDict.ar.join.rules, may: false, owner: true, forbidden: "x" }));
    expect(founder).not.toContain('name="newPassword"');
  });
});

describe("rule 1152: the brand-file fields the profile page held", () => {
  it("social, value proposition and sitemap; a sitemap must be an https address", () => {
    expect(sitemapValid("")).toBe(true);
    expect(sitemapValid("https://shop.example/sitemap.xml")).toBe(true);
    expect(sitemapValid("javascript:alert(1)")).toBe(false);
    const ro = renderToStaticMarkup(h(BrandExtras, { lang: "en", readOnly: true, forbidden: "x", initial: { social: {}, valueProp: "", sitemap: "" } }));
    expect(ro).not.toContain('type="submit"');
  });
});

describe("rule 1153: the credit card moved to billing, unchanged", () => {
  it("billing renders it with the month's usage read once on the server", () => {
    const page = read("src/app/[lang]/app/settings/billing/page.tsx");
    expect(page).toContain("<CreditUsageCard ");
    expect(page).toMatch(/Promise\.all\(\[entitlementView\(u\), monthUsage\(u, now\)/);
    expect(read("src/app/api/profile/route.ts")).toContain("monthUsage(u)");
  });
});

describe("rule 1154: plan cards, the summary and the VAT note", () => {
  const card = (current: boolean, highlight: boolean, lang: "ar" | "en" = "en") =>
    renderToStaticMarkup(h(PlanCard, { lang, id: "pro", name: "Pro", price: "499", period: "SAR / month", credits: "1,000", features: ["a", "b"], current, highlight }));
  it("the current plan says so in words; a recommended plan is the pricing flag, never on the current one", () => {
    expect(card(true, true)).toContain("Your current plan");
    expect(card(true, true)).toContain("data-current");
    expect(card(true, true)).not.toContain("Recommended");
    expect(card(false, true)).toContain("Recommended");
    expect(card(false, false)).not.toMatch(/Recommended|Your current plan|data-current/);
    expect(card(true, false, "ar")).toContain("خطتك الحالية");
  });
  it("a price is never the danger colour", () => {
    for (const c of [card(true, true), card(false, false)]) expect(c).not.toContain("text-danger");
    const page = read("src/app/[lang]/app/settings/billing/page.tsx");
    expect(page).not.toMatch(/price[^\n]*text-danger|text-danger[^\n]*price/);
  });
  it("the page sums up plan, credits, seats and the next date, and states VAT next to the prices", () => {
    const page = read("src/app/[lang]/app/settings/billing/page.tsx");
    expect(page).toContain("data-billing-summary");
    expect(page).toContain('href={settingsHref(lang, "members")}');
    expect(page).toContain("data-vat-note");
    expect(page).toMatch(/<PlanCard key=\{k\} lang=\{lang\} id=\{k\}/);
  });
});

describe("rule 1155: GET /api/billing/status and the return page's poll", () => {
  const get = () => statusRoute.GET();
  const intent = (email: string, status: string, kind = "plan") => ({ ref: "", email, kind, plan: "pro", baseHalalas: 1, vatHalalas: 0, amountCents: 1, currency: "SAR", status, createdAt: new Date().toISOString() });
  it("signs in, is the owner's, and reads nothing while Paymob is off", async () => {
    paymobOff();
    expect((await get()).status).toBe(401);
    const owner = await newUser("bs");
    const m = await newMember(owner);
    await signIn(m.email);
    expect((await get()).status).toBe(403);
    await signIn(owner.email);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enabled: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("answers the account's own last checkout only, mapped to four states", async () => {
    paymobOn();
    const owner = await newUser("bs");
    const other = await newUser("bs");
    await signIn(owner.email);
    expect((await (await get()).json()).checkout).toEqual({ state: "none" });
    const ref = `pmi_${"b".repeat(24)}`;
    await db.set(`paymob:intent:${ref}`, { ...intent(other.email, "paid"), ref });
    await db.set(lastCheckoutKey(owner.email), ref);
    expect((await (await get()).json()).checkout).toEqual({ state: "none" }); // another account's intent
    await db.set(`paymob:intent:${ref}`, { ...intent(owner.email, "open"), ref });
    expect((await (await get()).json()).checkout).toEqual({ state: "pending", kind: "plan", plan: "pro" });
    await db.set(`paymob:intent:${ref}`, { ...intent(owner.email, "paid"), ref });
    expect((await (await get()).json())).toMatchObject({ ok: true, enabled: true, checkout: { state: "success" } });
    await db.set(lastCheckoutKey(owner.email), "../../user:x");
    expect((await (await get()).json()).checkout).toEqual({ state: "none" });
    expect([checkoutState("open"), checkoutState("paid"), checkoutState("failed"), checkoutState("mismatch"), checkoutState(undefined)]).toEqual(["pending", "success", "failed", "failed", "none"]);
  });
  it("the pointer leaves with the account, and the route never takes a ref from the request", () => {
    expect(paymobAccountKeys("a@test.example")).toContain(lastCheckoutKey("a@test.example"));
    const src = read("src/app/api/billing/status/route.ts");
    expect(src).toMatch(/export async function GET\(\)/);
    expect(src).toContain("lastCheckout(u.email)");
    expect(src).toMatch(/allow\(`billingstatus:\$\{u\.email\}`/);
  });
  it("the poll reads only, says where it is in a live region, and refreshes once on success", () => {
    const src = read("src/components/app/PaymobBilling.tsx");
    const poll = src.slice(src.indexOf("export function PaymobReturnStatus"));
    expect(poll).toContain('fetch("/api/billing/status", { cache: "no-store" })');
    expect(poll).not.toMatch(/method: "POST"/);
    expect(poll).toContain('role="status" aria-live="polite"');
    expect(poll).toMatch(/if \(state === "success"\) \{ stop\([^)]*"ok"\); r\.refresh\(\); return; \}/);
    // A dropped request tries again; an answer with nothing pending stops.
    expect(poll).toContain('if (n >= tries || (j !== null && state !== "pending"))');
    expect(poll).toContain("let done = false;");
    expect(read("src/app/[lang]/app/settings/billing/page.tsx")).toContain("{returned && online && <PaymobReturnStatus lang={lang} />}");
  });
});

describe("rule 1156: payment history from the payments already recorded", () => {
  it("newest first, safe fields only, the state in words", async () => {
    const u = await newUser("ph");
    const base = { plan: "pro", reference: "BANK-REF-SECRET", recordedAt: "2026-10-01T10:00:00.000Z", recordedBy: "founder@test.example" };
    await db.hset(paymentsKey(u.email), "p1", { ...base, id: "p1", amountSar: 499, date: "2026-09-01", commission: { partner: "x@test.example", sar: 74 } });
    await db.hset(paymentsKey(u.email), "p2", { ...base, id: "p2", amountSar: 50, date: "2026-10-02", topup: { lot: "l1", credits: 200 }, refund: { credits: 100, sar: 25, date: "2026-10-05", reference: "R", at: "x", by: "y" } });
    await db.hset(paymentsKey(u.email), "p3", { ...base, id: "p3", amountSar: 299, date: "2026-08-01", voidedAt: "2026-08-02", voidedBy: "f", voidReason: "typo" });
    const rows = await paymentHistory(u.email);
    expect(rows.map((r) => r.id)).toEqual(["p2", "p1", "p3"]);
    expect(rows.map((r) => r.state)).toEqual(["refunded", "paid", "voided"]);
    expect(rows[0]).toEqual({ id: "p2", date: "2026-10-02", plan: "pro", topupCredits: 200, amountSar: 50, state: "refunded", refundSar: 25 });
    expect(JSON.stringify(rows)).not.toMatch(/BANK-REF-SECRET|commission|recordedBy|typo|founder@/);
    const html = renderToStaticMarkup(h(PaymentHistory, { lang: "ar", rows, planName: (p) => p }));
    expect(html).not.toMatch(/[٠-٩]/);
    expect(html).toContain("2026-10-02");
    expect(renderToStaticMarkup(h(PaymentHistory, { lang: "en", rows: [], planName: (p) => p }))).toContain("No payments recorded yet.");
    expect(read("src/app/[lang]/app/settings/billing/page.tsx")).toContain("owner ? paymentHistory(u.email) : Promise.resolve(null)");
  });
});

describe("rule 1157: the renewal and card confirmations run the change inside the dialog", () => {
  it("passes run, a busy label and a fail label to ask()", () => {
    const src = read("src/components/app/PaymobBilling.tsx");
    expect(src).toMatch(/const common = \{ cancelLabel: S\.keep, destructive: true, run, busyLabel: S\.working, failLabel: S\.errors\.server \};/);
    expect(src).toMatch(/if \(!j\.ok\) return S\.errors\[j\.error \?\? "server"\] \?\? S\.errors\.server;/);
  });
});

describe("rule 1158: settings screens keep the shared accessibility rules", () => {
  const files = ["AccountSettings", "BrandExtras", "CreditUsageCard", "DangerZone", "NotifyPrefsSettings", "PaymentHistory", "PlanCard", "SecuritySettings", "SettingsCard", "SettingsNav"].map((f) => `src/components/app/settings/${f}.tsx`);
  it("logical start/end classes only, Western digits, 44px links in the nav", () => {
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/\b(?:ml|mr|pl|pr)-\d|\btext-(?:left|right)\b|\b(?:left|right)-\d/);
      expect(src, f).not.toMatch(/[٠-٩۰-۹]/);
    }
    expect(read("src/components/app/settings/SettingsNav.tsx").match(/min-h-\[var\(--hit-min\)\]/g)!.length).toBeGreaterThanOrEqual(3);
  });
  it("each new settings page has its own title and a PageHeader", () => {
    for (const s of ["account", "security", "notifications", "danger"]) {
      const src = read(`src/app/[lang]/app/settings/${s}/page.tsx`);
      expect(src, s).toContain(`settingsScreenMeta("${s}")`);
      expect(src, s).toContain("<PageHeader ");
    }
  });
});
