import { test, expect, open } from "./fixtures/app";
import { simulatedIp } from "./fixtures/accounts";
import { BRAND, createWorkspace, freshAccount, generateBatch, inviteMember, joinAs, useSession } from "./fixtures/workspace";
import { E2E_ADMIN_KEY } from "./web-server";

/**
 * AI usage (rules 2905-2909): GET /api/usage is the account's own month in requests (never money), for the owner and admins
 * only; the Settings > AI usage page renders the same body; the founder's ranking of clients is behind the console key.
 *
 * The e2e server mocks the model, so a turn makes no model call and nothing is counted: the month reads zero requests. The
 * spec pins what does not depend on the count: who may read it, the shape, the month check, that no money figure leaves the
 * route, and that the page shows what the route says. When the counters do move (a test that drives a real call), the same
 * invariants hold: every slice is at most the total and each share is a percentage.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const SEED = "ai-usage";
const COPY = { title: "AI usage", none: "No requests this month yet.", total: "Total requests" };
type Row = { key: string; calls: number; share: number };
type Usage = { ok: boolean; month: string; total: { calls: number }; person: Row[]; brand: Row[]; agent: Row[]; model: Row[]; day: Row[] };
const DIMS = ["person", "brand", "agent", "model", "day"] as const;

function expectShape(body: Usage) {
  expect(body.ok).toBe(true);
  expect(body.month).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  expect(Number.isInteger(body.total.calls) && body.total.calls >= 0).toBe(true);
  for (const dim of DIMS) {
    expect(Array.isArray(body[dim]), `${dim} is a list`).toBe(true);
    if (body.total.calls === 0) expect(body[dim], `${dim} of an empty month`).toEqual([]);
    for (const row of body[dim]) {
      expect(typeof row.key).toBe("string");
      expect(row.calls, `${dim}/${row.key} calls`).toBeGreaterThan(0);
      expect(row.calls, `${dim}/${row.key} is at most the month`).toBeLessThanOrEqual(body.total.calls);
      expect(row.share).toBeGreaterThanOrEqual(0);
      expect(row.share).toBeLessThanOrEqual(100);
    }
  }
}

test("the owner and an admin read the account's month; a member and a stranger cannot, and no money figure is in it", async ({ page, playwright, baseURL }) => {
  const api = page.request;
  const owner = freshAccount("usage-owner", "E2E Usage Owner");
  const admin = freshAccount("usage-admin", "E2E Usage Admin");
  const member = freshAccount("usage-member", "E2E Usage Member");
  await createWorkspace(api, owner, SEED, "E2E Usage Co");
  await generateBatch(api);
  const chat = await api.post("/api/chat", { data: { text: "Count this turn" }, headers: BRAND });
  expect(chat.status(), await chat.text()).toBe(200);

  const adminApi = await joinAs(playwright, baseURL!, await inviteMember(api, admin.email, "admin", SEED), admin, SEED);
  const memberApi = await joinAs(playwright, baseURL!, await inviteMember(api, member.email, "member", SEED), member, SEED);
  const anonymous = await playwright.request.newContext({ baseURL: baseURL! });
  try {
    // The owner: this month, the shape the page and the console read.
    const res = await api.get("/api/usage", { headers: BRAND });
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as Usage;
    expectShape(body);
    const thisMonth = new Date().toISOString().slice(0, 7);
    expect([thisMonth, new Date(Date.now() - 3600_000).toISOString().slice(0, 7)], "the default is the current month").toContain(body.month);

    // Requests and shares only: nothing that costs Thakeen money is in the answer (rule 2907).
    const text = JSON.stringify(body).toLowerCase();
    for (const word of ["usd", "cost", "margin", "price", "$"]) expect(text, `the answer must not carry "${word}"`).not.toContain(word);
    expect(Object.keys(body).sort()).toEqual(["agent", "brand", "day", "model", "month", "ok", "person", "total"]);

    // An admin reads the same month; a member is refused; a signed-out caller is a 401.
    const asAdmin = await adminApi.get("/api/usage", { headers: BRAND });
    expect(asAdmin.status()).toBe(200);
    expect(((await asAdmin.json()) as Usage).total.calls).toBe(body.total.calls);
    const asMember = await memberApi.get("/api/usage", { headers: BRAND });
    expect(asMember.status()).toBe(403);
    expect((await asMember.json()).error).toBe("forbidden");
    const out = await anonymous.get("/api/usage");
    expect(out.status()).toBe(401);
    expect((await out.json()).ok).toBe(false);

    // The month is the only input. A past month reads empty; a malformed one is refused; the account is never taken from the request.
    const past = await api.get("/api/usage?month=2025-01", { headers: BRAND });
    expect(past.status()).toBe(200);
    const pastBody = (await past.json()) as Usage;
    expect(pastBody.month).toBe("2025-01");
    expect(pastBody.total.calls).toBe(0);
    expectShape(pastBody);
    for (const bad of ["2026-13", "2026-00", "2026-1", "abc", "2026-01-15", "..%2Fx"]) {
      const res2 = await api.get(`/api/usage?month=${bad}`, { headers: BRAND });
      expect(res2.status(), `month=${bad}`).toBe(400);
      expect((await res2.json()).error).toBe("bad_input");
    }
    expect(((await (await api.get("/api/usage?month=", { headers: BRAND })).json()) as Usage).month, "an empty month is this month").toBe(body.month);
    const forged = await api.get(`/api/usage?account=${encodeURIComponent(admin.email)}&email=${encodeURIComponent(member.email)}`, { headers: BRAND });
    expect(forged.status()).toBe(200);
    expect(await forged.json(), "an account named in the query changes nothing").toEqual(body);

    // The page shows what the route says, and the month picker is a plain GET.
    const shown = await open(page, "/en/app/settings/usage");
    expect(shown.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(COPY.title);
    const view = page.getByTestId("owner-usage");
    await expect(view).toContainText(COPY.total);
    await expect(page.getByTestId("owner-usage-total")).toHaveText(String(body.total.calls));
    if (body.total.calls === 0) await expect(view).toContainText(COPY.none);
    await open(page, "/en/app/settings/usage?month=2025-01");
    await expect(page.getByLabel("Month")).toHaveValue("2025-01");
    await expect(page.getByTestId("owner-usage-total")).toHaveText("0");
    await expect(page.getByTestId("owner-usage")).toContainText(COPY.none);
    // A malformed month on the page falls back to this month instead of failing.
    const fallback = await open(page, "/en/app/settings/usage?month=nonsense");
    expect(fallback.status()).toBe(200);
    await expect(page.getByLabel("Month")).toHaveValue(body.month);

    // A member does not see the page: the same 404 an unknown section gets.
    const memberCtx = await page.context().browser()!.newContext({ baseURL: baseURL! });
    try {
      await useSession(memberCtx, memberApi);
      const memberPage = await memberCtx.newPage();
      const denied = await memberPage.goto("/en/app/settings/usage", { waitUntil: "domcontentloaded" });
      expect(denied?.status()).toBe(404);
      await expect(memberPage.getByTestId("owner-usage")).toHaveCount(0);
    } finally {
      await memberCtx.close();
    }
  } finally {
    await adminApi.dispose();
    await memberApi.dispose();
    await anonymous.dispose();
  }
});

test("the founder's ranking of clients answers only to the console key, never to a customer's session", async ({ page, playwright, baseURL }) => {
  const owner = freshAccount("usage-ranking", "E2E Usage Ranking");
  await createWorkspace(page.request, owner, `${SEED}-ranking`, "E2E Ranking Co");
  const anonymous = await playwright.request.newContext({ baseURL: baseURL! });
  const headers = { "x-forwarded-for": simulatedIp(`${SEED}-console`) };
  try {
    // No key: a 401 for a stranger, and the same for a signed-in customer (an owner is not the console).
    expect((await anonymous.get("/api/admin/usage/clients", { headers })).status()).toBe(401);
    expect((await page.request.get("/api/admin/usage/clients", { headers })).status(), "a customer's session is not the console").toBe(401);
    expect((await anonymous.get("/api/admin/usage/clients", { headers: { ...headers, "x-admin-key": "not-the-key" } })).status()).toBe(401);

    // With the key: the ranking of the month, a list (empty or not), and a bad month is refused.
    const res = await anonymous.get("/api/admin/usage/clients", { headers: { ...headers, "x-admin-key": E2E_ADMIN_KEY } });
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { ok: boolean; month: string; rows: Array<{ email: string; calls: number }> };
    expect(body.ok).toBe(true);
    expect(body.month).toMatch(/^\d{4}-\d{2}$/);
    expect(Array.isArray(body.rows)).toBe(true);
    const bad = await anonymous.get("/api/admin/usage/clients?month=2026-13", { headers: { ...headers, "x-admin-key": E2E_ADMIN_KEY } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error).toBe("bad_input");
  } finally {
    await anonymous.dispose();
  }
});
