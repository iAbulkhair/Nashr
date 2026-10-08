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
 * Prove the signed-in session's address (rules 751-754). A password signup reads as signed out until its owner types the
 * emailed code, so every spec that signs up must do this before it calls an app route. The e2e server runs with
 * `APP_ENV=test`, where the signup, send and email routes return the code as `devCode` (rule 766) so no mailbox is needed.
 * With no `devCode` in hand (a login to an account an earlier run left unverified) a fresh one is asked for first.
 */
export async function verifyEmail(request: APIRequestContext, ip: string, devCode?: string) {
  const headers = { "x-forwarded-for": simulatedIp(ip) };
  let code = devCode;
  if (!code) {
    const send = await request.post("/api/auth/verify/send", { headers });
    if (send.status() === 409) return; // already verified
    if (!send.ok()) throw new Error(`asking for a verification code failed with ${send.status()}: ${await send.text()}`);
    code = ((await send.json()) as { devCode?: string }).devCode;
  }
  if (!code) throw new Error("no devCode: the e2e server must run with APP_ENV=test (rule 766)");
  const check = await request.post("/api/auth/verify/check", { data: { code }, headers });
  if (!check.ok()) throw new Error(`verifying the address failed with ${check.status()}: ${await check.text()}`);
}

/** Sign up and, when the signup was accepted, verify the address from the response's `devCode`. Returns the signup response. */
export async function signUpVerified(request: APIRequestContext, data: { email: string; name: string; password: string; lang: string }, clientIp = data.email) {
  const signup = await request.post("/api/auth/signup", { data, headers: { "x-forwarded-for": simulatedIp(clientIp) } });
  if (!signup.ok()) return signup;
  await verifyEmail(request, clientIp, ((await signup.json()) as { devCode?: string }).devCode);
  return signup;
}

/**
 * Sign up, or log in when the account already exists on this server.
 *
 * Two statuses mean "try logging in instead": 409, the account exists, and 429, the per-IP signup throttle
 * (`src/app/api/auth/signup/route.ts`, five per hour) answered before the route ever looked the account up. The
 * throttle deliberately runs first so that signup cannot be used to probe which addresses have accounts, which means a
 * suite rerunning against a still-live server sees 429 rather than 409 from the sixth run onward.
 */
export async function signUpOrLogIn(request: APIRequestContext, account: Account, clientIp = account.email) {
  // Sign-up is capped at five per IP per hour, and every spec in the suite shares one address. Off Vercel `clientIp()`
  // in src/lib/rate.ts reads only the last x-forwarded-for hop (rule 773), and `next start` keeps a header the request
  // already carries, so giving each account its own value makes the suite look like the separate clients it is
  // simulating, instead of one client tripping a real limit.
  const signup = await signUpVerified(request, { email: account.email, name: account.name, password: account.password, lang: "en" }, clientIp);
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
  // A rerun against an account an earlier run left unverified: it logs in, and the app stays closed until the code is typed.
  await verifyEmail(request, clientIp);
}
