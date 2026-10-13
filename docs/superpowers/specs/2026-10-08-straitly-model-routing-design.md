# Model catalog, routing and Straitly gateway: design

> **Status update (2026-10-12, from `git log origin/main` and the files named; the status line below is the state when the document was written):** merged to `main` as #298 (2026-10-10; follow-ups #315), default off (`LLM_PROVIDER` unset keeps today's behaviour), in `production` since release #336 (2026-10-12).

Date: 2026-10-08. Status: draft for owner review. Branch: `claude/thakeen-ai-models-integration-b3855c`.

## 1. Goal

Thakeen uses many more models through the Straitly gateway (https://straitly.ai, 181 models, one key, 40% below provider list price) and picks the right one per task automatically. A customer may override the model on chat and on content generation.

Decisions already made by the owner:

- Automatic routing is the default. Override exists, on chat and content generation only.
- Everything goes through Straitly, Claude included (option B). Direct Anthropic stays as a fallback for Claude models.
- A customer's model choice changes what the task costs by a credit multiplier per tier. The 60% margin floor holds for every model in the catalog.
- Judge, reviewer, cross-review and onboarding are never overridable. The model is never the only approval (CLAUDE.md).
- Catalog scope: every Straitly model may be picked by a customer, but China-hosted models are marked as such and are never used by automatic routing.

Out of scope: plan gating of models, per-model allowances, BYOK, model choice for the free tools, image/video providers (kie.ai, Higgsfield, fal stay as they are).

## 2. What Straitly offers (from their docs, 2026-10-08)

- Base URL `https://api.straitly.ai/v1`, bearer key, `GET /v1/models` lists what our key can call.
- Two dialects on one base URL: OpenAI `POST /chat/completions` and Anthropic-native `POST /messages`.
- Billing buckets: fresh input, cache read, cache write, output. 40% off list on each. Cache TTLs 5 minutes and 1 hour. Failed requests are not charged. A request may run up to 15 minutes.
- Privacy page: prompts and responses are not stored, no training on data, metadata kept. Some inference hosts are in China (DeepSeek, Zhipu, Moonshot, Alibaba, MiniMax and others).

Not documented, must be proven by the spike in section 9 before section 5 is built:

1. `strict: true` tool schemas pass through `/messages` (chat depends on them, rule 770).
2. Adaptive thinking and `effort` pass through (generation and chat depend on them).
3. `cache_control` blocks produce cache read and write counts in `usage` (the cost model assumes cache reads).
4. Non-Claude models answer on `/messages`. If not, they use `/chat/completions` through the adapter in section 5.
5. Rate limits, failover behavior, and a stable model id for each catalog entry.

## 3. Model catalog

File `src/lib/models/catalog.ts`. Server and test only, like `task-costs.ts` (listed in `SERVER_ONLY` of tests/client-bundle.test.ts). The browser receives only the picker projection (id, labels, tier, hosting), never rates.

Each entry:

| Field | Meaning |
|---|---|
| `id` | The exact id Straitly accepts |
| `label` | `{ ar, en }` |
| `vendor` | anthropic, openai, google, xai, deepseek, moonshot, zhipu, minimax, alibaba |
| `hosting` | `"west"` or `"china"` |
| `tier` | `"economy"` (x0.6), `"standard"` (x1), `"premium"` (x2) |
| `dialect` | `"messages"` or `"chat"` (set by the spike) |
| `caps` | `{ tools, strict, thinking, cache, vision }` booleans |
| `rate` | USD per million tokens, `{ in, out, cacheRead, cacheWrite }`, equal to provider list x 0.6 |
| `auto` | Automatic routing may use it. Must be false when `hosting` is `"china"`, enforced by a test |
| `pick` | A customer may choose it for chat or generation |

A starting catalog is proposed in the plan, from the live `GET /v1/models` output and the Straitly models page. A script `scripts/check-models.ts` compares the catalog with `GET /v1/models` and fails if an entry is not callable. It runs by hand and in the deploy checklist, never at build time.

## 4. Routing

File `src/lib/models/route.ts`: `route(purpose, ctx): ModelId`.

Purposes and rules:

| Purpose | Default (today's model) | Overridable |
|---|---|---|
| `chat` | claude-sonnet-5-5 | yes, per conversation |
| `generate` | claude-opus-5 | yes, per brand |
| `review`, `xreview` | claude-sonnet-5 | no |
| `judge` | claude-sonnet-5 | no, and never the same model as the one that generated the batch, when the catalog has an alternative |
| `onboard` | claude-opus-5 | no |
| `imagePrompt` | claude-sonnet-5 | no |
| `tool` (free tools) | claude-sonnet-5 | no |

Automatic routing only returns entries with `auto: true`. The first release keeps the table above, so nothing changes for customers. Later releases change the table in code, one line per purpose, after the golden set (`src/lib/golden.ts`, `evals.ts`) is run on the candidate.

Override resolution, for `chat` and `generate`:

1. Read the stored id from the caller's own scope (`sc(u)`): `conversation.model` for chat, `brand.model` for generation. Never take an id from the request body without validating it.
2. Accept it only if it is in the catalog with `pick: true` and the task needs capabilities it has (chat needs `tools`; generation needs `thinking` only when the call asks for it).
3. Otherwise log a counter, fall back to the automatic choice, and tell the customer the model was unavailable, in the reply language.

Setting an override is a route that authenticates with `currentUser()`, writes only under `sc(u)`, validates the id against the catalog, and is covered by the existing user rate limit.

## 5. Client layer

`src/lib/model.ts` keeps `anthropic()` as the only factory (rule 335). Changes:

- `LLM_PROVIDER` is `"anthropic"` (default) or `"straitly"`. With `straitly`, the factory builds the same SDK client with `baseURL = STRAITLY_BASE_URL` and `apiKey = STRAITLY_API_KEY`. Timeout and retry arguments stay mandatory.
- Claude models: if the Straitly call fails with a 5xx or a connection error before any response byte, and `ANTHROPIC_API_KEY` is set, the same request is sent once to Anthropic directly. An attempt timeout is not a trigger: the SDK's abort wraps the whole fetch and cannot be told apart from the caller's own abort, so a gateway hang ends as a normal timeout and refund. The retry stays inside the caller's deadline (`until`), so the refund path still runs.
- Non-Claude models: sent on `/messages` when the spike proves it works. If not, `src/lib/models/chat-adapter.ts` translates the request (system, messages, tools) to `/chat/completions` and the reply back to the shapes `chat.ts` and `noor.ts` read. The adapter is only built if the spike requires it.
- `modelState()` returns `"on"` when either key is present. A production deployment with neither key still answers `"paused"` (rule 431). `CLAUDE_PAUSED` keeps its meaning.
- Usage metering: `costUsd(model, usage)` reads the catalog `rate` first, then the old `RATES`. A model with no rate throws in tests and is priced at the most expensive rate in production, as today's default does for unknown ids, with a console error naming the model.
- The metering row records the model id and the provider that answered, so the founder console can show per-model cost.

## 6. Credits and margin

- Task credits charged = existing task credits x tier multiplier, rounded up to a whole credit, computed in one function `creditsFor(task, model)` next to `pricing.ts`. Charge and refund both call it, so a refund returns exactly what was charged. The charge happens before the model call, as today.
- Chat: `CHAT_TURN_MAX_USD` becomes per tier. The per-message price keeps its 60% floor per tier. Economy messages cost less credit, Premium cost more.
- `tests/pricing-floor.test.ts` iterates every catalog entry with `pick: true` or `auto: true`, prices a cold-cache batch of each task type at that model's rate and tier multiplier, and fails the build under the floor. A task that cannot meet the floor on a premium model is marked not allowed for that model in the catalog (`tasks` allow-list) instead of lowering the floor.
- The auto-run (`autoUnderFloor`, rule 296) uses the brand's model when it has one, and skips a type whose estimate crosses the floor.

## 7. Customer surfaces

- Chat: a model picker in the conversation header, 5 to 8 entries, each with tier and credit multiplier. "Automatic (recommended)" is the first entry and the default. China-hosted entries show "hosted in China" and ask for one confirmation per customer, stored under `sc(u)`.
- Content generation: "Default model" in the brand settings, same list and labels, shows the multiplier before saving.
- Arabic and English, and the multipliers come from the server, not hard-coded in the client.
- No model name appears in public site copy (existing rule: no model mention on the homepage).

## 8. Data shape and migration

All new fields are additive (rule 679, expand only):

- `conversation.model?: string`, `brand.model?: string`, `account.chinaHostingOk?: boolean`.
- Old code ignores them. New code treats a missing value as automatic.
- No contract release is needed in this feature. A later contract release would only remove the old `RATES` table once nothing reads it.
- Usage rows gain `model` and `provider` fields. Readers treat a missing value as the old default.

## 9. Spike (gate before PR 2)

A throwaway script in the scratchpad, run with a Straitly key that the owner puts in the environment privately. It never prints the key. It checks the five unknowns in section 2 with one Claude model and one non-Claude model, and reports a table of pass or fail. The spike changes the plan, not the product: a failed unknown moves that feature to the fallback path in section 5 (Claude stays direct for that feature) or removes the capability from `caps`.

## 10. Rollout

1. PR 1: provider switch, `LLM_PROVIDER=anthropic` default, catalog types, no behavior change. Tests for the factory and the fallback.
2. PR 2: catalog, rates, `creditsFor`, floor test over the catalog. Still no customer change.
3. PR 3: `route()` replaces the hard-coded model constants (`CHAT_MODEL`, `ESTIMATE_MODELS`, the literals in `judge.ts`, `onboard.ts`, `noor.ts`, `media/prompts.ts`, the tools route). Same table, so same behavior. `ESTIMATE_MODELS` is derived from `route()`.
4. PR 4: overrides, routes, UI, copy.
5. Switch `LLM_PROVIDER=straitly` on staging first, run the golden set and the judge comparison, then on production after the owner approves, with direct Anthropic as the fallback. The release pull request names the step (expand), and production is changed only on the owner's explicit yes.

## 11. Rules and tests (numbers taken from the next free range at plan time)

- Rule: `new Anthropic(` appears only in `model.ts` (existing 335, extended to the provider switch).
- Rule: a model id from a stored override or a request is always validated against the catalog before use.
- Rule: automatic routing never returns an entry with `hosting: "china"`.
- Rule: judge, review, xreview and onboard never read an override.
- Rule: every catalog entry that can be chosen or auto-routed has a rate and meets the margin floor at its tier price.
- Rule: charge and refund use the same `creditsFor` value.
- Rule: `STRAITLY_API_KEY` is read only in `model.ts`, never logged, never in a URL.
- Tests in `tests/`: catalog shape, routing table, override fallback, tenant isolation of overrides, floor over the catalog, credits round trip, fallback to direct Anthropic, the client bundle does not import the catalog rates.
- Docs updated in the same commits: `architecture.md`, `flows.md` (model call, credits, releases), `permissions.md` (the override route), `variables.md` (`LLM_PROVIDER`, `STRAITLY_API_KEY`, `STRAITLY_BASE_URL`), `tests.md`, `costs.md`.

## 12. Risks

| Risk | Response |
|---|---|
| Straitly is a new vendor and a single point of failure | Direct Anthropic fallback for Claude models; `LLM_PROVIDER` switch back in one deploy |
| Data location for China-hosted models (Saudi PDPL) | Never in automatic routing, labeled, one confirmation per customer, owner to get legal advice before any default change |
| `strict`, thinking or cache not passed through | Spike decides before building; fallback path per feature |
| A cheaper model writes worse Arabic | Golden set and judge comparison before a table change; Economy models are picks, not defaults |
| Margin falls under the floor on a premium model | The floor test over the whole catalog fails the build; the task allow-list per model |
| Provider rate changes | Rates are data in the catalog, with the date checked in a comment, as `RATES` is today |
