import type { APIRequestContext } from "@playwright/test";

/**
 * The suite's accounts. Credentials are fixed rather than random so a rerun against a server that is still up logs in
 * instead of signing up again: signup is throttled to five per IP per hour (`src/app/api/auth/signup/route.ts`), and a
 * random address every run would exhaust that on the fifth rerun.
 */
export const OWNER = { email: "e2e-owner@test.example", password: "e2epass123", name: "E2E Owner" };
export const SECOND = { email: "e2e-second@test.example", password: "e2epass123", name: "E2E Second" };

export type Account = typeof OWNER;

/** A stable dotted-quad derived from a name, so each simulated client keeps its own rate-limit bucket across a run. */
export function simulatedIp(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `203.0.113.${(h % 254) + 1}`; // TEST-NET-3, reserved for documentation
}

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
export async function signUpOrLogIn(request: APIRequestContext, account: Account, clientIp = account.email) {
  const signup = await request.post("/api/auth/signup", {
    data: { email: account.email, name: account.name, password: account.password, lang: "en" },
    // Sign-up is capped at five per IP per hour, and every spec in the suite shares one address. `clientIp()` in
    // src/lib/rate.ts reads x-real-ip first — the header the platform sets — so giving each account its own value
    // makes the suite look like the separate clients it is simulating, instead of one client tripping a real limit.
    headers: { "x-real-ip": simulatedIp(clientIp) },
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
