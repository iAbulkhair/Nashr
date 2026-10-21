import { test, expect } from "@playwright/test";
import { signUpVerified } from "./fixtures/accounts";

/**
 * Server-side guards on request bodies, exercised over HTTP because that is the only place they matter.
 *
 * The first block pins a defect that was live: `/api/generate` validated its `type` with `type in TASK_COST`, and `in`
 * walks the prototype chain. `TASK_COST["constructor"]` is a function, `credits < function` is false for any balance,
 * so the credit gate opened at zero, `credits -= cost` wrote NaN, and `gov.autoApprove["constructor"]` was truthy —
 * which also marked the resulting items approved, bypassing the human gate that publishing depends on.
 *
 * Each test signs up through `signUpVerified`: a new password owner reads as signed out until the emailed code is typed
 * (rule 751), so the helper types the `devCode` the test server returns (rule 766).
 */
/** Direct API mutations name their brand like the app does (rule 888); "default" is every account's first brand. */
const BRAND = { "x-thakeen-brand": "default" };
const PROTOTYPE_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"];

test.describe("POST /api/generate validates the task type", () => {
  test("rejects every Object.prototype key and leaves the balance untouched", async ({ request }) => {
    const email = `guard-${Date.now().toString(36)}@test.example`;
    expect((await signUpVerified(request, { email, name: "Guard", password: "guardpass1", lang: "en" })).ok()).toBe(true);
    expect((await request.put("/api/brand", { data: { name: "Guard", industry: "test", products: "x", audience: "y" }, headers: BRAND })).ok()).toBe(true);

    const credits = async () => ((await (await request.get("/api/tasks")).json()) as { credits: number }).credits;
    const before = await credits();
    expect(before, "a new account starts on the trial allowance").toBe(50);

    for (const key of PROTOTYPE_KEYS) {
      const res = await request.post("/api/generate", { data: { type: key }, headers: BRAND });
      expect(res.status(), `type "${key}" must be refused`).toBe(400);
      expect((await res.json()).error).toBe("bad_type");
    }

    expect(await credits(), "a refused request must not move the balance").toBe(before);
  });

  test("a real type still charges exactly its cost", async ({ request }) => {
    const email = `guard-ok-${Date.now().toString(36)}@test.example`;
    await signUpVerified(request, { email, name: "Guard", password: "guardpass1", lang: "en" });
    await request.put("/api/brand", { data: { name: "Guard", industry: "test", products: "x", audience: "y" }, headers: BRAND });

    const res = await request.post("/api/generate", { data: { type: "social" }, headers: BRAND });
    expect(res.ok()).toBe(true);
    // social is 10 credits for 10 items (src/lib/tasks.ts).
    expect(await res.json()).toMatchObject({ ok: true, created: 10, credits: 40 });
  });

  test("an unknown but ordinary string is refused too", async ({ request }) => {
    const email = `guard-x-${Date.now().toString(36)}@test.example`;
    await signUpVerified(request, { email, name: "Guard", password: "guardpass1", lang: "en" });
    await request.put("/api/brand", { data: { name: "Guard", industry: "test", products: "x", audience: "y" }, headers: BRAND });
    const res = await request.post("/api/generate", { data: { type: "not_a_task_type" }, headers: BRAND });
    expect(res.status()).toBe(400);
  });
});
