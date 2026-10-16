import { beforeAll, describe, expect, it } from "vitest";
import { json, newUser, params, settle, signIn, signOut } from "./helpers/session";
import { vjson } from "./helpers/version";
import { getBrand, getTask, saveBrand, saveTask, type Brand, type Task } from "@/lib/brand";
import { readFile, writeFile } from "@/lib/files";
import { createConversation, listConversations } from "@/lib/conversations";
import { history, push } from "@/lib/chat";
import type { User } from "@/lib/auth";
import { db } from "@/lib/db";
import { mk } from "@/lib/media/keys";
import type { MediaJob } from "@/lib/media/types";

import * as tasksRoute from "@/app/api/tasks/route";
import * as taskRoute from "@/app/api/tasks/[id]/route";
import * as imageRoute from "@/app/api/tasks/[id]/image/route";
import * as videoRoute from "@/app/api/tasks/[id]/video/route";
import * as mediaRoute from "@/app/api/media/[jobId]/route";
import * as pptxRoute from "@/app/api/tasks/[id]/pptx/route";
import * as publishRoute from "@/app/api/publish/[id]/route";
import * as filesRoute from "@/app/api/files/route";
import * as convRoute from "@/app/api/conversations/route";
import * as brandRoute from "@/app/api/brand/route";

const brand = (name: string): Brand => ({ name, website: "https://x.example", industry: "متجر إلكتروني", dialect: "saudi", languages: ["ar"], tone: "t", products: "p", audience: "a", offers: "", competitors: "", banned: "", preferred: "", channels: ["instagram"], city: "الرياض", updatedAt: new Date().toISOString() });
const task = (id: string): Task => ({ id, type: "social", channel: "instagram", title: "A's post", body: "secret body of A", status: "pending", createdAt: new Date().toISOString(), lang: "ar" });

let A: User, B: User, convId: string;
/** A's running render: B must not read it, and a poll by B must not move it. */
const JOB = "0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  A = await newUser("owner");
  B = await newUser("intruder");
  await saveBrand(A.email, brand("Brand of A"));
  await saveBrand(B.email, brand("Brand of B"));
  await saveTask(A.email, task("a1b2c3d4e5f60718"), true);
  await writeFile(A.email, "strategy.md", "A's private strategy");
  convId = (await createConversation(A.email, "A's thread")).id;
  await push(A.email, { role: "user", content: "A's private message", at: new Date().toISOString() }, convId);
  const at = new Date().toISOString();
  const job: MediaJob = { id: JOB, scope: A.email, email: A.email, accountSince: A.createdAt, lang: "ar", taskId: "a1b2c3d4e5f60718", kind: "video", model: "vid-quick", provider: "kie", credits: 12, prompt: "A's prompt", providerTaskId: "kietaskAbc123", state: "running", createdAt: at, updatedAt: at };
  await db.set(mk.job(A.email, JOB), job);
});

describe("tenant isolation at the route level (rule 1)", () => {
  it("another account's task id is a 404 on every id-taking route, and the task is untouched", async () => {
    await signIn(B.email);
    const id = "a1b2c3d4e5f60718";
    const calls = [
      taskRoute.PATCH(await vjson(`/api/tasks/${id}`, "PATCH", { status: "approved", editedBody: "hijacked" }), params({ id })),
      imageRoute.POST(json(`/api/tasks/${id}/image`, "POST"), params({ id })),
      videoRoute.POST(json(`/api/tasks/${id}/video`, "POST", { model: "vid-quick" }), params({ id })),
      pptxRoute.GET(json(`/api/tasks/${id}/pptx`, "GET"), params({ id })),
      publishRoute.POST(await vjson(`/api/publish/${id}`, "POST", { provider: "telegram" }), params({ id })),
      mediaRoute.GET(json(`/api/media/${JOB}`, "GET"), params({ jobId: JOB })),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(404);
    await settle();
    const t = await getTask(A.email, id);
    expect(t).toMatchObject({ status: "pending", body: "secret body of A" });
    expect(t!.editedBody).toBeUndefined();
    expect(await db.get<MediaJob>(mk.job(A.email, JOB)), "A's render is untouched").toMatchObject({ state: "running", prompt: "A's prompt" });
  });

  it("lists only show the caller's own records", async () => {
    await signIn(B.email);
    const tasks = (await (await tasksRoute.GET(json("/api/tasks", "GET"))).json()) as { tasks: Task[] };
    expect(tasks.tasks).toHaveLength(0);
    const count = (await (await tasksRoute.GET(json("/api/tasks?count=pending", "GET"))).json()) as { pending: number };
    expect(count.pending).toBe(0);
    const file = (await (await filesRoute.GET(json("/api/files?name=strategy.md", "GET"))).json()) as { file: unknown };
    expect(file.file).toBeNull();
    const files = (await (await filesRoute.GET(json("/api/files", "GET"))).json()) as { files: unknown[] };
    expect(files.files).toHaveLength(0);
    const convs = (await (await convRoute.GET(json("/api/conversations", "GET"))).json()) as { conversations: unknown[] };
    expect(convs.conversations).toHaveLength(0);
    const hits = (await (await convRoute.GET(json("/api/conversations?q=private", "GET"))).json()) as { hits: unknown[] };
    expect(hits.hits).toHaveLength(0);
    const br = (await (await brandRoute.GET(new Request("http://t/api/brand"))).json()) as { brand: Brand };
    expect(br.brand.name).toBe("Brand of B");
  });

  it("writes with another account's ids land in the caller's workspace or nowhere", async () => {
    await signIn(B.email);
    await convRoute.PATCH(json("/api/conversations", "PATCH", { id: convId, title: "renamed by B" }));
    await convRoute.DELETE(json(`/api/conversations?id=${convId}`, "DELETE"));
    await filesRoute.DELETE(json("/api/files?name=strategy.md", "DELETE"));
    // A scope or email in the body is ignored: the record is written under the caller.
    await filesRoute.PUT(json("/api/files", "PUT", { name: "strategy.md", content: "B's text", scope: A.email, email: A.email }));
    expect((await listConversations(A.email))[0].title).toBe("A's thread");
    expect(await history(A.email, convId)).toHaveLength(1);
    expect((await readFile(A.email, "strategy.md"))!.content).toBe("A's private strategy");
    expect((await readFile(B.email, "strategy.md"))!.content).toBe("B's text");
    expect((await getBrand(A.email))!.name).toBe("Brand of A");
  });

  it("every workspace route answers 401 without a session", async () => {
    signOut();
    const id = "a1b2c3d4e5f60718";
    const res = await Promise.all([
      tasksRoute.GET(json("/api/tasks", "GET")),
      taskRoute.PATCH(await vjson(`/api/tasks/${id}`, "PATCH", { status: "approved" }), params({ id })),
      imageRoute.POST(json(`/api/tasks/${id}/image`, "POST"), params({ id })),
      videoRoute.POST(json(`/api/tasks/${id}/video`, "POST", { model: "vid-quick" }), params({ id })),
      pptxRoute.GET(json(`/api/tasks/${id}/pptx`, "GET"), params({ id })),
      publishRoute.POST(await vjson(`/api/publish/${id}`, "POST", { provider: "telegram" }), params({ id })),
      mediaRoute.GET(json(`/api/media/${JOB}`, "GET"), params({ jobId: JOB })),
      filesRoute.GET(json("/api/files", "GET")),
      filesRoute.PUT(json("/api/files", "PUT", { name: "x.md", content: "x" })),
      filesRoute.DELETE(json("/api/files?name=x.md", "DELETE")),
      convRoute.GET(json("/api/conversations", "GET")),
      convRoute.POST(json("/api/conversations", "POST", {})),
      brandRoute.GET(new Request("http://t/api/brand")),
    ]);
    expect(res.map((r) => r.status)).toEqual(res.map(() => 401));
  });

  it("the owner still reaches their own task (the 404s above are not a blanket refusal)", async () => {
    await signIn(A.email);
    const id = "a1b2c3d4e5f60718";
    const res = await taskRoute.PATCH(await vjson(`/api/tasks/${id}`, "PATCH", { status: "approved" }), params({ id }));
    expect(res.status).toBe(200);
    await settle();
    expect((await getTask(A.email, id))!.status).toBe("approved");
  });
});
