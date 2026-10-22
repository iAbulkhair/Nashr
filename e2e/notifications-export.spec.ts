import { readFileSync } from "node:fs";
import type { APIRequestContext } from "@playwright/test";
import { test, expect, open } from "./fixtures/app";
import { BRAND, createWorkspace, freshAccount, generateBatch, inviteMember, joinAs, stamp } from "./fixtures/workspace";

/**
 * The bell and the privacy export (rules 1123, 1320-1329, 1966; src/app/api/notifications/route.ts,
 * src/app/api/account/export/route.ts, src/lib/privacy-export.ts, src/components/app/NotificationsPanel.tsx,
 * src/components/app/settings/DangerZone.tsx).
 *
 *  - Notifications. A bell entry is made by the app itself, and the team routes make two a signed-in test can cause: an
 *    invitation (rule: the owner is told an invitation link was created) and its acceptance ("{name} joined your members").
 *    The list and the unread count read the session's own account; one entry is marked read by its id (400 for an id of the
 *    wrong shape, 404 for one the account does not hold, another account's included), then the rest at once; the page
 *    does the same through its buttons.
 *  - Export. The owner's whole copy as one JSON file: the account, plan and every brand with its profile and tasks, no
 *    password, nothing from the request. Another account's export holds none of it; a member is refused; signed out is a 401;
 *    the Danger zone's button downloads the same file.
 *
 * Sign-up journeys run on chromium-desktop only.
 */
test.use({ storageState: { cookies: [], origins: [] } });
test.skip(({ browserName }) => browserName !== "chromium", "signs accounts up; the per-address limits are shared, so one browser engine runs it");

type Notif = { id: string; kind: string; title: string; body: string; href: string; at: string; read?: boolean };
type NotifList = { ok: boolean; notifications: Notif[]; unread: number };

async function bell(api: APIRequestContext): Promise<NotifList> {
  const res = await api.get("/api/notifications");
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as NotifList;
}

const unreadCount = async (api: APIRequestContext) => {
  const res = await api.get("/api/notifications?count=1");
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { ok: boolean; unread: number; notifications?: unknown };
  expect(body.notifications, "the count call carries no entries").toBeUndefined();
  return body.unread;
};

const markOne = (api: APIRequestContext, id: unknown) => api.post("/api/notifications", { data: { id }, headers: BRAND });

test("the bell lists the account's own entries, marks one read by id, then all, and another account's id is a 404", async ({ page, playwright, baseURL }) => {
  const SEED = "e2e-notify";
  const owner = freshAccount("notify-owner", "E2E Notify Owner");
  const member = freshAccount("notify-member", "E2E Notify Member");
  const stranger = freshAccount("notify-stranger", "E2E Notify Stranger");
  const api = page.request;
  const strangerApi = await playwright.request.newContext({ baseURL: baseURL! });
  const contexts: APIRequestContext[] = [strangerApi];
  try {
    await createWorkspace(api, owner, `${SEED}-owner`, "E2E Notify Co");
    await createWorkspace(strangerApi, stranger, `${SEED}-stranger`, "E2E Notify Stranger Co");

    // Signed out, the bell is closed.
    const anonymous = await playwright.request.newContext({ baseURL: baseURL! });
    contexts.push(anonymous);
    expect((await anonymous.get("/api/notifications")).status()).toBe(401);
    expect((await anonymous.get("/api/notifications?count=1")).status()).toBe(401);
    expect((await anonymous.post("/api/notifications", { data: {} })).status()).toBe(401);

    // An invitation makes the owner's first entry: unread, in the account's bell, with a link to the Members page.
    const token = await inviteMember(api, member.email, "member", `${SEED}-invite`);
    const inviteTitle = "A new invitation link was created";
    const afterInvite = await bell(api);
    const invited = afterInvite.notifications.find((n) => n.title === inviteTitle);
    expect(invited, `no "${inviteTitle}" among ${afterInvite.notifications.map((n) => n.title).join(" | ")}`).toBeDefined();
    expect(invited!.id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
    expect(invited!.kind).toBe("info");
    expect(invited!.read ?? false).toBe(false);
    expect(invited!.href).toContain("/team");
    expect(Number.isNaN(Date.parse(invited!.at))).toBe(false);
    expect(afterInvite.unread).toBe(afterInvite.notifications.filter((n) => !n.read).length);
    expect(await unreadCount(api)).toBe(afterInvite.unread);

    // A second invitation (to an address that never joins) makes a third entry that stays unread to the end. Both invitations
    // are open before the member accepts, so the trial's three seats are never over.
    await inviteMember(api, freshAccount("notify-second", "E2E Notify Second").email, "member", `${SEED}-invite-2`);
    const second = (await bell(api)).notifications.filter((n) => n.title === inviteTitle);
    expect(second, "one entry per invitation").toHaveLength(2);

    // Accepting the first makes the joined entry, for the owner: the bell belongs to the account.
    contexts.push(await joinAs(playwright, baseURL!, token, member, `${SEED}-member`));
    const joinedTitle = `${member.name} joined your members`;
    await expect.poll(async () => (await bell(api)).notifications.some((n) => n.title === joinedTitle), { message: `no "${joinedTitle}" in the owner's bell` }).toBe(true);
    const afterJoin = await bell(api);
    const joined = afterJoin.notifications.find((n) => n.title === joinedTitle)!;
    expect(joined.read ?? false).toBe(false);
    expect(joined.body).toContain(member.email);

    // The other account's bell holds none of it.
    const strangerBell = await bell(strangerApi);
    expect(JSON.stringify(strangerBell)).not.toContain(member.email);
    expect(strangerBell.notifications.map((n) => n.title)).not.toContain(joinedTitle);
    expect(strangerBell.notifications.map((n) => n.title)).not.toContain(inviteTitle);

    // Refusals: an id of the wrong shape is a 400, one the account does not hold (another account's included) is a 404.
    for (const bad of ["has space", "", "a".repeat(41), "semi;colon", 123, null, { nested: true }]) {
      const res = await markOne(api, bad);
      expect(res.status(), `marking id ${JSON.stringify(bad)}`).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("bad_id");
    }
    const absent = await markOne(api, "no-such-notice");
    expect(absent.status()).toBe(404);
    expect(((await absent.json()) as { error: string }).error).toBe("not_found");
    const foreign = await markOne(strangerApi, joined.id);
    expect(foreign.status(), "another account's entry id is not found").toBe(404);
    expect((await bell(api)).notifications.find((n) => n.id === joined.id)?.read ?? false, "and it stays unread for its owner").toBe(false);

    // One entry read by its id: the answer is the unread count after the write; the other entry stays unread; marking it again is harmless.
    const before = (await bell(api)).unread;
    const one = await markOne(api, invited!.id);
    expect(one.status(), await one.text()).toBe(200);
    expect(((await one.json()) as { ok: boolean; unread: number }).unread).toBe(before - 1);
    const midway = await bell(api);
    expect(midway.notifications.find((n) => n.id === invited!.id)?.read).toBe(true);
    expect(midway.notifications.find((n) => n.id === joined.id)?.read ?? false).toBe(false);
    expect(midway.unread).toBe(before - 1);
    const again = await markOne(api, invited!.id);
    expect(again.status()).toBe(200);
    expect(((await again.json()) as { unread: number }).unread).toBe(before - 1);

    // The page: the read entry has no button, the unread one does, and pressing it clears the page's "Mark all" with it.
    await open(page, "/en/app/notifications");
    await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
    const joinedRow = page.getByRole("listitem").filter({ hasText: joinedTitle });
    // Two invitation rows (rule 3004): the first is read (no button), the second is still unread (one button).
    const invitedRows = page.getByRole("listitem").filter({ hasText: inviteTitle });
    await expect(joinedRow).toBeVisible();
    await expect(invitedRows).toHaveCount(2);
    await expect(invitedRows.getByRole("button", { name: "Mark as read" })).toHaveCount(1);
    const markJoined = joinedRow.getByRole("button", { name: "Mark as read" });
    await expect(markJoined).toBeVisible();
    // A click before React owns the page does nothing: click again until the button has gone.
    await expect(async () => {
      if (await markJoined.count()) await markJoined.click({ timeout: 1_000 });
      await expect(markJoined).toHaveCount(0, { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect.poll(() => unreadCount(api), { message: "the page's mark-as-read reached the server" }).toBe(before - 2);

    // What is left unread is the second invitation. Another account marking all read touches only its own bell; the bare
    // POST then marks every entry of this one, and the entries stay.
    const fresh = await bell(api);
    expect(fresh.unread).toBeGreaterThan(0);
    const strangerAll = await strangerApi.post("/api/notifications", { data: {}, headers: BRAND });
    expect(strangerAll.status()).toBe(200);
    expect((await bell(api)).unread, "another account's mark-all leaves this bell alone").toBe(fresh.unread);
    const all = await api.post("/api/notifications", { data: {}, headers: BRAND });
    expect(all.status()).toBe(200);
    expect(((await all.json()) as { unread: number }).unread).toBe(0);
    const done = await bell(api);
    expect(done.unread).toBe(0);
    expect(done.notifications.every((n) => n.read)).toBe(true);
    expect(done.notifications.length, "marking read keeps the entries").toBe(fresh.notifications.length);
    expect(await unreadCount(api)).toBe(0);
  } finally {
    await Promise.all(contexts.map((c) => c.dispose()));
  }
});

test("the export holds only the caller's data, no password, and is refused to a member and to a signed-out caller", async ({ page, playwright, baseURL }) => {
  const SEED = "e2e-export";
  const a = freshAccount("export-a", "E2E Export A");
  const b = freshAccount("export-b", "E2E Export B");
  const member = freshAccount("export-member", "E2E Export Member");
  const nameA = `E2E Export A Co ${stamp()}`;
  const nameB = `E2E Export B Co ${stamp()}`;
  const markerA = `MARKER-OFFER-A-${stamp()}`;
  const markerB = `MARKER-OFFER-B-${stamp()}`;
  const apiA = page.request;
  const apiB = await playwright.request.newContext({ baseURL: baseURL! });
  const contexts: APIRequestContext[] = [apiB];
  try {
    await createWorkspace(apiA, a, `${SEED}-a`, nameA);
    await createWorkspace(apiB, b, `${SEED}-b`, nameB);
    // A distinctive string in each brand file, and a batch of work for A.
    for (const [api, name, marker] of [[apiA, nameA, markerA], [apiB, nameB, markerB]] as const) {
      const res = await api.put("/api/brand", { data: { name, industry: "Test goods", products: "Test products", audience: "Test audience", offers: marker, dialect: "english", languages: ["en"], channels: ["instagram"] }, headers: BRAND });
      expect(res.status(), await res.text()).toBe(200);
    }
    await generateBatch(apiA);

    // Signed out: refused.
    const anonymous = await playwright.request.newContext({ baseURL: baseURL! });
    contexts.push(anonymous);
    const noSession = await anonymous.get("/api/account/export");
    expect(noSession.status()).toBe(401);
    expect(((await noSession.json()) as { error: string }).error).toBe("auth");

    // A member of A's account is refused: only the owner downloads the account's data.
    const memberApi = await joinAs(playwright, baseURL!, await inviteMember(apiA, member.email, "member", `${SEED}-invite`), member, `${SEED}-member`);
    contexts.push(memberApi);
    const refused = await memberApi.get("/api/account/export");
    expect(refused.status()).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("forbidden");

    // A's copy.
    const resA = await apiA.get("/api/account/export");
    expect(resA.status(), await resA.text()).toBe(200);
    expect(resA.headers()["content-type"]).toContain("application/json");
    expect(resA.headers()["content-disposition"]).toMatch(/^attachment; filename="thakeen-data-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(resA.headers()["cache-control"]).toBe("no-store");
    expect(resA.headers()["x-content-type-options"]).toBe("nosniff");
    const textA = await resA.text();
    const exportA = JSON.parse(textA) as {
      format: string; exportedAt: string; account: { email: string; name: string };
      plan: { plan: string }; brands: Array<{ id: string; name: string; status: string; active: boolean; profile: { name: string; offers: string } | null; tasks: Array<{ title: string; body: string }>; files: unknown[]; conversations: unknown[]; connections: unknown[] }>;
    };
    expect(exportA.format).toBe("thakeen-export/1");
    expect(Number.isNaN(Date.parse(exportA.exportedAt))).toBe(false);
    expect(exportA.account).toMatchObject({ email: a.email, name: a.name });
    expect(exportA.plan.plan).toBe("trial");
    expect(Object.keys(exportA).filter((k) => !["format", "exportedAt", "account", "consent", "plan", "partner", "brands"].includes(k)), "no key beyond the documented ones").toEqual([]);
    expect(exportA.brands).toHaveLength(1);
    expect(exportA.brands[0]).toMatchObject({ id: "default", status: "active", active: true });
    expect(exportA.brands[0].profile).toMatchObject({ name: nameA, offers: markerA });
    expect(exportA.brands[0].tasks.length, "the batch made for A is in A's copy").toBeGreaterThan(0);
    expect(exportA.brands[0].tasks.every((t) => t.title.includes(nameA))).toBe(true);
    // Nothing secret: the password never leaves, and nothing of the other account is in this copy.
    expect(textA).not.toContain(a.password);
    expect(textA).not.toContain(b.email);
    expect(textA).not.toContain(nameB);
    expect(textA).not.toContain(markerB);

    // B's copy holds B's data and none of A's.
    const resB = await apiB.get("/api/account/export");
    expect(resB.status(), await resB.text()).toBe(200);
    const textB = await resB.text();
    const exportB = JSON.parse(textB) as typeof exportA;
    expect(exportB.account).toMatchObject({ email: b.email, name: b.name });
    expect(exportB.brands[0].profile).toMatchObject({ name: nameB, offers: markerB });
    expect(exportB.brands[0].tasks, "B made no batch").toHaveLength(0);
    for (const secret of [a.email, a.name, nameA, markerA, a.password, b.password, member.email]) expect(textB, `B's export must not carry "${secret}"`).not.toContain(secret);

    // The Danger zone's button downloads the same file for the owner who is signed in in this browser.
    await open(page, "/en/app/settings/danger");
    const link = page.getByRole("link", { name: "Download my data" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/api/account/export");
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toMatch(/^thakeen-data-\d{4}-\d{2}-\d{2}\.json$/);
    const downloaded = JSON.parse(readFileSync((await download.path())!, "utf8")) as typeof exportA;
    expect(downloaded.account.email).toBe(a.email);
    expect(downloaded.brands[0].profile?.name).toBe(nameA);
  } finally {
    await Promise.all(contexts.map((c) => c.dispose()));
  }
});
