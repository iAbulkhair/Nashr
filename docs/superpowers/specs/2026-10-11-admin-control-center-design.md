# Admin control center: agents, workflow, feature flags, audit (design)

Status: design only, no code. Written 2026-10-11 on branch `claude/prompt-studio-specs` from main `37b00583`. Rules **1050-1079** are reserved for this work (`docs/system/tests/1050-admin-control-center.md`, all "designed, not pinned"). Checked free on 2026-10-11 against `git ls-tree origin/main docs/system/tests/` and the open PRs (#316 930-959, #319 987-990, #320 991-1010, another branch 1011-1019; the companion spec takes 1020-1049). Permissions route rows 210-224 are proposed; the flows section is the next free one at build time (63 if still free).

Companion spec: `2026-10-11-agent-learning-loop-design.md`. Both build on **draft PR #316** (agent skills portal, rules 930-959) and **assume it merges first**: the Agents page links to its `/{lang}/admin/skills` section rather than editing prompts itself, and its `skills:paused` switch is shown here next to the other switches. #317 (UI/UX phase 0, merged) gave the console `useConfirm` (`src/components/app/ConfirmDialog.tsx`) and `TempPasswordDialog`; this spec uses them and finishes the job of removing `window.prompt` from the console.

## 1. Why

The founder decided (2026-10-11) that the admin controls all of Thakeen: the agents, the users and the workflow. Today each lever is somewhere else, and several need a code release:

- **Pause.** `CLAUDE_PAUSED` is a **code constant** in `src/lib/model.ts` (not an environment variable): pausing every agent takes a commit, a release PR and a Hostinger build. During an incident (a bad prompt, a runaway bill, a provider outage) that is far too slow.
- **Agents.** Every plan gets all eight agents (`entitlements().agents = AGENT_IDS`); there is no switch to take one agent out for everyone or for one plan.
- **Models.** Which model writes and reviews each task type is `TASK_MODELS` in `src/lib/task-models.ts` (rule 901), code only.
- **Features.** Paymob, Composio, calendars, Straitly routing and media are on or off only by which environment variables are set in hPanel. The founder cannot see from the console which names are missing, and cannot turn a ready feature off without removing its keys.
- **Workflow.** Approval before publish is per account (`gov.autoApprove`); there is no platform-wide hold. Cron runs leave no "last run" record except the secretary tick (`sec:tick:last`); a stuck media job or handoff is visible only in logs.
- **Audit.** `admin:log` exists (capped 2000) but each route writes its own ad-hoc row, and the Users page still asks with `window.prompt` (nine places in `src/components/admin/Users.tsx`).

Success: in an incident the founder opens `/{lang}/admin/agents`, presses **Pause all agents**, types a reason, confirms, and within ten seconds no model call leaves any instance; the Audit log shows who, when, before, after and why; and turning Composio on is refused with "missing: COMPOSIO_API_KEY, COMPOSIO_PROVIDERS" instead of breaking at a customer's click.

## 2. Founder decisions (2026-10-11, binding)

| # | Decision |
|---|---|
| D1 | The admin controls all of Thakeen: agents, users, workflow (aspect 3 of the prompt system). |
| D2 | Agent self-improvement is approved by the founder in the admin panel, always (companion spec). |
| D3 | Founder only for now; designed so a future support role gets read-only access and a few limited actions. |
| D4 | Layer precedence 0 code safety > 1 playbooks > 2 platform > 3 plan/industry > 4 workspace > 5 per-agent (companion spec section 4). This spec's switches sit in layer 0: they are code gates, not prompt text. |

User quote: "spec it, always my approval in admin panel".

## 3. Goals, non-goals, anti-goals

Goals
1. A pause switch in Redis that every model call checks in code, complementing the code constant.
2. Agents page: on/off per agent globally and per plan; model per task within margin; cost per agent from metering.
3. Workflow page: platform approval rules checked in code, platform quiet days, cron list with last run and status, queue health, stuck items with a safe retry.
4. Feature flags that can only turn on a feature whose environment names are present, and say which are missing.
5. One audit helper for every admin write (who, when, section, target, before, after, reason) and a filterable log page.
6. Confirm and form dialogs everywhere in the console; no `window.prompt`, `confirm` or `alert`.
7. A role map ready for a support role.

Non-goals
- Editing environment variables or secrets from the browser. hPanel stays the only place; values never enter Redis, the console or chat.
- Duplicating the Users, Billing, Partners or Usage pages. They keep their actions; this spec only moves their writes onto the audit helper and their questions onto dialogs.
- Editing prompts here (that is `/admin/skills`, #316 and the companion spec).
- A support role in production (only its design and the role map).

Anti-goals
- A Redis flag that can grant what the environment does not allow (money, identity, a provider without credentials).
- A model override that sells a task type below the 60% margin floor.
- A console action that charges a customer (no "run weekly batch now" button).
- A switch whose state differs between instances for more than the cache window.

## 4. The control state

### 4.1 One key, read once per request

```ts
type By = { email: string; imp?: string } | { key: true };
type Stamp = { by: By; at: string; reason: string };

type ControlState = {
  v: number;                                   // increments on every write (optimistic concurrency)
  pause?: { on: boolean } & Stamp;             // all model calls
  agents?: Partial<Record<AgentId, { on: boolean; plans?: Plan[] } & Stamp>>;   // plans: the plans that keep it while on; absent = all
  models?: Partial<Record<TaskType, { write?: ModelId; review?: ModelId } & Stamp>>;
  workflow?: {
    forceApproval?: { types: TaskType[] } & Stamp;     // owner auto-approve ignored for these types
    publishHold?: { on: boolean } & Stamp;             // no connector publish leaves
    quiet?: { days: { date: string; countries?: string[]; note: string }[] } & Stamp;   // YYYY-MM-DD, platform quiet days
  };
  flags?: Partial<Record<FlagId, { on: boolean } & Stamp>>;
  limits?: { learnWeeklyUsd?: number; learnTargetUsd?: number; watch?: Partial<WatchThresholds> } & Partial<Stamp>;  // companion spec, bounded in code
};
```

- Key `ctl:state` (json), lock `ctl:lock` (`SET NX`, 10 s), history `ctl:hist` (capped list of 500 `{v, at, by, section, before, after, reason}`).
- **Defaults are today's behaviour**: no row means pause off, every agent on for every plan, no model override, no forced approval, no hold, no quiet day, and every flag "follow the environment" (section 7). The release that adds the reader changes nothing until the founder writes.
- `src/lib/control.ts`: `getControl()` returns the parsed state from an **in-process cache with a 10-second TTL** (one `db.get` per instance per 10 s, not per request); `parseControl` reads defensively (an unknown agent, type, model or flag id is dropped; a malformed row is the defaults plus a logged warning, except `pause`, which is read on its own and treated as on when it cannot be parsed).
- A read error keeps the last value this instance read. An instance that has never read the state and cannot read it treats **pause as on** for model calls (fail closed) and everything else as defaults.
- Writes: `setControl(section, patch, by, reason, baseV)` under `ctl:lock`, refuses a stale `baseV` (409 `stale`), validates the patch (section-specific checks below), writes `ctl:state`, pushes `ctl:hist` and the audit row (section 9) in one `Promise.all`, and clears this instance's cache. Other instances see it within 10 s.

### 4.2 What stays in the environment and what moves to Redis

The principle: **the environment is the ceiling, Redis is the switch inside it.** Anything that grants access, identity or money, or that needs a credential, stays in the environment; anything an incident needs in seconds, and that can only narrow what the environment allows, goes to Redis.

| Setting | Where | Why |
|---|---|---|
| Every secret and credential (`ANTHROPIC_API_KEY`, `STRAITLY_API_KEY`, `PAYMOB_*` keys, `COMPOSIO_API_KEY`, OAuth client secrets, `CRON_SECRET`, `CONNECT_SECRET`, `RESEND_API_KEY`, …) | env | secrets never in Redis (CLAUDE.md) |
| `ADMIN_EMAILS`, `WAITLIST_ADMIN_KEY`, `STAGING_ACCESS_KEY` | env | who holds admin or staging power must not be changeable from a session |
| `APP_ENV`, `APP_ORIGIN`, `BUILD_*`, Redis URLs | env | identity of the deployment |
| `PAYMOB_LIVE` | env | real money; Redis may turn payment off, never live on |
| `LLM_PROVIDER` | env | the ceiling; the `straitly` flag may send calls direct to Anthropic, never to the gateway without the env |
| `MEDIA_MODELS_ON` | env | which paid media models may run at all; the `media` flag and the existing breaker (`media:off`) only narrow it |
| `CLAUDE_PAUSED` (code constant) | code | the deploy-level pause stays: effective pause = constant OR Redis pause OR no key |
| Pause all agents | Redis `ctl:state.pause` | incident, seconds |
| Agent on/off, per plan | Redis | incident and packaging, no release |
| Model per task | Redis, within a code allowlist and the margin check | tuning without a release; the code table stays the default |
| Approval rules, publish hold, quiet days | Redis | incident and national events |
| Feature flags | Redis, only inside env readiness | turn a ready feature off or on without touching hPanel |
| Learning budget and watch thresholds | Redis, bounded by code maxima | companion spec |
| Customer workspace instructions pause | Redis `skills:paused` (#316, unchanged) | shown on the Agents page beside the pause |

### 4.3 Staging and production

Staging and live have **separate Upstash databases** (`architecture.md` section 6), so each has its own control state; nothing syncs between them. Consequences:
- A switch flipped on staging never affects live, and the reverse.
- On staging most feature flags show missing names (staging has few provider credentials), which is expected and shown as such.
- `GET /api/admin/control?export=1` returns the state without stamps' emails (actor shown as founder/key) so the founder can compare staging and live side by side before a release; the release checklist (`flows.md` section 52) gains one line: "compare control state if this release reads a new switch".
- A release that adds a new switch must default to today's behaviour when its row is absent (4.1), so the order "deploy, then flip" is always safe.

## 5. Agents page (`/{lang}/admin/agents`, new `ADMIN_SECTIONS` entry)

### 5.1 Pause all agents

- One large switch at the top: **Pause all agents** / **Resume**, with the current state, who, when and why.
- Effect: `modelState()` answers `paused` while `ctl.pause.on` is true, exactly as with `CLAUDE_PAUSED`: chat answers `PAUSED_REPLY`, generation refuses before a credit moves, onboarding and free tools refuse, golden and the learning crons skip.
- **Enforced in code at the one choke point**: every model call goes through `metered()` (`src/lib/metered.ts`, rule 980). `metered()` reads `getControl()` and throws `ModelPaused` before the stream starts. That makes it impossible for any call, including one a future feature forgets to gate, to leave while paused.
- **Refuse before charging**: `modelState()` is synchronous today and is called before charges. It keeps its signature and reads the cached control state; the routes that charge (chat, `draft_items`, generate, media prompts, onboarding, the #316 test, routines, weekly, handoffs) call `await refreshControl()` once at entry (the same 10 s cache), so the cached value they read is fresh. The existing backstop stays: every caller that charges first refunds on a `ModelPaused` throw.
- Confirm dialog (destructive), reason required. The switch shows the cache window: "takes effect on every server within 10 seconds".
- Beside it, read-only with a link: #316's "Pause customer instructions" (`skills:paused`) state, and the media breaker's switched-off models (`media:off`).

### 5.2 Agents on or off

A table, one row per agent (Noor, Sami, Razan, Faris, Dana, Majed, Layan, Reem):

| Column | Source |
|---|---|
| State | `ctl.agents[id]` (default on, all plans) |
| Plans that keep it | checkboxes trial, starter, pro, business, agency |
| This month: calls, USD, USD per call | `usage:_all:{month}:agent:{id}:calls` and `:usd_micro` (already written by metering, #318) |
| Last month | the same keys for the previous month |
| Task types and their models | `TASK_MODELS` with overrides (5.3) |
| Prompt | link to `/{lang}/admin/skills` filtered to the agent |

Effect, checked in code:
- `entitlements(u, now, ctl?)` gains an optional third argument; `agents` becomes `AGENT_IDS` filtered by `ctl.agents` (global off removes it; `plans` removes it for other plans). Without the argument it is today's list, so existing callers compile and behave as before (expand).
- Gates that already read `entitlements().agents` (chat route, MCP) pass `ctl`. New checks with the same refusal (`agent_off`, 403, no charge) are added where an agent is started without the chat route: `generateBatch` (weekly, routines, handoffs, Majed's auto-run, `draft_items`), the handoff target picker (a handoff to a disabled agent is refused with a note to the owner) and the #316 test route.
- The customer app shows a disabled agent greyed with "Paused by Thakeen for now" (Arabic and English), never as an error, and no credit moves.
- **Reem**: disabling Reem stops her model calls (chat, meeting extraction, walk-through). Her reminders, calendar feed and booking webhooks are not model calls and continue, because an owner's to-dos must not silently stop.
- Confirm dialog with the count of accounts affected (`users:all` by plan, from the overview stats already computed), reason required.

### 5.3 Model per task

- A row per task type: the code default (`TASK_MODELS[type]`), the override if any, and the cost estimate per batch and the margin at the type's credit price for each allowed model.
- **Allowlist in code**: `MODEL_CHOICES: Record<TaskType, {write: ModelId[]; review: ModelId[]}>`, the three product models only (rule 809), excluding models a type cannot use (tools, length).
- **Margin check on write**: `estimateBatch` (`src/lib/task-costs.ts`) with the override must keep the type at or above the 60% margin floor at its credit price; else 409 `margin_floor` with the computed margin. `tests/pricing-floor.test.ts` is extended to iterate every model in `MODEL_CHOICES`, so any override the console can save is already proven by CI.
- **Precedence**: a customer's own pick (#298, `/api/models`, priced with its multiplier) > the founder's override > `TASK_MODELS`. The override changes what "Automatic" means. Rule 903's judge choice is unchanged unless a `review` override is set.
- `generate` and `critique` (noor.ts) and `estimateBatch` read the effective table through one function `taskModels(type, ctl)`, so the price and the call cannot disagree.
- The prompt stamp is unaffected (the model is recorded on `Task.quality.model` and in metering already).

### 5.4 Cost per agent

Read only, from the counters metering already writes (no new metering): month to date, last month, calls, USD per call, and the platform's own spend (golden, learn) apart. A link to `/{lang}/admin/usage` for the detail. No customer email is shown on this page.

## 6. Workflow page (`/{lang}/admin/workflow`, new `ADMIN_SECTIONS` entry)

### 6.1 Approval rules (checked in code)

- **Force approval** for chosen task types: while a type is listed, an owner's `gov.autoApprove[type]` is ignored and every new item of that type lands in the inbox as pending. Checked where `autoApprove` is read when an item is created (`generate-batch.ts`) and where the judge withdraws an auto-approval; items already approved stay approved. The owner's Governance page shows "Thakeen requires approval for this type for now" next to the disabled toggle.
- **Publish hold**: while on, `publishTask` (inside `publish-once.ts`, after its lock, where the gates already re-run on the copy being sent) refuses with `publish_held` before any connector call; the item stays approved and the owner sees "Publishing is paused by Thakeen; your post is kept and you can publish it when this lifts". Composio drafts (WhatsApp templates, private uploads, email drafts) are held the same way. Nothing is queued to auto-publish later: the owner publishes when the hold lifts.
- Both: confirm dialog (destructive for the hold), reason required, audit.

### 6.2 Platform quiet days

- A list of dates (YYYY-MM-DD, at most 60 ahead, at most 30 stored), each with an optional list of countries (ISO codes matching the brand's country in `sec:cal:{scope}` / `COUNTRY_CAL`; empty = everywhere) and a note (for example a national day of mourning).
- On a quiet day for a brand's country: the weekly batch, routines and Majed's auto-run skip that brand without charging (outcome `quiet_day` in the cron summary), and Reem sends no nudges or evening wrap. Owner-started actions (chat, a draft, a publish) are not blocked: the owner decides.
- Brand-level quiet days (Reem phase 3 A1) stay as they are; a day quiet at either level is quiet.

### 6.3 Crons: list, last run, status

- `CRONS` registry in `src/lib/crons.ts`: name, path, schedule, what it does, whether it charges customers, and `safeToRun`. A test asserts it equals `vercel.json` plus the hPanel-only `*/15 * * * *` secretary tick, plus the companion spec's two crons.
- Each cron route writes `cronrun:{name}` (json, no TTL) at start (`startedAt`) and end (`endedAt`, `ms`, `ok`, `status`, a short outcome summary without emails or scopes, `chain` index), one `set` each.
- Status shown: **ok**, **failed** (last run not ok), **running** (started, not ended, younger than `maxDuration`), **stuck** (started, not ended, older than `maxDuration`), **late** (no start for 1.5 schedule periods), **never**.
- **Run now** only for crons with `safeToRun` (no customer charge, idempotent): media sweep, stores sync, learn-watch, secretary tick. It calls the library function on the server (`sweepMedia`, …), never the HTTP route, so the browser never handles `CRON_SECRET`. Confirm dialog, reason, audit, rate-limited. The weekly batch, daily renewals, golden and the proposer have no button.

### 6.4 Queue health

Counts and oldest age from **global** structures only (no scan of tenants): `mjobs:open:{fal,kie,higgsfield}` (media jobs open), `sec:duescopes` and `sec:tick:last` (reminders), `sec:cal:due` (calendars), `learn:open` (proposals), and the new stuck index (6.5). A red mark when the oldest item passes a threshold in code (media 30 min, reminders tick 30 min).

### 6.5 Stuck items and retry

- New index `stuck:{kind}` (sorted set, score = time entered, member = an opaque id) for long-running states that today have no global view: media jobs (`mjob` id), handoffs (`handoff` id), publish markers left after a timeout (`publock`/`pubtry`), routines holds. Code adds the member when the item enters the state and removes it when it leaves (one command each, added to the existing writes; expand: items already in flight are found by the media sweep as today).
- The member maps server-side to `{scope, id}` in `stuck:ref:{kind}:{opaque}` (TTL 14 days); the console receives only kind, opaque id, age, agent and type, and a link to the account in Users.
- **Retry** calls the existing idempotent path for that kind only: media `advanceJob` (the force-advance the sweep uses), handoff `retryHandoff` (the existing `handofftry` counter), publish "check result" (publish-once's marker path). A retry never charges and never publishes anew where publish-once says the result is unknown; it asks the provider first, as publish-once does. Confirm, reason, audit, rate-limited.

## 7. Feature flags (`/{lang}/admin/flags`, new `ADMIN_SECTIONS` entry)

### 7.1 Registry

`FLAGS` in `src/lib/flags.ts`, one row per feature, with the environment names it needs (names only):

| Flag | Needs (all present) | Effect point |
|---|---|---|
| `paymob` | `PAYMOB_SECRET_KEY`, `PAYMOB_PUBLIC_KEY`, `PAYMOB_HMAC_SECRET`, `PAYMOB_INTEGRATION_ID_CARD` | `billing.ts` readiness; live mode still needs `PAYMOB_LIVE=1` (env only) |
| `composio` | `COMPOSIO_API_KEY`, `COMPOSIO_PROVIDERS` | `connectors/composio.ts` readiness; each provider also needs its `COMPOSIO_AUTH_*` |
| `google_refs` (#316) | `COMPOSIO_API_KEY`, `COMPOSIO_AUTH_GOOGLEDOCS`, `COMPOSIO_AUTH_GOOGLESHEETS` | Instructions page Import button and route |
| `calendar_google` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Reem B3 calendar link |
| `calendar_microsoft` | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Reem B3 calendar link |
| `straitly` | `LLM_PROVIDER=straitly`, `STRAITLY_API_KEY` | `model.ts` `straitlyKey()`: flag off sends calls direct to Anthropic |
| `media` | `MEDIA_MODELS_ON` and the provider keys of at least one model | `media/config.ts` `modelsSwitchedOn` |
| `turnstile` | none switchable | shown read-only: it stays env (fail open by design) |
| `learn_cron`, `learn_rollout` | none | companion spec |

### 7.2 Rules

- **Effective** = `envReady(flag) && (row ? row.on : default)`, where `default` is `true` for features that are env-gated today (so the release changes nothing) and `false` for new ones (`learn_cron`, `learn_rollout`).
- **Turning on is refused** while any needed name is missing: 409 `env_missing` with the list of names. The page shows, per flag: effective state, the stored switch, and "missing: …" in red. Never a value, never a length or prefix of a value (a test greps every flags answer for the values set in the test environment).
- If a name is removed from hPanel later, the flag is effectively off at once even though the row says on, and the page shows why.
- Readiness is evaluated where the feature already checks its env (one function per feature, `ready()`), so the flag cannot disagree with the feature.
- Confirm, reason, audit. Turning `paymob` or `composio` off shows the number of accounts with a live subscription or connection, read from existing counters, and what they will see.

## 8. Users and workspaces: consolidate, do not duplicate

The Users page (`src/components/admin/Users.tsx`, `/api/admin/users/{email}`, `/api/admin/plan`, `/api/admin/topups`, `/api/admin/payments/{email}`) keeps every action it has: plan, seats, chat allowance, deal, credits, top-ups, trial, video grant, reset password, verify email, impersonate, suspend, member removal. This spec changes three things only:

1. **Dialogs**: the nine `window.prompt` calls and three `confirm` calls left after #317 become a `FormDialog` (one component, typed fields: integer with min and max, date, text with a length limit, select; Arabic and English labels; the same answer bookkeeping as `confirmGate`), as planned in the UI/UX report section 5. A source test then pins no `prompt(`, `confirm(` or `alert(` in `src/components/admin`.
2. **Audit**: every write goes through `adminAudit` (section 9) instead of its own `pushCapped("admin:log", …)`.
3. **Workspaces**: the account detail gains a read-only "Workspaces" list (each brand: name, industry, plan, agents active for its plan after the Agents page rules, instructions count from #316's feed, last activity), with links to the existing pages. No new write action.

The new pages link into Users for anything about one account; the Users page links to Agents and Workflow for platform switches. No second place edits the same thing.

## 9. Audit log

### 9.1 One helper

`adminAudit(row)` in `src/lib/admin-audit.ts` is the only writer of `admin:log`:

```ts
type AuditRow = {
  id: string;                  // 12 hex
  at: string;                  // ISO
  actor: string;               // founder email, "key", "paymob", "auto-rollback", "cron:{name}"
  imp?: string;                // when acting inside an impersonation session
  section: AdminSection | "billing-webhook" | "skills" | "learn";
  action: string;              // e.g. "control:pause", "agents:off", "flags:on", "plan:change", "learn:approve"
  target?: { kind: "account" | "agent" | "type" | "flag" | "cron" | "proposal" | "rollout" | "platform"; id: string };
  before?: unknown;            // the changed fields only, never a secret value
  after?: unknown;
  reason?: string;             // required for control-center writes (3-200 characters)
  // legacy fields kept for the old reader: email, what
  email?: string;
  what: string;
};
```

- Expand: old rows (`{actor, email, what, reason?, before?, after?, at}`) stay readable; the log page shows them as "legacy". New rows carry both the new fields and `what`/`email`, so the current Log component keeps working until it is replaced.
- Cap raised from 2000 to 5000 (`CAPS.adminLog`). Control-center writes are also in `ctl:hist` with full before/after, kept 500.
- Before/after never hold a secret: flags store booleans; payments store amounts and ids as today. A test writes every action with the test environment's secret values set and greps the stored rows for them.
- A source test pins that no file but `admin-audit.ts` contains `pushCapped("admin:log"`.

### 9.2 Log page

`/{lang}/admin/log` gains filters (section, actor, action prefix, target) and paging (`?before={index}`, 50 a page, `lrange` with an offset; filters apply to the page read, and the page says "filtered within the last N rows"). Each row expands to show before and after side by side. Read only.

## 10. Dialogs

- `useConfirm` (#317) for every switch, with `destructive` for pause, agent off, publish hold, flag off and stop rollout.
- `FormDialog` (section 8) for any question with a value: reason, number, date, list of types, list of countries.
- Every control-center write asks for a reason in the same dialog as the confirmation (one dialog, not two).
- The dialog repeats the effect in plain words ("No agent will answer any customer until you resume. No credits will be used.") and the cache window where it applies.

## 11. Roles

Founder only today: every admin route authenticates with `adminActor(req)` / `isAdmin(req)` (a key session, or a founder signed in as themselves, `ADMIN_EMAILS`).

Designed for a future support role without building it:
- `src/lib/admin-roles.ts`: `AdminRole = "founder" | "support"`, `ADMIN_CAN: Record<AdminAction, AdminRole[]>`, and `adminCan(actor, action)`. Every admin route checks its action through `adminCan` after `adminActor`. Today `adminActor` only ever returns founders, so every check passes for them; the map exists so the support role is a data change plus one identity source.
- Support (when built): read every section except payment details and the evidence viewer of the learning loop; actions limited to: resend verification email, issue a temporary password, extend a trial by at most 7 days, run a `safeToRun` cron, retry a stuck item. Never: pause, agents, models, workflow, flags, plans, credits, top-ups, refunds, deals, impersonation, skills, proposals, rollouts.
- Identity source for support (founder answer Q3, section 18): a separate environment list set in hPanel, so admin power is never granted from a session.
- `ADMIN_SECTIONS` gains a `role` attribute per section so the nav can hide what a role cannot open; the page gate (`requireAdmin()`) gains the same check.

## 12. Stored shapes and releases (rule 679)

| Key or field | Change | Expand | Contract |
|---|---|---|---|
| `ctl:state`, `ctl:lock`, `ctl:hist` | new | absent = today's behaviour | none |
| `cronrun:{name}` | new | written by each cron from the release on; "never" until the first run | none |
| `stuck:{kind}`, `stuck:ref:{kind}:{id}` | new | in-flight items before the release are not listed (the media sweep still finds them) | none |
| `admin:log` rows | new fields (`id`, `section`, `action`, `target`, `imp`) | old rows read as legacy; new rows keep `what` and `email` | a later release may stop writing `what` once the old Log component is gone |
| `CAPS.adminLog` | 2000 → 5000 | a cap only | none |
| `entitlements(u, now, ctl?)` | optional argument | absent = all agents | none |
| `Task`, `Governance` | unchanged | | |

No data conversion. The flags default to "follow the environment" so the first release with flags changes no feature's state.

## 13. Routes, auth, rate limits

| Route | Who | Auth first | Rate limit |
|---|---|---|---|
| `GET /api/admin/control` (`?export=1`) | F | `adminActor` | 300/hour per actor |
| `POST /api/admin/control` (`{section, patch, reason, v}`; sections `pause`, `agents`, `models`, `workflow`, `flags`, `limits`) | F | `adminActor`, `adminCan`, then body | 60/hour per actor; `pause` 20/hour; 429 with `Retry-After` |
| `GET /api/admin/crons` | F | `adminActor` | 300/hour |
| `POST /api/admin/crons/{name}/run` (`{reason, confirm: true}`) | F | `adminActor`; `name` must be a `safeToRun` registry key | 10/hour |
| `GET /api/admin/queues` | F | `adminActor` | 300/hour |
| `POST /api/admin/queues/retry` (`{kind, id, reason}`) | F | `adminActor`; `id` resolved through `stuck:ref` only | 60/hour |
| `GET /api/admin/log` (`?before=&section=&actor=`) | F | `isAdmin` (unchanged) | 300/hour |
| `GET /api/admin/flags` | F | `adminActor` | 300/hour |

No public route. No route takes a scope, email or Redis key from the request except the existing Users routes, which already take a target email from the path and check existence.

## 14. Permissions rows (proposed for `permissions.md` 1.7, and 2.1 for the pages)

| # | Method | Path | Who | Checks |
|---|---|---|---|---|
| 210 | GET | `/api/admin/control` | F | `adminActor`; state, effective flags with missing names, agent costs; no values |
| 211 | POST | `/api/admin/control` | F | `adminActor`, `adminCan`; lock, `v`, reason; margin check for models; env readiness for flags; `adminAudit` |
| 212 | GET | `/api/admin/crons` | F | `adminActor`; registry and `cronrun:*` |
| 213 | POST | `/api/admin/crons/{name}/run` | F; name from path, registry only | `adminActor`; `safeToRun`; server-side call |
| 214 | GET | `/api/admin/queues` | F | `adminActor`; global sets only |
| 215 | POST | `/api/admin/queues/retry` | F; opaque id from body, resolved server-side | `adminActor`; existing idempotent path; never charges |
| 216 | GET | `/api/admin/flags` | F | `adminActor`; names and booleans only |
| 217-224 | | reserved | | |

Pages: `/{lang}/admin/agents`, `/{lang}/admin/workflow`, `/{lang}/admin/flags` behind `requireAdmin()` like the other nine sections (rule 870), with `adminScreenMeta` titles (rule 961).

## 15. Environment variables

**None new.** Names read (meaning unchanged): the readiness lists in section 7.1, `ADMIN_EMAILS` and `WAITLIST_ADMIN_KEY` (console gate), `CRON_SECRET` (crons, unchanged). Reserved for the future support role, not added now: one name for the support email list (founder answer Q3: an environment list), named in `variables.md` when the role is built.

## 16. Tests and rules (1050-1079)

Listed in `docs/system/tests/1050-admin-control-center.md`, all "designed, not pinned" until built.

| # | Rule |
|---|---|
| 1050 | `ctl:state` absent or partial = today's behaviour; parse drops unknown ids |
| 1051 | 10-second in-process cache; read error keeps the last value; no value ever read = pause on for model calls |
| 1052 | `metered()` throws `ModelPaused` before any stream while `ctl.pause.on` or `CLAUDE_PAUSED` |
| 1053 | Every charging entry point refreshes the control state before `modelState()`; a `ModelPaused` throw refunds |
| 1054 | Agent off (global or for a plan) removes it from `entitlements(u, now, ctl).agents`; chat, MCP, `generateBatch` callers, handoffs and the #316 test refuse `agent_off` with no charge |
| 1055 | Reem off stops her model calls only; reminders, feed and bookings continue |
| 1056 | Model override only from `MODEL_CHOICES`; 409 `margin_floor` below 60%; the floor test iterates every choice |
| 1057 | Effective model: customer pick > founder override > `TASK_MODELS`; one function for call and price |
| 1058 | Agent costs read from existing usage counters only |
| 1059 | Forced approval ignores `autoApprove` for listed types at creation and judge withdrawal; existing items unchanged |
| 1060 | Publish hold refuses `publish_held` inside publish-once before any connector call, Composio drafts included |
| 1061 | Platform quiet day: weekly, routines, Majed auto-run and Reem nudges skip without charge for matching countries; owner actions not blocked |
| 1062 | `CRONS` equals `vercel.json` plus the secretary tick plus the learning crons; every cron writes `cronrun:{name}` at start and end; status rules |
| 1063 | Run now only for `safeToRun`; server-side function call; no `CRON_SECRET` leaves the server |
| 1064 | Queue health reads only global structures |
| 1065 | `stuck:{kind}` maintained on enter and leave; retry through the existing idempotent path; never charges |
| 1066 | Flag on refused 409 `env_missing` with names; effective = env ready and switch; env removed = off |
| 1067 | Flags and control answers carry names and booleans only, never values |
| 1068 | Redis can only narrow env: `PAYMOB_LIVE`, `LLM_PROVIDER`, `MEDIA_MODELS_ON` stay env; `straitly` off sends direct |
| 1069 | `adminAudit` is the only writer of `admin:log` (source test) |
| 1070 | Control-center writes need a reason of 3-200 characters (400 `reason_required`) |
| 1071 | No secret value in any audit row or `ctl:hist` (test with planted values) |
| 1072 | Log filters and paging; legacy rows shown |
| 1073 | No `prompt(`, `confirm(` or `alert(` in `src/components/admin` (source test); `FormDialog` typed fields |
| 1074 | Every control write asks through a dialog; destructive styling for pause, off, hold |
| 1075 | `adminCan` checked on every admin route; founders pass everything; the support map is data |
| 1076 | Writes under `ctl:lock` with `v`; stale 409 |
| 1077 | Staging and live states are separate; export carries no emails or values |
| 1078 | Rate limits as section 13, each 429 with `Retry-After` |
| 1079 | Reserved for follow-ups |

## 17. Phased build plan

Prerequisite: #316 merged (the Agents page links to it and shows `skills:paused`). Each phase is one branch, proven locally, one draft PR, per CLAUDE.md's CI rules.

| Phase | Content | Rules | Estimate |
|---|---|---|---|
| 1 | `control.ts` (state, cache, lock, history), `adminAudit` and moving every `admin:log` writer onto it, pause in `metered()` and `modelState()`, Agents page with pause and read-only costs | 1050-1053, 1058, 1069-1071, 1076 | 2 days |
| 2 | Agents on/off per plan with every gate; model overrides with the margin check and the extended floor test | 1054-1057 | 2 days |
| 3 | Feature flags registry, readiness per feature, Flags page | 1066-1068, 1077 | 1.5 days |
| 4 | Workflow: forced approval, publish hold, platform quiet days | 1059-1061 | 2 days |
| 5 | Crons registry and `cronrun:*`, run now, queue health, stuck index and retry | 1062-1065 | 2 days |
| 6 | `FormDialog`, the Users page's prompts and confirms replaced, Log filters and paging, Workspaces list | 1072-1074 | 1.5 days |
| 7 | Roles map and `adminCan` on every route (support role not enabled) | 1075, 1078 | 1 day |

Total about 12 working days. Phase 1 first: it removes the slowest incident step (pausing needs a release today) and gives the companion spec its audit helper and flags.

## 18. Founder questions, answered

Founder decision 2026-10-11 («موافق على الكل»): every recommended answer below is accepted as written.

| # | Question | Decided answer |
|---|---|---|
| Q1 | Does "Pause all agents" also stop the golden set, the learning crons and your own console tests? | Yes, one switch stops every model call. The learning crons also have their own `learn_cron` flag for when only they should stop. |
| Q2 | What does a platform quiet day stop? | Automated work only: weekly batches, routines, Majed's auto-run and Reem's nudges. Owners can still chat, draft and publish. |
| Q3 | When a support person joins, where are they listed? | A separate environment list set in hPanel (one new name, added then), never a Redis list, so admin power cannot be granted from a session. |
| Q4 | May a model override move a type up (Sonnet to Opus) when the margin still holds? | Yes, only when the margin check passes at the type's credit price; the page shows the margin before you save. |
| Q5 | How does a customer see an agent you switched off? | Greyed in the sidebar with "Paused by Thakeen for now", no error, no credit used. |
| Q6 | Should `LLM_PROVIDER`, `PAYMOB_LIVE` or `MEDIA_MODELS_ON` move into Redis too? | No. They stay the ceiling in hPanel; the console can only turn those features off or back on inside it. |
