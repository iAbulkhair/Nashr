# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth-flows.spec.ts >> login >> correct credentials reach the app
- Location: e2e/auth-flows.spec.ts:79:7

# Error details

```
Error: signup answered 429 and logging e2e-second@test.example in then failed with 401: {"ok":false,"error":"invalid"}. If this is a fresh server the signup throttle is exhausted for this IP; restart the server to clear it.
```

# Test source

```ts
  1  | import type { APIRequestContext } from "@playwright/test";
  2  | 
  3  | /**
  4  |  * The suite's accounts. Credentials are fixed rather than random so a rerun against a server that is still up logs in
  5  |  * instead of signing up again: signup is throttled to five per IP per hour (`src/app/api/auth/signup/route.ts`), and a
  6  |  * random address every run would exhaust that on the fifth rerun.
  7  |  */
  8  | export const OWNER = { email: "e2e-owner@test.example", password: "e2epass123", name: "E2E Owner" };
  9  | export const SECOND = { email: "e2e-second@test.example", password: "e2epass123", name: "E2E Second" };
  10 | 
  11 | export type Account = typeof OWNER;
  12 | 
  13 | /** The brand the owner workspace is seeded with, so app pages render their real content instead of the start wizard. */
  14 | export const SEEDED_BRAND = {
  15 |   name: "E2E Roastery",
  16 |   website: "https://roastery.example",
  17 |   industry: "Coffee roastery",
  18 |   dialect: "saudi",
  19 |   languages: ["ar", "en"],
  20 |   tone: "Warm and direct",
  21 |   products: "Specialty coffee beans, subscriptions, brewing gear",
  22 |   audience: "Riyadh residents aged 25-45 who brew at home",
  23 |   offers: "",
  24 |   competitors: "",
  25 |   banned: "",
  26 |   preferred: "",
  27 |   channels: ["instagram", "whatsapp"],
  28 |   city: "Riyadh",
  29 | };
  30 | 
  31 | /**
  32 |  * Sign up, or log in when the account already exists on this server.
  33 |  *
  34 |  * Two statuses mean "try logging in instead": 409, the account exists, and 429, the per-IP signup throttle
  35 |  * (`src/app/api/auth/signup/route.ts`, five per hour) answered before the route ever looked the account up. The
  36 |  * throttle deliberately runs first so that signup cannot be used to probe which addresses have accounts, which means a
  37 |  * suite rerunning against a still-live server sees 429 rather than 409 from the sixth run onward.
  38 |  */
  39 | export async function signUpOrLogIn(request: APIRequestContext, account: Account) {
  40 |   const signup = await request.post("/api/auth/signup", {
  41 |     data: { email: account.email, name: account.name, password: account.password, lang: "en" },
  42 |   });
  43 |   if (signup.ok()) return;
  44 | 
  45 |   const status = signup.status();
  46 |   if (status !== 409 && status !== 429) {
  47 |     throw new Error(`signup for ${account.email} failed with ${status}: ${await signup.text()}`);
  48 |   }
  49 |   const login = await request.post("/api/auth/login", { data: { email: account.email, password: account.password } });
  50 |   if (!login.ok()) {
> 51 |     throw new Error(
     |           ^ Error: signup answered 429 and logging e2e-second@test.example in then failed with 401: {"ok":false,"error":"invalid"}. If this is a fresh server the signup throttle is exhausted for this IP; restart the server to clear it.
  52 |       `signup answered ${status} and logging ${account.email} in then failed with ${login.status()}: ${await login.text()}. ` +
  53 |         `If this is a fresh server the signup throttle is exhausted for this IP; restart the server to clear it.`,
  54 |     );
  55 |   }
  56 | }
  57 | 
```