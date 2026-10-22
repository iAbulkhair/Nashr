import type { APIRequestContext } from "@playwright/test";
import { test, expect, open, fillWhenReady } from "./fixtures/app";
import { BRAND, createWorkspace, freshAccount, stamp } from "./fixtures/workspace";

/**
 * Reem's list, the secretary (rules in docs/system/tests.md "secretary"; src/app/api/secretary/route.ts,
 * src/app/api/secretary/[id]/route.ts, src/lib/secretary-store.ts, secretary-change.ts, secretary-owner.ts). One item is
 * created, listed, edited (a stale `rev` is a 409 that carries the current item), completed, reopened, deleted and
 * restored; bad bodies and ids are clean 4xx answers; another account holds the same API but not this item: its id is a
 * 404 on every change, it never appears in that account's lists, and the id in a create body is ignored. The page does the
 * same through the forms.
 *
 * Every call names its brand (rule 888). Sign-up journeys run on chromium-desktop only.
 */
test.use({ storageState: { cookies: [], origins: [] } });
test.skip(({ browserName }) => browserName !== "chromium", "signs accounts up; the per-address limits are shared, so one browser engine runs it");

const SEED = "e2e-secretary";
const SEC_ID = /^s[a-f0-9]{16}$/;
const ABSENT = "s0000000000000000";

type Item = { id: string; title: string; description: string; priority: number; rev: number; source: string; completedAt: string | null; deletedAt: string | null; result: string | null };
type Agenda = { open: number; buckets: Record<string, Array<{ item: Item }>> };

async function agendaOf(api: APIRequestContext): Promise<{ titles: string[]; open: number }> {
  const res = await api.get("/api/secretary", { headers: BRAND });
  expect(res.status(), await res.text()).toBe(200);
  const agenda = ((await res.json()) as { agenda: Agenda }).agenda;
  return { titles: Object.values(agenda.buckets).flatMap((rows) => rows.map((r) => r.item.title)), open: agenda.open };
}

async function viewTitles(api: APIRequestContext, view: "done" | "deleted"): Promise<string[]> {
  const res = await api.get(`/api/secretary?view=${view}`, { headers: BRAND });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { items: Item[] }).items.map((i) => i.title);
}

async function create(api: APIRequestContext, body: Record<string, unknown>): Promise<Item> {
  const res = await api.post("/api/secretary", { data: body, headers: BRAND });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { ok: boolean; item: Item }).item;
}

const change = (api: APIRequestContext, id: string, body: unknown) => api.patch(`/api/secretary/${id}`, { data: body, headers: BRAND });
const errorOf = async (res: { json(): Promise<unknown> }) => ((await res.json()) as { error?: string; field?: string });

test("an item is created, listed, edited, completed, reopened, deleted and restored, and bad requests are refused cleanly", async ({ page, playwright, baseURL }) => {
  const owner = freshAccount("secretary-crud", "E2E Secretary");
  await createWorkspace(page.request, owner, `${SEED}-crud`, "E2E Secretary Co");
  const api = page.request;
  const title = `E2E reminder ${stamp()}`;

  // Signed out, the list is closed.
  const anonymous = await playwright.request.newContext({ baseURL: baseURL! });
  try {
    expect((await anonymous.get("/api/secretary")).status()).toBe(401);
    expect((await anonymous.post("/api/secretary", { data: { title: "x" } })).status()).toBe(401);
    expect((await anonymous.patch(`/api/secretary/${ABSENT}`, { data: { title: "x" } })).status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }

  // Refusals first: each is a 400 that names the field, and nothing is written.
  const noTitle = await api.post("/api/secretary", { data: { description: "no title" }, headers: BRAND });
  expect(noTitle.status()).toBe(400);
  expect(await errorOf(noTitle)).toMatchObject({ error: "title_required", field: "title" });
  const notAnObject = await api.post("/api/secretary", { data: [], headers: BRAND });
  expect(notAnObject.status()).toBe(400);
  expect((await errorOf(notAnObject)).error).toBe("bad_request");
  const badPriority = await api.post("/api/secretary", { data: { title: "x", priority: 9 }, headers: BRAND });
  expect(badPriority.status()).toBe(400);
  expect(await errorOf(badPriority)).toMatchObject({ error: "bad_priority", field: "priority" });
  const badKind = await api.post("/api/secretary", { data: { title: "x", kind: "nope" }, headers: BRAND });
  expect(badKind.status()).toBe(400);
  expect((await errorOf(badKind)).error).toBe("bad_kind");
  expect((await agendaOf(api)).open, "refused creates write nothing").toBe(0);

  // Create. The id, source and scope are the server's: whatever the body says about them is ignored.
  const item = await create(api, { title, description: "first version", priority: 2, id: "sdeadbeefdeadbeef", source: "agent", scope: "someone-else", email: "someone@else.example" });
  expect(item.id).toMatch(SEC_ID);
  expect(item.id).not.toBe("sdeadbeefdeadbeef");
  expect(item).toMatchObject({ title, description: "first version", priority: 2, rev: 1, source: "owner", completedAt: null, deletedAt: null });
  const listed = await agendaOf(api);
  expect(listed.titles).toContain(title);
  expect(listed.open).toBe(1);

  // Edit. A stale revision is a 409 that hands back the current item, and changes nothing.
  const edited = await change(api, item.id, { title: `${title} (edited)`, description: "second version", rev: 1 });
  expect(edited.status(), await edited.text()).toBe(200);
  const afterEdit = ((await edited.json()) as { item: Item }).item;
  expect(afterEdit).toMatchObject({ id: item.id, title: `${title} (edited)`, description: "second version", rev: 2 });
  const stale = await change(api, item.id, { title: "stale write", rev: 1 });
  expect(stale.status()).toBe(409);
  const conflict = (await stale.json()) as { error: string; item: Item };
  expect(conflict.error).toBe("conflict");
  expect(conflict.item).toMatchObject({ title: `${title} (edited)`, rev: 2 });
  expect((await agendaOf(api)).titles).not.toContain("stale write");
  const edited2 = `${title} (edited)`;

  // Bad changes: an unknown action, a close without a result, a body that is not an object, a malformed id and an absent one.
  const badAction = await change(api, item.id, { action: "explode" });
  expect(badAction.status()).toBe(400);
  expect((await errorOf(badAction)).error).toBe("bad_action");
  const noResult = await change(api, item.id, { action: "complete" });
  expect(noResult.status()).toBe(400);
  expect(await errorOf(noResult)).toMatchObject({ error: "result_required", field: "result" });
  const arrayBody = await change(api, item.id, []);
  expect(arrayBody.status()).toBe(400);
  expect((await change(api, "not-an-id", { title: "x" })).status(), "a malformed id is a 404 before any key is built").toBe(404);
  const absent = await change(api, ABSENT, { title: "x" });
  expect(absent.status()).toBe(404);
  expect((await errorOf(absent)).error).toBe("not_found");

  // Complete: it leaves the agenda and shows in the done list with its result; it cannot be edited while done; reopen brings it back.
  const closed = await change(api, item.id, { action: "complete", result: "E2E result: sent", rev: 2 });
  expect(closed.status(), await closed.text()).toBe(200);
  expect(((await closed.json()) as { item: Item }).item).toMatchObject({ result: "E2E result: sent" });
  expect((await agendaOf(api)).titles).not.toContain(edited2);
  expect(await viewTitles(api, "done")).toContain(edited2);
  const editDone = await change(api, item.id, { title: "while done" });
  expect(editDone.status()).toBe(409);
  expect((await errorOf(editDone)).error).toBe("completed");
  const reopened = await change(api, item.id, { action: "reopen" });
  expect(reopened.status(), await reopened.text()).toBe(200);
  expect(((await reopened.json()) as { item: Item }).item).toMatchObject({ completedAt: null, result: null });
  expect((await agendaOf(api)).titles).toContain(edited2);
  expect(await viewTitles(api, "done")).not.toContain(edited2);

  // Delete is soft: gone from the agenda, in the deleted list, not editable, and restore brings it back as it was.
  const deleted = await change(api, item.id, { action: "delete" });
  expect(deleted.status(), await deleted.text()).toBe(200);
  expect(((await deleted.json()) as { item: Item }).item.deletedAt).not.toBeNull();
  expect((await agendaOf(api)).titles).not.toContain(edited2);
  expect(await viewTitles(api, "deleted")).toContain(edited2);
  const editDeleted = await change(api, item.id, { title: "while deleted" });
  expect(editDeleted.status()).toBe(409);
  expect((await errorOf(editDeleted)).error).toBe("deleted");
  const restoredAgain = await change(api, item.id, { action: "restore" });
  expect(restoredAgain.status(), await restoredAgain.text()).toBe(200);
  expect(((await restoredAgain.json()) as { item: Item }).item).toMatchObject({ title: edited2, description: "second version", deletedAt: null });
  expect((await agendaOf(api)).titles).toContain(edited2);
  expect(await viewTitles(api, "deleted")).not.toContain(edited2);
  const restoreOpen = await change(api, item.id, { action: "restore" });
  expect(restoreOpen.status(), "restoring an item that is not deleted is refused, not a 500").toBe(409);
  expect((await errorOf(restoreOpen)).error).toBe("not_deleted");
});

test("another account cannot see, edit, complete, delete or restore an item by its id, and an id in a create body is ignored", async ({ page, playwright, baseURL }) => {
  const a = freshAccount("secretary-a", "E2E Secretary A");
  const b = freshAccount("secretary-b", "E2E Secretary B");
  const apiA = page.request;
  const apiB = await playwright.request.newContext({ baseURL: baseURL! });
  try {
    await createWorkspace(apiA, a, `${SEED}-a`, "E2E Secretary A Co");
    await createWorkspace(apiB, b, `${SEED}-b`, "E2E Secretary B Co");
    const titleA = `A only ${stamp()}`;
    const titleB = `B only ${stamp()}`;
    const itemA = await create(apiA, { title: titleA, description: "A's private note" });

    // B's lists do not carry it, whichever list.
    expect((await agendaOf(apiB)).titles).not.toContain(titleA);
    expect(await viewTitles(apiB, "done")).not.toContain(titleA);
    expect(await viewTitles(apiB, "deleted")).not.toContain(titleA);

    // B names A's id on every kind of change: not found, as if it did not exist, with nothing of A's in the answer.
    const attempts: Array<[string, unknown]> = [
      ["update", { title: "hijacked", rev: 1 }],
      ["complete", { action: "complete", result: "hijacked" }],
      ["delete", { action: "delete" }],
      ["restore", { action: "restore" }],
      ["reopen", { action: "reopen" }],
      ["add_note", { action: "add_note", text: "hijacked" }],
      ["snooze", { action: "snooze", preset: "2h" }],
    ];
    for (const [label, body] of attempts) {
      const res = await change(apiB, itemA.id, body);
      expect(res.status(), `${label} on another account's item`).toBe(404);
      const text = await res.text();
      expect(text).not.toContain(titleA);
      expect(text).not.toContain("A's private note");
    }

    // A's item is exactly as it was.
    const agendaA = await apiA.get("/api/secretary", { headers: BRAND });
    const rows = Object.values(((await agendaA.json()) as { agenda: Agenda }).agenda.buckets).flatMap((r) => r.map((x) => x.item));
    const still = rows.find((i) => i.id === itemA.id);
    expect(still, "A's item is still on A's list").toBeDefined();
    expect(still).toMatchObject({ title: titleA, description: "A's private note", rev: 1, completedAt: null, deletedAt: null });

    // B creates an item with A's id in the body: the id is the server's, so B gets a new one and A's item is untouched.
    const itemB = await create(apiB, { title: titleB, id: itemA.id });
    expect(itemB.id).toMatch(SEC_ID);
    expect(itemB.id).not.toBe(itemA.id);
    expect((await agendaOf(apiA)).titles).not.toContain(titleB);
    expect((await agendaOf(apiB)).titles).toContain(titleB);
    expect((await agendaOf(apiB)).titles).not.toContain(titleA);
    // A cannot change B's item by its id either.
    expect((await change(apiA, itemB.id, { action: "delete" })).status()).toBe(404);
    expect((await agendaOf(apiB)).titles).toContain(titleB);
    expect((await agendaOf(apiA)).titles).toContain(titleA);
  } finally {
    await apiB.dispose();
  }
});

test("the to-do page adds an item, closes it with a result, reopens it, deletes it and restores it", async ({ page }) => {
  const owner = freshAccount("secretary-ui", "E2E Secretary UI");
  await createWorkspace(page.request, owner, `${SEED}-ui`, "E2E Secretary UI Co");
  const title = `E2E page item ${stamp()}`;

  await open(page, "/en/app/b/default/todo");
  await expect(page.getByRole("heading", { level: 1, name: "My to-dos" })).toBeVisible();

  const addForm = page.locator("form").filter({ has: page.getByRole("heading", { name: "Add an item" }) });
  await fillWhenReady(addForm.getByPlaceholder("e.g. Send the campaign brief to the designer"), title);
  await addForm.getByRole("button", { name: "Add", exact: true }).click();
  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row).toContainText("No due date");

  // Close it: the form asks what was done and refuses an empty answer; the item moves to "Done recently" with its result.
  await row.getByRole("button", { name: "Done", exact: true }).click();
  await fillWhenReady(row.getByPlaceholder("e.g. Sent the quote by email"), "E2E page result");
  await row.getByRole("button", { name: "Close it" }).click();
  const doneSection = page.getByRole("region", { name: "Done recently" });
  await expect(doneSection.getByText(title)).toBeVisible();
  await expect(doneSection.getByText("E2E page result")).toBeVisible();

  // Reopen: it leaves "Done recently" and is on the list again.
  await doneSection.getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByRole("region", { name: "Done recently" })).toHaveCount(0);
  await expect(page.getByRole("listitem").filter({ hasText: title })).toBeVisible();

  // Delete: it moves to the restorable list; Restore puts it back.
  await page.getByRole("listitem").filter({ hasText: title }).getByRole("button", { name: "Delete", exact: true }).click();
  const deletedSection = page.getByRole("region", { name: /^Deleted/ });
  await expect(deletedSection.getByText(title)).toBeVisible();
  await deletedSection.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("region", { name: /^Deleted/ })).toHaveCount(0);
  await expect(page.getByRole("listitem").filter({ hasText: title })).toBeVisible();

  // The server agrees with the page.
  expect((await agendaOf(page.request)).titles).toContain(title);
});
