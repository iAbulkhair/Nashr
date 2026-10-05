/**
 * Reem B3, the brand's marketing calendar (spec 2026-10-05-secretary-reem-b3-calendar-read-design.md). Rule 612 is the
 * provider part: `gcal` and `mscal` exist as OAuth providers flagged `secretary`, so the Integrations page, the generic
 * connector routes and the publishing code never show or use them, and only the account owner may link a calendar.
 */
import { describe, expect, it } from "vitest";
import { json, newUser, params, signIn } from "./helpers/session";
import { db } from "@/lib/db";
import { SEC_KEYS } from "@/lib/secretary";
import { scopeFor, saveBrands } from "@/lib/brands";
import { wipeAccount } from "@/lib/account";
import { addDays, zoneDay, zoneTime } from "@/lib/secretary-agenda";
import { CAL_STALE_MS, dropLink, freshMeetings, getLink, meetingsNow, openTokens, putLink, scheduleSync, sealTokens, type CalEvents, type CalLink } from "@/lib/secretary-cal-link";
import { meetingTitle, todayMeetings, type Meeting } from "@/lib/secretary-meetings";
import { CAL_PROVIDERS, getProvider } from "@/lib/connectors/registry";
import { MIN_ROLE, can } from "@/lib/roles";
import * as connectList from "@/app/api/connect/route";
import * as connectOne from "@/app/api/connect/[provider]/route";

describe("rule 612a: gcal and mscal exist, are secretary-only and never listed on Integrations", () => {
  it("gcal asks Google for the two read-only calendar scopes and nothing else", () => {
    const g = getProvider("gcal")!;
    expect(g.secretary).toBe(true);
    expect(g.kind).toBe("oauth");
    expect(g.capabilities).toEqual([]);
    expect(g.oauth!.clientIdEnv).toBe("GOOGLE_CLIENT_ID");
    expect(g.oauth!.clientSecretEnv).toBe("GOOGLE_CLIENT_SECRET");
    expect(g.oauth!.authorizeUrl).toBe(getProvider("google")!.oauth!.authorizeUrl);
    expect(g.oauth!.tokenUrl).toBe(getProvider("google")!.oauth!.tokenUrl);
    expect(g.oauth!.scopes).toEqual(["openid", "email", "https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events.owned.readonly"]);
    expect(g.oauth!.extraAuthParams).toEqual({ access_type: "offline", prompt: "consent", include_granted_scopes: "false" });
  });

  it("mscal asks Microsoft for basic calendar reads with PKCE on the common endpoints", () => {
    const m = getProvider("mscal")!;
    expect(m.secretary).toBe(true);
    expect(m.kind).toBe("oauth");
    expect(m.capabilities).toEqual([]);
    expect(m.oauth!.authorizeUrl).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(m.oauth!.tokenUrl).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(m.oauth!.tokenAuth).toBe("body");
    expect(m.oauth!.pkce).toBe(true);
    expect(m.oauth!.scopes).toEqual(["openid", "email", "offline_access", "User.Read", "Calendars.ReadBasic"]);
    expect(m.oauth!.clientIdEnv).toBe("MICROSOFT_CLIENT_ID");
    expect(m.oauth!.clientSecretEnv).toBe("MICROSOFT_CLIENT_SECRET");
  });

  it("CAL_PROVIDERS is exactly the two, and no other provider is flagged secretary", async () => {
    expect([...CAL_PROVIDERS]).toEqual(["gcal", "mscal"]);
    const { PROVIDERS } = await import("@/lib/connectors/registry");
    expect(PROVIDERS.filter((p) => p.secretary).map((p) => p.id)).toEqual(["gcal", "mscal"]);
  });

  it("GET /api/connect as the owner lists neither, and still lists the publishing providers", async () => {
    const o = await newUser("calp");
    await signIn(o.email);
    const r = await connectList.GET();
    const body = (await r.json()) as { ok: boolean; providers: { id: string }[] };
    expect(body.ok).toBe(true);
    const ids = body.providers.map((p) => p.id);
    expect(ids).not.toContain("gcal");
    expect(ids).not.toContain("mscal");
    expect(ids).toContain("google");
    expect(ids).toContain("wordpress");
  });

  it("POST and DELETE /api/connect/{gcal,mscal} answer 404 unknown_provider, as for a provider that does not exist", async () => {
    const o = await newUser("calp");
    await signIn(o.email);
    for (const id of ["gcal", "mscal"]) {
      const post = await connectOne.POST(json(`http://x/api/connect/${id}`, "POST", { action: "sync_ads" }), params({ provider: id }));
      expect(post.status).toBe(404);
      expect(await post.json()).toEqual({ ok: false, error: "unknown_provider" });
      const del = await connectOne.DELETE(json(`http://x/api/connect/${id}`, "DELETE"), params({ provider: id }));
      expect(del.status).toBe(404);
      expect(await del.json()).toEqual({ ok: false, error: "unknown_provider" });
    }
  });
});

describe("rule 612b: only the account owner links a calendar", () => {
  it("the role key calendar.link needs the owner, so an admin or a member is refused", () => {
    expect(MIN_ROLE["calendar.link"]).toBe("owner");
    const as = (kind: "owner" | "member", role: "owner" | "admin" | "member") => ({ email: "a@test.example", actor: { kind, role, email: "a@test.example" } }) as never;
    expect(can(as("owner", "owner"), "calendar.link")).toBe(true);
    expect(can(as("member", "admin"), "calendar.link")).toBe(false);
    expect(can(as("member", "member"), "calendar.link")).toBe(false);
  });
});

const TOK = { access: "ya29.access-secret", refresh: "1//refresh-secret", expiresAt: 1_800_000_000_000 };
const linkOf = (over: Partial<CalLink> = {}): CalLink => ({ v: 1, provider: "gcal", login: "o@brand.example", account: "o@brand.example", proof: "domain", calendarId: "cal1", calendarName: "Marketing", tokens: sealTokens(TOK), state: "ok", connectedAt: 1, rev: 1, ...over });
const meet = (start: string, end: string, over: Partial<Meeting> = {}): Meeting => ({ start, end, title: "Sync", allDay: false, ...over });

describe("rule 619 (midnight part): meetings of the local today", () => {
  it("meetingTitle of a private meeting is «مشغول» in Arabic and Busy in English; a public one keeps its title", () => {
    const p = meet("2026-10-06T08:00:00.000Z", "2026-10-06T09:00:00.000Z", { title: "", private: true });
    expect(meetingTitle(p, "ar")).toBe("مشغول");
    expect(meetingTitle(p, "en")).toBe("Busy");
    expect(meetingTitle(meet("2026-10-06T08:00:00.000Z", "2026-10-06T09:00:00.000Z", { title: "Launch" }), "ar")).toBe("Launch");
  });

  it("meeting crossing local midnight is today's: Riyadh 23:00 yesterday to 01:00 today is in at 00:30, one ending exactly at 00:00 is not", () => {
    const z = "Asia/Riyadh" as const;
    const today = "2026-10-06";
    const yesterday = addDays(today, -1);
    const now = zoneTime(today, 0, 30, z);
    expect(zoneDay(now, z)).toBe(today);
    const iso = (ms: number) => new Date(ms).toISOString();
    const crossing = meet(iso(zoneTime(yesterday, 23, 0, z)), iso(zoneTime(today, 1, 0, z)), { title: "Late" });
    const endsAtMidnight = meet(iso(zoneTime(yesterday, 22, 0, z)), iso(zoneTime(today, 0, 0, z)), { title: "Ends" });
    const noon = meet(iso(zoneTime(today, 12, 0, z)), iso(zoneTime(today, 13, 0, z)), { title: "Noon" });
    const tomorrow = meet(iso(zoneTime(addDays(today, 1), 0, 0, z)), iso(zoneTime(addDays(today, 1), 1, 0, z)), { title: "Tomorrow" });
    const out = todayMeetings([noon, tomorrow, endsAtMidnight, crossing], z, now);
    expect(out.map((m) => m.title)).toEqual(["Late", "Noon"]);
  });
});

describe("rule 623 (store part): the calendar link and its events", () => {
  const ev = (syncedAt: number): CalEvents => ({ syncedAt, events: [meet("2026-10-06T08:00:00.000Z", "2026-10-06T09:00:00.000Z")] });
  const now = 1_790_000_000_000;

  it("freshMeetings is empty for no link, a choose or reconnect link, or data 46 minutes old, and returns the events for an ok link synced 44 minutes ago", () => {
    expect(freshMeetings(null, ev(now), now)).toEqual([]);
    expect(freshMeetings(linkOf({ state: "choose" }), ev(now), now)).toEqual([]);
    expect(freshMeetings(linkOf({ state: "reconnect" }), ev(now), now)).toEqual([]);
    expect(freshMeetings(linkOf(), null, now)).toEqual([]);
    expect(CAL_STALE_MS).toBe(45 * 60_000);
    expect(freshMeetings(linkOf(), ev(now - 46 * 60_000), now)).toEqual([]);
    expect(freshMeetings(linkOf(), ev(now - 44 * 60_000), now)).toHaveLength(1);
  });

  it("tokens are sealed, never plain in the stored record, and open back; a broken blob opens to null", async () => {
    const sealed = sealTokens(TOK);
    expect(sealed).not.toContain("ya29");
    expect(sealed).not.toContain("refresh-secret");
    const l = linkOf({ tokens: sealed });
    expect(openTokens(l)).toEqual(TOK);
    expect(openTokens(linkOf({ tokens: "not.a.blob" }))).toBeNull();
    expect(openTokens(linkOf({ tokens: "" }))).toBeNull();
    const u = await newUser("calstore");
    await putLink(u.email, l);
    expect(JSON.stringify(await db.get(SEC_KEYS.calLink(u.email)))).not.toContain("ya29");
  });

  it("keys are namespaced by scope and meetingsNow reads the link and the events together", async () => {
    const u = await newUser("calnow");
    expect(SEC_KEYS.calLink(u.email)).toBe(`sec:cal:link:${u.email}`);
    expect(SEC_KEYS.calEvents(u.email)).toBe(`sec:cal:events:${u.email}`);
    expect(SEC_KEYS.calDue).toBe("sec:cal:due");
    expect(await meetingsNow(u.email, now)).toEqual([]);
    await putLink(u.email, linkOf());
    await db.set(SEC_KEYS.calEvents(u.email), ev(now - 60_000), 86400);
    expect(await getLink(u.email)).toMatchObject({ provider: "gcal", state: "ok" });
    expect(await meetingsNow(u.email, now)).toHaveLength(1);
    await dropLink(u.email);
    expect(await getLink(u.email)).toBeNull();
    expect(await meetingsNow(u.email, now)).toEqual([]);
  });

  it("wipeAccount removes the link, the events and the due entry of every brand scope", async () => {
    const u = await newUser("calwipe");
    const stamp = new Date().toISOString();
    await saveBrands(u.email, [{ id: "default", name: "", createdAt: stamp, status: "active" }, { id: "b2", name: "Two", createdAt: stamp, status: "active" }]);
    const scopes = [u.email, scopeFor(u.email, "b2")];
    await Promise.all(scopes.flatMap((s) => [putLink(s, linkOf()), db.set(SEC_KEYS.calEvents(s), ev(now), 86400), scheduleSync(s, now + 60_000)]));
    expect(await Promise.all(scopes.map((s) => db.zscore(SEC_KEYS.calDue, s)))).toEqual([now + 60_000, now + 60_000]);
    await wipeAccount(u.email);
    expect(await Promise.all(scopes.map((s) => db.get(SEC_KEYS.calLink(s))))).toEqual([null, null]);
    expect(await Promise.all(scopes.map((s) => db.get(SEC_KEYS.calEvents(s))))).toEqual([null, null]);
    expect(await Promise.all(scopes.map((s) => db.zscore(SEC_KEYS.calDue, s)))).toEqual([null, null]);
  });
});
