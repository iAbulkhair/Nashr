import { beforeEach, describe, expect, it, vi } from "vitest";
import { jar, json, markVerified, newUser, params, settle, signIn, signOut, useWorkspace } from "./helpers/session";
import { vjson } from "./helpers/version";
import { wsHandle } from "@/lib/ws-handle";
import { acct, getLogin, getUser, saveUser } from "@/lib/auth";
import { getBrand, getTask, listLite, type Task } from "@/lib/brand";
import { listFiles } from "@/lib/files";
import { saveConnection } from "@/lib/connectors/store";
import { createMcpToken } from "@/lib/mcp";
import { db } from "@/lib/db";
import { getUsage } from "@/lib/usage";
import { ONBOARD_EXTRA_BRAND_COST } from "@/lib/pricing";
import { TASK_COST } from "@/lib/tasks";

/**
 * End-to-end journeys: a whole customer path through the real route handlers, in order, with the state each step leaves
 * behind checked by the next one. No model key and no network, so every agent call takes its mock path; storage is the
 * in-memory adapter. What these cover that the per-route tests do not is the joins — a task created by one route being
 * approved by a second and published by a third, under the brand the session had active at the time.
 */
vi.mock("@/lib/crawl", () => ({ crawl: async (url: string) => ({ url: `https://${url}`, ok: true, title: "Roastery | Home", description: "Coffee", text: "", links: [], platform: "unknown", colors: [], fonts: [] }) }));
const published: { id: string; scope: string }[] = [];
vi.mock("@/lib/connectors/publish", async (orig) => ({
  ...(await orig<typeof import("@/lib/connectors/publish")>()),
  publishTask: async (scope: string, t: Task, provider: string) => { published.push({ id: t.id, scope }); return { provider, url: "https://t.me/nashr/1", status: "published" as const }; },
}));

import * as signupRoute from "@/app/api/auth/signup/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as accountRoute from "@/app/api/account/route";
import * as onboardRoute from "@/app/api/onboard/route";
import * as confirmRoute from "@/app/api/onboard/confirm/route";
import * as generateRoute from "@/app/api/generate/route";
import * as tasksRoute from "@/app/api/tasks/route";
import * as taskRoute from "@/app/api/tasks/[id]/route";
import * as publishRoute from "@/app/api/publish/[id]/route";
import * as filesRoute from "@/app/api/files/route";
import * as brandsRoute from "@/app/api/brands/route";
import * as mcpRoute from "@/app/api/mcp/route";

const body = async (res: Response) => (await res.json()) as Record<string, never>;
const drain = async (res: Response) => (await res.text()).split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as { type: string });
const rpc = (method: string, p: Record<string, unknown>, token: string) =>
  new Request("https://nashr.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: p }) });
const rpcText = async (res: Response) => ((await res.json()) as { result: { content: { text: string }[] } }).result.content[0].text;

beforeEach(() => { published.length = 0; signOut(); });

describe("journey: sign up, build the workspace, generate, approve, publish", () => {
  it("carries one item from generation to a published post, and the credits and the inbox follow it", async () => {
    const email = `journey-${Math.random().toString(36).slice(2, 8)}@test.example`;

    // 1. Sign up. The response sets a session cookie, so every later step is this account.
    expect((await signupRoute.POST(json("/api/auth/signup", "POST", { email, name: "Roastery", password: "coffee123", lang: "ar" }))).status).toBe(200);
    expect(jar().get("thakeen_session")).toBeTruthy();
    // The account is opaque: its id is read from the address's login, never built from it.
    const aid = (await getLogin(email))!.acct!;
    // The page the signup opens sends its workspace handle with every call.
    useWorkspace(wsHandle(aid));
    expect((await getUser(aid))!.credits).toBe(50);
    // Signup leaves the account unverified, so its session reads as signed out until the address is proved (rule 751).
    await markVerified(email);

    // 2. Onboarding: the owner confirms the site on the start page, then it is free for the first brand, once, and it
    // leaves a brand file and the workspace files behind.
    const confirmed = await confirmRoute.POST(json("/api/onboard/confirm", "POST", { url: "roastery.example" }));
    expect(await confirmed.json()).toEqual({ ok: true, cost: 0 });
    const events = await drain(await onboardRoute.POST(json("/api/onboard", "POST", { url: "roastery.example" })));
    expect(events.at(-1)!.type).toBe("done");
    expect(await getBrand(aid)).not.toBeNull();
    expect((await listFiles(aid)).map((f) => f.name)).toContain("brand.md");
    expect((await getUser(aid))!.credits).toBe(50); // the first brand's onboarding never charges

    // 3. Generate a batch of social posts: ten items, ten credits.
    const gen = await body(await generateRoute.POST(json("/api/generate", "POST", { type: "social" })));
    expect(gen).toMatchObject({ ok: true, created: 10, credits: 40 });

    // 4. The inbox shows them, all pending, and the sidebar badge agrees.
    const inbox = (await body(await tasksRoute.GET(json("/api/tasks", "GET")))) as unknown as { tasks: Task[] };
    expect(inbox.tasks).toHaveLength(10);
    expect(inbox.tasks.every((t) => t.status === "pending")).toBe(true);
    const badge = (await body(await tasksRoute.GET(json("/api/tasks?count=pending", "GET")))) as unknown as { pending: number };
    expect(badge.pending).toBe(10);

    // 5. The owner edits one item and approves it.
    const target = inbox.tasks[0];
    const patched = await body(await taskRoute.PATCH(await vjson(`/api/tasks/${target.id}`, "PATCH", { status: "approved", editedBody: "نص المالك بعد التعديل" }), params({ id: target.id })));
    expect(patched).toMatchObject({ ok: true });
    await settle();
    const saved = (await getTask(aid, target.id))!;
    expect(saved.status).toBe("approved");
    expect(saved.editedBody).toBe("نص المالك بعد التعديل");
    expect(saved.decidedAt).toBeTruthy();

    // 6. Approving takes it out of the pending set, and the light index the dashboards read agrees with the task.
    expect((await body(await tasksRoute.GET(json("/api/tasks?count=pending", "GET")))) as unknown as { pending: number }).toMatchObject({ pending: 9 });
    expect((await listLite(aid)).find((l) => l.id === target.id)).toMatchObject({ status: "approved", edited: true });

    // 7. Publishing needs a connected platform; then the item records where it went.
    expect((await publishRoute.POST(await vjson(`/api/publish/${target.id}`, "POST", { provider: "telegram" }), params({ id: target.id }))).status).toBe(400); // nothing connected yet
    await saveConnection(aid, { provider: "telegram", data: { botToken: "t", chatId: "c" }, connectedAt: new Date().toISOString() });
    expect((await publishRoute.POST(await vjson(`/api/publish/${target.id}`, "POST", { provider: "telegram" }), params({ id: target.id }))).status).toBe(200);
    expect(published).toEqual([{ id: target.id, scope: aid }]);
    expect((await getTask(aid, target.id))!.published).toHaveLength(1);

    // 8. The owner's own workspace file survives the whole run and can be deleted again.
    await filesRoute.PUT(json("/api/files", "PUT", { name: "notes.md", content: "ملاحظاتي" }));
    expect((await listFiles(aid)).map((f) => f.name)).toContain("notes.md");
    await filesRoute.DELETE(json("/api/files?name=notes.md", "DELETE"));
    expect((await listFiles(aid)).map((f) => f.name)).not.toContain("notes.md");
    // The index must lose the name too, not just the record: it is what listFiles reads.
    expect(await db.smembers(`files:${aid}`)).not.toContain("notes.md");
  });
});

describe("journey: an account works in a second brand", () => {
  it("keeps the two workspaces apart, charges the second brand's setup once, and a bearer token follows the active brand", async () => {
    // A trial has one brand (rule 1390); the founder cap gives this one room for a second (rule 1393).
    const u = await newUser("second");
    await saveUser({ ...(await getUser(acct(u)))!, brandCap: 2 });
    await signIn(u.email);
    expect((await getUser(acct(u)))!.credits).toBe(50);

    // A second brand, and the app switches to it.
    const added = (await body(await brandsRoute.POST(json("/api/brands", "POST", { action: "add", name: "Second" })))) as unknown as { ok: boolean; brand: { id: string } };
    expect(added.ok).toBe(true);
    const second = added.brand.id;
    const scope = `${acct(u)}#${second}`;

    // Onboarding runs again for the new brand: it has its own brand file and its own files. The confirmation is the
    // active brand's own, like everything else in the scope, and it shows what the build will cost (rule 246).
    const confirmed = await confirmRoute.POST(json("/api/onboard/confirm", "POST", { url: "second.example" }));
    expect(await confirmed.json()).toEqual({ ok: true, cost: ONBOARD_EXTRA_BRAND_COST });
    expect(await db.get(`onboardok:${acct(u)}`), "the default brand confirmed nothing").toBeNull();
    expect((await drain(await onboardRoute.POST(json("/api/onboard", "POST", { url: "second.example" })))).at(-1)!.type).toBe("done");
    expect(await getBrand(scope)).not.toBeNull();
    // An added brand's setup is charged once, to Noor in that brand: 50 → 41.
    expect(ONBOARD_EXTRA_BRAND_COST).toBe(9);
    expect((await getUser(acct(u)))!.credits).toBe(41);
    expect((await getUser(acct(u)))!.agentSpend?.by[scope]).toEqual({ noor: ONBOARD_EXTRA_BRAND_COST });
    expect(await getBrand(acct(u))).toBeNull(); // the default brand was never onboarded

    // Items generated now belong to the second brand only.
    expect(await body(await generateRoute.POST(json("/api/generate", "POST", { type: "whatsapp" })))).toMatchObject({ ok: true, created: 3, credits: 41 - TASK_COST.whatsapp });
    expect(await listLite(scope)).toHaveLength(3);
    expect(await listLite(acct(u))).toHaveLength(0);

    // The MCP bearer token is the same account: it must land in the brand the owner has active, not in the default one.
    const token = await createMcpToken(acct(u));
    expect(await rpcText(await mcpRoute.POST(rpc("tools/call", { name: "list_inbox", arguments: { status: "pending" } }, token)))).toMatch(/pending/);
    expect(await rpcText(await mcpRoute.POST(rpc("tools/call", { name: "list_files", arguments: {} }, token)))).toMatch(/brand\.md/);

    // Switching back makes the default brand's empty workspace the one the token sees.
    await brandsRoute.POST(json("/api/brands", "POST", { action: "switch", id: "default" }));
    expect(await rpcText(await mcpRoute.POST(rpc("tools/call", { name: "list_files", arguments: {} }, token)))).toBe("No files.");
  });
});

describe("journey: losing and regaining control of an account", () => {
  it("a password change ends every other session and every bearer token issued under the old password", async () => {
    const u = await newUser("pw");
    const stolenSession = await signIn(u.email);
    const stolenToken = await createMcpToken(acct(u));
    // The token works while the password stands.
    expect((await mcpRoute.POST(rpc("tools/call", { name: "list_files", arguments: {} }, stolenToken))).status).toBe(200);
    expect(await rpcText(await mcpRoute.POST(rpc("tools/call", { name: "list_files", arguments: {} }, stolenToken)))).toBe("No files.");

    // The owner changes the password from Settings.
    expect((await accountRoute.PATCH(json("/api/account", "PATCH", { currentPassword: "abc12345", newPassword: "newpass123" }))).status).toBe(200);

    // The old cookie is dead…
    signOut();
    jar().set("thakeen_session", stolenSession);
    expect((await tasksRoute.GET(json("/api/tasks", "GET"))).status).toBe(401);
    // …and so is the bearer token that was created with the old password.
    expect((await mcpRoute.POST(rpc("tools/call", { name: "list_files", arguments: {} }, stolenToken))).status).toBe(401);

    // The new password is the one that logs in.
    signOut();
    expect((await loginRoute.POST(json("/api/auth/login", "POST", { email: u.email, password: "abc12345" }))).status).toBe(401);
    expect((await loginRoute.POST(json("/api/auth/login", "POST", { email: u.email, password: "newpass123" }))).status).toBe(200);
    expect((await tasksRoute.GET(json("/api/tasks", "GET"))).status).toBe(200);
  });
});

describe("journey: what a batch costs the business", () => {
  it("records tokens and money per kind of call, so the cost of one request type per account is a read", async () => {
    const u = await newUser("cost");
    const { meter } = await import("@/lib/usage");
    await meter(acct(u), "claude-opus-5-5", "generate", { input_tokens: 1200, output_tokens: 4700, cache_read_input_tokens: 7500 });
    await meter(acct(u), "claude-sonnet-5-5", "review", { input_tokens: 4100, output_tokens: 1800 });
    await meter(acct(u), "claude-sonnet-5-5", "judge", { input_tokens: 4400, output_tokens: 1500 });

    const usage = await getUsage(acct(u));
    expect(usage.calls).toBe(3);
    expect(Object.keys(usage.byKind).sort()).toEqual(["generate", "judge", "review"]);
    // Opus 5.5 output at $20/M is what a batch actually costs; the two Sonnet passes together are a fraction of it.
    expect(usage.byKind.generate.usd).toBeCloseTo(1200 * 4e-6 + 4700 * 20e-6 + 7500 * 0.2e-6, 4);
    expect(usage.byKind.review.usd).toBeCloseTo(4100 * 2e-6 + 1800 * 10e-6, 4);
    expect(usage.byKind.generate.usd).toBeGreaterThan(usage.byKind.review.usd + usage.byKind.judge.usd);
    expect(usage.usd).toBeCloseTo(usage.byKind.generate.usd + usage.byKind.review.usd + usage.byKind.judge.usd, 2);
  });
});
