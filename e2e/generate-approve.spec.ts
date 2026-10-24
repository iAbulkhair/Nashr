import type { Page } from "@playwright/test";
import { test, expect, open, appPath } from "./fixtures/app";
import { appDict } from "../src/lib/app-i18n";
import { BRAND, apiTasks, createWorkspace, decide, freshAccount, generateBatch, hydrated, mockItem, versionOf } from "./fixtures/workspace";

/**
 * Generate a batch, decide on it, and the publish gate when nothing is connected. The model is mocked on the e2e server
 * (`APP_ENV=test`, no key), so a batch is free and its items are titled `DEV MOCK social #n for {brand}` (src/lib/noor.ts).
 *
 * Each test signs its own account up (e2e/fixtures/workspace.ts): the shared owner's inbox is read by other specs, and an
 * approval or a rejection changes it for good.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const I = appDict.en.inbox;
const G = appDict.en.generate;
const SEED = "generate-approve";
const card = (page: Page, n: number, brand: string) => page.locator("article.card", { hasText: `DEV MOCK social #${n} for ${brand}` });
const chip = (page: Page, label: string, count: number) => page.getByRole("button", { name: new RegExp(`^${label}\\s*\\(${count}\\)$`) });

test.describe("generate, approve and reject", () => {
  test("a batch from the Generate page lands in the inbox; one item is approved and one rejected, and both stay decided", async ({ page, failures }) => {
    void failures;
    const brand = "E2E Generate Co";
    await createWorkspace(page.request, freshAccount("gen", "E2E Generate"), SEED, brand);

    // The Generate page: the social button costs 10 credits of the trial's 50 and makes ten mock items.
    await open(page, "/en/app/b/default/generate");
    const social = page.getByRole("button", { name: G.types.social.t });
    await hydrated(social);
    await expect(social).toBeEnabled();
    const made = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/generate" && r.request().method() === "POST");
    await social.click();
    const res = await made;
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, created: 10, credits: 40 });

    // The page moves to the approval inbox, where the batch waits (nothing is approved by itself on a new account).
    await page.waitForURL((u) => appPath(u) === "/en/app/b/default");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(I.title);
    await expect(chip(page, I.pending, 10)).toBeVisible();
    await expect(page.locator("article.card", { hasText: "DEV MOCK social" })).toHaveCount(10);

    // Approve item 1.
    const first = card(page, 1, brand);
    await hydrated(first.getByRole("button", { name: I.approve, exact: true }));
    const approved = page.waitForResponse((r) => /^\/api\/tasks\/[^/]+$/.test(new URL(r.url()).pathname) && r.request().method() === "PATCH");
    await first.getByRole("button", { name: I.approve, exact: true }).click();
    const approvedRes = await approved;
    expect(approvedRes.status()).toBe(200);
    expect(approvedRes.request().postDataJSON()).toMatchObject({ status: "approved" });
    // It leaves the waiting list and shows up under Approved.
    await expect(card(page, 1, brand)).toHaveCount(0);
    await expect(chip(page, I.pending, 9)).toBeVisible();
    await expect(chip(page, I.approved, 1)).toBeVisible();

    // Reject item 2 with a reason: Reject opens the reason field, and a second Reject sends it.
    const second = card(page, 2, brand);
    await second.getByRole("button", { name: I.reject, exact: true }).click();
    await second.getByPlaceholder(I.why).fill("Off-brand tone");
    const rejected = page.waitForResponse((r) => /^\/api\/tasks\/[^/]+$/.test(new URL(r.url()).pathname) && r.request().method() === "PATCH");
    await second.getByRole("button", { name: I.reject, exact: true }).click();
    const rejectedRes = await rejected;
    expect(rejectedRes.status()).toBe(200);
    expect(rejectedRes.request().postDataJSON()).toMatchObject({ status: "rejected", note: "Off-brand tone" });
    await expect(card(page, 2, brand)).toHaveCount(0);
    await expect(chip(page, I.pending, 8)).toBeVisible();
    await expect(chip(page, I.rejected, 1)).toBeVisible();

    // The chips show each decided item with its own badge.
    await page.getByRole("button", { name: new RegExp(`^${I.approved}`) }).click();
    await expect(card(page, 1, brand)).toBeVisible();
    await expect(card(page, 1, brand).locator("span.badge", { hasText: new RegExp(`^${I.approved}$`) })).toHaveCount(1);
    await page.getByRole("button", { name: new RegExp(`^${I.rejected}`) }).click();
    await expect(card(page, 2, brand)).toBeVisible();
    await expect(card(page, 2, brand).locator("span.badge", { hasText: new RegExp(`^${I.rejected}$`) })).toHaveCount(1);

    // The decisions are stored, not only drawn: the server lists the same states, with a decision time on the two.
    const tasks = await apiTasks(page.request);
    expect(tasks).toHaveLength(10);
    const one = mockItem(tasks, "social", 1, brand);
    const two = mockItem(tasks, "social", 2, brand);
    expect(one.status).toBe("approved");
    expect(one.decidedAt, "an approval is dated").toBeTruthy();
    expect(two.status).toBe("rejected");
    expect(two.decidedAt, "a rejection is dated").toBeTruthy();
    expect(tasks.filter((t) => t.status === "pending")).toHaveLength(8);

    // And they survive a reload of the page.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(chip(page, I.pending, 8)).toBeVisible();
    await expect(chip(page, I.approved, 1)).toBeVisible();
    await expect(chip(page, I.rejected, 1)).toBeVisible();
  });
});

test.describe("publishing with no platform connected", () => {
  test("every publish is refused with the app's reason, and nothing is marked published", async ({ page, playwright, baseURL }) => {
    const brand = "E2E Publish Co";
    await createWorkspace(page.request, freshAccount("pub", "E2E Publish"), SEED, brand);
    await generateBatch(page.request);
    const tasks = await apiTasks(page.request);
    const instagram = mockItem(tasks, "social", 1, brand); // the mock batch cycles instagram, snapchat, tiktok, x
    const x = mockItem(tasks, "social", 4, brand);
    expect([instagram.channel, x.channel]).toEqual(["instagram", "x"]);

    // Approving is allowed with no connection: the owner can approve and copy the text by hand.
    const approve = await decide(page.request, instagram, "approved");
    expect(approve.status(), await approve.text()).toBe(200);
    const approvedItem = { ...instagram, status: "approved" as const };

    const publish = (id: string, data: Record<string, unknown>) => page.request.post(`/api/publish/${id}`, { data, headers: BRAND });

    // The platform must be one the item can go to AND one the account has connected; this account has connected none.
    for (const [item, provider] of [[approvedItem, "instagram"], [approvedItem, "facebook"], [x, "x"]] as const) {
      const res = await publish(item.id, { provider, version: versionOf(item) });
      expect(res.status(), `${provider} with nothing connected`).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error: "wrong_target" });
    }

    // The other refusals the route makes before it looks at connections.
    const noProvider = await publish(instagram.id, { version: versionOf(instagram) });
    expect(noProvider.status()).toBe(400);
    expect((await noProvider.json()).error).toBe("provider_required");
    const noVersion = await publish(instagram.id, { provider: "instagram" });
    expect(noVersion.status()).toBe(400);
    expect((await noVersion.json()).error).toBe("version_required");
    const stale = await publish(instagram.id, { provider: "instagram", version: "0".repeat(64) });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).error).toBe("changed");

    // A rejected item is never published, whatever the platform.
    const rejected = mockItem(tasks, "social", 2, brand);
    expect((await decide(page.request, rejected, "rejected")).status()).toBe(200);
    const refusedRejected = await publish(rejected.id, { provider: "instagram", version: versionOf(rejected) });
    expect(refusedRejected.status()).toBe(409);
    expect((await refusedRejected.json()).error).toBe("rejected_item");

    // Signed out, the route does not even say whether the item exists.
    const anonymous = await playwright.request.newContext({ baseURL });
    const out = await anonymous.post(`/api/publish/${instagram.id}`, { data: { provider: "instagram", version: versionOf(instagram) }, headers: BRAND });
    expect(out.status()).toBe(401);
    await anonymous.dispose();

    // Nothing went out: no item carries a published record.
    for (const t of await apiTasks(page.request)) expect(t.published ?? [], `${t.title} must not be published`).toEqual([]);

    // The inbox agrees: an approved item offers no "Publish to" button, because there is nowhere to publish to.
    await open(page, "/en/app/b/default");
    // The filter is a client control: a click before the page hydrates is lost.
    const approvedTab = page.getByRole("button", { name: new RegExp(`^${I.approved}`) });
    await hydrated(approvedTab);
    await approvedTab.click();
    const approvedCard = card(page, 1, brand);
    await expect(approvedCard).toBeVisible();
    await expect(approvedCard.getByRole("button", { name: new RegExp(`^${I.publishTo}`) })).toHaveCount(0);
  });
});
