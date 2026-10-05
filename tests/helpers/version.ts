import { json } from "./session";
import { currentUser, sc } from "@/lib/auth";
import { getTask } from "@/lib/brand";
import { taskVersion } from "@/lib/task-version";

/**
 * A PATCH /api/tasks/[id] or POST /api/publish/[id] body as the inbox sends it: with the version of the item as the
 * signed-in person sees it now (src/lib/task-version.ts). A body that names `version` itself (even as undefined) is kept
 * as it is, for the tests of a stale or missing version.
 */
export async function withVersion(id: string, body: unknown): Promise<unknown> {
  if (!body || typeof body !== "object" || "version" in body) return body;
  const u = await currentUser();
  const t = u ? await getTask(sc(u), id) : null;
  return t ? { ...body, version: taskVersion(t) } : body;
}

/**
 * `json(url, method, body)` from ./session with the version added as `withVersion` adds it, the item's id read from the
 * URL (`/api/tasks/{id}` or `/api/publish/{id}`). For the existing route tests, which approve and publish as the inbox does.
 */
export async function vjson(url: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  const id = decodeURIComponent(/^\/api\/(?:tasks|publish)\/([^/?]+)/.exec(url)?.[1] ?? "");
  return json(url, method, id ? await withVersion(id, body) : body, headers);
}
