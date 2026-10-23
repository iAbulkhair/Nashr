import type { APIRequest, APIRequestContext, Page } from "@playwright/test";
import { test, expect, open } from "./fixtures/app";
import { simulatedIp, type Account } from "./fixtures/accounts";
import { createWorkspace, freshAccount, generateBatch, stamp } from "./fixtures/workspace";
import { E2E_ADMIN_KEY } from "./web-server";

/**
 * Several brands in one account (rules 886-893, 1390-1393, 3030: src/app/api/brands/route.ts, src/app/api/brand/route.ts,
 * src/lib/brands.ts, src/components/app/BrandSwitcher.tsx). A trial account holds one brand, so the founder's console raises
 * the number (`/api/admin/brand-cap`, rule 1393) before a second can be added. Then:
 *   - the two brands keep their own brand file, work items and Reem list, whichever brand the call names;
 *   - `x-thakeen-brand` is only a selector among the session account's own active brands: another account's brand id, an
 *     invented one, a malformed one and an archived one are all a 404 that holds nothing of anyone's, and a write that names
 *     one writes nothing;
 *   - the sidebar's brand menu lists the active brands and moves the page to the one picked.
 *
 * Every call names its brand with the header: adding a brand makes it the caller's active one, and a call without the header
 * would land on whichever brand the session falls back to. Sign-up journeys run on chromium-desktop only.
 */
test.use({ storageState: { cookies: [], origins: [] } });
test.skip(({ browserName }) => browserName !== "chromium", "signs accounts up; the per-address limits are shared, so one browser engine runs it");

const SEED = "e2e-brands";
const on = (id: string) => ({ "x-thakeen-brand": id });

type BrandRow = { id: string; name: string; status: "active" | "archived"; hasBrandFile: boolean };
type BrandList = { ok: boolean; brands: BrandRow[]; active: string; cap: number; count: number; canUpgrade: boolean };

async function brandList(api: APIRequestContext): Promise<BrandList> {
  const res = await api.get("/api/brands");
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as BrandList;
}

/** The founder's console raises an account's active-brand cap (rule 1393). The console key is this run's, and no second factor is enrolled. */
async function raiseCap(playwright: { request: APIRequest }, baseURL: string, account: Account, seed: string, brandCap = 3) {
  const console_ = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": simulatedIp(`${seed}-console`) } });
  try {
    const res = await console_.post("/api/admin/brand-cap", { data: { email: account.email, brandCap, reason: "e2e: brand journeys need more than one brand" }, headers: { "x-admin-key": E2E_ADMIN_KEY } });
    expect(res.status(), await res.text()).toBe(200);
    expect(((await res.json()) as { user: { brandCap: number } }).user.brandCap).toBe(brandCap);
  } finally {
    await console_.dispose();
  }
}

/** Add a brand (it becomes this login's active one) and return its id. */
async function addBrand(api: APIRequestContext, name: string): Promise<string> {
  const res = await api.post("/api/brands", { data: { action: "add", name }, headers: on("default") });
  expect(res.status(), await res.text()).toBe(200);
  const j = (await res.json()) as { ok: boolean; brand: { id: string; name: string; status: string } };
  expect(j.brand.name).toBe(name);
  expect(j.brand.status).toBe("active");
  return j.brand.id;
}

/** Every title on Reem's agenda for the brand, whichever bucket it sits in. */
async function reemTitles(api: APIRequestContext, brand: string): Promise<string[]> {
  const res = await api.get("/api/secretary", { headers: on(brand) });
  expect(res.status(), `GET /api/secretary as ${brand}: ${await res.text()}`).toBe(200);
  const agenda = ((await res.json()) as { agenda: { buckets: Record<string, Array<{ item: { title: string } }>> } }).agenda;
  return Object.values(agenda.buckets).flatMap((rows) => rows.map((r) => r.item.title));
}

async function addReemItem(api: APIRequestContext, brand: string, title: string) {
  const res = await api.post("/api/secretary", { data: { title }, headers: on(brand) });
  expect(res.status(), await res.text()).toBe(200);
}

/** The work items of the brand, read under its own header (`apiTasks` names none, so it reads the caller's active brand). */
async function tasksOf(api: APIRequestContext, brand: string): Promise<Array<{ id: string; title: string }>> {
  const res = await api.get("/api/tasks", { headers: on(brand) });
  expect(res.status(), `GET /api/tasks as ${brand}: ${await res.text()}`).toBe(200);
  return ((await res.json()) as { tasks: Array<{ id: string; title: string }> }).tasks;
}

async function brandFileName(api: APIRequestContext, brand: string): Promise<string | undefined> {
  const res = await api.get("/api/brand", { headers: on(brand) });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { brand: { name: string } | null }).brand?.name;
}

async function saveBrandFile(api: APIRequestContext, brand: string, name: string) {
  const res = await api.put("/api/brand", { data: { name, industry: "Test goods", products: "Test products", audience: "Test audience", dialect: "english", languages: ["en"], channels: ["instagram"] }, headers: on(brand) });
  expect(res.status(), await res.text()).toBe(200);
}

test("two brands keep their own brand file, work and Reem list, and a foreign, invented or archived brand id is a clean 404", async ({ page, playwright, baseURL }) => {
  const a = freshAccount("brands-a", "E2E Brands A");
  const b = freshAccount("brands-b", "E2E Brands B");
  const nameA = `E2E Brands A Co ${stamp()}`;
  const nameB = `E2E Brands B Co ${stamp()}`;
  const apiA = page.request;
  const apiB = await playwright.request.newContext({ baseURL: baseURL! });
  try {
    await createWorkspace(apiA, a, `${SEED}-a`, nameA);
    await createWorkspace(apiB, b, `${SEED}-b`, nameB);

    // One brand to start with, and the trial's cap is one: a second add is refused with the number and the plan, nothing written.
    const start = await brandList(apiA);
    expect(start.brands.map((r) => r.id)).toEqual(["default"]);
    expect([start.cap, start.count, start.active, start.canUpgrade]).toEqual([1, 1, "default", true]);
    const capped = await apiA.post("/api/brands", { data: { action: "add", name: "Over the cap" }, headers: on("default") });
    expect(capped.status()).toBe(402);
    expect(await capped.json()).toMatchObject({ ok: false, error: "brand_limit", cap: 1, plan: "trial" });
    expect((await brandList(apiA)).brands, "a refused add writes nothing").toHaveLength(1);
    // An action the route does not know is a clean 400, never a 500.
    const unknownAction = await apiA.post("/api/brands", { data: { action: "explode", id: "default" }, headers: on("default") });
    expect(unknownAction.status()).toBe(400);
    expect(((await unknownAction.json()) as { error: string }).error).toBe("bad_action");

    // The console raises the cap; the add then lands, and the new brand is the caller's active one.
    await raiseCap(playwright, baseURL!, a, `${SEED}-a`);
    await raiseCap(playwright, baseURL!, b, `${SEED}-b`);
    const second = await addBrand(apiA, "E2E Second Brand");
    const afterAdd = await brandList(apiA);
    expect(afterAdd.brands.map((r) => r.id).sort()).toEqual(["default", second].sort());
    expect([afterAdd.cap, afterAdd.count, afterAdd.active]).toEqual([3, 2, second]);
    expect(afterAdd.brands.find((r) => r.id === "default")?.name, "the first brand shows its brand file's name").toBe(nameA);
    expect(afterAdd.brands.find((r) => r.id === second)).toMatchObject({ name: "E2E Second Brand", status: "active", hasBrandFile: false });

    // Each brand has its own brand file: the new one has none until it is saved, and saving it leaves the first untouched.
    expect(await brandFileName(apiA, second), "a new brand starts without a brand file").toBeUndefined();
    const secondFile = `E2E Second File ${stamp()}`;
    await saveBrandFile(apiA, second, secondFile);
    expect(await brandFileName(apiA, second)).toBe(secondFile);
    expect(await brandFileName(apiA, "default"), "saving the second brand's file leaves the first one's alone").toBe(nameA);

    // Reem's list is per brand.
    const defaultTitle = `Default brand only ${stamp()}`;
    const secondTitle = `Second brand only ${stamp()}`;
    await addReemItem(apiA, "default", defaultTitle);
    await addReemItem(apiA, second, secondTitle);
    const defaultReem = await reemTitles(apiA, "default");
    const secondReem = await reemTitles(apiA, second);
    expect(defaultReem).toContain(defaultTitle);
    expect(defaultReem).not.toContain(secondTitle);
    expect(secondReem).toContain(secondTitle);
    expect(secondReem).not.toContain(defaultTitle);

    // So is the work: a batch made for the first brand is not in the second brand's inbox.
    await generateBatch(apiA);
    const defaultTasks = await tasksOf(apiA, "default");
    expect(defaultTasks.length).toBeGreaterThan(0);
    expect(defaultTasks.every((t) => t.title.endsWith(`for ${nameA}`)), "the batch is the first brand's").toBe(true);
    expect(await tasksOf(apiA, second), "the second brand has no work of its own yet").toHaveLength(0);

    // The other account has a second brand of its own, which A does not know and cannot name.
    const foreignBrand = await addBrand(apiB, "E2E Foreign Brand");
    await saveBrandFile(apiB, foreignBrand, `E2E Foreign File ${stamp()}`);
    const foreignTitle = `Foreign brand only ${stamp()}`;
    await addReemItem(apiB, foreignBrand, foreignTitle);

    const mustNotLeak = [b.email, nameB, "E2E Foreign Brand", "E2E Foreign File", foreignTitle, foreignBrand];
    const forgedIds = [
      { label: "another account's brand id", id: foreignBrand },
      { label: "an invented id of the right shape", id: "abcd1234" },
      { label: "a malformed id", id: "not a brand!" },
      { label: "the other account's address", id: b.email },
    ];
    for (const { label, id } of forgedIds) {
      for (const path of ["/api/tasks", "/api/brand", "/api/secretary", "/api/brands"]) {
        // The selector is matched among A's own active brands and nothing else: a malformed one is Next's 404 before any
        // store read, an unknown, foreign or archived one is a 404 from the session (rule 886, R-C3), on every route.
        const res = await apiA.get(path, { headers: on(id) });
        expect(res.status(), `GET ${path} naming ${label}`).toBe(404);
        const text = await res.text();
        for (const secret of mustNotLeak) expect(text, `GET ${path} naming ${label} must not carry "${secret}"`).not.toContain(secret);
      }
    }

    // A write that names a brand that is not A's writes nothing, here or there.
    const forgedFile = await apiA.put("/api/brand", { data: { name: "Forged Name", industry: "x", products: "x", audience: "x" }, headers: on(foreignBrand) });
    expect(forgedFile.status()).toBe(404);
    const forgedItem = await apiA.post("/api/secretary", { data: { title: "Forged item" }, headers: on(foreignBrand) });
    expect(forgedItem.status()).toBe(404);
    expect(await brandFileName(apiB, foreignBrand), "the other account's brand file is as it was").not.toBe("Forged Name");
    expect(await reemTitles(apiB, foreignBrand)).not.toContain("Forged item");
    expect(await reemTitles(apiA, "default")).not.toContain("Forged item");
    expect(await reemTitles(apiA, second)).not.toContain("Forged item");
    // Nor can A switch to, rename or archive a brand that is only B's: not found, and B's list is as it was.
    for (const action of ["switch", "rename", "archive"] as const) {
      const res = await apiA.post("/api/brands", { data: { action, id: foreignBrand, name: "Hijacked" }, headers: on("default") });
      expect(res.status(), `${action} on another account's brand`).toBe(404);
    }
    const bList = await brandList(apiB);
    expect(bList.brands.find((r) => r.id === foreignBrand)).toMatchObject({ name: "E2E Foreign Brand", status: "active" });

    // The first brand cannot be archived. The second can: it leaves the active count, its id stops opening anything, the work stays.
    const noDefault = await apiA.post("/api/brands", { data: { action: "archive", id: "default" }, headers: on("default") });
    expect(noDefault.status()).toBe(400);
    expect(((await noDefault.json()) as { error: string }).error).toBe("cannot_archive_default");
    const archived = await apiA.post("/api/brands", { data: { action: "archive", id: second }, headers: on("default") });
    expect(archived.status(), await archived.text()).toBe(200);
    const afterArchive = await brandList(apiA);
    expect(afterArchive.brands.find((r) => r.id === second)?.status).toBe("archived");
    expect([afterArchive.count, afterArchive.active], "the caller leaves the brand just archived").toEqual([1, "default"]);
    const gone = await apiA.get("/api/brand", { headers: on(second) });
    expect(gone.status(), "an archived brand's id is not a brand the session can act in").toBe(404);
    const noSwitch = await apiA.post("/api/brands", { data: { action: "switch", id: second }, headers: on("default") });
    expect(noSwitch.status()).toBe(404);
    // The first brand's data is where it was.
    expect(await reemTitles(apiA, "default")).toContain(defaultTitle);
    expect((await tasksOf(apiA, "default")).length).toBe(defaultTasks.length);

    // The other account's brand is untouched by all of that.
    expect(await reemTitles(apiB, foreignBrand)).toContain(foreignTitle);
  } finally {
    await apiB.dispose();
  }
});

/** Open the sidebar's brand menu. A click before React hydrates the rail does nothing, so click again until it says it is open. */
async function openBrandMenu(page: Page, current: string) {
  const trigger = page.getByTestId("app-sidebar").getByRole("button", { name: `Switch brand: ${current}`, exact: true });
  await expect(async () => {
    if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  return trigger;
}

test("the sidebar's brand menu lists the active brands and moves the page to the one picked", async ({ page, playwright, baseURL }) => {
  const owner = freshAccount("brands-ui", "E2E Brands UI");
  const first = `E2E First Brand ${stamp()}`;
  const secondName = `E2E Second Brand ${stamp()}`;
  await createWorkspace(page.request, owner, `${SEED}-ui`, first);
  await raiseCap(playwright, baseURL!, owner, `${SEED}-ui`, 2);
  const second = await addBrand(page.request, secondName);
  await saveBrandFile(page.request, second, secondName);
  // Adding made the new brand the active one; the page should open on the first, so go back to it.
  const back = await page.request.post("/api/brands", { data: { action: "switch", id: "default" }, headers: on("default") });
  expect(back.status(), await back.text()).toBe(200);

  await open(page, "/en/app");
  await openBrandMenu(page, first);
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: new RegExp(first) })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: new RegExp(secondName) })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Manage brands" })).toBeVisible();
  // At the cap the menu offers no "Add a brand" row; two of two here.
  await expect(menu.getByRole("menuitem", { name: "Add a brand" })).toHaveCount(0);

  // Picking the other brand remembers the choice on the server and moves the page under that brand's own path.
  await menu.getByRole("menuitem", { name: new RegExp(secondName) }).click();
  await page.waitForURL((u) => u.pathname.startsWith("/en/app") && u.pathname.includes(`/b/${second}`), { timeout: 15_000 });
  await expect(page.getByTestId("app-sidebar").getByRole("button", { name: `Switch brand: ${secondName}`, exact: true })).toBeVisible();
  expect((await brandList(page.request)).active, "the server remembers the pick").toBe(second);
});
