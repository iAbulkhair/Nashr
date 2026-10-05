/**
 * What Thakeen may call through Composio, per toolkit: the exact tool slugs and, for each, the argument names the code
 * may send. Nothing outside these lists is ever executed (docs/superpowers/specs/2026-10-05-meta-via-composio-design.md,
 * section 3). Slugs and argument names were read from Composio's tool schemas on 2026-10-05; the measured run on the
 * founder's own accounts confirms them (plan Task 8). No imports: the registry and tests read it freely.
 *
 * Not here on purpose: ad writes (money moves need their own spec, evaluation spec C-R1), comments and messages (untrusted
 * input with no feature to use it), Google Business Profile (Composio lists no toolkit for it), Calendly and Cal.com
 * (Reem B2 receives their webhooks directly, evaluation spec C-R4).
 */
export type Toolkit = "facebook" | "instagram" | "twitter" | "linkedin" | "tiktok";

type Tools = Readonly<Record<string, readonly string[]>>;
export type ToolkitEntry = Readonly<{ provider: string; authEnv: string; read: Tools; write: Tools }>;

export const TOOLKITS: Readonly<Record<Toolkit, ToolkitEntry>> = {
  facebook: {
    provider: "meta",
    authEnv: "COMPOSIO_AUTH_FACEBOOK",
    // `fields` is always sent: the tool's default includes each Page's access_token, which Thakeen must never receive.
    read: { FACEBOOK_LIST_MANAGED_PAGES: ["fields", "limit"] },
    write: { FACEBOOK_CREATE_POST: ["page_id", "message", "published"], FACEBOOK_CREATE_PHOTO_POST: ["page_id", "url", "message", "published"] },
  },
  instagram: {
    provider: "meta",
    authEnv: "COMPOSIO_AUTH_INSTAGRAM",
    read: { INSTAGRAM_GET_USER_INFO: ["fields"], INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT: ["ig_user_id", "fields"] },
    write: { INSTAGRAM_POST_IG_USER_MEDIA: ["ig_user_id", "image_url", "caption"], INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH: ["ig_user_id", "creation_id", "max_wait_seconds"] },
  },
  twitter: {
    provider: "x",
    authEnv: "COMPOSIO_AUTH_TWITTER",
    read: { TWITTER_USER_LOOKUP_ME: [] },
    write: { TWITTER_CREATION_OF_A_POST: ["text"] },
  },
  linkedin: {
    provider: "linkedin",
    authEnv: "COMPOSIO_AUTH_LINKEDIN",
    read: { LINKEDIN_GET_MY_INFO: [] },
    write: { LINKEDIN_CREATE_LINKED_IN_POST: ["author", "commentary", "visibility", "lifecycleState"] },
  },
  tiktok: {
    provider: "tiktok",
    // TikTok has no managed app on Composio: this auth config carries Thakeen's own TikTok app (plan Task 8).
    authEnv: "COMPOSIO_AUTH_TIKTOK",
    read: {},
    write: { TIKTOK_POST_PHOTO: ["photo_images", "photo_cover_index", "post_mode", "title", "description"] },
  },
};

/** Which toolkits each provider connects through, in the order the Integrations card offers them. */
export const PROVIDER_TOOLKITS: Readonly<Record<string, readonly Toolkit[]>> = {
  meta: ["instagram", "facebook"],
  x: ["twitter"],
  linkedin: ["linkedin"],
  tiktok: ["tiktok"],
};

export const isToolkit = (s: string): s is Toolkit => Object.prototype.hasOwnProperty.call(TOOLKITS, s);
