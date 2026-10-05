import type { Task } from "../brand";
import { getFreshConnection, refusedToken } from "./fresh";
import { publishWordPress } from "./wordpress";
import { postToX } from "./x";
import { publishShopifyArticle } from "./shopify";
import { postTelegram } from "./keyed";
import { postToFacebook, postToInstagram } from "./meta";
import { CONNECTION_OF } from "./targets";
import { hasArtwork } from "../media-catalog";

/** `notes`: things the owner should know about a publish that went out (WordPress: `image_failed`, the draft has no featured image). */
export type PublishResult = { url: string; id: string; provider: string; status: "draft" | "published"; notes?: string[] };

/**
 * `again`: the owner confirmed a second publish to this platform; WordPress then updates the post it made before.
 * `live`: the owner confirmed this one item for the live site (WordPress only); otherwise WordPress gets a draft.
 * Both are set from the owner's own click on the publish route, never by the chat or MCP paths.
 */
export type PublishOptions = { again?: boolean; live?: boolean };

export { targetsFor, connectedTargets } from "./targets";

export async function publishTask(email: string, task: Task, provider: string, opts: PublishOptions = {}): Promise<PublishResult> {
  try {
    return await publishWith(email, task, provider, opts);
  } catch (e) {
    throw await refusedToken(email, CONNECTION_OF[provider] ?? provider, e);
  }
}

async function publishWith(email: string, task: Task, provider: string, opts: PublishOptions): Promise<PublishResult> {
  const c = await getFreshConnection(email, CONNECTION_OF[provider] ?? provider);
  if (!c) throw new Error("not_connected");
  const body = task.editedBody ?? task.body;
  const title = body.match(/^#\s+(.+)$/m)?.[1] ?? task.title;
  switch (provider) {
    case "wordpress": {
      // The post this item went to before, from the item's own record (never from a request): updated in place on "publish again".
      const before = opts.again ? [...(task.published ?? [])].reverse().find((p) => p.provider === "wordpress" && p.id) : undefined;
      const r = await publishWordPress(c, { title, body: body.replace(/^#\s+.+\n/, ""), status: opts.live ? "publish" : "draft", imageUrl: hasArtwork(task) ? task.imageUrl : undefined, updateId: before?.id });
      return { ...r, id: String(r.id), provider };
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
