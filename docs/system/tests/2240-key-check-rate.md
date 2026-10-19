# Coverage: failed key checks limited per workspace (rule 2240)

Status on 2026-10-19 on branch `claude/api-platform-integrations-ce2972`. `POST /api/connect/{provider}/key` checks the credentials it is given against an outside service (a WordPress site's username and application password, a WooCommerce, Odoo or PrestaShop key, a Telegram bot token, a Brevo or Klaviyo API key) and had no rate limit, so a signed-in account could use Thakeen's servers to try passwords against any WordPress site. Failed checks now cost a hit in two buckets of the caller's own workspace (flows section 12 step 2a); a passing check hands its hits back. Rules 2241-2249 are reserved for this branch.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 2240 | Ten failed checks an hour and thirty a day per workspace (`KEY_CHECK_FAILS_PER_HOUR`, `KEY_CHECK_FAILS_PER_DAY` in `src/lib/rate.ts`), every key provider together, in `rate:keycheck:{hour|day}:{sc(u)}` built by `wsKey.keyCheckBucket`; over either, 429 `slow_down` with a `Retry-After` of the refusing window and no outside call; a passing check gives both hits back before the save; a missing field, an unknown provider or a member without `connectors` costs nothing; another workspace keeps its allowance | Yes: `tests/key-check-rate.test.ts`, `tests/key-registry.test.ts` (byte-identity row) | none |
