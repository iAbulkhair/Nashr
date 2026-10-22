import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ALL_VIDEO_MODELS, entitlementView, entitlements, grantActive, isUtcDay, type EntUser } from "@/lib/entitlements";
import { getUser, saveUser, type User } from "@/lib/auth";
import { db } from "@/lib/db";
import { chatStatus } from "@/lib/chat-allowance";
import { route } from "@/lib/models/route";
import { getMember, saveMember, seatsUsed } from "@/lib/team";
import { chatTrialKey } from "@/lib/usage";
import { newMember, newUser } from "./helpers/session";
import { AGENT_IDS } from "@/lib/agents";
import { allowanceOf, chatAllowanceOf, seatLimit } from "@/lib/pricing";
import { chatCaps } from "@/lib/rate";
import { MEDIA_MODELS, TRIAL_VIDEO_MODELS } from "@/lib/media-catalog";
import EntitlementsTable, { videoGrantRequest } from "@/components/admin/EntitlementsTable";
import type { Billing } from "@/lib/billing-state";
import { adminConsoleSrc } from "./helpers/admin-console";

/**
 * Rule 780: `entitlements(u)` is the one place that says what an account's plan includes. It reads only the record and
 * constants, so these tests are pure: no db, no clock but the `now` they pass. The last block (rule 784) is the founder
 * console's view of one stored account, which reads the db (the global setup file gives an in-memory one, ruling R6).
 */
const NOW = Date.parse("2026-10-08T12:00:00Z");
const day = (n: number) => new Date(NOW + n * 86400_000).toISOString().slice(0, 10);
const grant = (until: string) => ({ video: { value: "all" as const, until, by: "founder@x", at: "2026-10-08T00:00:00Z" } });

const user = (p: Partial<EntUser> = {}): EntUser => ({ plan: "pro", trialEnds: "2099-01-01T00:00:00Z", ...p });
const billingFixture = (p: Partial<Billing> = {}): Billing => ({
  provider: "paymob", plan: "pro", status: "active", paidThrough: "2026-11-08", anchor: 8, autoRenew: true, failures: 0, txns: [], ...p,
});

describe("entitlements (rule 780)", () => {
  it("matches the old helpers for every plan and override", () => {
    const cases: EntUser[] = [
      user({ plan: "trial" }), user({ plan: "starter" }), user({ plan: "pro" }), user({ plan: "business" }),
      user({ plan: "agency" }), user({ plan: "agency", deal: { credits: 4000, priceSar: 2800, setAt: "x", setBy: "y" } }),
      user({ plan: "pro", seats: 9 }), user({ plan: "starter", chatAllowance: 0 }), user({ plan: "pro", chatAllowance: 900 }),
    ];
    for (const u of cases) {
      const e = entitlements(u, NOW);
      expect(e.credits.monthly).toBe(allowanceOf(u));
      expect(e.seats).toBe(seatLimit(u));
      expect(e.chat.monthly).toBe(chatAllowanceOf(u));
      expect({ hour: e.chat.hour, day: e.chat.day }).toEqual({ ...chatCaps(u) });
      expect(e.agents).toEqual(AGENT_IDS);
      expect(e.active).toBe(true);
    }
  });

  it("a trial includes the trial video models; a paid plan every video model", () => {
    expect(entitlements(user({ plan: "trial" }), NOW).media.video).toEqual(TRIAL_VIDEO_MODELS);
    expect(entitlements(user({ plan: "pro" }), NOW).media.video).toEqual(ALL_VIDEO_MODELS);
    expect(ALL_VIDEO_MODELS).toEqual(["vid-quick", "vid-sound", "vid-premium", "vid-cinematic", "vid-motion"]);
  });

  it("a video grant opens every model to a trial through the end of its day", () => {
    const u = user({ plan: "trial", grants: grant(day(0)) });
    expect(entitlements(u, NOW).media.video).toEqual(ALL_VIDEO_MODELS);
    expect(entitlements(u, Date.parse(`${day(0)}T23:59:59.999Z`)).media.video).toEqual(ALL_VIDEO_MODELS);
    expect(entitlements(u, Date.parse(`${day(1)}T00:00:00.000Z`)).media.video).toEqual(TRIAL_VIDEO_MODELS);
  });

  it("ignores an expired grant", () => {
    expect(entitlements(user({ plan: "trial", grants: grant(day(-1)) }), NOW).media.video).toEqual(TRIAL_VIDEO_MODELS);
    expect(grantActive(grant(day(-1)).video, NOW)).toBe(false);
    expect(grantActive(undefined, NOW)).toBe(false);
    expect(grantActive({ ...grant(day(3)).video, until: "not-a-day" }, NOW)).toBe(false);
    expect(grantActive({ ...grant(day(3)).video, by: "" }, NOW)).toBe(false);   // a grant needs by and at (spec 9)
    expect(grantActive({ ...grant(day(3)).video, at: "" }, NOW)).toBe(false);
    expect(grantActive(grant(day(3)).video, NOW)).toBe(true);
  });

  it("a stored grant dated with a day that does not exist reads as absent (ruling R8)", () => {
    // Date.parse rolls 2026-02-31 forward to 3 March, so a regex alone would keep this grant alive until then: asked
    // on 20 February it must already read as absent. The same stored grant with a real last day of the month is live.
    const feb20 = Date.parse("2026-02-20T00:00:00Z");
    expect(grantActive({ ...grant("2026-02-31").video }, feb20)).toBe(false);
    expect(grantActive({ ...grant("2026-02-28").video }, feb20)).toBe(true);
    expect(entitlements(user({ plan: "trial", trialEnds: "2026-03-20T00:00:00Z", grants: grant("2026-02-31") }), feb20).media.video).toEqual(TRIAL_VIDEO_MODELS);
  });

  it("isUtcDay: a YYYY-MM-DD day that exists, leap days included", () => {
    for (const s of ["2026-10-08", "2028-02-29", "2026-12-31", "0001-01-01"]) expect(isUtcDay(s), s).toBe(true);
    for (const s of ["2026-02-31", "2027-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-10-00", "2026-10-32", "2026-1-9", "26-10-09", "2026-10-08T00:00:00Z", " 2026-10-08", "", "soon"]) expect(isUtcDay(s), s).toBe(false);
    expect(isUtcDay(20261008)).toBe(false);
    expect(isUtcDay(undefined)).toBe(false);
  });

  it("inactive: suspended, ended trial, locked Paymob subscription", () => {
    const suspended = user({ suspended: true });
    const ended = user({ plan: "trial", trialEnds: "2026-10-01T00:00:00Z" });
    const locked = user({ plan: "pro", billing: { ...billingFixture(), status: "locked", paidThrough: "2026-10-05" } });
    expect(entitlements(suspended, NOW)).toMatchObject({ active: false, inactive: "suspended" });
    expect(entitlements(ended, NOW)).toMatchObject({ active: false, inactive: "trial_over", endsAt: "2026-10-01T00:00:00Z" });
    expect(entitlements(locked, NOW)).toMatchObject({ active: false, inactive: "billing_locked", endsAt: "2026-10-05" });
    for (const u of [suspended, ended, locked]) {   // inactive accounts still report the plan's own numbers
      const e = entitlements(u, NOW);
      expect([e.credits.monthly, e.seats, e.chat.monthly]).toEqual([allowanceOf(u), seatLimit(u), chatAllowanceOf(u)]);
    }
  });

  it("inactive is absent on an active account, and the first reason wins when several apply (M9)", () => {
    const active = entitlements(user(), NOW);
    expect(active.active).toBe(true);
    expect(active.inactive).toBeUndefined();
    expect("inactive" in active, "the key is left out, not set to undefined").toBe(false);
    const locked = billingFixture({ status: "locked", paidThrough: "2026-10-05" });
    const ended = { plan: "trial" as const, trialEnds: "2026-10-01T00:00:00Z" };
    // The order the gates refuse in (flows: What a plan includes, item 1): suspended, then a locked subscription, then an ended trial.
    expect(entitlements(user({ suspended: true, billing: locked }), NOW).inactive).toBe("suspended");
    expect(entitlements(user({ ...ended, billing: locked }), NOW).inactive).toBe("billing_locked");
    expect(entitlements(user({ ...ended, suspended: true }), NOW).inactive).toBe("suspended");
    expect(entitlements(user({ ...ended, suspended: true, billing: locked }), NOW).inactive).toBe("suspended");
    // Only the one reason is reported; the account is not active whichever it is.
    expect(entitlements(user({ ...ended, billing: locked }), NOW).active).toBe(false);
  });

  it("a Paymob subscription that is past due, inside its grace days, still reads active (only `locked` is inactive)", () => {
    for (const status of ["active", "past_due"] as const) {
      const e = entitlements(user({ billing: billingFixture({ status, failures: status === "past_due" ? 1 : 0, ...(status === "past_due" ? { graceUntil: "2026-10-12" } : {}) }) }), NOW);
      expect(e.active, status).toBe(true);
      expect(e.inactive, status).toBeUndefined();
      expect(e.endsAt, status).toBe("2026-11-08");   // still the paid-through day
    }
  });

  it("endsAt: the trial end, the Paymob paid-through day, or null when activated by hand", () => {
    expect(entitlements(user({ plan: "trial", trialEnds: "2026-10-20T00:00:00Z" }), NOW).endsAt).toBe("2026-10-20T00:00:00Z");
    expect(entitlements(user({ plan: "pro", billing: { ...billingFixture(), status: "active", paidThrough: "2026-11-08" } }), NOW).endsAt).toBe("2026-11-08");
    expect(entitlements(user({ plan: "pro" }), NOW).endsAt).toBeNull();
  });
});

/** A stored account, saved after `patch` is applied to it. */
async function stored(patch: Partial<User>): Promise<User> {
  const base = await newUser("view");
  const u = { ...(await getUser(base.email))!, ...patch };
  await saveUser(u);
  return u;
}

describe("entitlementView (rule 784)", () => {
  it("a trial with an expired grant: the plan's own list, the expired grant marked, use read from the store", async () => {
    const u = await stored({ plan: "trial", trialEnds: "2026-10-20T00:00:00Z", credits: 37, grants: grant(day(-2)) });
    await db.set(chatTrialKey(u.email), 4);   // four chat messages used, so `used.chat` is not just the empty default
    const v = await entitlementView(u, NOW);
    expect(v.ent).toEqual(entitlements(u, NOW));
    expect(v.ent.media.video).toEqual(TRIAL_VIDEO_MODELS);
    expect(v.used.credits).toBe(37);
    expect(v.used.credits).toBe(u.credits);
    expect(v.used.seats).toBe(await seatsUsed(u.email));
    expect(v.used.chat).toEqual(await chatStatus(u, route("chat").model));
    expect(v.used.chat.counted).toBe(4);
    expect(v.resetsAt).toBeNull();
    expect(v.grants.video).toEqual({ ...grant(day(-2)).video, expired: true });
  });

  it("an active grant is not marked expired, and no grant reads as null", async () => {
    const withGrant = await stored({ plan: "trial", trialEnds: "2026-10-20T00:00:00Z", grants: grant(day(3)) });
    const without = await stored({ plan: "trial", trialEnds: "2026-10-20T00:00:00Z" });
    const a = await entitlementView(withGrant, NOW);
    expect(a.grants.video).toEqual({ ...grant(day(3)).video, expired: false });
    expect(a.ent.media.video).toEqual(ALL_VIDEO_MODELS);
    expect((await entitlementView(without, NOW)).grants.video).toBeNull();
  });

  it("a grant dated with a day that does not exist is marked expired, like grantActive reads it", async () => {
    const u = await stored({ plan: "trial", trialEnds: "2026-03-20T00:00:00Z", grants: grant("2026-02-31") });
    const v = await entitlementView(u, Date.parse("2026-02-20T00:00:00Z"));
    expect(v.grants.video?.expired).toBe(true);
    expect(v.ent.media.video).toEqual(TRIAL_VIDEO_MODELS);
  });

  it("a paid plan's credits renew on its own day (rule 2936); the chat count still restarts on the next 1st (a UTC day)", async () => {
    const u = await stored({ plan: "pro", renewedOn: "2026-10-01" });
    expect(await entitlementView(u, NOW)).toMatchObject({ resetsAt: "2026-11-01", chatResetsAt: "2026-11-01" });
    const dec = await stored({ plan: "pro", renewedOn: "2026-12-01" });
    expect(await entitlementView(dec, Date.parse("2026-12-15T10:00:00Z"))).toMatchObject({ resetsAt: "2027-01-01", chatResetsAt: "2027-01-01" });
    // A plan set by hand on the 20th renews on the 20th; its chat count on the 1st.
    const hand = await stored({ plan: "pro", renewedOn: "2026-09-20", renewAnchor: 20, handPlan: { paidThrough: "2026-12-20", by: "founder@x", at: "x" } });
    expect(await entitlementView(hand, NOW)).toMatchObject({ resetsAt: "2026-10-20", chatResetsAt: "2026-11-01" });
    // Its last paid day: no new period comes, so no renewal shows.
    const last = await stored({ plan: "pro", renewedOn: "2026-09-20", renewAnchor: 20, handPlan: { paidThrough: "2026-10-20", by: "founder@x", at: "x" } });
    expect((await entitlementView(last, NOW)).resetsAt).toBeNull();
    // A renewal already due reads as today.
    const due = await stored({ plan: "pro", renewedOn: "2026-08-20", renewAnchor: 20 });
    expect((await entitlementView(due, NOW)).resetsAt).toBe("2026-10-08");
    // Agency, with a deal, is paid too.
    const agency = await stored({ plan: "agency", renewedOn: "2026-10-01" });
    expect((await entitlementView(agency, NOW)).resetsAt).toBe("2026-11-01");
  });

  it("a locked Paymob subscription never renews (rule 712), so it has no reset; an active one renews on its anchor (ruling R3)", async () => {
    const active = await stored({ plan: "pro", renewedOn: "2026-10-08", billing: billingFixture({ status: "active" }) });
    const locked = await stored({ plan: "pro", billing: billingFixture({ status: "locked", paidThrough: "2026-10-05" }) });
    expect(await entitlementView(active, NOW)).toMatchObject({ resetsAt: "2026-11-08", chatResetsAt: "2026-11-01" });
    const v = await entitlementView(locked, NOW);
    expect(v.resetsAt).toBeNull();
    expect(v.chatResetsAt).toBeNull();
    expect(v.ent).toMatchObject({ active: false, inactive: "billing_locked" });
  });

  it("base is the plan's own values, with the deal, seat, chat and grant overrides removed (ruling R12)", async () => {
    // An Agency deal: the plan's credits are Business's, the effective ones are the deal's.
    const agency = await stored({ plan: "agency", deal: { credits: 4000, priceSar: 2800, setAt: "x", setBy: "founder@x" } });
    const a = await entitlementView(agency, NOW);
    expect(a.base.credits.monthly).toBe(allowanceOf({ plan: "agency" }));
    expect(a.base.credits.monthly).not.toBe(4000);
    expect(a.ent.credits.monthly).toBe(4000);
    // A seat override.
    const seats = await stored({ plan: "pro", seats: 9 });
    const s = await entitlementView(seats, NOW);
    expect(s.base.seats).toBe(seatLimit({ plan: "pro" }));
    expect(s.ent.seats).toBe(9);
    // A chat override.
    const chat = await stored({ plan: "pro", chatAllowance: 900 });
    const c = await entitlementView(chat, NOW);
    expect(c.base.chat.monthly).toBe(chatAllowanceOf({ plan: "pro" }));
    expect(c.ent.chat.monthly).toBe(900);
    // A trial with a live video grant.
    const trial = await stored({ plan: "trial", trialEnds: "2026-10-20T00:00:00Z", grants: grant(day(3)) });
    const t = await entitlementView(trial, NOW);
    expect(t.base.media.video).toEqual(TRIAL_VIDEO_MODELS);
    expect(t.ent.media.video).toEqual(ALL_VIDEO_MODELS);
  });

  it("base equals ent when nothing is overridden, and keeps the account's state (suspended, locked, ends)", async () => {
    const plain = await stored({ plan: "pro" });
    const p = await entitlementView(plain, NOW);
    expect(p.base).toEqual(p.ent);
    const locked = await stored({ plan: "pro", seats: 7, billing: billingFixture({ status: "locked", paidThrough: "2026-10-05" }) });
    const l = await entitlementView(locked, NOW);
    expect(l.base).toMatchObject({ active: false, inactive: "billing_locked", endsAt: "2026-10-05", seats: seatLimit({ plan: "pro" }) });
  });

  it("used.seats counts the owner and the active members, not a paused one, and is what seatsUsed says (M8)", async () => {
    const owner = await stored({ plan: "pro" });
    expect((await entitlementView(owner, NOW)).used.seats).toBe(1);   // the owner alone
    await newMember(owner);
    // Pins the legacy shape (multi-org M1): `saveMember` pauses through the legacy `member:{email}` record.
    const paused = await newMember(owner, "member", "m", { legacy: true });
    await saveMember({ ...(await getMember(paused.email))!, disabled: "seats" });   // what enforceSeats does when a plan shrinks
    const v = await entitlementView(owner, NOW);
    expect(v.used.seats).toBe(await seatsUsed(owner.email));
    expect(v.used.seats).toBe(2);   // the owner and the one active member
  });

  it("is read-only: it writes nothing to the store", async () => {
    const mem = (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown>; lists: Map<string, string[]>; sets: Map<string, Set<string>> } }).__nashrMem;
    const snapshot = () => JSON.stringify([[...mem.kv], [...mem.lists], [...mem.sets].map(([k, v]) => [k, [...v]])]);
    const u = await stored({ plan: "pro", grants: grant(day(3)) });
    const before = snapshot();
    await entitlementView(u, NOW);
    expect(snapshot()).toBe(before);
  });
});

describe("EntitlementsTable (rule 784)", () => {
  const html = async (patch: Partial<User>, lang: "ar" | "en") => renderToStaticMarkup(createElement(EntitlementsTable, { view: await entitlementView(await stored(patch), NOW), lang }));
  const label = (id: string, lang: "ar" | "en") => MEDIA_MODELS.find((m) => m.id === id)!.label[lang];
  const trial = { plan: "trial" as const, trialEnds: "2026-10-20T00:00:00Z" };

  it("an expired grant is greyed and marked expired, and the video row falls back to the plan's list", async () => {
    for (const [lang, word] of [["en", "expired"], ["ar", "منتهية"]] as const) {
      const out = await html({ ...trial, grants: grant(day(-2)) }, lang);
      expect(out, lang).toContain('data-expired="true"');
      expect(out, lang).toContain(word);
      expect(out, lang).toContain(day(-2));
      expect(out, lang).toContain("opacity-60");
      const videoRow = out.slice(out.indexOf('data-row="video"'), out.indexOf('data-row="agents"'));
      for (const id of TRIAL_VIDEO_MODELS) expect(videoRow, `${lang} ${id}`).toContain(label(id, lang));
      expect(videoRow, lang).not.toContain(label("vid-cinematic", lang));
    }
  });

  it("a live grant shows its day, who set it and the note, not greyed, and every model as effective", async () => {
    const out = await html({ ...trial, grants: { video: { ...grant(day(3)).video, note: "agency demo" } } }, "en");
    expect(out).toContain('data-expired="false"');
    expect(out).not.toContain("opacity-60");
    expect(out).toContain(day(3));
    expect(out).toContain("founder@x");
    expect(out).toContain("agency demo");
    const videoRow = out.slice(out.indexOf('data-row="video"'), out.indexOf('data-row="agents"'));
    for (const m of MEDIA_MODELS.filter((x) => x.kind === "video")) expect(videoRow).toContain(m.label.en);
  });

  it("shows each dimension with its effective number and what is used, in both languages", async () => {
    for (const lang of ["en", "ar"] as const) {
      const u = await stored({ plan: "pro", credits: 123 });
      const v = await entitlementView(u, NOW);
      const out = renderToStaticMarkup(createElement(EntitlementsTable, { view: v, lang }));
      for (const key of ["credits", "seats", "chat", "rate", "video", "agents", "status"]) expect(out, `${lang} ${key}`).toContain(`data-row="${key}"`);
      expect(out).toContain(String(v.ent.credits.monthly));
      expect(out).toContain(`${v.used.seats} / ${v.ent.seats}`);
      expect(out).toContain(`${v.used.chat.counted} / ${v.used.chat.allowance}`);
      expect(out).toContain(`${v.ent.chat.hour} / ${v.ent.chat.day}`);
      expect(out).toContain("2026-11-01");   // the reset day
      expect(out).not.toContain('data-testid="video-grant"');
    }
  });

  it("an account that is not active says why", async () => {
    const locked = await html({ plan: "pro", billing: billingFixture({ status: "locked", paidThrough: "2026-10-05" }) }, "en");
    expect(locked).toContain("billing locked");
    expect(locked).toContain("2026-10-05");
    expect(await html({ plan: "pro", suspended: true }, "ar")).toContain("موقوف");
  });

  /** The cells of one row, as text, in column order: dimension, plan, override, effective, used, resets. */
  const cells = (out: string, key: string) => {
    const row = out.slice(out.indexOf(`data-row="${key}"`));
    return [...row.slice(0, row.indexOf("</tr>")).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
  };

  it("the Plan column reads the plan's own value and the Override column what differs from it (ruling R12)", async () => {
    const seats = await html({ plan: "pro", seats: 9 }, "en");
    const [, plan, override, effective] = cells(seats, "seats");
    expect([plan, effective]).toEqual([String(seatLimit({ plan: "pro" })), "9"]);
    expect(override).toContain("9");
    // Nothing differs on an untouched account: the override cell is a dash and the plan equals the effective number.
    const plain = await html({ plan: "pro" }, "en");
    for (const key of ["credits", "seats", "chat"]) {
      const [, p, o, e] = cells(plain, key);
      expect([p, o], key).toEqual([e, "—"]);
    }
  });

  it("an Agency deal shows its credits@price and who set it in the Override cell, the plan's credits in the Plan cell", async () => {
    const u = await stored({ plan: "agency", deal: { credits: 4000, priceSar: 2800, setAt: "x", setBy: "founder@x" } });
    const out = renderToStaticMarkup(createElement(EntitlementsTable, { view: await entitlementView(u, NOW), lang: "en", deal: u.deal }));
    const [, plan, override, effective] = cells(out, "credits");
    expect(plan).toBe(String(allowanceOf({ plan: "agency" })));
    expect(effective).toBe("4000");
    expect(override).toContain("4000@2800");
    expect(override).toContain("founder@x");
  });

  it("an Agency deal at the floor (1500 credits, Business's own number) still shows in the Override cell (M4)", async () => {
    // The effective credits equal the plan's, so a check on "credits differ" would hide the contract and who set it.
    const u = await stored({ plan: "agency", deal: { credits: 1500, priceSar: 999, setAt: "x", setBy: "founder@x" } });
    const view = await entitlementView(u, NOW);
    expect(view.ent.credits.monthly).toBe(view.base.credits.monthly);
    const [, plan, override, effective] = cells(renderToStaticMarkup(createElement(EntitlementsTable, { view, lang: "en", deal: u.deal })), "credits");
    expect([plan, effective]).toEqual(["1500", "1500"]);
    expect(override).toContain("1500@999");
    expect(override).toContain("founder@x");
    // With no deal on the record the cell is still a dash.
    const plain = await stored({ plan: "agency" });
    const [, , o] = cells(renderToStaticMarkup(createElement(EntitlementsTable, { view: await entitlementView(plain, NOW), lang: "en", deal: plain.deal })), "credits");
    expect(o).toBe("—");
  });

  it("Arabic: every day, email and credits@price sits in a left-to-right, no-wrap island, inside a scrolling box (M5)", async () => {
    const u = await stored({ plan: "agency", deal: { credits: 4000, priceSar: 2800, setAt: "x", setBy: "founder@x" }, grants: grant(day(3)) });
    const out = renderToStaticMarkup(createElement(EntitlementsTable, { view: await entitlementView(u, NOW), lang: "ar", deal: u.deal }));
    const island = (inner: string) => `<bdi dir="ltr" class="whitespace-nowrap">${inner}</bdi>`;
    // The status cell's day: a trial's last day (the agency account above is activated by hand and has none).
    const trialOut = renderToStaticMarkup(createElement(EntitlementsTable, { view: await entitlementView(await stored(trial), NOW), lang: "ar" }));
    expect(trialOut).toContain(island("2026-10-20"));
    expect(cells(trialOut, "status")[3]).toContain("مفعّل");
    expect(out).toContain(island(day(3)));          // the grant's last day
    expect(out).toContain(island("founder@x"));     // who set the grant, and the deal
    expect(out).toContain(island("4000@2800 SAR")); // credits@price
    expect(out).toContain(island("2026-11-01"));    // the reset day
    // Every ISO day in the markup is inside such an island (none is bare text in a cell).
    const bare = out.replace(/<bdi dir="ltr" class="whitespace-nowrap">[^<]*<\/bdi>/g, "");
    expect(bare.match(/\d{4}-\d{2}-\d{2}/g) ?? []).toEqual([]);
    expect(bare).not.toMatch(/[\w.-]+@[\w.-]+/);
    // The table scrolls inside its own box instead of widening the page.
    expect(out).toMatch(/<div class="overflow-x-auto"><table/);
    // The console's wrapper lets that box shrink: without min-w-0 the one-column grid below sm
    // takes the table's width and the whole page scrolls sideways on a phone.
    const consoleSrc = adminConsoleSrc();
    expect(consoleSrc).toMatch(/<div className="col-span-full min-w-0"><EntitlementsTable /);
  });

  it("a chat override and a live grant on a trial: base values in Plan, the override in its cell", async () => {
    const out = await html({ ...trial, chatAllowance: 900, grants: grant(day(3)) }, "ar");
    const [, chatPlan, chatOverride, chatEffective] = cells(out, "chat");
    expect([chatPlan, chatEffective]).toEqual([String(chatAllowanceOf({ plan: "trial" })), "900"]);
    expect(chatOverride).toContain("900");
    const [, videoPlan, , videoEffective] = cells(out, "video");
    for (const id of TRIAL_VIDEO_MODELS) expect(videoPlan).toContain(label(id, "ar"));
    expect(videoPlan).not.toContain(label("vid-cinematic", "ar"));
    expect(videoEffective).toContain(label("vid-cinematic", "ar"));
  });

  it("has no footnote explaining blank Plan cells", async () => {
    const out = await html({ plan: "pro", seats: 9 }, "en");
    expect(out).not.toContain("inside the effective number");
    expect(out).not.toContain("set from the account's controls");
  });
});

describe("videoGrantRequest: what the Video grant button sends (rules 783-784, ruling R13)", () => {
  it("a day sends the grant, with the note trimmed and left out when blank", () => {
    expect(videoGrantRequest(" 2026-11-01 ", "  demo for a lead ", false)).toEqual({ videoGrant: { until: "2026-11-01", note: "demo for a lead" } });
    expect(videoGrantRequest("2026-11-01", "   ", true)).toEqual({ videoGrant: { until: "2026-11-01" } });
  });

  it("an empty day clears the grant when the account has one, and sends nothing when it has none", () => {
    expect(videoGrantRequest("", "", true)).toEqual({ videoGrant: null });
    expect(videoGrantRequest("   ", "", true)).toEqual({ videoGrant: null });
    expect(videoGrantRequest("", "", false)).toBeNull();
  });

  it("does not check the day: the server answers bad_grant", () => {
    expect(videoGrantRequest("tomorrow", "", false)).toEqual({ videoGrant: { until: "tomorrow" } });
  });
});
