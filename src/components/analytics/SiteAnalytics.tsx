import type { AnalyticsConfig } from "@/lib/analytics";
import type { Lang } from "@/lib/i18n";
import AnalyticsLoader from "./AnalyticsLoader";
import ConsentBanner from "./ConsentBanner";

/**
 * The public site's analytics (rules 3330-3339), rendered by the site footer, so only on the public marketing pages, and
 * only when `analyticsConfig()` found a provider switched on: otherwise the footer renders nothing of it at all (no
 * banner, no script, no request). The provider's public id goes to the browser as a prop.
 *
 * The loader gives the script the page's nonce (rule 2326), read in the browser from the layout's nonced theme script, so
 * this stays a plain component the footer can render without awaiting the request headers. The provider's host in
 * script-src serves browsers older than `'strict-dynamic'`.
 */
export default function SiteAnalytics({ cfg, lang }: { cfg: AnalyticsConfig; lang: Lang }) {
  return (
    <>
      <AnalyticsLoader cfg={cfg} />
      {cfg.consent && <ConsentBanner cfg={cfg} lang={lang} />}
    </>
  );
}
