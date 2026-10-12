# Model catalog, routing and Straitly gateway Implementation Plan

> **Status update (2026-10-12, from `git log origin/main` and the files named; the status line below is the state when the document was written):** merged to `main` as #298 (2026-10-10), default off, not in `production` yet. The `- [ ]` boxes below were never ticked as steps ran: they are the task list, not open work; the spec's status update and `docs/system/tests/` say what shipped.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thakeen calls every model through the Straitly gateway, routes each task to a model automatically, and lets a customer override the model for chat and content generation, priced by tier.

**Architecture:** `anthropic()` in `src/lib/model.ts` stays the only client factory and gains a provider switch plus a direct-Anthropic fallback built into its `fetch`. A server-only catalog holds each model's rate, tier and hosting. `route()` replaces the hard-coded model strings. Credits charged are `base x tier multiplier`, checked by the margin-floor test over the whole catalog.

**Tech Stack:** Next.js 16 (read `node_modules/next/dist/docs/` before touching routes or pages), TypeScript, Upstash Redis via `src/lib/db.ts`, `@anthropic-ai/sdk`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-straitly-model-routing-design.md`

## Global Constraints

- Tenant isolation: every read or write of a conversation, brand or account field uses the caller's scope from `sc(u)`. Never build a Redis key from an id, email or scope taken from the request.
- Every API route authenticates first (`currentUser()`). The new override routes use the existing user rate limit from `src/lib/rate.ts`.
- `new Anthropic(` appears only in `src/lib/model.ts` (rule 335, `tests/model-timeouts.test.ts`). Every caller states `timeoutMs` and `maxRetries`.
- The judge, reviewer (`review`, `xreview`) and `onboard` never read an override. Publishing and credit spending stay checked in code.
- `STRAITLY_API_KEY` is read only in `src/lib/model.ts`, never logged, never in a URL, named in `docs/system/variables.md` and never pasted into chat or committed.
- No `await db.*` inside a loop: `Promise.all` or `pmap` from `src/lib/parallel.ts`.
- Stored shapes: expand only (rule 679). New fields are optional. A missing value means automatic routing.
- Catalog rates are server only: add `src/lib/models/catalog.ts` and `src/lib/models/credits.ts` to `SERVER_ONLY` in `tests/client-bundle.test.ts`. The browser may import `src/lib/models/tiers.ts` only. (This refines the spec's "next to pricing.ts": `pricing.ts` is client-visible, so `creditsFor` lives in its own server file.)
- Rates are Straitly's: provider list price x 0.6 on every token bucket. Margin floor is 60% (`src/lib/pricing.ts`, rule 241).
- Automatic routing never returns `hosting: "china"`. A China-hosted pick needs the customer's stored confirmation, checked on the server.
- No model name in public site copy.
- Rule numbers come from the next free range at execution time: read `tests/` and `docs/system/tests.md` for duplicates after merges. Docs updated in the same commit as each rule: `architecture.md`, `flows.md`, `permissions.md`, `variables.md`, `tests.md`, `costs.md`.
- Run `npm run check` and `npx next build` before every commit. Commit messages end with the Co-Authored-By line from the session.

## Review Focus

Failure modes the spec implies that no task's happy path would catch, most likely first:

1. A stored override names a model later removed from the catalog: the reply is still sent on the automatic model and the customer is told, nothing throws. (Tasks 5, 6)
2. An override id such as `"constructor"` or `"__proto__"` is rejected, not looked up through the prototype chain. (Tasks 3, 6)
3. Rounding: a 1-credit task at Economy x0.6 still charges 1 credit, and the floor test uses the charged value, not the fraction. (Task 4)
4. Straitly fails after a streamed chat reply has started: the direct-Anthropic retry happens only before the first response byte, so no duplicated text and no repeated tool action. (Task 2)
5. `LLM_PROVIDER=straitly` with no `STRAITLY_API_KEY`, or neither key in production: the product answers paused (rule 431), never mock and never a charge. (Task 2)
6. A customer picks a China-hosted model by sending the id directly, without the confirmation: the server refuses. (Task 6)

---

### Task 1: Spike, proving what Straitly passes through (gate)

**Files:**
- Create (throwaway, not committed): `$TMPDIR/straitly-spike.mjs`
- Modify: `docs/superpowers/specs/2026-10-08-straitly-model-routing-design.md` section 2 (record the result table)

**Interfaces:**
- Consumes: `STRAITLY_API_KEY` set by the owner in their own environment. Never printed.
- Produces: a pass/fail table that decides `dialect` and `caps` in Task 3, and whether Task 2b is needed.

- [ ] **Step 1: Ask the owner to set `STRAITLY_API_KEY` in the shell that runs the spike.** Stop and wait if it is unset. Do not ask for the value in chat.
- [ ] **Step 2: Write the spike with the Anthropic SDK pointed at `https://api.straitly.ai/v1`.** It runs five checks and prints only pass/fail plus the `usage` object: (a) `GET /v1/models` lists the ids for `claude-opus-5`, `claude-sonnet-5`, `claude-sonnet-5-5` and one model per other vendor; (b) a tool call with `strict: true` and an optional-parameter schema like the chat tools; (c) `thinking: { type: "adaptive" }` with `output_config: { effort: "medium" }`; (d) two identical calls with a `cache_control` block over 4,000 tokens, the second must report `cache_read_input_tokens > 0`; (e) one non-Claude model on `/messages`, and if it fails, on `/chat/completions`.
- [ ] **Step 3: Run it.** Command: `node $TMPDIR/straitly-spike.mjs`. Expected: a table with five rows.
- [ ] **Step 4: Record the table in the spec, section 2, replacing the "must be proven" list with the results.** Commit only the spec: `git add docs/superpowers/specs/2026-10-08-straitly-model-routing-design.md && git commit -m "docs: Straitly spike results"`.
- [ ] **Step 5: Decide with the owner.** If (b), (c) or (d) failed for Claude on `/messages`, Claude stays on direct Anthropic for that feature (set the matching `caps` false) and the plan continues. If (e) failed on `/messages` but passed on `/chat/completions`, do Task 2b.

---

### Task 2: Provider switch with direct-Anthropic fallback

**Files:**
- Modify: `src/lib/model.ts` (`anthropic`, `modelState`)
- Modify: `docs/system/variables.md`, `docs/system/architecture.md`
- Test: `tests/model-provider.test.ts` (new), update `tests/model-pause.test.ts`, `tests/model-timeouts.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `llmProvider(): "anthropic" | "straitly"` reading `LLM_PROVIDER` (anything else is `"anthropic"`); `anthropic(o: { timeoutMs: number; maxRetries: number }): Anthropic` with the signature unchanged; `modelState()` returns `"on"` when the active provider's key is set or, for `straitly`, when `ANTHROPIC_API_KEY` is set as fallback.

- [ ] **Step 1: Write failing tests in `tests/model-provider.test.ts`.** Names: `defaults to anthropic when LLM_PROVIDER is unset or unknown`; `straitly provider sends requests to STRAITLY_BASE_URL with STRAITLY_API_KEY`; `straitly without STRAITLY_API_KEY or ANTHROPIC_API_KEY is paused in production and mock outside` (rule 431); `a 5xx or connection error from Straitly on a claude-* model is retried once against api.anthropic.com with ANTHROPIC_API_KEY`; `no fallback for a non-claude model`; `no fallback once the first response byte arrived` (Review Focus 4); `the key never appears in a thrown error message or console output`. Use an injected `fetch` stub, not the network.
- [ ] **Step 2: Run:** `npx vitest run tests/model-provider.test.ts`. Expected: FAIL (functions missing).
- [ ] **Step 3: Implement in `src/lib/model.ts`.** With `straitly`, build the SDK client with `baseURL` from `STRAITLY_BASE_URL` (default `https://api.straitly.ai`; confirm the `/v1` handling against the spike) and a custom `fetch` wrapper that, for a request whose JSON body has `model` starting with `claude-`, retries once on a network error or a 5xx status before any response body was read, swapping origin and auth header to Anthropic's with `ANTHROPIC_API_KEY`. Read the request body once and reuse it. Keep both existing argument checks.
- [ ] **Step 4: Update `modelState()`** to the rules in Interfaces. `CLAUDE_PAUSED` and the production-without-key refusal stay as today.
- [ ] **Step 5: Extend `tests/model-timeouts.test.ts`** so the `new Anthropic(` scan still passes and a read of `STRAITLY_API_KEY` outside `src/lib/model.ts` fails.
- [ ] **Step 6: Document `LLM_PROVIDER`, `STRAITLY_API_KEY`, `STRAITLY_BASE_URL`** (names and meaning only, no values) in `variables.md`, and the call path in `architecture.md`.
- [ ] **Step 7: Run `npm run check`.** Expected: all pass.
- [ ] **Step 8: Commit:** `git commit -m "feat(model): provider switch with direct Anthropic fallback"`.

### Task 2b (only if the spike says so): chat-dialect adapter for non-Claude models

**Files:**
- Create: `src/lib/models/chat-adapter.ts`
- Test: `tests/chat-adapter.test.ts`

**Interfaces:**
- Produces: `completeViaChat(req: Anthropic.MessageCreateParamsNonStreaming, o: { timeoutMs: number; signal?: AbortSignal }): Promise<Anthropic.Message>` returning the Anthropic `Message` shape (`content`, `stop_reason`, `usage`) so `noor.ts` and `chat.ts` read it unchanged.

- [ ] **Step 1: Write failing tests:** `translates system, user and assistant turns and tool_use blocks to chat/completions and back`; `maps prompt and completion tokens to input_tokens and output_tokens with cache fields 0`.
- [ ] **Step 2: Run, expect FAIL. Step 3: implement. Step 4: run, expect PASS.**
- [ ] **Step 5: Commit:** `git commit -m "feat(model): chat-completions adapter for non-Claude models"`. Skip this task entirely when `/messages` serves them.

---

### Task 3: Tiers, catalog and rates

**Files:**
- Create: `src/lib/models/tiers.ts` (client safe)
- Create: `src/lib/models/catalog.ts` (server only)
- Create: `scripts/check-models.ts`
- Modify: `src/lib/usage.ts` (`costUsd`, `hasRate`), `tests/client-bundle.test.ts` (`SERVER_ONLY`)
- Test: `tests/model-catalog.test.ts` (new)

**Interfaces:**
- Produces in `tiers.ts`: `type Tier = "economy" | "standard" | "premium"`; `TIER_MULTIPLIER: Readonly<Record<Tier, number>>` = `{ economy: 0.6, standard: 1, premium: 2 }`.
- Produces in `catalog.ts`: `type ModelEntry = { id: string; label: { ar: string; en: string }; vendor: string; hosting: "west" | "china"; tier: Tier; dialect: "messages" | "chat"; caps: { tools: boolean; strict: boolean; thinking: boolean; cache: boolean; vision: boolean }; rate: { in: number; out: number; cacheRead: number; cacheWrite: number }; auto: boolean; pick: boolean; tasks?: readonly string[] }`; `MODELS: readonly ModelEntry[]`; `modelById(id: unknown): ModelEntry | undefined` backed by a `Map`, so `"constructor"` and `"__proto__"` return undefined; `autoModels(): readonly ModelEntry[]`; `pickModels(): readonly ModelEntry[]`; `pickerView(): { id: string; label: ModelEntry["label"]; tier: Tier; hosting: ModelEntry["hosting"] }[]` (no rates).
- Produces in `usage.ts`: `costUsd` reads the catalog rate first, then `RATES`; `hasRate(model)` is true for either.

- [ ] **Step 1: Write failing tests.** `catalog ids are unique`; `every entry with hosting china has auto false`; `every entry has all four rates and rate.cacheRead < rate.in < rate.cacheWrite`; `modelById returns undefined for constructor, __proto__, toString, non-strings and unknown ids`; `the three Claude models used today are in the catalog with auto true`; `pickerView has no rate field`; `costUsd of a catalog model uses its catalog rate`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Start the catalog from the Task 1 `GET /v1/models` output: today's three Claude models (`auto: true, pick: true`), one or two Western models per other vendor from the spike (`pick: true`, `auto: false` until a golden-set run), and any China-hosted ones the owner wants listed (`hosting: "china", auto: false, pick: true`). Rates are provider list x 0.6 with a comment holding the date checked. Keep 5 to 8 entries with `pick: true`.
- [ ] **Step 4: Add the two server files to `SERVER_ONLY`; run** `npx vitest run tests/model-catalog.test.ts tests/client-bundle.test.ts`. Expected: PASS.
- [ ] **Step 5: Write `scripts/check-models.ts`:** reads `GET /v1/models` with the key from the environment and exits non-zero when a catalog id is not callable. Run by hand and in the release checklist; not part of `npm run check`.
- [ ] **Step 6: Run `npm run check`, then commit:** `git commit -m "feat(models): catalog, tiers and Straitly rates"`.

---

### Task 4: Credits by tier and the floor test over the catalog (switch to Opus for this task)

**Files:**
- Create: `src/lib/models/credits.ts` (server only)
- Modify: `src/lib/generate-batch.ts:207,248` (charge and refund), `src/lib/pricing.ts:194-202` (`CHAT_TURN_MAX_USD`, `chatOverflowHold`), chat charging in `src/lib/chat-allowance.ts` and `src/lib/chat-budget.ts`, `src/lib/task-costs.ts`, `tests/pricing-floor.test.ts`
- Test: `tests/model-credits.test.ts` (new)

**Interfaces:**
- Consumes: `TIER_MULTIPLIER`, `modelById`, `ModelEntry` from Task 3.
- Produces: `creditsFor(base: number, model: string): number` = `Math.max(1, Math.ceil(base * multiplier))` using `modelById(model)?.tier ?? "standard"`; `chatTurnMaxUsd(model: string): number` = `CHAT_TURN_MAX_USD` x the tier multiplier; `estimateFor(type: TaskType, model: string): number` in `task-costs.ts` returning USD for a cold-cache batch at that model's rates.

- [ ] **Step 1: Write failing tests.** `creditsFor rounds up and never returns less than 1` (1 credit at 0.6 is 1); `creditsFor of an unknown or prototype id uses the standard multiplier`; `a charge then a refund of the same batch returns exactly the charged credits` for each tier; `chatTurnMaxUsd scales by tier`.
- [ ] **Step 2: Extend `tests/pricing-floor.test.ts`:** for every catalog entry with `auto` or `pick`, for every task type it allows (`tasks` unset means all), cost per charged credit at that model's rate stays under the floor. The failure message names the model and the task type.
- [ ] **Step 3: Run, expect FAIL.**
- [ ] **Step 4: Implement `creditsFor`, `chatTurnMaxUsd`, `estimateFor`.** Charge and refund in `generate-batch.ts` both use `creditsFor(cost, model)` with the model chosen in Task 5, computed once and held in the receipt. Where a premium model cannot meet the floor for a task type, set that entry's `tasks` allow-list; do not lower the floor.
- [ ] **Step 5: Run `npm run check`.** Expected: PASS. Update `costs.md` and the credits section of `flows.md`.
- [ ] **Step 6: Commit:** `git commit -m "feat(credits): tier multiplier and floor test over the catalog"`.

---

### Task 5: `route()` replaces the hard-coded models

**Files:**
- Create: `src/lib/models/route.ts`
- Modify: `src/lib/chat.ts:495` (`CHAT_MODEL`) and its uses at 398, 412, 422; `src/lib/noor.ts:19,205-214,319,485`; `src/lib/judge.ts:96`; `src/lib/onboard.ts:131`; `src/lib/media/prompts.ts:77`; `src/app/api/tools/[tool]/route.ts:35`; `src/lib/task-costs.ts` (`ESTIMATE_MODELS`)
- Test: `tests/model-route.test.ts` (new); update the literal check in `tests/pricing-floor.test.ts`

**Interfaces:**
- Consumes: `modelById`, `autoModels`, `ModelEntry` (Task 3).
- Produces: `type Purpose = "chat" | "generate" | "review" | "xreview" | "judge" | "onboard" | "imagePrompt" | "tool"`; `DEFAULTS: Readonly<Record<Purpose, string>>` equal to today's models; `OVERRIDABLE: readonly Purpose[]` = `["chat", "generate"]`; `route(purpose: Purpose, ctx?: { stored?: unknown; confirmedChina?: boolean; generatedBy?: string }): { model: string; overridden: boolean; rejected?: "unknown" | "not_pickable" | "china_unconfirmed" | "needs_tools" }`.

- [ ] **Step 1: Write failing tests.** `defaults equal today's models for every purpose`; `a purpose outside OVERRIDABLE ignores ctx.stored` (review, xreview, judge, onboard, imagePrompt, tool); `a valid stored pick returns it with overridden true`; `unknown, removed and prototype ids fall back to the default with rejected set`; `a china model without confirmedChina is rejected china_unconfirmed`; `chat needs caps.tools, otherwise rejected needs_tools`; `auto routing never returns a china entry` (loop over every purpose); `judge returns a different model from ctx.generatedBy when the catalog has an auto alternative`.
- [ ] **Step 2: Run, expect FAIL. Step 3: implement `route`.**
- [ ] **Step 4: Replace each literal with `route(purpose).model`.** `CHAT_MODEL` stays exported as `DEFAULTS.chat` so existing imports keep working. `ESTIMATE_MODELS` is derived from `DEFAULTS`; keep `tests/pricing-floor.test.ts` pinning that each literal is the model the code calls.
- [ ] **Step 5: Run `npm run check`.** Expected: PASS, with no change in behavior (same models).
- [ ] **Step 6: Commit:** `git commit -m "refactor(models): route() owns every model choice"`.

---

### Task 6: Overrides, stored under the caller's scope

**Files:**
- Create: `src/app/api/models/route.ts`
- Modify: `src/lib/conversations.ts` (`Conversation` gains `model?: string`), `src/lib/brand.ts` (`Brand` gains `model?: string`), `src/lib/account.ts` (account gains `chinaHostingOk?: boolean`), the chat route and `src/lib/generate-batch.ts` (pass `stored` and `confirmedChina` into `route()`, and tell the customer when `rejected` is set), `docs/system/permissions.md`, `flows.md`
- Test: `tests/model-override.test.ts` (new)

**Interfaces:**
- Consumes: `route`, `pickerView`, `modelById`, `creditsFor`.
- Produces: `GET /api/models` returns `{ models: ReturnType<typeof pickerView>; multipliers: Record<Tier, number>; chinaConfirmed: boolean }`; `PUT /api/models` takes `{ target: "conversation" | "brand"; id?: string; model: string | null }` or `{ confirmChina: true }` and answers `{ ok: true } | { error: "unknown_model" | "not_pickable" | "china_unconfirmed" | "not_found" }`.

- [ ] **Step 1: Write failing tests.** `401 without a session`; `rate limited by the existing user limit`; `a conversation or brand outside the caller's scope is not_found and nothing is written`; `the stored key is built from sc(u), never from a request scope or email`; `unknown, constructor and __proto__ ids are rejected unknown_model`; `a china model without stored confirmation is rejected china_unconfirmed even when the UI was skipped`; `model null clears the override`; `a rejected stored override at call time falls back and the chat reply carries the unavailable notice in the reply language`; `calls for review, judge and onboard never read conversation.model or brand.model` (spy on the store read).
- [ ] **Step 2: Run, expect FAIL. Step 3: implement the route and the call-site wiring.** A trial or paused account behaves as it does for chat today.
- [ ] **Step 4: Update `permissions.md` (route row) and `flows.md`.**
- [ ] **Step 5: Run `npm run check`. Step 6: commit:** `git commit -m "feat(models): per-conversation and per-brand overrides"`.

---

### Task 7: Picker UI, Arabic and English

**Files:**
- Modify: the conversation header component and the brand settings page under `src/app` (find them with `grep -rln "conversation" src/app --include=*.tsx`), `src/lib/dictionary.ts`
- Test: `tests/model-picker-copy.test.ts` (new); update `tests/pricing-copy.test.ts` if it scans copy

**Interfaces:**
- Consumes: `GET /api/models` and `PUT /api/models` from Task 6.
- Produces: no new exports.

- [ ] **Step 1: Write failing tests.** `every new dictionary key exists in ar and en`; `no public marketing page mentions a model name`; `the picker lists Automatic first and labels china entries`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Chat header picker with tier and multiplier (shown as "x0.6", "x1", "x2" from the server), a one-time confirmation dialog for China-hosted entries, and a brand settings field "Default model for content" that shows the multiplier before saving. Follow the existing dialog and RTL patterns in the app.
- [ ] **Step 4: Verify in the browser:** start the preview, open a chat, switch the model, send a message, check the credit charge in the response and the Arabic layout. Take a screenshot of each.
- [ ] **Step 5: Run `npm run check` and `npx next build`. Step 6: commit:** `git commit -m "feat(ui): model picker for chat and brand default"`.

---

### Task 8: Metering by model and provider

**Files:**
- Modify: `src/lib/usage.ts` (`meter`, `getUsage`, `UsageSummary`), `src/lib/admin-stats.ts`
- Test: `tests/usage-model.test.ts` (new)

**Interfaces:**
- Consumes: catalog rates.
- Produces: `meter(email, model, kind, usage?, agent?, provider?: "anthropic" | "straitly")` with `provider` optional; `getUsage` adds `models: Record<string, { calls: number; usd: number }>` and treats rows without a model as the old default.

- [ ] **Step 1: Write failing tests:** `meter records usd per model`; `old rows without model still total correctly`; `usageMonthKeys covers the new counters so wipeAccount cannot miss one`.
- [ ] **Step 2: Run, expect FAIL. Step 3: implement with `Promise.all`, no awaits in a loop.**
- [ ] **Step 4: Run `npm run check`. Step 5: commit:** `git commit -m "feat(usage): meter cost per model and provider"`.

---

### Task 9: Rules, tests list and the staging switch checklist

**Files:**
- Modify: `docs/system/flows.md` ("Releases" section), `docs/system/tests.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the release checklist.

- [ ] **Step 1: Add the rules and the tests that pin them to `tests.md`** with numbers from the next free range (check for duplicates after merging main).
- [ ] **Step 2: Write the release checklist in `flows.md`:** run `scripts/check-models.ts`; set `LLM_PROVIDER=straitly` on staging only; run the golden set (`src/lib/golden.ts`, `evals.ts`) and compare judge scores with direct Anthropic; check the founder console cost per model; then ask the owner for an explicit yes before production. The release pull request names the step (expand).
- [ ] **Step 3: Run `npm run check` and `npx next build`. Step 4: commit:** `git commit -m "docs: model routing release checklist"`.

---

## Pull requests

PR 1: Tasks 2 and 2b (if needed). PR 2: Tasks 3 and 4. PR 3: Task 5. PR 4: Tasks 6 to 9. Each PR is opened as a draft against `main`, and none switches production to Straitly. That is the owner's separate yes (Task 9).

## After main moved to the 5.5 models (2026-10-09)

PR #308 (rules 809 and 900) moved every call to Opus 5.5, Sonnet 5.5 and Haiku 5.5 while this branch was open. The
merge of main set `DEFAULTS` to chat, review, xreview and judge `claude-sonnet-5-5`, generate and onboard
`claude-opus-5-5`, imagePrompt and tool `claude-haiku-5-5`; `PRICED_AT` follows chat and generate. Opus 5 and Sonnet 5
stay in the catalog with `auto` and `pick` false, so stored usage still prices and a stored pick of either falls back.

- [ ] **Later, separate step (rule 901, after the golden set):** give `generate` a default per task type. Today
  `route("generate", { task })` uses `task` only to check a pick's `tasks` allow-list and always falls back to the one
  `DEFAULTS.generate`. With `TASK_MODELS` (local commit 055e1898 on `claude/ai-api-task-assignment-834d4f`, not pushed)
  the automatic default comes from that table when `ctx.task` is set, and `creditsFor` must price the batch at the
  model the table picks (rule 241 over every pair in the table, not only the catalog defaults). This needs its own
  branch from main and its own draft PR.
