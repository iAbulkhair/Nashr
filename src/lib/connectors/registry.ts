import { composioEnabled, composioReady } from "./composio";

/** Every platform Nashr can connect to. OAuth ones activate when their env keys exist. */
export type KeyField = { name: string; label: string; labelAr: string; type?: "text" | "password" | "url"; placeholder?: string };
export type Provider = {
  id: string;
  name: string;
  kind: "oauth" | "key";
  capabilities: ("publish_post" | "publish_article" | "products" | "orders" | "analytics" | "ads" | "messaging")[];
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    scopes: string[];
    clientIdEnv: string;
    clientSecretEnv: string;
    pkce?: boolean;
    scopeSeparator?: string;
    extraAuthParams?: Record<string, string>;
    /** Some providers want client creds in the body, others Basic auth. */
    tokenAuth?: "body" | "basic";
    /** Shopify/Salla-style per-store authorize URLs use {shop} placeholder filled from the connect form. */
    needsShop?: boolean;
  };
  keyFields?: KeyField[];
  docs?: string;
  /**
   * Reem's calendar providers (Reem B3): the owner links one calendar so she can read meetings. Never listed on
   * Integrations, never a publishing target, never reachable through the generic connector routes.
   */
  secretary?: true;
};

export const PROVIDERS: Provider[] = [
  // ---- no approval needed (key-based) ----
  {
    id: "wordpress", name: "WordPress (self-hosted)", kind: "key", capabilities: ["publish_article"],
    keyFields: [
      { name: "site", label: "Site URL", labelAr: "رابط الموقع", type: "url", placeholder: "https://example.com" },
      { name: "username", label: "Username", labelAr: "اسم المستخدم" },
      { name: "appPassword", label: "Application password", labelAr: "كلمة مرور التطبيق", type: "password", placeholder: "xxxx xxxx xxxx xxxx" },
    ],
    docs: "WordPress → Users → Profile → Application Passwords → Add new",
  },
  {
    id: "woocommerce", name: "WooCommerce", kind: "key", capabilities: ["products", "orders"],
    keyFields: [
      { name: "site", label: "Store URL", labelAr: "رابط المتجر", type: "url" },
      { name: "consumerKey", label: "Consumer key", labelAr: "Consumer key", type: "password" },
      { name: "consumerSecret", label: "Consumer secret", labelAr: "Consumer secret", type: "password" },
    ],
    docs: "WooCommerce → Settings → Advanced → REST API → Add key (Read)",
  },
  {
    id: "klaviyo", name: "Klaviyo", kind: "key", capabilities: ["messaging"],
    keyFields: [{ name: "apiKey", label: "Private API key", labelAr: "مفتاح API الخاص", type: "password", placeholder: "pk_…" }],
    docs: "Klaviyo → Settings → API keys → Create private key (templates:write)",
  },
  {
    id: "odoo", name: "Odoo", kind: "key", capabilities: ["products", "orders"],
    keyFields: [
      { name: "url", label: "Odoo URL", labelAr: "رابط Odoo", type: "url", placeholder: "https://mycompany.odoo.com" },
      { name: "db", label: "Database name", labelAr: "اسم قاعدة البيانات" },
      { name: "username", label: "Login email", labelAr: "بريد الدخول" },
      { name: "apiKey", label: "API key", labelAr: "مفتاح API", type: "password" },
    ],
    docs: "Odoo → Preferences → Account Security → New API Key",
  },
  {
    id: "prestashop", name: "PrestaShop", kind: "key", capabilities: ["products"],
    keyFields: [
      { name: "site", label: "Store URL", labelAr: "رابط المتجر", type: "url" },
      { name: "apiKey", label: "Webservice key", labelAr: "مفتاح Webservice", type: "password" },
    ],
    docs: "PrestaShop → Advanced Parameters → Webservice → enable + Add key (products: GET)",
  },
  {
    id: "telegram", name: "Telegram", kind: "key", capabilities: ["publish_post"],
    keyFields: [
      { name: "botToken", label: "Bot token", labelAr: "رمز البوت", type: "password", placeholder: "123456:ABC…" },
      { name: "chatId", label: "Channel @username or chat id", labelAr: "معرّف القناة @username", placeholder: "@mystore" },
    ],
    docs: "@BotFather → /newbot → copy token → add the bot as admin of your channel",
  },
  {
    id: "brevo", name: "Brevo", kind: "key", capabilities: ["messaging"],
    keyFields: [{ name: "apiKey", label: "API key", labelAr: "مفتاح API", type: "password", placeholder: "xkeysib-…" }],
    docs: "Brevo → SMTP & API → API Keys → Generate",
  },
  // ---- OAuth (activate when env keys exist) ----
  { id: "x", name: "X", kind: "oauth", capabilities: ["publish_post"], oauth: { authorizeUrl: "https://x.com/i/oauth2/authorize", tokenUrl: "https://api.x.com/2/oauth2/token", scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"], clientIdEnv: "X_CLIENT_ID", clientSecretEnv: "X_CLIENT_SECRET", pkce: true, tokenAuth: "basic" } },
  { id: "shopify", name: "Shopify", kind: "oauth", capabilities: ["products", "orders", "publish_article"], oauth: { authorizeUrl: "https://{shop}/admin/oauth/authorize", tokenUrl: "https://{shop}/admin/oauth/access_token", scopes: ["read_products", "read_orders", "write_content"], clientIdEnv: "SHOPIFY_CLIENT_ID", clientSecretEnv: "SHOPIFY_CLIENT_SECRET", scopeSeparator: ",", needsShop: true } },
  { id: "google", name: "Google (Business Profile, GA4, Search Console, YouTube)", kind: "oauth", capabilities: ["publish_post", "analytics"], oauth: { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", scopes: ["https://www.googleapis.com/auth/business.manage", "https://www.googleapis.com/auth/analytics.readonly", "https://www.googleapis.com/auth/webmasters.readonly", "openid", "email"], clientIdEnv: "GOOGLE_CLIENT_ID", clientSecretEnv: "GOOGLE_CLIENT_SECRET", extraAuthParams: { access_type: "offline", prompt: "consent" } } },
  // Reem's calendar (B3). Read-only scopes, one calendar per brand held in code (spec 2026-10-05-secretary-reem-b3-calendar-read-design.md §3).
  { id: "gcal", name: "Google Calendar (Reem)", kind: "oauth", capabilities: [], secretary: true, oauth: { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events.owned.readonly"], clientIdEnv: "GOOGLE_CLIENT_ID", clientSecretEnv: "GOOGLE_CLIENT_SECRET", extraAuthParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "false" } } },
  { id: "mscal", name: "Outlook Calendar (Reem)", kind: "oauth", capabilities: [], secretary: true, oauth: { authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token", scopes: ["openid", "email", "offline_access", "User.Read", "Calendars.ReadBasic"], clientIdEnv: "MICROSOFT_CLIENT_ID", clientSecretEnv: "MICROSOFT_CLIENT_SECRET", pkce: true, tokenAuth: "body" } },
  // Only the permissions a built feature uses: Meta's review rejects a submission that asks for more (#198 pack).
  { id: "meta", name: "Meta (Facebook Page, Instagram)", kind: "oauth", capabilities: ["publish_post"], oauth: { authorizeUrl: "https://www.facebook.com/v23.0/dialog/oauth", tokenUrl: "https://graph.facebook.com/v23.0/oauth/access_token", scopes: ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "instagram_basic", "instagram_content_publish", "business_management"], clientIdEnv: "META_APP_ID", clientSecretEnv: "META_APP_SECRET", scopeSeparator: "," } },
  // A separate connection from the Page one above: `ads_read` needs its own App Review, and asking for it in the
  // publishing flow would make every Page connection fail until Meta approves it. Same app credentials.
  { id: "meta_ads", name: "Meta Ads (results)", kind: "oauth", capabilities: ["ads"], oauth: { authorizeUrl: "https://www.facebook.com/v23.0/dialog/oauth", tokenUrl: "https://graph.facebook.com/v23.0/oauth/access_token", scopes: ["ads_read"], clientIdEnv: "META_APP_ID", clientSecretEnv: "META_APP_SECRET", scopeSeparator: "," } },
  { id: "salla", name: "Salla (سلة)", kind: "oauth", capabilities: ["products", "orders"], oauth: { authorizeUrl: "https://accounts.salla.sa/oauth2/auth", tokenUrl: "https://accounts.salla.sa/oauth2/token", scopes: ["offline_access"], clientIdEnv: "SALLA_CLIENT_ID", clientSecretEnv: "SALLA_CLIENT_SECRET" } },
  { id: "zid", name: "Zid (زد)", kind: "oauth", capabilities: ["products", "orders"], oauth: { authorizeUrl: "https://oauth.zid.sa/oauth/authorize", tokenUrl: "https://oauth.zid.sa/oauth/token", scopes: [], clientIdEnv: "ZID_CLIENT_ID", clientSecretEnv: "ZID_CLIENT_SECRET" } },
  { id: "linkedin", name: "LinkedIn", kind: "oauth", capabilities: ["publish_post"], oauth: { authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization", tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken", scopes: ["openid", "profile", "w_member_social"], clientIdEnv: "LINKEDIN_CLIENT_ID", clientSecretEnv: "LINKEDIN_CLIENT_SECRET" } },
  { id: "tiktok", name: "TikTok", kind: "oauth", capabilities: ["publish_post"], oauth: { authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/", tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/", scopes: ["user.info.basic", "video.publish", "video.upload"], clientIdEnv: "TIKTOK_CLIENT_KEY", clientSecretEnv: "TIKTOK_CLIENT_SECRET", scopeSeparator: "," } },
  { id: "snapchat", name: "Snapchat Ads", kind: "oauth", capabilities: ["ads"], oauth: { authorizeUrl: "https://accounts.snapchat.com/login/oauth2/authorize", tokenUrl: "https://accounts.snapchat.com/login/oauth2/access_token", scopes: ["snapchat-marketing-api"], clientIdEnv: "SNAP_CLIENT_ID", clientSecretEnv: "SNAP_CLIENT_SECRET" } },
  // Read only, and only through Composio (ads-via-composio.ts): no direct app, so no `oauth` block.
  { id: "google_ads", name: "Google Ads (results)", kind: "oauth", capabilities: ["ads"] },
  { id: "tiktok_ads", name: "TikTok Ads (results)", kind: "oauth", capabilities: ["ads"] },
  { id: "linkedin_ads", name: "LinkedIn Ads (results)", kind: "oauth", capabilities: ["ads"] },
  // Drafts only, and only through Composio: a template for Meta's review, a private upload.
  { id: "whatsapp", name: "WhatsApp Business (templates)", kind: "oauth", capabilities: ["messaging"] },
  { id: "youtube", name: "YouTube (private uploads)", kind: "oauth", capabilities: ["publish_post"] },
  { id: "google_workspace", name: "Google Docs and Sheets (reference files)", kind: "oauth", capabilities: [] },
  // The customer's cloud drives (rules 1775-1789): import brand files and media, export finished media. Composio only.
  { id: "google_drive", name: "Google Drive", kind: "oauth", capabilities: [] },
  { id: "dropbox", name: "Dropbox", kind: "oauth", capabilities: [] },
  { id: "onedrive", name: "OneDrive", kind: "oauth", capabilities: [] },
];

/** The two calendar providers Reem can read (flagged `secretary` in PROVIDERS). */
export const CAL_PROVIDERS = ["gcal", "mscal"] as const;
export type CalProvider = (typeof CAL_PROVIDERS)[number];

export function getProvider(id: string) {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}
/** Providers with no direct publishing code: they connect through Composio or not at all. */
const COMPOSIO_ONLY = ["linkedin", "tiktok", "google_ads", "tiktok_ads", "linkedin_ads", "google", "whatsapp", "youtube", "google_workspace", "google_drive", "dropbox", "onedrive"];

/** The provider connects through Composio (COMPOSIO_PROVIDERS names it and the key is set), not its own OAuth app. */
export const routedViaComposio = (id: string) => composioEnabled(id);

/** OAuth providers are "available" only when their app credentials, or their Composio auth configs, are configured. */
export function isAvailable(p: Provider) {
  if (p.kind === "key") return true;
  if (routedViaComposio(p.id)) return composioReady(p.id);
  if (COMPOSIO_ONLY.includes(p.id)) return false;
  return !!(process.env[p.oauth!.clientIdEnv] && process.env[p.oauth!.clientSecretEnv]);
}
