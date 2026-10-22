import { test, expect, fillWhenReady, open } from "./fixtures/app";
import { appDict } from "../src/lib/app-i18n";
import { BRAND, createWorkspace, freshAccount, hydrated, stamp } from "./fixtures/workspace";

/**
 * The chat against the mocked model (`APP_ENV=test`, no key: src/lib/chat.ts answers "[DEV MOCK] ..." and runs no tool, so a
 * turn costs nothing). What is pinned here is everything around the model: the route's checks, the stored thread, the
 * conversation lifecycle (POST/PATCH/GET/DELETE /api/conversations and `conv`), the refusal for a conversation that is not
 * there (rule 2933), and the page: type, send, the reply appears in the log and is still there after a reload.
 *
 * A trial may send 10 messages an hour (CHAT_CAPS), so each test keeps to a handful of turns on an account of its own.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const T = appDict.en.chat;
const SEED = "chat-mock";
const MOCK = "[DEV MOCK]";

test("the chat route refuses empty text and strangers, answers from the mock and keeps each conversation's thread apart", async ({ page, playwright, baseURL }) => {
  const api = page.request;
  await createWorkspace(api, freshAccount("chat-api", "E2E Chat Api"), SEED, "E2E Chat Co");
  const marker = `thread-marker-${stamp()}`;

  // Signed out: nothing is read, written or counted.
  const anonymous = await playwright.request.newContext({ baseURL: baseURL! });
  try {
    expect((await anonymous.get("/api/chat")).status()).toBe(401);
    expect((await anonymous.post("/api/chat", { data: { text: "hello" } })).status()).toBe(401);
    expect((await anonymous.get("/api/conversations")).status()).toBe(401);
    expect((await anonymous.post("/api/conversations", { data: { title: "x" } })).status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }

  // Nothing to say is not a turn: 400 `empty`, whatever else the body holds, and no history is written.
  for (const data of [{}, { text: "" }, { text: "   \n\t " }]) {
    const res = await api.post("/api/chat", { data, headers: BRAND });
    expect(res.status(), JSON.stringify(data)).toBe(400);
    expect((await res.json()).error).toBe("empty");
  }
  const fresh = (await (await api.get("/api/chat", { headers: BRAND })).json()) as { ok: boolean; messages: unknown[]; chat: unknown };
  expect(fresh.ok).toBe(true);
  expect(fresh.messages).toEqual([]);
  expect(fresh.chat, "the chat status travels with the thread").toBeTruthy();

  // A turn on the default thread: the mock answers, says so, and runs no tool (no item cards, no charge).
  const first = await api.post("/api/chat", { data: { text: `Remember ${marker}` }, headers: BRAND });
  expect(first.status(), await first.text()).toBe(200);
  const reply = (await first.json()) as { ok: boolean; message: { role: string; content: string; items?: unknown[] }; limit: unknown; charged: number };
  expect(reply.ok).toBe(true);
  expect(reply.message.role).toBe("assistant");
  expect(reply.message.content.startsWith(MOCK)).toBe(true);
  expect(reply.message.items ?? []).toEqual([]);
  expect(reply.limit).toBeNull();

  // The thread holds both sides, oldest first.
  const thread = (await (await api.get("/api/chat", { headers: BRAND })).json()) as { messages: Array<{ role: string; content: string }> };
  expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(thread.messages[0].content).toBe(`Remember ${marker}`);
  expect(thread.messages[1].content.startsWith(MOCK)).toBe(true);

  // A conversation of its own: created empty, titled by its first message, with a thread nobody else shares.
  const created = await api.post("/api/conversations", { data: { title: "…", agent: "noor" }, headers: BRAND });
  expect(created.status()).toBe(200);
  const conv = ((await created.json()) as { conversation: { id: string; title: string; count: number; agent: string } }).conversation;
  expect(conv.id).toMatch(/^[0-9a-f]{12}$/);
  expect(conv.count).toBe(0);
  expect(conv.agent).toBe("noor");
  const inConv = `conversation-text-${stamp()}`;
  const turn = await api.post("/api/chat", { data: { text: inConv, conv: conv.id }, headers: BRAND });
  expect(turn.status(), await turn.text()).toBe(200);
  expect(((await turn.json()) as { message: { content: string } }).message.content.startsWith(MOCK)).toBe(true);

  const convThread = (await (await api.get(`/api/chat?conv=${conv.id}`, { headers: BRAND })).json()) as { messages: Array<{ role: string; content: string }> };
  expect(convThread.messages.map((m) => m.content)[0]).toBe(inConv);
  expect(convThread.messages).toHaveLength(2);
  expect(JSON.stringify((await (await api.get("/api/chat", { headers: BRAND })).json()))).not.toContain(inConv);
  expect(JSON.stringify(convThread)).not.toContain(marker);

  // The list shows it with the first message as its title and one turn counted; a rename sticks.
  const listed = ((await (await api.get("/api/conversations", { headers: BRAND })).json()) as { conversations: Array<{ id: string; title: string; count: number }> }).conversations;
  const mine = listed.find((c) => c.id === conv.id);
  expect(mine, "the new conversation is listed").toBeTruthy();
  expect(mine!.title).toBe(inConv.slice(0, 60));
  expect(mine!.count).toBe(1);
  const renamed = await api.patch("/api/conversations", { data: { id: conv.id, title: "Renamed by test" }, headers: BRAND });
  expect(renamed.status()).toBe(200);
  const afterRename = ((await (await api.get("/api/conversations", { headers: BRAND })).json()) as { conversations: Array<{ id: string; title: string }> }).conversations;
  expect(afterRename.find((c) => c.id === conv.id)?.title).toBe("Renamed by test");

  // Deleting takes the thread with it, and a turn on a conversation that is not there is refused before it is counted or saved.
  expect((await api.delete(`/api/conversations?id=${conv.id}`, { headers: BRAND })).status()).toBe(200);
  expect(((await (await api.get("/api/conversations", { headers: BRAND })).json()) as { conversations: Array<{ id: string }> }).conversations.find((c) => c.id === conv.id)).toBeUndefined();
  for (const gone of [conv.id, "ffffffffffff", "not-an-id"]) {
    const res = await api.post("/api/chat", { data: { text: "anyone there?", conv: gone }, headers: BRAND });
    expect(res.status(), `conv ${gone}`).toBe(404);
    expect((await res.json()).error).toBe("conversation_gone");
  }
  const afterGone = (await (await api.get(`/api/chat?conv=${conv.id}`, { headers: BRAND })).json()) as { messages: unknown[] };
  expect(afterGone.messages, "the deleted thread is empty and was not written to").toEqual([]);
  // The default thread still holds only its own two messages.
  expect(((await (await api.get("/api/chat", { headers: BRAND })).json()) as { messages: unknown[] }).messages).toHaveLength(2);
});

test("a message typed in the chat page is answered in the log and is still there after a reload", async ({ page, failures }) => {
  void failures;
  await createWorkspace(page.request, freshAccount("chat-ui", "E2E Chat Ui"), `${SEED}-ui`, "E2E Chat Ui Co");
  const text = `Say hello ${stamp()}`;

  await open(page, "/en/app/b/default/chat");
  const log = page.getByRole("log");
  await expect(log).toBeVisible();
  const box = page.getByLabel(T.placeholder, { exact: true });
  const send = page.getByRole("button", { name: T.send, exact: true });
  await hydrated(box);
  await expect(send, "nothing to send yet").toBeDisabled();

  await fillWhenReady(box, text);
  await expect(send).toBeEnabled();
  const posted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/chat" && r.request().method() === "POST");
  await send.click();
  const res = await posted;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toMatchObject({ text, stream: true });

  // Both sides are drawn, the box is emptied, and the reply is the mock's.
  await expect(log).toContainText(text);
  await expect(log).toContainText(MOCK);
  await expect(box).toHaveValue("");

  // It was stored: a reload draws the same two messages from the server.
  await page.reload({ waitUntil: "domcontentloaded" });
  const again = page.getByRole("log");
  await expect(again).toContainText(text);
  await expect(again).toContainText(MOCK);
  const stored = (await (await page.request.get("/api/chat", { headers: BRAND })).json()) as { messages: Array<{ role: string; content: string }> };
  expect(stored.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
});
