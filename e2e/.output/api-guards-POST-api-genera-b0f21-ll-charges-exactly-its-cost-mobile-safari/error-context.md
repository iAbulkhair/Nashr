# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: api-guards.spec.ts >> POST /api/generate validates the task type >> a real type still charges exactly its cost
- Location: e2e/api-guards.spec.ts:32:7

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Test source

```ts
  1  | import { test, expect } from "@playwright/test";
  2  | 
  3  | /**
  4  |  * Server-side guards on request bodies, exercised over HTTP because that is the only place they matter.
  5  |  *
  6  |  * The first block pins a defect that was live: `/api/generate` validated its `type` with `type in TASK_COST`, and `in`
  7  |  * walks the prototype chain. `TASK_COST["constructor"]` is a function, `credits < function` is false for any balance,
  8  |  * so the credit gate opened at zero, `credits -= cost` wrote NaN, and `gov.autoApprove["constructor"]` was truthy —
  9  |  * which also marked the resulting items approved, bypassing the human gate that publishing depends on.
  10 |  */
  11 | const PROTOTYPE_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"];
  12 | 
  13 | test.describe("POST /api/generate validates the task type", () => {
  14 |   test("rejects every Object.prototype key and leaves the balance untouched", async ({ request }) => {
  15 |     const email = `guard-${Date.now().toString(36)}@test.example`;
  16 |     expect((await request.post("/api/auth/signup", { data: { email, name: "Guard", password: "guardpass1", lang: "en" } })).ok()).toBe(true);
  17 |     expect((await request.put("/api/brand", { data: { name: "Guard", industry: "test", products: "x", audience: "y" } })).ok()).toBe(true);
  18 | 
  19 |     const credits = async () => ((await (await request.get("/api/tasks")).json()) as { credits: number }).credits;
  20 |     const before = await credits();
  21 |     expect(before, "a new account starts on the trial allowance").toBe(50);
  22 | 
  23 |     for (const key of PROTOTYPE_KEYS) {
  24 |       const res = await request.post("/api/generate", { data: { type: key } });
  25 |       expect(res.status(), `type "${key}" must be refused`).toBe(400);
  26 |       expect((await res.json()).error).toBe("bad_type");
  27 |     }
  28 | 
  29 |     expect(await credits(), "a refused request must not move the balance").toBe(before);
  30 |   });
  31 | 
  32 |   test("a real type still charges exactly its cost", async ({ request }) => {
  33 |     const email = `guard-ok-${Date.now().toString(36)}@test.example`;
  34 |     await request.post("/api/auth/signup", { data: { email, name: "Guard", password: "guardpass1", lang: "en" } });
  35 |     await request.put("/api/brand", { data: { name: "Guard", industry: "test", products: "x", audience: "y" } });
  36 | 
  37 |     const res = await request.post("/api/generate", { data: { type: "social" } });
> 38 |     expect(res.ok()).toBe(true);
     |                      ^ Error: expect(received).toBe(expected) // Object.is equality
  39 |     // social is 10 credits for 10 items (src/lib/tasks.ts).
  40 |     expect(await res.json()).toMatchObject({ ok: true, created: 10, credits: 40 });
  41 |   });
  42 | 
  43 |   test("an unknown but ordinary string is refused too", async ({ request }) => {
  44 |     const email = `guard-x-${Date.now().toString(36)}@test.example`;
  45 |     await request.post("/api/auth/signup", { data: { email, name: "Guard", password: "guardpass1", lang: "en" } });
  46 |     await request.put("/api/brand", { data: { name: "Guard", industry: "test", products: "x", audience: "y" } });
  47 |     const res = await request.post("/api/generate", { data: { type: "not_a_task_type" } });
  48 |     expect(res.status()).toBe(400);
  49 |   });
  50 | });
  51 | 
```