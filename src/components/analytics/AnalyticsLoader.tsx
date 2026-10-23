"use client";
import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { GA_CONFIG, analyticsAllowed, pageAddress, pageViewRequest, scriptTag, type AnalyticsConfig } from "@/lib/analytics";
import { analyticsIdLine, readAnalyticsId } from "@/lib/cookie-consent";
import { useConsent } from "./use-consent";

type GtagWindow = { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void; [k: `ga-disable-${string}`]: boolean };
const gw = (): GtagWindow => window as unknown as GtagWindow;

/**
 * This page's CSP nonce (rule 2326), read from the layout's nonced theme script: the browser hides the attribute but keeps
 * the `nonce` property. Only called in the browser, after the consent cookie was read, so `document` is there.
 */
const pageNonce = (): string | undefined => document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce || undefined;

/** A random UUID: the site is served over https (and localhost), where every current browser has `randomUUID`. */
const randomId = (): string => crypto.randomUUID();

/** The anonymous id for Mixpanel and PostHog: read, or made and kept once the visitor has said yes (rule 3334). */
function anonId(): string {
  const have = readAnalyticsId(document.cookie);
  if (have) return have;
  const id = randomId();
  document.cookie = analyticsIdLine(id, location.protocol === "https:");
  return id;
}

/** Google's queue, set up once per page before `gtag.js` arrives; it reads the queue when it loads. */
function gtag(id: string): (...args: unknown[]) => void {
  const w = gw();
  if (!w.gtag) {
    w.dataLayer = w.dataLayer || [];
    // gtag.js reads `arguments` objects from the queue, not arrays: this is Google's own stub.
    w.gtag = function () {
      // eslint-disable-next-line prefer-rest-params
      w.dataLayer!.push(arguments);
    };
    w.gtag("js", new Date());
    w.gtag("config", id, { ...GA_CONFIG, page_location: pageAddress(location.origin, location.pathname) });
  }
  return w.gtag;
}

/**
 * Loads the active provider and reports page views (rules 3332-3334). Asks `analyticsAllowed` before anything: a provider
 * that needs a yes renders no script and sends nothing until the consent cookie says "yes"; Plausible and Umami, which
 * keep no identifier, load at once and report page views themselves (Umami told to leave out the query string). One
 * page view per page: Google through its queue, Mixpanel and PostHog with one request each, no other event.
 */
export default function AnalyticsLoader({ cfg }: { cfg: AnalyticsConfig }) {
  const choice = useConsent();
  const pathname = usePathname();
  const allowed = choice !== undefined && analyticsAllowed(cfg, choice ?? null);

  useEffect(() => {
    if (!allowed || !pathname) return;
    if (cfg.provider === "google") {
      gw()[`ga-disable-${cfg.id}`] = false;
      gtag(cfg.id)("event", "page_view", { page_location: pageAddress(location.origin, pathname), page_title: document.title });
      return;
    }
    const req = pageViewRequest(cfg, { origin: location.origin, pathname, title: document.title, anonId: anonId(), now: Date.now(), eventId: randomId() });
    if (req) void fetch(req.url, { method: "POST", keepalive: true, credentials: "omit", headers: { "Content-Type": req.contentType }, body: req.body }).catch(() => {});
  }, [allowed, cfg, pathname]);

  const tag = choice === undefined ? null : scriptTag(cfg, choice);
  return tag ? <Script id="analytics" src={tag.src} strategy="afterInteractive" nonce={pageNonce()} {...tag.attrs} /> : null;
}
