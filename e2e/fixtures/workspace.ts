import { expect, type APIRequestContext, type BrowserContext, type Locator, type APIRequest } from "@playwright/test";
import { signUpVerified, simulatedIp, type Account } from "./accounts";
import { taskVersion } from "../../src/lib/task-version";

/**
 * Helpers for the specs that need an account of their own (generate, approve, team, tenant, delete, usage).
 *
 * The shared owner (`OWNER`, e2e/auth.setup.ts) is signed in once for the whole suite and other specs read its inbox and
 * settings, so a spec that approves, rejects, invites, deletes or generates must not touch it. Each of these specs makes a
 * throwaway account instead, with an address that is new every run (a fixed one would collide on a server that is still
 * up), and signs it up through the same API the sign-up page calls. Sign-up is throttled to five per IP per hour, so every
 * spec file passes its own `clientIp` seed to `simulatedIp` and keeps to a few accounts.
 */

/** Direct API mutations name their brand like the app does (rule 888); "default" is every account's first brand. */
export const BRAND = { "x-thakeen-brand": "default" };

/** A short token that differs on every call, for addresses and names that must not repeat across runs. */
export const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A throwaway account. `tag` shows in the address, so a failing run can be traced to its spec. */
export function freshAccount(tag: string, name: string): Account {
  return { email: `e2e-${tag}-${stamp()}@test.example`, password: "e2epass123", name };
}

/** The minimal brand file the app accepts (name, industry, products, audience), English, so the mock drafts read plainly. */
export const brandBody = (name: string) => ({ name, industry: "Test goods", products: "Test products", audience: "Test audience", dialect: "english", languages: ["en"], channels: ["instagram"] });

/**
 * Sign the account up (verified through the test server's `devCode`, rule 766) and give it a brand file, so the app's pages
 * render their own content instead of the first-login game. The session cookie lands in `request`'s jar, which a
 * browser context can take with `useSession`.
 */
export async function createWorkspace(request: APIRequestContext, account: Account, ipSeed: string, brandName: string) {
  const signup = await signUpVerified(request, { email: account.email, name: account.name, password: account.password, lang: "en" }, ipSeed);
  expect(signup.ok(), `sign-up for ${account.email} failed with ${signup.status()}: ${await signup.text()}`).toBe(true);
  const brand = await request.put("/api/brand", { data: brandBody(brandName), headers: BRAND });
  expect(brand.ok(), `saving the brand failed with ${brand.status()}: ${await brand.text()}`).toBe(true);
}

/** Give a browser context the session an API context holds, so a page opened in it is signed in as that account. */
export async function useSession(context: BrowserContext, request: APIRequestContext) {
  await context.addCookies((await request.storageState()).cookies);
}

export type ApiTask = { id: string; title: string; status: "pending" | "approved" | "rejected"; channel: string; type: string; body: string; editedBody?: string; decidedAt?: string; published?: unknown[] };

/** The account's tasks, as the inbox lists them (GET /api/tasks). */
export async function apiTasks(request: APIRequestContext): Promise<ApiTask[]> {
  const res = await request.get("/api/tasks");
  expect(res.status(), "GET /api/tasks").toBe(200);
  return ((await res.json()) as { tasks: ApiTask[] }).tasks;
}

/** Make a batch the way the Generate page does (POST /api/generate). With no model key the batch is the mock one. */
export async function generateBatch(request: APIRequestContext, type = "social") {
  const res = await request.post("/api/generate", { data: { type }, headers: BRAND });
  expect(res.status(), `POST /api/generate {type: ${type}}: ${await res.text()}`).toBe(200);
  return (await res.json()) as { ok: true; created: number; credits: number };
}

/** The item the mock batch titles `DEV MOCK {type} #{n} for {brand}` (src/lib/noor.ts `mock`). */
export function mockItem(tasks: ApiTask[], type: string, n: number, brandName: string): ApiTask {
  const title = `DEV MOCK ${type} #${n} for ${brandName}`;
  const found = tasks.find((t) => t.title === title);
  if (!found) throw new Error(`no item titled "${title}" among ${tasks.map((t) => t.title).join(", ")}`);
  return found;
}

/** Approve or reject an item over the API, bound to the version of the card read just before, as the inbox does. */
export async function decide(request: APIRequestContext, task: ApiTask, status: "approved" | "rejected" | "pending") {
  return request.patch(`/api/tasks/${task.id}`, { data: { status, version: taskVersion(task) }, headers: BRAND });
}

/** The version a publish must carry (src/lib/task-version.ts). */
export const versionOf = (task: ApiTask) => taskVersion(task);

/** Wait until React owns the element, so a click on it reaches its handler (the same signal `fillWhenReady` waits for). */
export async function hydrated(el: Locator) {
  await el.waitFor({ state: "visible" });
  await expect
    .poll(() => el.evaluate((n) => Object.keys(n).some((k) => k.startsWith("__reactFiber$"))), { message: "React never hydrated this element" })
    .toBe(true);
}

/**
 * Invite an address to the account the request is signed in to (POST /api/team/invite). The e2e server has no mail, so the
 * answer carries the link, and the token sits after `#t=` (it never reaches a server log). Returns the token.
 */
export async function inviteMember(owner: APIRequestContext, email: string, role: "member" | "admin", ipSeed: string): Promise<string> {
  const res = await owner.post("/api/team/invite", { data: { email, role, lang: "en" }, headers: { "x-forwarded-for": simulatedIp(ipSeed) } });
  expect(res.status(), `inviting ${email}: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as { ok: boolean; link?: string; emailed: boolean };
  expect(body.emailed, "the e2e server has no mail, so the link is handed back").toBe(false);
  return inviteToken(body.link ?? "");
}

/** The token of an invite link (`…/join#t={64 hex}`). */
export function inviteToken(link: string): string {
  const m = /#t=([a-f0-9]{64})/.exec(link);
  if (!m) throw new Error(`no invite token in "${link}"`);
  return m[1];
}

/**
 * Accept an invite over the API, in a context of its own so it never shares cookies with the owner's. The returned context
 * is signed in as the new member; the caller disposes it.
 */
export async function joinAs(playwright: { request: APIRequest }, baseURL: string, token: string, member: Account, ipSeed: string) {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" } });
  const res = await ctx.post("/api/team/accept", { data: { token, name: member.name, password: member.password, lang: "en" }, headers: { "x-forwarded-for": simulatedIp(ipSeed) } });
  expect(res.status(), `accepting the invite for ${member.email}: ${await res.text()}`).toBe(200);
  return ctx;
}
