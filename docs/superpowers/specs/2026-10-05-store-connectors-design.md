# Store connectors: Salla, Zid, WooCommerce, WordPress

Status: draft for the founder's review, 2026-10-05. Built in Thakeen's own code, not through a connection platform: no platform listed by Unified, Nango or Composio covers Salla and Zid (Unified lists both as beta with partial objects), and the code for them already exists (`src/lib/connectors/salla.ts`, `zid.ts`, `woocommerce.ts`, `wordpress.ts`). The social, ads and calendar evaluation is a separate spec (`2026-10-05-composio-evaluation-design.md`) and shares no files with this one.

## 1. Goal and what the founder decided

Close the gaps between what the four connectors do today and what a store owner expects, in this order of value, without any write to a customer's store that the owner has not approved.

Decided by the founder on 2026-10-05:

- Salla, Zid, WooCommerce and WordPress stay on **direct code**; no connection platform is used for them.
- This work lives on its own branch, apart from the Composio experiment.

Not in this spec: product or price writes to any store (needs its own spec with per-change approval and a rollback record), WordPress.com hosted sites (they use OAuth, not application passwords; the registry says "self-hosted"), abandoned carts for WooCommerce (core WooCommerce has no abandoned-cart API; plugins differ), Salla or Zid customer, shipping or accounting objects, Shopify, PrestaShop, Odoo.

## 2. What exists today (read from the code, 2026-10-05)

| | Connect | Imports products | Sales snapshot (`store-sales.md`) | Publishes |
|---|---|---|---|---|
| Salla | OAuth, scope `offline_access` | yes | yes: orders last 30 days (10 pages) and abandoned carts (3 pages) | no. The registry lists `publish_article` but `publishWith` has no Salla case |
| Zid | OAuth, three headers (token, manager token, store id) | yes | yes: orders (5 pages) and abandoned carts (3 pages), 403 handling | no |
| WooCommerce | key and secret | yes | **no** (`SALES_PROVIDERS` is `salla`, `shopify`, `zid`) | no |
| WordPress | application password | no | no | drafts only (`status: "draft"`), plain post body |

Whether the Salla and Zid partner apps are approved and their client ids set in production is not visible in code (`isAvailable` needs `SALLA_CLIENT_ID/SECRET` and `ZID_CLIENT_ID/SECRET`). That is a founder-side check, listed in section 8.

## 3. Phase A: WooCommerce sales snapshot (the first build)

The same `SalesSnapshot` the other stores produce (`src/lib/connectors/sales.ts`), read from the store's REST API, so the Reports page, the generation memory and the agents see WooCommerce stores the way they see Salla, Zid and Shopify.

- **Source:** `GET {site}/wp-json/wc/v3/orders` with the connection's key and secret, over `safeFetch` (the host is user-supplied). Page size 100, at most 5 pages, `after` a day before the window start and each row re-checked on `date_created_gmt` (the way Zid's rule works, because a date filter's zone and meaning are the store's). The request asks only for the fields it reads with `_fields=id,status,total,currency,date_created_gmt,line_items,refunds`, so a customer's name, email, phone and address are never in the response (privacy at the request, not only in the reducer).
- **Which orders count:** revenue and count leave out `cancelled`, `refunded`, `failed` and `trash`; `pending` (payment awaited) is counted in the order count and left out of revenue; `processing`, `completed` and `on-hold` count in both. A partly refunded order counts its total minus its refunds (refund totals are negative strings). Money is read with `amountOf` under the order's own `currency`, never a default; an unreadable total adds to `unread`, never to revenue. The full count comes from the `X-WP-Total` header when present; when more pages remain and the header is absent, `orders.capped` is set.
- **Carts:** `carts.unavailable = true` always (core WooCommerce has no abandoned-cart data). The snapshot and Dana's STORE DATA then show carts as unknown, not zero, which is the existing meaning of `unavailable`.
- **Errors:** 401 marks the connection `needsReconnect`; 403 answers `orders_access_denied` without marking it (the key lacks read access to orders); a body that is not an array fails the sync.
- **Route and lists:** `POST /api/connect/woocommerce {action:"sync_sales"}` with the same gates as the other three (any login, `read`). `SALES_PROVIDERS`, `PROVIDER_NAME` and `READS_METRICS` gain `woocommerce`; `tests/connectors-working.test.ts` keeps them equal to the code paths. One store per workspace stays: the card shows the store last synced while it stays connected.
- **Key permission:** the connection form today asks for a key used for products. Orders need read access to orders; the form text says "Read" is enough and that "Read/Write" is not needed. The key stays encrypted with `CONNECT_SECRET` as now.
- **Cost:** no model call, no credits.

## 4. Phase B: keep every store fresh without a button

A scheduled sync for the four stores, not webhooks.

- A daily sync of the connected store's snapshot (and ads, where a connection exists), through the existing cron path (`src/lib/cron-batch.ts` and the cron bearer secret). The plan first reads what the cron runs today and adds the stores to it with `pmap` (never an awaited Redis call in a loop) and a per-account cap.
- A failed sync keeps the last good snapshot and its `at` time; the card shows the age, never a fresh-looking old number.
- **Why not webhooks now:** each store's webhooks need a public route (signature check with `sameSecret`, rate limit, body cap, replay marker) and, for WooCommerce, a key with write permission to register one, which is a scope escalation for a daily report. If the founder later wants near-real-time numbers, the safe shape is a **doorbell**: the webhook only triggers a debounced re-sync (`SET NX EX 300` per account and provider) and never writes the numbers in its body; its token is a random 43-character value per connection, stored hashed, and an unknown or malformed token is a 404 with an empty body. Specified then, not built now.

## 5. Phase C: WordPress publishing, still draft-only

Keep `status: "draft"`: the owner publishes inside WordPress after reading it. Add, in this order:

1. **Featured image.** When the item has artwork (`hasArtwork`), upload it to `POST /wp-json/wp/v2/media` and set `featured_media`. The image URL is Thakeen's own storage, fetched through `safeFetch` anyway; a failed upload still creates the draft without an image and says so. `verifyWordPress` also checks the user's capability `upload_files` and reports it.
2. **Update in place.** If the item was already sent and the owner confirms "publish again", the connector updates the stored post id (`PUT /wp-json/wp/v2/posts/{id}`) instead of creating a second draft. The id is read from the task's own record under `sc(u)`, never from a request; `publishOnce` keeps its lock and its "result unknown" marker.
3. **Excerpt and slug** from the item's own fields only (no invented text).

Not added: categories and tags (would need the owner's choice per post), publishing live, scheduled posts, comments, any read of posts.

## 6. Phase D: Salla and Zid

- **Salla `publish_article`:** Task 0 reads Salla's current Merchant API for a blog or articles endpoint that can hold a draft. If it exists, add a draft-only publish like Shopify's. If not, the registry's `publish_article` capability is removed so the card does not promise it. Default if undecided: remove it.
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

- Is the Salla partner app approved and `SALLA_CLIENT_ID/SECRET` set in production? Same for Zid. If not, those stores cannot connect in production at all, whatever this spec builds.
- Do the real test stores (one each for Salla, Zid, WooCommerce, a WordPress site) exist for the live checks?
- Saudi cash-on-delivery stores: confirm that "pending" should stay out of revenue (section 3).

## 9. Files, docs and tests

New or changed: `src/lib/connectors/woocommerce.ts` (`wooSales`), `sales.ts` and `store-sales.ts` (provider lists), `working.ts`, `api/connect/[provider]` (sync action for WooCommerce), `wordpress.ts` (media, update), `publish.ts` and `publish-once.ts` (the update path), the cron path (Phase B), the Integrations card text for the WooCommerce key. Docs in the same commit as each phase: `flows.md` (connector steps 11 to 14 and the WordPress step), `permissions.md` (the new action's row), `tests.md` (rules pinned and not pinned). No environment variable is added. Tests, one per rule in sections 3 to 7 (numbers set in the plan): WooCommerce status and refund math, `_fields` has no personal field, `unavailable` carts, 401 and 403 mapping, list equality, daily-sync stale marker, WordPress media failure still drafts, update uses the stored id.

## 10. Questions for the founder

1. Is "pending" excluded from revenue the right rule for your Gulf merchants?
2. Is a daily sync enough, or do you want near-real-time numbers badly enough to take the webhook surface (section 4)?
3. If Salla has no draft-capable blog endpoint, remove its `publish_article` capability (the default)?
4. Should WordPress ever be allowed to publish live, with a separate owner confirmation, or stay draft-only?

## 11. Rulings made while writing this spec

- S-R1: the order request names its fields (`_fields`) so personal data is never fetched.
- S-R2: WooCommerce carts are `unavailable`, not zero, because core WooCommerce cannot say.
- S-R3: daily scheduled sync before any webhook; webhooks, if ever, are a doorbell that never carries numbers.
- S-R4: WordPress stays draft-only; featured image failure never blocks the draft.
- S-R5: a store key over plain http is refused.
