# Coverage: public site analytics, cookie consent, dev picture hosts, riyal formatting, the app drawing (rules 3330-3352)

Status on 2026-10-23, branch `claude/sup-marketing-analytics` (not pushed). Ideas from the Supastarter marketing app (analytics providers, consent banner, hero dashboard, placeholder image hosts), rebuilt for Thakeen with no new dependency and without the template's figures. Release step: none. The two new cookies (`thakeen_consent`, `thakeen_aid`) live only in the visitor's browser; no stored shape changes and no route reads them. Every analytics env name unset (the default) leaves the site exactly as before. Rules 3353-3359 are free.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 3330 | One server-side switch, `ANALYTICS_PROVIDER` (google, mixpanel, posthog, plausible, umami). Unset, unknown, or an id missing or of the wrong shape means none: no banner, no script, no request | `tests/marketing-analytics.test.ts` | none |
| 3331 | Analytics renders only from the site footer, which only the public marketing pages render (never `/app` or the console) | `tests/marketing-analytics.test.ts` | none |
| 3332 | Google, Mixpanel and PostHog render no script and send nothing until the consent cookie says yes. The server render never holds the script; the loader waits for the browser to read the cookie, and the script carries the page nonce (rule 2326) | `tests/marketing-analytics.test.ts` | an end-to-end check that no third-party request leaves before the click |
| 3333 | Plausible and Umami are cookieless: no banner, no settings link, and the script loads without consent | `tests/marketing-analytics.test.ts` | none |
| 3334 | Page views only. The address sent is origin plus path, never the query or the fragment, and no email, name or account. Mixpanel `ip=0`; PostHog `$process_person_profile:false`; Google signals and ad personalisation off; Mixpanel and PostHog run no third-party script; the anonymous id is a random UUID set only after yes | `tests/marketing-analytics.test.ts` | none |
| 3335 | The banner is in Arabic and English and renders nothing until the browser knows the answer (no flash, no server render) | `tests/marketing-analytics.test.ts` (copy, server snapshot) | a client render test |
| 3336 | The banner shows only while a consent provider is on and the visitor has not answered | `tests/marketing-analytics.test.ts` | none |
| 3337 | The footer has a "Cookie settings" button that reopens the banner, only for a consent provider | `tests/marketing-analytics.test.ts` | none |
| 3338 | Accept and Reject carry the same button class; nothing is pre-ticked; plain copy with no legal claim | `tests/marketing-analytics.test.ts` | none |
| 3339 | The answer lives in a first-party cookie (path /, Lax, Secure on https, 180 days, no domain). A no clears the anonymous id and Google's cookies and turns Google off. No route or server module reads the cookie | `tests/marketing-analytics.test.ts` | none |
| 3340 | The page policy adds only the active provider's script and connect hosts. Hosts that are not plain https origins are dropped. Nothing is added when none is set | `tests/marketing-analytics.test.ts` | none |
| 3341 | The proxy adds them only on marketing paths (`marketingPath`), never on `/{lang}/app…` or the console | `tests/marketing-analytics.test.ts` | none |
| 3342 | `UMAMI_SCRIPT_HOST` takes a self-hosted Umami's https origin only. Anything else turns Umami off. Unset means Umami Cloud | `tests/marketing-analytics.test.ts` | none |
| 3343 | The env names are in `docs/system/variables.md` section 3a and `.env.example`, none is `NEXT_PUBLIC_`, and `ANALYTICS_REGION=eu` picks the EU hosts | `tests/marketing-analytics.test.ts`, `tests/mail-logs-tooling.test.ts` (rule 1977) | none |
| 3344 | placehold.co and picsum.photos are in `images.remotePatterns` only when `NODE_ENV` is not production. A production `next.config` has no image hosts | `tests/marketing-analytics.test.ts` | none |
| 3345 | The page policy names neither placeholder host in any mode (the CSP is unchanged) | `tests/marketing-analytics.test.ts` | none |
| 3346 | `formatSar`: Arabic `299 ر.س`, English `SAR 299`, Latin digits with commas, two decimals at most. `planPriceLabel` reads `PLAN_PRICE_SAR` | `tests/marketing-analytics.test.ts` | none |
| 3347 | No currency that is not charged (USD, EUR, AED, $, €, دولار, درهم) on the home page plans or from the formatter | `tests/marketing-analytics.test.ts` | a scan of every public page render |
| 3348 | The app drawing sits in its own section, placed by `APP_SCREEN_SPOT` (after the gallery by default, after the cover, or off), never inside the cover | `tests/marketing-analytics.test.ts` | none |
| 3349 | `roleMeets` (display only) mirrors `MIN_ROLE` for every action | `tests/marketing-analytics.test.ts` | none |
| 3350 | The drawing and role cards hold no digit, money, percentage, client count, revenue or result word, and no picture, in text or labels, in both languages | `tests/marketing-analytics.test.ts` | none |
| 3351 | Role avatars are drawn SVG shapes in an agent colour, never photographs | `tests/marketing-analytics.test.ts` | none |
| 3352 | The Owner, Admin and Member cards tick each row from `MIN_ROLE`: owner all, admin all but billing and roles, member asks for content and edits drafts | `tests/marketing-analytics.test.ts` | none |
