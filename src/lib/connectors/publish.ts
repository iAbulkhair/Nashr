import type { Task } from "../brand";
import { getFreshConnection, refusedToken } from "./fresh";
import { publishWordPress } from "./wordpress";
import { postToX } from "./x";
import { publishShopifyArticle } from "./shopify";
import { draftBrevoCampaign, draftKlaviyoTemplate, postTelegram } from "./keyed";
import { postToFacebook, postToInstagram } from "./meta";
import { isComposio, postToFacebookVia, postToInstagramVia, postToLinkedInVia, postToTikTokVia, postToXVia, submitWhatsAppTemplateVia, uploadToYouTubeVia } from "./via-composio";
import { CONNECTION_OF } from "./targets";
import { hasArtwork, isOurMediaUrl } from "../media-catalog";
import { shareUrl } from "../media/share";
import { render } from "../md";

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

/**
 * The post title and the body without it, for blog drafts (WordPress, Shopify): the first H1 is the title wherever it
 * sits, and that same line is taken out of the body, so a draft whose H1 follows an intro line no longer repeats its title
 * (rule 1482, issue #144). No H1: the item's own title and the body as it is.
 */
export function splitTitle(body: string, fallback: string): { title: string; rest: string } {
  const h1 = /^#[ \t]+(.+)$\n?/m;
  const m = h1.exec(body);
  return m ? { title: m[1].trim(), rest: body.slice(0, m.index) + body.slice(m.index + m[0].length) } : { title: fallback, rest: body };
}

async function publishWith(email: string, task: Task, provider: string, opts: PublishOptions): Promise<PublishResult> {
  const c = await getFreshConnection(email, CONNECTION_OF[provider] ?? provider);
  if (!c) throw new Error("not_connected");
  const body = task.editedBody ?? task.body;
  const { title, rest } = splitTitle(body, task.title);
  // Rule 1755: the image leaves as a short signed link, minted now for this one publish; the task keeps the plain URL.
  const art = hasArtwork(task) ? shareUrl(task.imageUrl!) : undefined;
  switch (provider) {
    case "wordpress": {
      // The post this item went to before, from the item's own record (never from a request): updated in place on "publish again".
      const before = opts.again ? [...(task.published ?? [])].reverse().find((p) => p.provider === "wordpress" && p.id) : undefined;
      const r = await publishWordPress(c, { title, body: rest, status: opts.live ? "publish" : "draft", imageUrl: art, updateId: before?.id });
      return { ...r, id: String(r.id), provider };
    }
    case "shopify": {
      const r = await publishShopifyArticle(c, { title, body: rest, published: false });
      return { ...r, provider, status: "draft" };
    }
    case "telegram": {
      const r = await postTelegram(c, body);
      return { ...r, provider, status: "published" };
    }
    case "x": {
      const r = isComposio(c) ? await postToXVia(email, c, body) : await postToX(c, body);
      return { ...r, provider, status: "published" };
    }
    case "facebook": {
      const r = isComposio(c) ? await postToFacebookVia(email, c, body, art) : await postToFacebook(c, body, art);
      return { ...r, provider, status: "published" };
    }
    case "instagram": {
      // targetsFor already requires a generated image; checked again here because this is the call that posts.
      if (!art) throw new Error("instagram_needs_image");
      const r = isComposio(c) ? await postToInstagramVia(email, c, body, art) : await postToInstagram(c, body, art);
      return { ...r, provider, status: "published" };
    }
    // LinkedIn and TikTok publish only through Composio: Thakeen has no direct publishing code for them.
    case "linkedin": {
      if (!isComposio(c)) throw new Error("unsupported_provider");
      const r = await postToLinkedInVia(email, c, body);
      return { ...r, provider, status: "published" };
    }
    case "tiktok": {
      if (!isComposio(c)) throw new Error("unsupported_provider");
      if (!art) throw new Error("tiktok_needs_image");
      // The image lands in the owner's TikTok inbox; they finish the post in the app.
      const r = await postToTikTokVia(email, c, body, art);
      return { ...r, provider, status: "draft" };
    }
    // Drafts only from here: nothing reaches a customer or the public until the owner acts in that platform.
    case "whatsapp": {
      // A template submitted to Meta's review; nobody is messaged.
      if (!isComposio(c)) throw new Error("unsupported_provider");
      const r = await submitWhatsAppTemplateVia(email, c, task.id, body, task.lang);
      return { ...r, provider, status: "draft" };
    }
    case "youtube": {
      // A private upload; the owner makes it public in YouTube Studio.
      if (!isComposio(c)) throw new Error("unsupported_provider");
      // Staged by composioStageFile, which signs it (rule 1755).
      if (!isOurMediaUrl(task.videoUrl)) throw new Error("youtube_needs_video");
      const r = await uploadToYouTubeVia(email, c, task.title, body, task.videoUrl!);
      return { ...r, provider, status: "draft" };
    }
    case "brevo": {
      const r = await draftBrevoCampaign(c, { name: `Thakeen: ${task.title}`, subject: task.title, html: render(body) });
      return { ...r, provider, status: "draft" };
    }
    case "klaviyo": {
      const r = await draftKlaviyoTemplate(c, { name: `Thakeen: ${task.title}`, html: render(body) });
      return { ...r, provider, status: "draft" };
    }
    default:
      throw new Error("unsupported_provider");
  }
}
