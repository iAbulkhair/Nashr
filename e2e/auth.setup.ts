import { test as setup, expect } from "@playwright/test";
import { OWNER, SEEDED_BRAND, signUpOrLogIn } from "./fixtures/accounts";

export const OWNER_STATE = "e2e/.auth/owner.json";

/**
 * Logs the owner in once and saves the cookie jar, so the suite pays for one bcrypt round instead of one per spec.
 * The owner is also given a brand file: without one, `/[lang]/app` and `/[lang]/app/reports` redirect to the start
 * wizard, and every app route spec would be testing the wizard instead of the page it names. The no-brand redirect is
 * covered on its own, with a throwaway account, in onboarding.spec.ts.
 */
setup("authenticate and seed the owner", async ({ request, context }) => {
  await signUpOrLogIn(request, OWNER);

  const state = await request.storageState();
  expect(state.cookies.some((c) => c.name === "thakeen_session"), "signup/login must set the session cookie").toBe(true);

  const brand = await request.put("/api/brand", { data: SEEDED_BRAND });
  expect(brand.ok(), `seeding the brand failed: ${brand.status()} ${await brand.text()}`).toBe(true);

  await context.addCookies(state.cookies);
  await context.storageState({ path: OWNER_STATE });
});
