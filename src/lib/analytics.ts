/**
 * The public site's one analytics switch (rules 3330-3343). Import-free on purpose: the proxy reads it to widen the page
 * policy for the active provider only (tests/staging.test.ts holds the proxy's imports closed), and the footer, the
 * consent banner and the loader read it on the server and hand the browser a plain object.
 *
 * One provider at a time, chosen on the server by `ANALYTICS_PROVIDER`; anything else, or a provider whose public id is
 * missing or malformed, is "none": no banner, no script, no request, no policy change. The ids are public by design (each
 * one is in every visitor's page), never secrets, and never compiled in: no `NEXT_PUBLIC_` name, so a value changes on
 * the next start, and docs/system/variables.md section 3a lists the names.
 *
 * Page views only, on the public marketing pages only (the pages with the site footer, never `/app` or the console). No
 * provider gets an email, a name, an account id or the query string: the address sent is the origin and the path.
 * - Google Analytics, Mixpanel and PostHog set or need an identifier, so they wait for the visitor's yes on the consent
 *   banner (src/lib/cookie-consent.ts). Google loads `gtag.js` with Google signals and ad personalisation off; Mixpanel
 *   and PostHog run no script at all: the page posts one page-view event to the provider's own ingestion address, with an
 *   anonymous random id kept in a first-party cookie only after the yes (Mixpanel's `ip=0` drops the address for location).
 * - Plausible and Umami are cookieless: they keep no identifier in the browser, so their script loads with no banner.
 */

export type AnalyticsProvider = "google" | "mixpanel" | "posthog" | "plausible" | "umami";
export const ANALYTICS_PROVIDERS: readonly AnalyticsProvider[] = ["google", "mixpanel", "posthog", "plausible", "umami"];

/** The env names this module reads. Names only: docs/system/variables.md section 3a. */
export const ANALYTICS_ENV = {
  provider: "ANALYTICS_PROVIDER",
  region: "ANALYTICS_REGION",
  google: "GA_MEASUREMENT_ID",
  mixpanel: "MIXPANEL_PROJECT_TOKEN",
  posthog: "POSTHOG_PROJECT_KEY",
  plausible: "PLAUSIBLE_DOMAIN",
  umami: "UMAMI_WEBSITE_ID",
  umamiHost: "UMAMI_SCRIPT_HOST",
} as const;

/** What the browser gets: the provider, its public id, where its script or events go, and whether it needs a yes first. */
export type AnalyticsConfig = {
  provider: AnalyticsProvider;
  /** The provider's public id: GA measurement id, Mixpanel token, PostHog project key, Plausible domain, Umami website id. */
  id: string;
  /** The one script the page loads, or null (Mixpanel and PostHog run no script). */
  script: string | null;
  /** Where page views are posted by the page itself (Mixpanel and PostHog), else null. */
  endpoint: string | null;
  /** True for Google, Mixpanel and PostHog: nothing loads and nothing is sent before the visitor accepts. */
  consent: boolean;
  /** Hosts the page policy must allow for this provider: script-src and connect-src. Origins only. */
  csp: { script: string[]; connect: string[] };
};

type Env = Record<string, string | undefined>;

const GA_ID = /^G-[A-Z0-9]{4,20}$/;
const MIXPANEL_TOKEN = /^[a-f0-9]{32}$/;
const POSTHOG_KEY = /^phc_[A-Za-z0-9]{20,64}$/;
// A bare host name (example.com, www.example.sa): letters, digits, dots and hyphens, at least one dot, no scheme or path.
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Umami Cloud, when `UMAMI_SCRIPT_HOST` is not set. Its tracker posts to the gateway host. */
export const UMAMI_CLOUD = "https://cloud.umami.is";
const UMAMI_CLOUD_API = "https://api-gateway.umami.dev";

/**
 * A self-hosted Umami's origin: https only, no user, port allowed, nothing after the host but "/". Returns the origin
 * (which can hold no space or `;`, so it can never add a directive to the policy), or null.
 */
export function httpsOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" || u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

const pick = (env: Env, name: string) => (env[name] ?? "").trim();

/**
 * The active provider's settings from the environment, or null when analytics is off. Fails closed: an unknown provider
 * name, a missing id or an id of the wrong shape is off, never a half-configured script.
 */
export function analyticsConfig(env: Env = process.env): AnalyticsConfig | null {
  const provider = pick(env, ANALYTICS_ENV.provider).toLowerCase();
  const eu = pick(env, ANALYTICS_ENV.region).toLowerCase() === "eu";
  switch (provider) {
    case "google": {
      const id = pick(env, ANALYTICS_ENV.google);
      if (!GA_ID.test(id)) return null;
      return {
        provider, id, consent: true, endpoint: null,
        script: `https://www.googletagmanager.com/gtag/js?id=${id}`,
        csp: {
          script: ["https://www.googletagmanager.com"],
          connect: ["https://*.google-analytics.com", "https://*.analytics.google.com", "https://www.googletagmanager.com"],
        },
      };
    }
    case "mixpanel": {
      const id = pick(env, ANALYTICS_ENV.mixpanel);
      if (!MIXPANEL_TOKEN.test(id)) return null;
      const host = eu ? "https://api-eu.mixpanel.com" : "https://api-js.mixpanel.com";
      return { provider, id, consent: true, script: null, endpoint: `${host}/track/?ip=0`, csp: { script: [], connect: [host] } };
    }
    case "posthog": {
      const id = pick(env, ANALYTICS_ENV.posthog);
      if (!POSTHOG_KEY.test(id)) return null;
      const host = eu ? "https://eu.i.posthog.com" : "https://us.i.posthog.com";
      return { provider, id, consent: true, script: null, endpoint: `${host}/i/v0/e/`, csp: { script: [], connect: [host] } };
    }
    case "plausible": {
      const id = pick(env, ANALYTICS_ENV.plausible).toLowerCase();
      if (!DOMAIN.test(id)) return null;
      return { provider, id, consent: false, endpoint: null, script: "https://plausible.io/js/script.js", csp: { script: ["https://plausible.io"], connect: ["https://plausible.io"] } };
    }
    case "umami": {
      const id = pick(env, ANALYTICS_ENV.umami).toLowerCase();
      if (!UUID.test(id)) return null;
      const set = pick(env, ANALYTICS_ENV.umamiHost);
      const host = set ? httpsOrigin(set) : UMAMI_CLOUD;
      if (!host) return null;
      const connect = host === UMAMI_CLOUD ? [host, UMAMI_CLOUD_API] : [host];
      return { provider, id, consent: false, endpoint: null, script: `${host}/script.js`, csp: { script: [host], connect } };
    }
    default:
      return null;
  }
}

/** The hosts to add to the page policy for this config: nothing when analytics is off. */
export const analyticsCsp = (cfg: AnalyticsConfig | null): { script: string[]; connect: string[] } => cfg?.csp ?? { script: [], connect: [] };

/**
 * May the provider run now? Cookieless providers always (while switched on); the others only after "yes". The single gate
 * the loader asks before it renders a script or sends an event (rule 3332).
 */
export const analyticsAllowed = (cfg: AnalyticsConfig | null, choice: "yes" | "no" | null): boolean => !!cfg && (!cfg.consent || choice === "yes");

/**
 * The one script tag the page may load now, or null (rule 3332): nothing for a provider that needs a yes until "yes",
 * nothing for Mixpanel and PostHog ever, Plausible and Umami at once. Umami is told to leave the query string and the
 * fragment out of what it reports; Plausible records the path only.
 */
export function scriptTag(cfg: AnalyticsConfig | null, choice: "yes" | "no" | null): { src: string; attrs: Record<string, string> } | null {
  if (!cfg?.script || !analyticsAllowed(cfg, choice)) return null;
  if (cfg.provider === "plausible") return { src: cfg.script, attrs: { "data-domain": cfg.id } };
  if (cfg.provider === "umami") return { src: cfg.script, attrs: { "data-website-id": cfg.id, "data-exclude-search": "true", "data-exclude-hash": "true" } };
  return { src: cfg.script, attrs: {} };
}

/** Show the banner? Only for a provider that needs a yes, and only until the visitor has answered (rule 3336). */
export const bannerNeeded = (cfg: AnalyticsConfig | null, choice: "yes" | "no" | null): boolean => !!cfg && cfg.consent && choice === null;

/** The address a page view reports: origin and path, never the query string or the fragment (rule 3334). */
export const pageAddress = (origin: string, pathname: string): string => `${origin}${pathname.split(/[?#]/)[0] || "/"}`;

/** What one page view knows: the page, its title, the anonymous random id, the time and a random event id. Nothing else. */
export type PageView = { origin: string; pathname: string; title: string; anonId: string; now: number; eventId: string };

/**
 * The one request a Mixpanel or PostHog page view sends (rule 3334), or null for the providers whose own script reports
 * page views. The body names the page, its title and an anonymous random id; never an email, a name, an account id, a
 * query string or a fragment. Mixpanel's `ip=0` (in the endpoint) tells it not to read a location from the address, and
 * PostHog's `$process_person_profile: false` keeps the event off any person profile.
 */
export function pageViewRequest(cfg: AnalyticsConfig, v: PageView): { url: string; contentType: string; body: string } | null {
  const url = pageAddress(v.origin, v.pathname);
  const path = url.slice(v.origin.length);
  const title = v.title.slice(0, 200);
  if (cfg.provider === "mixpanel" && cfg.endpoint) {
    const event = { event: "$mp_web_page_view", properties: { token: cfg.id, distinct_id: v.anonId, time: Math.floor(v.now / 1000), $insert_id: v.eventId, $current_url: url, current_url_path: path, current_page_title: title } };
    return { url: cfg.endpoint, contentType: "application/x-www-form-urlencoded", body: `data=${encodeURIComponent(JSON.stringify([event]))}` };
  }
  if (cfg.provider === "posthog" && cfg.endpoint) {
    const event = { api_key: cfg.id, event: "$pageview", distinct_id: v.anonId, timestamp: new Date(v.now).toISOString(), uuid: v.eventId, properties: { $current_url: url, $pathname: path, title, $process_person_profile: false } };
    return { url: cfg.endpoint, contentType: "application/json", body: JSON.stringify(event) };
  }
  return null;
}

/**
 * Google's settings for `gtag("config", id, …)` (rule 3334): no automatic page view (the loader sends one per page with
 * the address above), Google signals and ad personalisation off, and `anonymize_ip` for any older property that still
 * reads it (GA4 keeps no IP address).
 */
export const GA_CONFIG = { send_page_view: false, anonymize_ip: true, allow_google_signals: false, allow_ad_personalization_signals: false } as const;
