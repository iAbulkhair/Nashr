import type { APIRequestContext } from "@playwright/test";

/**
 * The suite's accounts. Credentials are fixed rather than random so a rerun against a server that is still up logs in
 * instead of signing up again: signup is throttled to five per IP per hour (`src/app/api/auth/signup/route.ts`), and a
 * random address every run would exhaust that on the fifth rerun.
 */
export const OWNER = { email: "e2e-owner@test.example", password: "e2epass123", name: "E2E Owner" };
export const SECOND = { email: "e2e-second@test.example", password: "e2epass123", name: "E2E Second" };

export type Account = typeof OWNER;

/** The brand the owner workspace is seeded with, so app pages render their real content instead of the start wizard. */
export const SEEDED_BRAND = {
  name: "E2E Roastery",
  website: "https://roastery.example",
  industry: "Coffee roastery",
  dialect: "saudi",
  languages: ["ar", "en"],
  tone: "Warm and direct",
  products: "Specialty coffee beans, subscriptions, brewing gear",
  audience: "Riyadh residents aged 25-45 who brew at home",
  offers: "",
  competitors: "",
  banned: "",
  preferred: "",
  channels: ["instagram", "whatsapp"],
  city: "Riyadh",
};

/**
 * Sign up, or log in when the account already exists on this server.
 *
 * Two statuses mean "try logging in instead": 409, the account exists, and 429, the per-IP signup throttle
 * (`src/app/api/auth/signup/route.ts`, five per hour) answered before the route ever looked the account up. The
 * throttle deliberately runs first so that signup cannot be used to probe which addresses have accounts, which means a
 * suite rerunning against a still-live server sees 429 rather than 409 from the sixth run onward.
 */
export async function signUpOrLogIn(request: APIRequestContext, account: Account) {
  const signup = await request.post("/api/auth/signup", {
    data: { email: account.email, name: account.name, password: account.password, lang: "en" },
  });
  if (signup.ok()) return;

  const status = signup.status();
  if (status !== 409 && status !== 429) {
    throw new Error(`signup for ${account.email} failed with ${status}: ${await signup.text()}`);
  }
  const login = await request.post("/api/auth/login", { data: { email: account.email, password: account.password } });
  if (!login.ok()) {
    throw new Error(
      `signup answered ${status} and logging ${account.email} in then failed with ${login.status()}: ${await login.text()}. ` +
        `If this is a fresh server the signup throttle is exhausted for this IP; restart the server to clear it.`,
    );
  }
}
