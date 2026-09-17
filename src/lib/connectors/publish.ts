import type { Task } from "../brand";
import { getConnection } from "./store";
import { publishWordPress } from "./wordpress";
import { postToX } from "./x";
import { publishShopifyArticle } from "./shopify";

export type PublishResult = { url: string; id: string; provider: string; status: "draft" | "published" };

/** Which providers can take which task. */
export function targetsFor(task: Task, connected: string[]): string[] {
  const out: string[] = [];
  if (task.type === "article") for (const p of ["wordpress", "shopify"]) if (connected.includes(p)) out.push(p);
  if (task.type === "social" && task.channel === "x" && connected.includes("x")) out.push("x");
  return out;
}

export async function publishTask(email: string, task: Task, provider: string): Promise<PublishResult> {
  const c = await getConnection(email, provider);
  if (!c) throw new Error("not_connected");
  const body = task.editedBody ?? task.body;
  const title = body.match(/^#\s+(.+)$/m)?.[1] ?? task.title;
  switch (provider) {
    case "wordpress": {
      const r = await publishWordPress(c, { title, body: body.replace(/^#\s+.+\n/, ""), status: "draft" });
      return { ...r, id: String(r.id), provider, status: "draft" };
    }
    case "shopify": {
      const r = await publishShopifyArticle(c, { title, body: body.replace(/^#\s+.+\n/, ""), published: false });
      return { ...r, provider, status: "draft" };
    }
    case "x": {
      const r = await postToX(c, body);
      return { ...r, provider, status: "published" };
    }
    default:
      throw new Error("unsupported_provider");
  }
}
