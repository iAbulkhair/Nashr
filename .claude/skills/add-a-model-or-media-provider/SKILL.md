---
name: add-a-model-or-media-provider
description: Use when adding a text model, an image or video model, or a whole new media provider (fal, kie, higgsfield are the existing ones), including catalog, credits and tests.
---

# Add a model or media provider

Two separate catalogs. Text models: `src/lib/models/catalog.ts` (server only, with `tiers.ts`, `route.ts`, `credits.ts`, `gateway-url.ts`, `overrides.ts`; the gateway client is `src/lib/model.ts`). Media models: `src/lib/media-catalog.ts` (imports nothing, so the browser bundle can use it) and the adapters in `src/lib/media/`. Read `docs/system/flows.md` section 23 (media) and section 74 (storage), and `docs/system/costs.md` before touching prices.

## A new text model

1. Add a `ModelEntry` to `src/lib/models/catalog.ts` with its tier, provider id and cost. The catalog validates itself (`validateCatalog`); a bad entry fails the unit test, not production.
2. If routing should change, edit `tiers.ts` or `route.ts`, never an `if` in a feature file. Credits per call come from `credits.ts`.
3. `catalog.ts` is server-only (`tests/client-bundle.test.ts` fails if a client component imports it). Show names to the customer through a plain list, not the catalog.
4. Run `npx jiti scripts/check-models.ts` to see the catalog against the gateway, then `npx vitest run tests/model-route.test.ts tests/model-route-calls.test.ts`.
5. Margin rule: `MARGIN_FLOOR` in `src/lib/pricing.ts` is 60 percent. A model that breaks the floor for any plan needs the founder's decision (change-a-plan-or-price).

## A new media model on an existing provider

1. Add the model id, label, kind (image or video) and credit cost to `src/lib/media-catalog.ts`. Customer credits are derived from our cost; keep that relation (`docs/system/costs.md`).
2. Teach the provider's adapter (`src/lib/media/fal.ts`, `kie.ts` or `higgsfield.ts`) the request shape for the model.
3. Availability is decided by `modelAvailable` in `src/lib/media/config.ts` (provider keys present, `MEDIA_DIR`, and `MEDIA_MODELS_ON` as the on switch). A model stays hidden until the founder switches it on.

## A new media provider

1. Add the id to `MediaProviderId` in `src/lib/media-catalog.ts` and implement a `MediaAdapter` from `src/lib/media/types.ts`: `submit`, `status`, optional `cancel` and `check`. Register it in `ADAPTERS` in `src/lib/media/registry.ts`.
2. Calls go out through `safeFetch` (`src/lib/safe-fetch.ts`) when any URL comes from a customer or from provider output. Downloaded results are stored through `src/lib/media/store.ts` and `storage.ts` (disk or blob), never linked straight from the provider.
3. Provider webhooks (if any) are public routes: signature check with `sameSecret`, rate limit, `CROSS_SITE_EXEMPT` (add-an-api-route, add-a-payment-provider has the same pattern).
4. Environment variable names go in `docs/system/variables.md` section 3 and `.env.example`; `src/lib/integration-status.ts` lists names for the admin status page. Values are entered by the founder (release-and-env-vars).
5. Jobs, keys and credits: a job holds credits before the call and refunds on failure (`src/lib/media/jobs.ts`, `src/lib/credits.ts`). Never charge twice for one job id.

## Tests

Use the helpers in `tests/helpers/media.ts` (`mediaEnv`, `fakeAdapter`, `fakeDeps`, `noNetwork`) and the model mock `claudeOn` in `tests/helpers/model.ts`. Tests never call a real provider. Add a docs rule file (add-a-feature, numbering step).

## Checks

`npx vitest run tests/client-bundle.test.ts tests/model-route.test.ts` plus your media tests, then `npm run check` and `npx next build`.

## Traps

- Importing `catalog.ts` or an adapter from a client file. The media catalog is the only client-safe one.
- Treating provider output (URLs, captions, JSON) as trusted. It is untrusted input.
- Spending credits outside a user request. A cron or a retry that renders media needs a code check, not a prompt line.
- Quoting a provider price in public copy. Costs are internal.
