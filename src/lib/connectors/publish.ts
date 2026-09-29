import type { Task } from "../brand";
import { getFreshConnection, refusedToken } from "./fresh";
import { publishWordPress } from "./wordpress";
import { postToX } from "./x";
import { publishShopifyArticle } from "./shopify";
import { postTelegram } from "./keyed";
import { postToFacebook, postToInstagram } from "./meta";
import { CONNECTION_OF } from "./targets";
import { hasArtwork } from "../media-catalog";

export type PublishResult = { url: string; id: string; provider: string; status: "draft" | "published" };

export { targetsFor, connectedTargets } from "./targets";

export async function publishTask(email: string, task: Task, provider: string): Promise<PublishResult> {
  try {
    return await publishWith(email, task, provider);
  } catch (e) {
    throw await refusedToken(email, CONNECTION_OF[provider] ?? provider, e);
  }
}

async function publishWith(email: string, task: Task, provider: string): Promise<PublishResult> {
  const c = await getFreshConnection(email, CONNECTION_OF[provider] ?? provider);
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
    case "telegram": {
      const r = await postTelegram(c, body);
      return { ...r, provider, status: "published" };
    }
    case "x": {
      const r = await postToX(c, body);
      return { ...r, provider, status: "published" };
    }
    case "facebook": {
      const r = await postToFacebook(c, body, hasArtwork(task) ? task.imageUrl : undefined);
      return { ...r, provider, status: "published" };
    }
    case "instagram": {
      // targetsFor already requires a generated image; checked again here because this is the call that posts.
      if (!hasArtwork(task)) throw new Error("instagram_needs_image");
      const r = await postToInstagram(c, body, task.imageUrl!);
      return { ...r, provider, status: "published" };
    }
    default:
      throw new Error("unsupported_provider");
  }
}
