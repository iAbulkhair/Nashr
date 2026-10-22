import { test, expect } from "./fixtures/app";
import { appDict } from "../src/lib/app-i18n";
import { BRAND, apiTasks, createWorkspace, freshAccount, generateBatch, mockItem, stamp, useSession, versionOf } from "./fixtures/workspace";

/**
 * Tenant isolation, end to end: two accounts on the same server, each with its own brand, and the second one tries every
 * door to the first one's work (rule: every read and write uses the caller's scope from `sc(u)`, never an id from the request).
 *
 * The task routes take the item's id in the path and nothing else, so "fetching its API URL directly" means PATCH, publish,
 * image and pptx on `/api/tasks/{id}...` and `/api/publish/{id}`: all of them must answer 404 for an id that belongs to
 * another account, the same answer as for an id that does not exist, and none may change the item. There is no GET by id; the
 * inbox's list (GET /api/tasks) is the read, and it must hold only the caller's items.
 *
 * Two fresh accounts rather than the shared owner and SECOND: SECOND is the account auth-flows.spec.ts logs in to expect the
 * first-login game, so giving it a brand would break that spec.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const I = appDict.en.inbox;
const SEED = "tenant-isolation";

test("a second account cannot see, read or change the first account's items", async ({ browser, playwright, baseURL, request: a }) => {
  const brandA = "E2E Tenant A Co";
  const brandB = "E2E Tenant B Co";
  const accountA = freshAccount("tenant-a", "E2E Tenant A");
  const accountB = freshAccount("tenant-b", "E2E Tenant B");
  const marker = `tenant-a-private-${stamp()}`;

  // A: a brand, a batch, and one chat message carrying a marker no one else should ever read.
  await createWorkspace(a, accountA, SEED, brandA);
  await generateBatch(a);
  const chatA = await a.post("/api/chat", { data: { text: `Remember ${marker}` }, headers: BRAND });
  expect(chatA.status(), await chatA.text()).toBe(200);
  const tasksA = await apiTasks(a);
  expect(tasksA).toHaveLength(10);
  const target = mockItem(tasksA, "social", 1, brandA);

  // B: its own brand, no batch.
  const b = await playwright.request.newContext({ baseURL: baseURL! });
  try {
    await createWorkspace(b, accountB, SEED, brandB);

    // The lists. B's inbox is empty; its brand file is its own; its chat history never contains A's message.
    expect(await apiTasks(b), "B's task list must not hold any of A's items").toEqual([]);
    const brand = await b.get("/api/brand");
    expect(brand.status()).toBe(200);
    const brandText = await brand.text();
    expect(brandText).toContain(brandB);
    expect(brandText).not.toContain(brandA);
    for (const path of ["/api/chat", "/api/conversations", "/api/activity", "/api/files"]) {
      const res = await b.get(path);
      expect(res.status(), `GET ${path} as B`).toBeLessThan(500);
      const text = await res.text();
      expect(text, `GET ${path} must not carry A's message`).not.toContain(marker);
      expect(text, `GET ${path} must not carry A's brand`).not.toContain(brandA);
    }
    // The same call as A sees A's own message, so the absence above is isolation and not an empty route.
    expect(await (await a.get("/api/chat")).text()).toContain(marker);

    // The direct doors, by A's real id. Each answers exactly what an id that never existed would.
    const ghost = "0".repeat(target.id.length);
    const doors: Array<[string, () => Promise<{ status(): number }>]> = [
      ["PATCH /api/tasks/{id} (reject)", () => b.patch(`/api/tasks/${target.id}`, { data: { status: "rejected" }, headers: BRAND })],
      ["PATCH /api/tasks/{id} (approve)", () => b.patch(`/api/tasks/${target.id}`, { data: { status: "approved", version: versionOf(target) }, headers: BRAND })],
      ["PATCH /api/tasks/{id} (edit)", () => b.patch(`/api/tasks/${target.id}`, { data: { editedBody: "Changed by B" }, headers: BRAND })],
      ["POST /api/publish/{id}", () => b.post(`/api/publish/${target.id}`, { data: { provider: "x", version: versionOf(target) }, headers: BRAND })],
      ["POST /api/tasks/{id}/image", () => b.post(`/api/tasks/${target.id}/image`, { data: {}, headers: BRAND })],
      ["GET /api/tasks/{id}/pptx", () => b.get(`/api/tasks/${target.id}/pptx`)],
    ];
    for (const [name, call] of doors) {
      expect((await call()).status(), `${name} on A's item`).toBe(404);
    }
    // A made-up id answers the same, which is what makes the 404 above say nothing about whether A's id exists.
    expect((await b.patch(`/api/tasks/${ghost}`, { data: { status: "rejected" }, headers: BRAND })).status()).toBe(404);

    // Forged selectors: the brand header and the workspace header are matched among the caller's own brands and accounts,
    // never read as a key. Whatever the answer, it holds nothing of A's.
    const forged: Array<Record<string, string>> = [{ "x-thakeen-brand": accountA.email }, { "x-thakeen-ws": accountA.email }, { "x-thakeen-brand": target.id }];
    for (const headers of forged) {
      const res = await b.get("/api/tasks", { headers });
      expect(res.status(), `GET /api/tasks with ${JSON.stringify(headers)}`).toBeLessThan(500);
      const text = await res.text();
      expect(text).not.toContain(target.id);
      expect(text).not.toContain(brandA);
    }

    // After all of that A's item is exactly as it was: still pending, text untouched.
    const after = mockItem(await apiTasks(a), "social", 1, brandA);
    expect(after.status).toBe("pending");
    expect(after.editedBody ?? after.body).toBe(target.body);

    // The same request as A is a different answer, so the 404s were about ownership and not about a malformed body.
    const own = await a.patch(`/api/tasks/${target.id}`, { data: { status: "rejected" }, headers: BRAND });
    expect(own.status()).toBe(200);

    // The pages: A's inbox shows A's batch; B's, in its own browser context, shows none of it.
    const ctxA = await browser.newContext({ baseURL: baseURL! });
    const ctxB = await browser.newContext({ baseURL: baseURL! });
    try {
      await useSession(ctxA, a);
      await useSession(ctxB, b);
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      await pageA.goto("/en/app/b/default", { waitUntil: "domcontentloaded" });
      await expect(pageA.locator("article.card", { hasText: `for ${brandA}` }).first()).toBeVisible();

      await pageB.goto("/en/app/b/default", { waitUntil: "domcontentloaded" });
      await expect(pageB.getByRole("heading", { level: 1 })).toContainText(I.title);
      await pageB.getByRole("button", { name: new RegExp(`^${I.all}`) }).click();
      await expect(pageB.getByText(appDict.en.inbox.empty)).toBeVisible();
      await expect(pageB.locator("article.card")).toHaveCount(0);
      await expect(pageB.locator("body")).not.toContainText(brandA);
      await expect(pageB.locator("body")).not.toContainText(accountA.email);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  } finally {
    await b.dispose();
  }
});

test("signed out, the item routes answer 401 and the list shows nothing", async ({ playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL: baseURL! });
  try {
    expect((await anonymous.get("/api/tasks")).status()).toBe(401);
    expect((await anonymous.patch("/api/tasks/anything", { data: { status: "rejected" }, headers: BRAND })).status()).toBe(401);
    expect((await anonymous.post("/api/publish/anything", { data: { provider: "x", version: "v" }, headers: BRAND })).status()).toBe(401);
    expect((await anonymous.get("/api/brand")).status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }
});
