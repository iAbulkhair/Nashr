import { test, expect } from "@playwright/test";

/**
 * Server-side guards on request bodies, exercised over HTTP because that is the only place they matter.
 *
 * The first block pins a defect that was live: `/api/generate` validated its `type` with `type in TASK_COST`, and `in`
 * walks the prototype chain. `TASK_COST["constructor"]` is a function, `credits < function` is false for any balance,
 * so the credit gate opened at zero, `credits -= cost` wrote NaN, and `gov.autoApprove["constructor"]` was truthy —
 * which also marked the resulting items approved, bypassing the human gate that publishing depends on.
 */
const PROTOTYPE_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"];

test.describe("POST /api/generate validates the task type", () => {
  test("rejects every Object.prototype key and leaves the balance untouched", async ({ request }) => {
    const email = `guard-${Date.now().toString(36)}@test.example`;
    expect((await request.post("/api/auth/signup", { data: { email, name: "Guard", password: "guardpass1", lang: "en" } })).ok()).toBe(true);
    expect((await request.put("/api/brand", { data: { name: "Guard", industry: "test", products: "x", audience: "y" } })).ok()).toBe(true);

    const credits = async () => ((await (await request.get("/api/tasks")).json()) as { credits: number }).credits;
    const before = await credits();
    expect(before, "a new account starts on the trial allowance").toBe(50);

    for (const key of PROTOTYPE_KEYS) {
      const res = await request.post("/api/generate", { data: { type: key } });
      expect(res.status(), `type "${key}" must be refused`).toBe(400);
      expect((await res.json()).error).toBe("bad_type");
    }

    expect(await credits(), "a refused request must not move the balance").toBe(before);
  });

  test("a real type still charges exactly its cost", async ({ request }) => {
    const email = `guard-ok-${Date.now().toString(36)}@test.example`;
    await request.post("/api/auth/signup", { data: { email, name: "Guard", password: "guardpass1", lang: "en" } });
    await request.put("/api/brand", { data: { name: "Guard", industry: "test", products: "x", audience: "y" } });

    const res = await request.post("/api/generate", { data: { type: "social" } });
    expect(res.ok()).toBe(true);
    // social is 10 credits for 10 items (src/lib/tasks.ts).
    expect(await res.json()).toMatchObject({ ok: true, created: 10, credits: 40 });
  });

  test("an unknown but ordinary string is refused too", async ({ request }) => {
    const email = `guard-x-${Date.now().toString(36)}@test.example`;
    await request.post("/api/auth/signup", { data: { email, name: "Guard", password: "guardpass1", lang: "en" } });
    await request.put("/api/brand", { data: { name: "Guard", industry: "test", products: "x", audience: "y" } });
    const res = await request.post("/api/generate", { data: { type: "not_a_task_type" } });
    expect(res.status()).toBe(400);
  });
});
