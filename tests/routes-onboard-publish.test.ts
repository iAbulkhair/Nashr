import { describe, expect, it, vi } from "vitest";
import { json, newUser, signIn, signOut } from "./helpers/session";
import { getUser } from "@/lib/auth";
import { getBrand, getTask, saveTask, type Task } from "@/lib/brand";
import { listFiles } from "@/lib/files";
import { saveConnection } from "@/lib/connectors/store";
import { wipeAccount } from "@/lib/account";
import { runTool } from "@/lib/chat";
import { db } from "@/lib/db";

// No network: the crawler is replaced, and with no model key the builder takes its mock path.
vi.mock("@/lib/crawl", () => ({ crawl: async (url: string) => ({ url: `https://${url}`, ok: true, title: "Roastery | Home", description: "Coffee", text: "", links: [], platform: "unknown", colors: [], fonts: [] }) }));
const published: string[] = [];
vi.mock("@/lib/connectors/publish", async (orig) => ({ ...(await orig<typeof import("@/lib/connectors/publish")>()), publishTask: async (_e: string, t: Task, provider: string) => { published.push(t.id); return { provider, url: "https://t.me/x/1", status: "published" as const }; } }));

import * as onboard from "@/app/api/onboard/route";
import * as publishRoute from "@/app/api/publish/[id]/route";

const drain = async (res: Response) => { const text = await res.text(); return text.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as { type: string }); };
const task = (id: string, status: Task["status"]): Task => ({ id, type: "social", channel: "instagram", title: id, body: "post", status, createdAt: new Date().toISOString(), lang: "ar" });

describe("onboarding limits (rule 14)", () => {
  it("needs a session", async () => {
    signOut();
    expect((await onboard.POST(json("/api/onboard", "POST", { url: "roastery.example" }))).status).toBe(401);
  });
  it("builds the workspace once, free of charge, and refuses a second run", async () => {
    const u = await newUser("onb");
    await signIn(u.email);
    const events = await drain(await onboard.POST(json("/api/onboard", "POST", { url: "roastery.example" })));
    expect(events.at(-1)!.type).toBe("done");
    expect(await getBrand(u.email)).not.toBeNull();
    expect((await listFiles(u.email)).map((f) => f.name).sort()).toEqual(["brand-guidelines.md", "brand.md", "market-research.md", "opportunities.md", "preferences.md", "strategy.md"]);
    expect((await getUser(u.email))!.credits).toBe(50);
    expect((await onboard.POST(json("/api/onboard", "POST", { url: "roastery.example" }))).status).toBe(409);
  });
  it("allows at most three runs a day per account, even when each run starts from an empty workspace", async () => {
    const u = await newUser("onb");
    await signIn(u.email);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await onboard.POST(json("/api/onboard", "POST", { url: "roastery.example" }));
      codes.push(res.status);
      if (res.status === 200) await drain(res);
      await db.del(`brand:${u.email}`); // as if the owner deleted the brand to get another free build
    }
    expect(codes).toEqual([200, 200, 200, 429]);
  });
});

describe("publishing needs an approval made in code (rule 3)", () => {
  it("the chat tool refuses a pending or rejected item and publishes an approved one", async () => {
    const u = await newUser("pub");
    await saveConnection(u.email, { provider: "telegram", data: { token: "t", chat: "c" }, connectedAt: new Date().toISOString() });
    await saveTask(u.email, task("pending1", "pending"), true);
    await saveTask(u.email, task("rejected1", "rejected"), true);
    await saveTask(u.email, task("approved1", "approved"), true);
    const actions: string[] = [];
    // The instruction to publish could come from crawled text; the model's wish is not enough.
    expect(await runTool(u, "publish_item", { task_id: "pending1", provider: "telegram" }, actions)).toMatch(/not approved/i);
    expect(await runTool(u, "publish_item", { task_id: "rejected1", provider: "telegram" }, actions)).toMatch(/not approved/i);
    expect(published).toEqual([]);
    expect((await getTask(u.email, "pending1"))!.status).toBe("pending");
    expect(await runTool(u, "publish_item", { task_id: "approved1", provider: "telegram" }, actions)).toMatch(/Published/);
    expect(published).toEqual(["approved1"]);
  });
  it("the manual route refuses a rejected item and a target that does not fit the item", async () => {
    const u = await newUser("pub");
    await signIn(u.email);
    await saveConnection(u.email, { provider: "telegram", data: { token: "t", chat: "c" }, connectedAt: new Date().toISOString() });
    await saveTask(u.email, task("rej", "rejected"), true);
    await saveTask(u.email, task("ok", "pending"), true);
    const call = (id: string, provider: string) => publishRoute.POST(json(`/api/publish/${id}`, "POST", { provider }), { params: Promise.resolve({ id }) });
    expect((await call("rej", "telegram")).status).toBe(409);
    expect((await call("ok", "wordpress")).status).toBe(400);
    expect((await call("ok", "telegram")).status).toBe(200); // the owner's own click is the approval
  });
});

describe("account deletion (rule 13)", () => {
  it("removes platform credentials, the user record and the users index entry", async () => {
    const u = await newUser("wipe");
    await saveConnection(u.email, { provider: "telegram", data: { token: "secret" }, connectedAt: new Date().toISOString() });
    await saveTask(u.email, task("t1", "pending"), true);
    expect(await db.smembers("users:all")).toContain(u.email);
    await wipeAccount(u.email);
    expect(await db.get(`conn:${u.email}:telegram`)).toBeNull();
    expect(await db.smembers(`conns:${u.email}`)).toHaveLength(0);
    expect(await getUser(u.email)).toBeNull();
    expect(await db.smembers("users:all")).not.toContain(u.email);
    expect(await getTask(u.email, "t1")).toBeNull();
  });
});
