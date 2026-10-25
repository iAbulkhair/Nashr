import { CLAUDE_PAUSED } from "./model";
import { PROVIDER_TOOLKITS, TOOLKITS } from "./connectors/composio-catalog";
import { PROVIDERS, isDirectApp } from "./connectors/registry";

/**
 * The founder console's Integrations page (rules 1540-1549, docs/system/flows.md section 69): every outside service the
 * product talks to, and whether it is set up. On or off is decided ONLY by whether each environment variable NAME is
 * present in the process (`present`): a value is never read out, compared, measured or sent, not even its length or a
 * prefix, so the answer would be the same for any value. The names are the ones docs/system/variables.md lists, pinned
 * by tests/margin-integrations.test.ts against that file, the connector registry and the Composio catalog.
 *
 * `gate` names what the CODE switches off on top of the variables: a constant in the source (`CLAUDE_PAUSED`), or a
 * further variable that must also be present (`PAYMOB_LIVE`, `MEDIA_MODELS_ON`, `LLM_PROVIDER`, `COMPOSIO_PROVIDERS`). Like
 * the rest, those are presence checks: a set `LLM_PROVIDER` reads "set", not which provider it names.
 */

/** A group of names: `all` must every one be present; `any` is a list of alternatives, one complete alternative is enough. */
export type Need = { all: readonly string[] } | { any: readonly (readonly string[])[] };
export type IntegrationDef = {
  id: string;
  name: { ar: string; en: string };
  /** What it does for the product, one line. */
  what: { ar: string; en: string };
  need: Need;
  /** Names that add to it but are not needed for it to work. */
  optional?: readonly string[];
  /** Callback paths outside the connector registry that the platform app must list (rule 2165). */
  callbacks?: readonly string[];
  /** Webhook paths the platform app must be given, each a route of ours (rule 2172). */
  webhooks?: readonly string[];
};

const all = (...n: string[]): Need => ({ all: n });

export const INTEGRATIONS: readonly IntegrationDef[] = [
  { id: "anthropic", name: { ar: "Anthropic (النماذج)", en: "Anthropic (models)" }, what: { ar: "كل استدعاءات النماذج: الدردشة والتوليد والتقييم", en: "Every model call: chat, generation, judging" }, need: all("ANTHROPIC_API_KEY") },
  { id: "straitly", name: { ar: "Straitly (بوابة النماذج)", en: "Straitly (model gateway)" }, what: { ar: "توجيه الاستدعاءات عبر البوابة بدل Anthropic مباشرة", en: "Routes model calls through the gateway instead of Anthropic directly" }, need: all("STRAITLY_API_KEY"), optional: ["LLM_PROVIDER", "STRAITLY_BASE_URL"] },
  { id: "upstash", name: { ar: "Upstash Redis (قاعدة البيانات)", en: "Upstash Redis (store)" }, what: { ar: "كل البيانات المحفوظة", en: "Every stored record" }, need: { any: [["KV_REST_API_URL", "KV_REST_API_TOKEN"], ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]] } },
  { id: "qstash", name: { ar: "Upstash QStash (تذكيرات ريم)", en: "Upstash QStash (Reem's tick)" }, what: { ar: "نبضة التذكيرات كل 15 دقيقة", en: "The reminder tick every 15 minutes" }, need: { any: [["QSTASH_CURRENT_SIGNING_KEY"], ["QSTASH_NEXT_SIGNING_KEY"]] } },
  { id: "cron", name: { ar: "المهام المجدولة (Cron)", en: "Scheduled jobs (cron)" }, what: { ar: "التجديد والملخصات والخطط الأسبوعية وتنبيه الهامش", en: "Renewals, briefs, weekly plans, the margin alert" }, need: all("CRON_SECRET") },
  { id: "resend", name: { ar: "Resend (البريد)", en: "Resend (email)" }, what: { ar: "رموز التحقق وروابط الاستعادة والدعوات والرسائل", en: "Verification codes, reset links, invites, notices" }, need: all("RESEND_API_KEY", "MAIL_FROM"), optional: ["WAITLIST_TO"] },
  { id: "paymob", name: { ar: "Paymob (الدفع بالبطاقة)", en: "Paymob (card payments)" }, what: { ar: "الدفع والتجديد بالبطاقة", en: "Card checkout and renewals" }, need: all("PAYMOB_SECRET_KEY", "PAYMOB_PUBLIC_KEY", "PAYMOB_HMAC_SECRET", "PAYMOB_INTEGRATION_ID_CARD"), optional: ["PAYMOB_INTEGRATION_ID_MOTO", "PAYMOB_LIVE"] },
  { id: "geidea", name: { ar: "Geidea (الدفع بالبطاقة)", en: "Geidea (card payments)" }, what: { ar: "الدفع والتجديد بالبطاقة، ويُقدَّم على Paymob إن ضُبط الاثنان", en: "Card checkout and renewals; chosen over Paymob when both are set" }, need: all("GEIDEA_PUBLIC_KEY", "GEIDEA_API_PASSWORD"), optional: ["GEIDEA_MIT", "GEIDEA_LIVE"] },
  { id: "paylinks", name: { ar: "روابط الدفع الخارجية", en: "External payment links" }, what: { ar: "زر الدفع في صفحة الفوترة حين لا يعمل Paymob", en: "The billing page's pay button while Paymob is off" }, need: { any: [["PAY_LINK_STARTER"], ["PAY_LINK_PRO"], ["PAY_LINK_BUSINESS"]] }, optional: ["PAY_LINK_STARTER", "PAY_LINK_PRO", "PAY_LINK_BUSINESS"] },
  { id: "composio", name: { ar: "Composio (النشر والتقارير)", en: "Composio (publishing, results)" }, what: { ar: "ربط لينكدإن وتيك توك وإعلانات المنصات عبر Composio", en: "LinkedIn, TikTok and ad platforms through Composio" }, need: all("COMPOSIO_API_KEY", "COMPOSIO_PROVIDERS"), optional: ["COMPOSIO_AUTH_FACEBOOK", "COMPOSIO_AUTH_INSTAGRAM", "COMPOSIO_AUTH_TWITTER", "COMPOSIO_AUTH_LINKEDIN", "COMPOSIO_AUTH_TIKTOK", "COMPOSIO_AUTH_WHATSAPP", "COMPOSIO_AUTH_YOUTUBE", "COMPOSIO_AUTH_METAADS", "COMPOSIO_AUTH_SNAPCHAT", "COMPOSIO_AUTH_GOOGLEADS", "COMPOSIO_AUTH_TIKTOK_ADS", "COMPOSIO_AUTH_LINKEDIN_ADS", "COMPOSIO_AUTH_GOOGLE_ANALYTICS", "COMPOSIO_AUTH_GOOGLE_SEARCH_CONSOLE", "COMPOSIO_AUTH_POSTHOG", "COMPOSIO_AUTH_GOOGLEDOCS", "COMPOSIO_AUTH_GOOGLESHEETS", "COMPOSIO_AUTH_GOOGLEDRIVE", "COMPOSIO_AUTH_DROPBOX", "COMPOSIO_AUTH_ONEDRIVE"] },
  { id: "fal", name: { ar: "fal.ai (الصورة السريعة)", en: "fal.ai (fast image)" }, what: { ar: "نموذج الصورة الافتراضي", en: "The default image model" }, need: all("FAL_KEY") },
  { id: "kie", name: { ar: "kie.ai (صور ومقاطع)", en: "kie.ai (images, video)" }, what: { ar: "نماذج الصور والمقاطع الأعلى", en: "The higher image and video models" }, need: all("KIE_API_KEY", "MEDIA_DIR"), optional: ["KIE_WEBHOOK_HMAC_KEY"] },
  { id: "higgsfield", name: { ar: "Higgsfield (صور ومقاطع)", en: "Higgsfield (images, video)" }, what: { ar: "نماذج نمط الحياة والتصميم والمقاطع السينمائية", en: "Lifestyle, design and cinematic video models" }, need: all("HIGGSFIELD_API_KEY_ID", "HIGGSFIELD_API_KEY_SECRET", "MEDIA_DIR") },
  { id: "store", name: { ar: "تخزين الوسائط (قرص Hostinger)", en: "Media storage (Hostinger disk)" }, what: { ar: "نسختنا الخاصة من كل صورة ومقطع", en: "Our private copy of every image and clip" }, need: all("MEDIA_DIR") },
  { id: "turnstile", name: { ar: "Cloudflare Turnstile (التحقق البشري)", en: "Cloudflare Turnstile (CAPTCHA)" }, what: { ar: "التسجيل واستعادة كلمة المرور", en: "Sign-up and password reset" }, need: all("TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY") },
  { id: "google_signin", name: { ar: "الدخول بحساب Google", en: "Sign in with Google" }, what: { ar: "زر الدخول والتسجيل بحساب Google", en: "The sign-in and sign-up button with a Google account" }, need: all("GOOGLE_SIGNIN_CLIENT_ID", "GOOGLE_SIGNIN_CLIENT_SECRET"), callbacks: ["/api/auth/google/callback"] },
  { id: "gcal", name: { ar: "Google (تقويم ريم)", en: "Google (Reem's calendar)" }, what: { ar: "تقويم Google لريم، وتجديد ربط الموقع القديم المباشر. ملف النشاط والتحليلات عبر Composio", en: "Reem's Google Calendar, and renewing an older direct site connection. Business Profile and analytics go through Composio" }, need: all("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET") },
  { id: "mscal", name: { ar: "Microsoft (تقويم Outlook)", en: "Microsoft (Outlook calendar)" }, what: { ar: "تقويم Outlook لريم", en: "Reem's Outlook calendar" }, need: all("MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET") },
  { id: "meta", name: { ar: "Meta (فيسبوك وإنستقرام)", en: "Meta (Facebook, Instagram)" }, what: { ar: "النشر المباشر ونتائج الإعلانات", en: "Direct publishing and ads results" }, need: all("META_APP_ID", "META_APP_SECRET"), optional: ["META_CONFIG_ID"] },
  { id: "x", name: { ar: "X", en: "X" }, what: { ar: "النشر المباشر", en: "Direct publishing" }, need: all("X_CLIENT_ID", "X_CLIENT_SECRET") },
  { id: "linkedin", name: { ar: "لينكدإن", en: "LinkedIn" }, what: { ar: "النشر عبر Composio فقط، بلا تطبيق لينكدإن خاص بنا", en: "Publishing through Composio only, no LinkedIn app of ours" }, need: all("COMPOSIO_AUTH_LINKEDIN") },
  { id: "tiktok", name: { ar: "تيك توك", en: "TikTok" }, what: { ar: "مسودات عبر Composio فقط، بلا تطبيق تيك توك خاص بنا", en: "Drafts through Composio only, no TikTok app of ours" }, need: all("COMPOSIO_AUTH_TIKTOK") },
  { id: "snapchat", name: { ar: "سناب شات (إعلانات)", en: "Snapchat Ads" }, what: { ar: "نتائج الإعلانات", en: "Ads results" }, need: all("SNAP_CLIENT_ID", "SNAP_CLIENT_SECRET") },
  { id: "shopify", name: { ar: "Shopify", en: "Shopify" }, what: { ar: "المنتجات والطلبات والمقالات", en: "Products, orders, articles" }, need: all("SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"), webhooks: ["/api/shopify/compliance"] },
  { id: "salla", name: { ar: "سلة", en: "Salla" }, what: { ar: "المنتجات والطلبات", en: "Products and orders" }, need: all("SALLA_CLIENT_ID", "SALLA_CLIENT_SECRET") },
  { id: "zid", name: { ar: "زد", en: "Zid" }, what: { ar: "المنتجات والطلبات", en: "Products and orders" }, need: all("ZID_CLIENT_ID", "ZID_CLIENT_SECRET") },
  { id: "whatsapp", name: { ar: "واتساب الدعم", en: "Support WhatsApp" }, what: { ar: "رقم الدعم في التطبيق والفوترة والرسائل", en: "The support number in the app, billing and emails" }, need: all("SUPPORT_WHATSAPP") },
  { id: "access", name: { ar: "دخول المؤسس والتشفير", en: "Founder access and encryption" }, what: { ar: "حسابات المؤسس ومفتاح اللوحة ومفتاح تشفير الربط", en: "Founder accounts, console key, connector encryption key" }, need: all("ADMIN_EMAILS", "CONNECT_SECRET"), optional: ["WAITLIST_ADMIN_KEY", "CONNECT_SECRET_PREVIOUS"] },
  { id: "origin", name: { ar: "عنوان الموقع", en: "Site origin" }, what: { ar: "الروابط في الرسائل وعناوين الرجوع للربط", en: "Links in emails and connector return addresses" }, need: all("APP_ORIGIN"), optional: ["TRUSTED_PROXY_HOPS", "APP_ENV"] },
];

/** A code-level switch on top of the variables. `off: true` means the code keeps the service off right now. */
export type Gate = { id: string; off: boolean; label: { ar: string; en: string } };
export type IntegrationStatus = "on" | "partial" | "off";
export type IntegrationView = { id: string; name: { ar: string; en: string }; what: { ar: string; en: string }; status: IntegrationStatus; names: { name: string; set: boolean; required: boolean }[]; gates: Gate[]; callbacks: string[]; webhooks: string[] };

/** Presence only: the variable exists and is not empty. The value itself is never returned, logged or compared. */
export const present = (env: Readonly<Record<string, string | undefined>>, name: string): boolean => typeof env[name] === "string" && env[name] !== "";

const requiredNames = (n: Need): string[] => ("all" in n ? [...n.all] : [...new Set(n.any.flat())]);

/** Pure: on when the need is met, partial when some required name is set but not all, off when none is. */
export function statusOf(n: Need, has: (name: string) => boolean): IntegrationStatus {
  if ("all" in n) {
    const k = n.all.filter(has).length;
    return k === n.all.length ? "on" : k > 0 ? "partial" : "off";
  }
  if (n.any.some((alt) => alt.every(has))) return "on";
  return n.any.some((alt) => alt.some(has)) ? "partial" : "off";
}

/** Pure: the code switches for one integration, from presence and the source constants only. */
export function gatesOf(id: string, has: (name: string) => boolean, claudePaused: boolean = CLAUDE_PAUSED): Gate[] {
  switch (id) {
    case "anthropic":
      return [{ id: "claude_paused", off: claudePaused, label: { ar: "CLAUDE_PAUSED في الكود: كل استدعاءات النماذج متوقفة", en: "CLAUDE_PAUSED in code: every model call is refused" } }];
    case "straitly":
      return [{ id: "llm_provider", off: !has("LLM_PROVIDER"), label: { ar: "يعمل فقط حين يُضبط LLM_PROVIDER على straitly", en: "Used only while LLM_PROVIDER is set to straitly" } }];
    case "paymob":
      return [{ id: "paymob_live", off: !has("PAYMOB_LIVE"), label: { ar: "مفاتيح الإنتاج تُرفض بلا PAYMOB_LIVE (مفاتيح الاختبار فقط)", en: "Live keys are refused without PAYMOB_LIVE (test keys only)" } }];
    case "geidea":
      return [
        { id: "geidea_live", off: !has("GEIDEA_LIVE"), label: { ar: "بلا GEIDEA_LIVE يُقبل طلب الاختبار فقط، ولا يُقبل GEIDEA_LIVE إلا على النشر الحي", en: "Without GEIDEA_LIVE only test orders are accepted; GEIDEA_LIVE is honoured on the production deploy only" } },
        { id: "geidea_mit", off: !has("GEIDEA_MIT"), label: { ar: "التجديد التلقائي بالبطاقة المحفوظة يحتاج GEIDEA_MIT بعد أن تفعّله Geidea", en: "Saved-card renewals need GEIDEA_MIT, once Geidea enables merchant-initiated charges" } },
      ];
    case "kie":
    case "higgsfield":
      return [{ id: "media_models_on", off: !has("MEDIA_MODELS_ON"), label: { ar: "لا يُعرض نموذج منها حتى يُذكر في MEDIA_MODELS_ON", en: "No model of it is offered until listed in MEDIA_MODELS_ON" } }];
    case "composio":
      return [composioGate(has), ...halfSetComposio(has)];
    case "linkedin":
    case "tiktok":
      return [composioGate(has)];
    default:
      return [];
  }
}

/** The Composio switch: no provider goes through Composio until both names are present. */
const composioGate = (has: (name: string) => boolean): Gate => ({ id: "composio_providers", off: !(has("COMPOSIO_API_KEY") && has("COMPOSIO_PROVIDERS")), label: { ar: "لا يمر مزوّد عبر Composio حتى يُضبط COMPOSIO_API_KEY و COMPOSIO_PROVIDERS", en: "No provider goes through Composio until COMPOSIO_API_KEY and COMPOSIO_PROVIDERS are set" } });

/**
 * Rule 2165: a Composio provider with two toolkits (Meta, Google, Google Docs and Sheets) whose auth config names are
 * set for one toolkit and not the other. Its Connect button stays hidden (`composioReady` wants every toolkit), and the
 * page said nothing. Presence only, like every other check here: which providers COMPOSIO_PROVIDERS lists is not read.
 */
export function halfSetComposio(has: (name: string) => boolean): Gate[] {
  return Object.entries(PROVIDER_TOOLKITS).flatMap(([provider, toolkits]) => {
    const names = toolkits.map((t) => TOOLKITS[t].authEnv);
    const missing = names.filter((n) => !has(n));
    if (missing.length === 0 || missing.length === names.length) return [];
    const set = names.filter(has).join(", ");
    return [{ id: `composio_half_${provider}`, off: true, label: { ar: `${provider}: ضُبط ${set} وينقص ${missing.join(", ")}، فيبقى زر الربط مخفيًا`, en: `${provider}: ${set} is set but ${missing.join(", ")} is missing, so its Connect button stays hidden` } }];
  });
}

/**
 * Rule 2165: the callback paths each row's platform app must list, from the registry (by client id name) and the row.
 * Rule 2175: only providers an app of ours connects (`isDirectApp`); the Google connector shares GOOGLE_CLIENT_ID with
 * Reem's calendar but connects through Composio, so its callback is never listed.
 */
const callbacksOf = (d: IntegrationDef, req: readonly string[]): string[] => [
  ...PROVIDERS.filter((p) => isDirectApp(p) && req.includes(p.oauth!.clientIdEnv)).map((p) => `/api/connect/${p.id}/callback`),
  ...(d.callbacks ?? []),
];

/** Every integration's state from `env` (the process environment by default). Names and booleans only. */
export function integrationsView(env: Readonly<Record<string, string | undefined>> = process.env, claudePaused: boolean = CLAUDE_PAUSED): IntegrationView[] {
  const has = (name: string) => present(env, name);
  return INTEGRATIONS.map((d) => {
    const req = requiredNames(d.need);
    const opt = (d.optional ?? []).filter((n) => !req.includes(n));
    return {
      id: d.id, name: d.name, what: d.what,
      status: statusOf(d.need, has),
      names: [...req.map((name) => ({ name, set: has(name), required: true })), ...opt.map((name) => ({ name, set: has(name), required: false }))],
      gates: gatesOf(d.id, has, claudePaused),
      callbacks: callbacksOf(d, req),
      webhooks: [...(d.webhooks ?? [])],
    };
  });
}

/** Every name the page knows, for the docs test. */
export const integrationNames = (): string[] => [...new Set(INTEGRATIONS.flatMap((d) => [...requiredNames(d.need), ...(d.optional ?? [])]))];
