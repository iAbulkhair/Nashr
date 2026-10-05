# Store connectors: Salla, Zid, WooCommerce, WordPress

Status: draft for the founder's review, 2026-10-05. Built in Thakeen's own code, not through a connection platform: no platform listed by Unified, Nango or Composio covers Salla and Zid (Unified lists both as beta with partial objects), and the code for them already exists (`src/lib/connectors/salla.ts`, `zid.ts`, `woocommerce.ts`, `wordpress.ts`). The social, ads and calendar evaluation is a separate spec (`2026-10-05-composio-evaluation-design.md`) and shares no files with this one.

## 1. Goal and what the founder decided

Close the gaps between what the four connectors do today and what a store owner expects, in this order of value, without any write to a customer's store that the owner has not approved.

Decided by the founder on 2026-10-05:

- Salla, Zid, WooCommerce and WordPress stay on **direct code**; no connection platform is used for them.
- This work lives on its own branch, apart from the Composio experiment.
- **Revenue counts paid orders only.** An order awaiting payment is an order, not revenue.
- **Sync twice a day is the target, if it costs nothing.** No model call and no credits are involved; the only cost is the scheduler (Phase B).
- **Salla `publish_article` stays.** The owner is told in the product that Salla articles are drafts and cannot be published from Thakeen, because of Salla's policies (Phase D).
- **WordPress may publish live one day**, with its own owner confirmation, never by default (Phase C).
- **Salla and Zid partner apps are not approved yet.** Neither store can connect in production until they are; this is the founder's track, not code.

Not in this spec: product or price writes to any store (needs its own spec with per-change approval and a rollback record), WordPress.com hosted sites (they use OAuth, not application passwords; the registry says "self-hosted"), abandoned carts for WooCommerce (core WooCommerce has no abandoned-cart API; plugins differ), Salla or Zid customer, shipping or accounting objects, Shopify, PrestaShop, Odoo.

## 2. What exists today (read from the code, 2026-10-05)

| | Connect | Imports products | Sales snapshot (`store-sales.md`) | Publishes |
|---|---|---|---|---|
| Salla | OAuth, scope `offline_access` | yes | yes: orders last 30 days (10 pages) and abandoned carts (3 pages) | no. The registry lists `publish_article` but `publishWith` has no Salla case |
| Zid | OAuth, three headers (token, manager token, store id) | yes | yes: orders (5 pages) and abandoned carts (3 pages), 403 handling | no |
| WooCommerce | key and secret | yes | **no** (`SALES_PROVIDERS` is `salla`, `shopify`, `zid`) | no |
| WordPress | application password | no | no | drafts by default; live only on a per-item confirmation (Phase C) |

Whether the Salla and Zid partner apps are approved and their client ids set in production is not visible in code (`isAvailable` needs `SALLA_CLIENT_ID/SECRET` and `ZID_CLIENT_ID/SECRET`). That is a founder-side check, listed in section 8.

## 3. Phase A: WooCommerce sales snapshot (the first build)

The same `SalesSnapshot` the other stores produce (`src/lib/connectors/sales.ts`), read from the store's REST API, so the Reports page, the generation memory and the agents see WooCommerce stores the way they see Salla, Zid and Shopify.

- **Source:** `GET {site}/wp-json/wc/v3/orders` with the connection's key and secret, over `safeFetch` (the host is user-supplied). Page size 100, at most 5 pages, `after` a day before the window start and each row re-checked on `date_created_gmt` (the way Zid's rule works, because a date filter's zone and meaning are the store's). The request asks only for the fields it reads with `_fields=id,status,total,currency,date_created_gmt,date_paid_gmt,line_items,refunds`, so a customer's name, email, phone and address are never in the response (privacy at the request, not only in the reducer).
- **Which orders count (built, founder's rule: only paid orders are revenue):** `cancelled`, `refunded`, `failed`, `trash` and checkout drafts are counted as canceled and are in no total. `pending`, `on-hold` (WooCommerce's "awaiting payment confirmation") and any order whose `date_paid_gmt` is present and empty are counted in the order count and in a new `orders.pending` number, and left out of revenue; `processing` and `completed` with a paid stamp count in both. A store that sends no paid stamp is read by status. A partly refunded order counts its total minus its refunds (refund totals are negative strings); a fully refunded one is canceled. Money is read with `amountOf` under the order's own `currency`, never a default; an unreadable total adds to `unread`, never to revenue. The count is never taken from `X-WP-Total` (it may cover more than the window): `X-WP-TotalPages` only stops the paging early, and `orders.capped` is set when the five-page cap is reached with more pages left.
- **Known limit, cash on delivery:** WooCommerce has no field that says cash was collected. It stamps `date_paid_gmt` when an order enters a paid status, and a cash-on-delivery order normally enters `processing` at checkout, so such an order may count as paid before the cash arrives. The rule is therefore "paid as WooCommerce itself reports it". A store that wants the stricter reading (completed only) is a later option, decided after a real cash-on-delivery store shows what its orders carry.
- **Carts:** `carts.unavailable = true` always (core WooCommerce has no abandoned-cart data). The snapshot and Dana's STORE DATA then show carts as unknown, not zero, which is the existing meaning of `unavailable`.
- **Errors (as built):** WooCommerce answers 401 for a wrong key and also for a key without read access to orders, so the two cannot be told apart: one error, `woo_access_denied`, which asks for a new Read key and a new connection. A key connection is not marked `needsReconnect` (that mechanism is for OAuth tokens). A body that is not a list, including a page of HTML, fails the sync as `woo unexpected_orders`.
- **Route and lists:** `POST /api/connect/woocommerce {action:"sync_sales"}` with the same gates as the other three (any login, `read`). `SALES_PROVIDERS`, `PROVIDER_NAME` and `READS_METRICS` gain `woocommerce` (done in Phase A); `tests/connectors-working.test.ts` keeps them equal to the code paths. One store per workspace stays: the card shows the store last synced while it stays connected.
- **Key permission:** the connection form today asks for a key used for products. Orders need read access to orders; the form text says "Read" is enough and that "Read/Write" is not needed. The key stays encrypted with `CONNECT_SECRET` as now.
- **Cost:** no model call, no credits.

## 4. Phase B: keep every store fresh without a button (built 2026-10-05)

A scheduled sync for the connected store, twice a day, not webhooks. Founder decision 2026-10-05: twice a day if the hosting cost allows it.

- **Hosting:** no extra cost. `vercel.json` gets two entries on one path, `/api/cron/stores` at `0 2 * * *` and `0 14 * * *` (05:00 and 17:00 Riyadh, so the 06:00 routines read a fresh snapshot). Each entry runs once a day, which is the limit of the most restricted plan, and Vercel documents several schedules for one path. The route is the cron path of `daily` and `evening`: bearer secret, `runCronBatch` markers per workspace and half-day (`{date}-am` or `-pm`), six at a time, resumable. Ads keep their own once-a-day read in `cron/daily`; a second ad read a day was not asked for.
- **Which store:** the store of the workspace's own snapshot while it is still connected, or its only connected store when it never synced. Several connected stores and no snapshot is the owner's choice (the button), never a guess; a connection marked for reconnect is skipped, not retried.
- **Not repeated:** a snapshot younger than 10 hours is left alone, so a manual sync is not read again an hour later and both daily runs still sync.
- **A failed read keeps the last good snapshot and its own date** (the card already shows "as of {date}"). It also writes a note, `storesyncfail:{scope}` (`{at, provider, error}`, status or known code only, 14 days), shown under the card until a sync succeeds. A 5xx or a network error is retried once by the batch; a key without access or a 4xx is not.
- No model call and no credits. Rules 623-627.
- **Why not webhooks now:** each store's webhooks need a public route (signature check with `sameSecret`, rate limit, body cap, replay marker) and, for WooCommerce, a key with write permission to register one, which is a scope escalation for a daily report. If the founder later wants near-real-time numbers, the safe shape is a **doorbell**: the webhook only triggers a debounced re-sync (`SET NX EX 300` per account and provider) and never writes the numbers in its body; its token is a random 43-character value per connection, stored hashed, and an unknown or malformed token is a 404 with an empty body. Specified then, not built now.

## 5. Phase C: WordPress publishing (built 2026-10-05)

A post is a draft by default: the owner reads it in WordPress and publishes there. Built, in this order:

1. **Featured image.** When the item has artwork (`hasArtwork`), it is copied to `POST /wp-json/wp/v2/media` and set as `featured_media`. The image URL goes through `safeFetch` (https only; png, jpeg, webp or gif; at most 8 MB). A failed copy still creates the draft and the answer carries `notes: ["image_failed"]`, which the inbox shows. Not built: a `verifyWordPress` check of the `upload_files` capability (a missing capability shows as `image_failed` instead).
2. **Update in place.** On the owner's "publish again", the connector updates the post id kept on the item's own WordPress record (`published[].id`, WordPress only) with `POST /wp-json/wp/v2/posts/{id}`; the id is digits only and never comes from a request. `publishOnce` keeps its lock and its "result unknown" marker. The update sends a status only when the owner also confirmed live, so a post the owner already published stays published; it does not touch the image; a 404 (post deleted) makes a new draft. **It replaces the title and body with Thakeen's text, so edits made in WordPress are lost**; the inbox says so in the confirmation.
3. **Excerpt and slug: dropped.** The item has no excerpt or slug field, and inventing them is against the rule of using the item's own fields only.
4. **Live publish, one item at a time (founder decision 2026-10-05).** A second button, "Publish live on WordPress", opens its own inline confirmation; only then does the body carry `live: true`. Checked in code: the route accepts it for `wordpress` only (400 `live_unsupported` otherwise), the site user must hold `publish_posts` (502 `wordpress_cannot_publish_live` before anything is sent), the `publish` role applies first, and the chat and MCP tool never pass `live` or `again`. The status in the record is what WordPress answers.

Not added: categories and tags (would need the owner's choice per post), scheduled posts, comments, any read of posts. Not tested against a real site: capabilities on a multisite or a role plugin, and the media upload on a host that limits upload size below 8 MB (the failure shows as `image_failed`).

## 6. Phase D: Salla and Zid

- **Salla `publish_article` (founder's decision: keep it, and say what it is):** the capability stays in the registry. Task 0 still reads Salla's current Merchant API for a blog or articles endpoint that can hold a draft and adds a draft-only publish like Shopify's if one exists. Whatever Task 0 finds, the product tells the owner plainly, on the Salla card and where a Salla article is offered, that an article sent to Salla is a draft and cannot be published from Thakeen because of Salla's policies, so they publish it in Salla themselves. The claim about Salla's policy is the founder's; Task 0 checks it against Salla's documentation and the wording is adjusted to what is true.
- **Zid:** no publishing; nothing added this round beyond the scheduled sync of Phase B.
- **Both:** the partner-app approvals and redirect URLs are checked by the founder (section 8); the code paths already handle 401 (reconnect) and 403 (permission message).

## 7. Rules (the same ones the existing connectors keep)

1. **Tenant isolation:** every read of a connection, snapshot or task uses `sc(u)`; no key is built from a request value.
2. **Authenticate first** on every route (`currentUser()`, the cron bearer secret for the scheduled sync); the sync action stays `read`, any change to a store's data would be admin+.
3. **User-supplied hosts only through `safeFetch`** (WooCommerce and WordPress sites); the plan also checks that a key-based connection to a non-https host is refused, since a store key sent over plain http is readable on the network; if it is not refused today, it is refused here.
4. **Only counts, money and product names** leave a store connector; the request itself asks for no personal field (section 3).
5. **No write to a store without the owner's approval in code.** WordPress drafts go through `publishOnce`, the `publish` role and the approval check; no phase writes products, prices or stock.
6. **Store data is untrusted input:** product names, titles and line items are rendered through `render` where shown and `csvSafe` in exports, and enter prompts only inside the existing data tags.
7. **Secrets** (keys, tokens) stay encrypted at rest, never in a URL, response or log; error text is cut to a status and a short code.
8. **Redis is HTTP per command:** the sync reads pages in order (a page decides the next) but writes the snapshot with one command; the scheduled sync uses `pmap`.

## 8. Founder-side checks (not code)

- **Answered 2026-10-05: not yet.** The Salla and Zid partner apps are not approved and their keys are not set in production, so neither store can connect in production until they are. The steps (apply in each partner portal, set the redirect URLs from `REDIRECT` in `src/lib/connectors/oauth.ts`, add `SALLA_CLIENT_ID/SECRET` and `ZID_CLIENT_ID/SECRET` to the hosting environment, and record them in `docs/system/variables.md`) are the founder's. Nothing in Phase A depends on it: WooCommerce connects with the store's own key.
- Do the real test stores (one each for Salla, Zid, WooCommerce, a WordPress site) exist for the live checks?
- Saudi cash-on-delivery stores: "pending" stays out of revenue (answered); the cash-on-delivery limit in section 3 needs one real store to confirm.

## 9. Files, docs and tests

New or changed: `src/lib/connectors/woocommerce.ts` (`wooSales`), `sales.ts` and `store-sales.ts` (provider lists), `working.ts`, `api/connect/[provider]` (sync action for WooCommerce), `wordpress.ts` (media, update), `publish.ts` and `publish-once.ts` (the update path), the cron path (Phase B), the Integrations card text for the WooCommerce key. Docs in the same commit as each phase: `flows.md` (connector steps 11 to 14 and the WordPress step), `permissions.md` (the new action's row), `tests.md` (rules pinned and not pinned). No environment variable is added. Tests, one per rule in sections 3 to 7 (numbers set in the plan): WooCommerce status and refund math, `_fields` has no personal field, `unavailable` carts, 401 and 403 mapping, list equality, daily-sync stale marker, WordPress media failure still drafts, update uses the stored id.

## 10. Questions for the founder

1. Is "pending" excluded from revenue the right rule for your Gulf merchants?
2. Is a daily sync enough, or do you want near-real-time numbers badly enough to take the webhook surface (section 4)?
3. If Salla has no draft-capable blog endpoint, remove its `publish_article` capability (the default)?
4. Should WordPress ever be allowed to publish live, with a separate owner confirmation, or stay draft-only? (Answered 2026-10-05: live with a per-item confirmation, section 5.)

## 11. Rulings made while writing this spec

- S-R1: the order request names its fields (`_fields`) so personal data is never fetched.
- S-R2: WooCommerce carts are `unavailable`, not zero, because core WooCommerce cannot say.
- S-R6: revenue is paid orders only; `on-hold` is awaiting payment in WooCommerce, so it is not revenue (founder, 2026-10-05).
- S-R7: 401 and 403 from WooCommerce are one error, because WooCommerce answers both for a key without access.
- S-R3: daily scheduled sync before any webhook; webhooks, if ever, are a doorbell that never carries numbers.
- S-R4: WordPress is a draft by default; live is a separate per-item confirmation (founder, 2026-10-05); a featured image failure never blocks the draft.
- S-R5: a store key over plain http is refused.
