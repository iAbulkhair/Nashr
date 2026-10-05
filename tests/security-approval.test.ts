import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { json, newMember, newUser, params, settle, signIn } from "./helpers/session";
import { getTask, saveTask, type Brand, type Task } from "@/lib/brand";
import { db } from "@/lib/db";
import { listDecisions } from "@/lib/decisions";
import { saveConnection } from "@/lib/connectors/store";
import { sha256, taskVersion } from "@/lib/task-version";
import type { User } from "@/lib/auth";

/**
 * Rules 560-567 (security review 2026-10-05).
 * - An approval and a publish are bound to the content the approver saw (src/lib/task-version.ts): a member may edit a
 *   pending draft, and before this an admin who had opened the card earlier approved or published the member's newer
 *   text under the admin's name. The version is checked under the task lock (PATCH) and under the publish lock.
 * - The reason a member types when rejecting lands in preferences.md, a core file every agent reads: a string only, one
 *   line, at most 300 characters, appended under a lock so two decisions at once both land.
 */
const h = vi.hoisted(() => ({ posts: [] as string[], beforeLock: null as null | (() => Promise<void>) }));
vi.mock("@/lib/connectors/publish", async (orig) => ({
  ...(await orig<typeof import("@/lib/connectors/publish")>()),
  publishTask: async (_s: string, t: Task, provider: string) => {
    h.posts.push(`${t.id}:${provider}:${t.editedBody ?? t.body}`);
    return { provider, url: "https://t.me/c/1", id: "1", status: "published" as const };
  },
}));
// A change that lands after the route's own read and before the publish lock: only the check under the lock sees it.
vi.mock("@/lib/publish-once", async (orig) => {
  const real = await orig<typeof import("@/lib/publish-once")>();
  return { ...real, publishOnce: async (...a: Parameters<typeof real.publishOnce>) => { if (h.beforeLock) await h.beforeLock(); return real.publishOnce(...a); } };
});

import * as taskRoute from "@/app/api/tasks/[id]/route";
import * as publishRoute from "@/app/api/publish/[id]/route";

const BRAND: Brand = { name: "محمصة ريف", website: "", industry: "coffee", dialect: "saudi", languages: ["ar"], tone: "دافئ", products: "قهوة", audience: "محبو القهوة", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: "2026-10-05" };
const item = (id: string, over: Partial<Task> = {}): Task => ({ id, type: "social", channel: "telegram", title: `عنوان ${id}`, body: "قهوة اليوم من محمصتنا", status: "pending", createdAt: new Date().toISOString(), lang: "ar", ...over });
const patch = async (id: string, body: unknown) => { const res = await taskRoute.PATCH(json(`/api/tasks/${id}`, "PATCH", body), params({ id })); await settle(); return res; };
const publish = (id: string, body: Record<string, unknown>) => publishRoute.POST(json(`/api/publish/${id}`, "POST", body), params({ id }));
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; task?: Task } });

/** An owner with a brand file and Telegram, plus an admin and a member of the same account. */
async function team(prefix: string) {
  const owner: User = await newUser(prefix);
  await db.set(`brand:${owner.email}`, BRAND);
  await saveConnection(owner.email, { provider: "telegram", data: { token: "t", chat: "c" }, connectedAt: new Date().toISOString() });
  const admin = await newMember(owner, "admin", `${prefix}a`);
  const member = await newMember(owner, "member", `${prefix}m`);
  h.posts.length = 0;
  h.beforeLock = null;
  return { owner, admin, member };
}

describe("the version is SHA-256 of the published content (rule 560)", () => {
  it("matches node's SHA-256 and changes with the text, the title and a generated image, not with a placeholder card", () => {
    for (const s of ["", "abc", "قهوة مختصة", "x".repeat(55), "x".repeat(56), "y".repeat(64), "z".repeat(5000)]) expect(sha256(s)).toBe(createHash("sha256").update(s).digest("hex"));
    const t = item("v");
    expect(taskVersion(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(taskVersion({ ...t, editedBody: "نص آخر" })).not.toBe(taskVersion(t));
    expect(taskVersion({ ...t, title: "عنوان آخر" })).not.toBe(taskVersion(t));
    expect(taskVersion({ ...t, imageUrl: "https://x.public.blob.vercel-storage.com/a.png", imageProvider: "kie" })).not.toBe(taskVersion(t));
    expect(taskVersion({ ...t, imageUrl: "https://placehold.co/1", imageProvider: "placeholder" })).toBe(taskVersion(t));
    // The chat card has no image fields and shows the effective text as `body`: same version as the stored item.
    expect(taskVersion({ title: t.title, body: "نص المالك" })).toBe(taskVersion({ ...t, editedBody: "نص المالك" }));
  });
});

describe("an approval is bound to the text the approver saw (rules 561-564)", () => {
  it("approve with a stale version is 409 changed and changes nothing; with the current version it approves", async () => {
    const { owner, admin } = await team("ver");
    await saveTask(owner.email, item("s1"));
    const seen = taskVersion((await getTask(owner.email, "s1"))!);
    await saveTask(owner.email, item("s1", { editedBody: "نص جديد كتبه غيري" }));
    await signIn(admin.email);
    const stale = await read(await patch("s1", { status: "approved", version: seen }));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("changed");
    expect(stale.body.task?.editedBody).toBe("نص جديد كتبه غيري");
    const kept = (await getTask(owner.email, "s1"))!;
    expect(kept.status).toBe("pending");
    expect(kept.decidedAt).toBeUndefined();
    expect(await listDecisions(owner.email)).toEqual([]);
    const ok = await read(await patch("s1", { status: "approved", version: taskVersion(kept) }));
    expect(ok.status).toBe(200);
    expect((await getTask(owner.email, "s1"))!.status).toBe("approved");
  });

  it("a member's edit after the admin opened the card: the admin's approve and publish are both refused, nothing goes out", async () => {
    const { owner, admin, member } = await team("race");
    await saveTask(owner.email, item("r1"));
    // The admin opens the inbox: this is the card on screen.
    const adminSaw = taskVersion((await getTask(owner.email, "r1"))!);
    // A member rewrites the pending draft (allowed: role "drafts").
    await signIn(member.email);
    expect((await patch("r1", { editedBody: "نص العضو الذي لم يره المشرف" })).status).toBe(200);
    // The admin publishes, then approves, from the card they saw.
    await signIn(admin.email);
    const pub = await read(await publish("r1", { provider: "telegram", version: adminSaw }));
    expect(pub.status).toBe(409);
    expect(pub.body.error).toBe("changed");
    const app = await read(await patch("r1", { status: "approved", version: adminSaw }));
    expect(app.status).toBe(409);
    expect(h.posts).toEqual([]);
    const now = (await getTask(owner.email, "r1"))!;
    expect(now.status).toBe("pending");
    expect(now.published).toBeUndefined();
    // Once the admin has seen the member's text, publishing it is their decision.
    const ok = await read(await publish("r1", { provider: "telegram", version: taskVersion(now) }));
    expect(ok.status).toBe(200);
    expect(h.posts).toEqual(["r1:telegram:نص العضو الذي لم يره المشرف"]);
  });

  it("a member who reopens an approved item and rewrites it cannot ride on the earlier approval", async () => {
    const { owner, admin, member } = await team("reopen");
    await saveTask(owner.email, item("o1", { status: "approved", decidedAt: new Date().toISOString() }));
    const adminSaw = taskVersion((await getTask(owner.email, "o1"))!);
    await signIn(member.email);
    expect((await patch("o1", { status: "pending" })).status).toBe(200);
    expect((await patch("o1", { editedBody: "نص بعد إعادة الفتح" })).status).toBe(200);
    await signIn(admin.email);
    expect((await publish("o1", { provider: "telegram", version: adminSaw })).status).toBe(409);
    expect((await patch("o1", { status: "approved", version: adminSaw })).status).toBe(409);
    expect(h.posts).toEqual([]);
  });

  it("the publish check runs again under the lock: an edit landing after the route's read is refused", async () => {
    const { owner, admin } = await team("lock");
    await saveTask(owner.email, item("l1"));
    const seen = taskVersion((await getTask(owner.email, "l1"))!);
    h.beforeLock = async () => { await saveTask(owner.email, item("l1", { editedBody: "تعديل وصل أثناء الطلب" })); };
    await signIn(admin.email);
    const r = await read(await publish("l1", { provider: "telegram", version: seen }));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("changed");
    expect(h.posts).toEqual([]);
    expect((await getTask(owner.email, "l1"))!.published).toBeUndefined();
  });

  it("a request without a version is refused for approve, approve-with-edit and publish; edits and rejections need none", async () => {
    const { owner } = await team("miss");
    await saveTask(owner.email, item("m1"));
    await signIn(owner.email);
    for (const body of [{ status: "approved" }, { status: "approved", editedBody: "نص" }, { status: "approved", version: 7 }]) {
      const r = await read(await patch("m1", body));
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("version_required");
    }
    const p = await read(await publish("m1", { provider: "telegram" }));
    expect(p.status).toBe(400);
    expect(p.body.error).toBe("version_required");
    expect(h.posts).toEqual([]);
    expect((await getTask(owner.email, "m1"))!.status).toBe("pending");
    expect((await patch("m1", { editedBody: "مسودة" })).status).toBe(200);
    expect((await patch("m1", { scheduledFor: "2026-10-10" })).status).toBe(200);
    expect((await patch("m1", { status: "rejected" })).status).toBe(200);
  });

  it("an approved item's text is rewritten only with the version of the text being replaced", async () => {
    const { owner } = await team("rew");
    await saveTask(owner.email, item("w1", { status: "approved", decidedAt: new Date().toISOString() }));
    const seen = taskVersion((await getTask(owner.email, "w1"))!);
    await saveTask(owner.email, item("w1", { status: "approved", decidedAt: new Date().toISOString(), title: "عنوان غيّره أحد" }));
    await signIn(owner.email);
    expect((await patch("w1", { editedBody: "نص المالك", version: seen })).status).toBe(409);
    const cur = (await getTask(owner.email, "w1"))!;
    expect((await patch("w1", { editedBody: "نص المالك", version: taskVersion(cur) })).status).toBe(200);
    expect((await getTask(owner.email, "w1"))!.editedBody).toBe("نص المالك");
  });
});

describe("a rejection reason is a short line in preferences.md (rules 565-567)", () => {
  const prefs = async (email: string) => (await db.get<{ content: string }>(`file:${email}:preferences.md`))?.content ?? "";

  it("a reason longer than 300 characters is cut to 300, on one line, without control characters", async () => {
    const { owner, member } = await team("note");
    await saveTask(owner.email, item("n1"));
    await signIn(member.email);
    const long = "سبب\n# عنوان جديد‮" + "ا".repeat(20000);
    expect((await patch("n1", { status: "rejected", note: long })).status).toBe(200);
    const file = await prefs(owner.email);
    const line = file.split("\n").find((l) => l.includes("Owner rejected a social item (telegram). Reason: "))!;
    const reason = line.split("Reason: ")[1];
    expect(reason.length).toBe(300);
    expect(reason.startsWith("سبب # عنوان جديد ا")).toBe(true);
    expect(file).not.toMatch(/\n# عنوان جديد/);
    expect(file).not.toContain("‮");
    expect(file.length).toBeLessThan(1000);
    const rec = (await listDecisions(owner.email)).find((d) => d.action === "reject")!;
    expect(String(rec.note ?? "").length).toBeLessThanOrEqual(300);
  });

  it("a reason that is not a string does not crash and is ignored", async () => {
    const { owner, member } = await team("obj");
    await saveTask(owner.email, item("j1"));
    await saveTask(owner.email, item("j2"));
    await signIn(member.email);
    expect((await patch("j1", { status: "rejected", note: { toString: "x", length: 99999 } })).status).toBe(200);
    expect((await patch("j2", { status: "rejected", note: ["a".repeat(5000)] })).status).toBe(200);
    expect((await getTask(owner.email, "j1"))!.status).toBe("rejected");
    expect(await prefs(owner.email)).not.toContain("Reason:");
  });

  it("two rejections at once both land in preferences.md", async () => {
    const { owner } = await team("two");
    await saveTask(owner.email, item("c1"));
    await saveTask(owner.email, item("c2"));
    await signIn(owner.email);
    await Promise.all([
      taskRoute.PATCH(json("/api/tasks/c1", "PATCH", { status: "rejected", note: "first reason" }), params({ id: "c1" })),
      taskRoute.PATCH(json("/api/tasks/c2", "PATCH", { status: "rejected", note: "second reason" }), params({ id: "c2" })),
    ]);
    await settle();
    const file = await prefs(owner.email);
    expect(file).toContain("Reason: first reason");
    expect(file).toContain("Reason: second reason");
  });
});
