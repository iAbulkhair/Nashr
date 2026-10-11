# Agent learning loop: agents propose, the founder approves (design)

Status: design only, no code. Written 2026-10-11 on branch `claude/prompt-studio-specs` from main `37b00583`. Rules **1020-1049** are reserved for this work (`docs/system/tests/1020-agent-learning-loop.md`, all "designed, not pinned"). Checked free on 2026-10-11 against `git ls-tree origin/main docs/system/tests/` (highest file 0980) and the open PRs: #316 holds 930-959, #317 (merged) 960-969 and 974-977, #319 987-990, #320 991-1010, another branch 1011-1019. Permissions route rows 200-209 are proposed (#316 holds 190-199); the flows section is the next free one at build time (62 if still free).

Companion spec: `2026-10-11-admin-control-center-design.md` (rules 1050-1079). Both build on **draft PR #316** (agent skills portal, `docs/superpowers/specs/2026-10-10-agent-skills-portal-design.md` on branch `claude/agent-skills-portal-47b7dd`, rules 930-959) and **assume #316 merges first**: they reuse its layer store (`src/lib/instructions-store.ts`), its single merge point (`src/lib/agent-instructions.ts` `loadLayers` / `instructionBlocks`), its safety screen (`src/lib/instructions-safety.ts`), its founder console section `/{lang}/admin/skills` (`SkillsAdminPanel.tsx`, `/api/admin/skills`) and its prompt-stamp fields `plat` and `ins`. Nothing here is built until #316 is on main.

## 1. Why

The founder wants the agents to get better from what actually happens in Thakeen, without giving up control. Today:

- The playbooks (`content/skills/*.md`, read by `src/lib/skills.ts`) change only with a code release, and nobody collects what the judge, the owners and the golden set say about them in one place.
- The signals exist but are scattered and per tenant: the judge's score and auto-fail code on each task (`Task.quality`), the owner's approve / edit / reject decisions and typed reasons (`decisions:{scope}`, `prefs:{scope}`), chat thumbs (`fblog:{scope}`), the weekly golden run (`golden:runs`, `src/lib/golden.ts`), and from #316 the owners' own standing instructions and "remember that we never…" proposals. `src/lib/feedback.ts` already feeds one agent's own recent signals back into that one workspace's prompt; nothing turns the pattern across all workspaces into a better default.
- #316 gives the founder a platform layer he edits by hand. He has no queue of suggested edits, no evidence behind them, no way to measure one version against another on real traffic, and no safe partial rollout.

Success: every Monday the founder opens `/{lang}/admin/skills` → Proposals, sees a short list of concrete edits per agent ("Noor, social: open with the product in use in the first line; 41 rejections in 9 workspaces said the hook was generic"), with the diff, the reason, the evidence and the cost of checking it; he edits one word, presses Approve, presses "Golden check ($0.60)", sees +3.1 points, rolls it out to 10% of workspaces, and a week later either finishes it to 100% or finds it was rolled back automatically because the judge score dropped in the treatment group.

## 2. Founder decisions (2026-10-11, binding)

| # | Decision | Where |
|---|---|---|
| D1 | The prompt system has three aspects: (1) inside Thakeen the founder and the agents improve agent skills and prompts (this spec); (2) clients add skills and instructions for their own account (#316); (3) the admin controls all of Thakeen: agents, users, workflow (companion spec). | 3 |
| D2 | Agents **propose**; the founder **always approves** in the admin panel. Nothing auto-applies, ever, regardless of golden score. | 6, 7 |
| D3 | The golden check before activation runs **only on the founder's click** (it costs money). | 8 |
| D4 | After approval: **staged rollout** to a share of workspaces, with **automatic rollback** on a score drop. Rollback may be automatic because it returns to an approved version. | 9, 10 |
| D5 | Layer precedence: **0** code safety (immutable) > **1** base playbooks in git > **2** founder platform layer > **3** plan/industry layer (new) > **4** client workspace > **5** client per-agent. A lower layer never overrides a higher one. | 4 |

User quote for the record: "spec it, always my approval in admin panel".

## 3. Goals, non-goals, anti-goals

Goals
1. One weekly, budget-capped proposer per agent that turns signals into concrete, reviewable edits of layers 1-3.
2. A Proposals queue in `/{lang}/admin/skills`: approve, edit then approve, reject with a reason, all audited.
3. A golden A/B check on the founder's click, with its price shown before the click.
4. Staged rollout by deterministic workspace buckets, measured per prompt version through the prompt stamp, with automatic rollback.
5. Base-layer (git playbook) proposals become a branch and a draft PR made by Claude, never a Redis write.
6. The new plan/industry layer (layer 3) and the binding precedence in the one merge point.

Non-goals (version 1)
- Proposals for a single client's own instructions (layers 4 and 5). Clients own those (#316); not in version 1 (founder answer Q4, section 18).
- Proposals for the reviewer or the judge (section 6.4).
- A self-hosted fine-tune, embeddings, or any model other than the product's three (Opus 5.5, Sonnet 5.5, Haiku 5.5, rule 809).
- Editing playbook files from the browser (still #316's non-goal).

Anti-goals (a failure even if it works)
- Any path from the cron, the watch job or a model output to an active prompt without the founder's click.
- One tenant's text, names or numbers in another tenant's prompt, or in a platform proposal's text.
- A client charged for a proposer call, a taxonomy call or a golden check.
- A change to the judge that the judge then scores (it would grade its own exam).

## 4. Layers and precedence (D5)

### 4.1 The six layers

| # | Layer | Who writes | Where it lives | Rendered as |
|---|---|---|---|---|
| 0 | Code safety | code review only | the gates (approval, publish-once, credits, brand proposals, `checkText`, placeholder and discount gates) and the fixed RULES in `fixedPrompt` / chat `system()` | not prompt text that anything below can reach; the gates do not read prompts |
| 1 | Base playbooks | Claude PR, founder merges | `content/skills/*.md`, industry `PLAYBOOKS` (`src/lib/playbooks.ts`) | `skillsBlock(agent)` and the industry playbook, as today |
| 2 | Founder platform | founder (#316 editor, or an approved proposal) | `skills:platform` (#316) | `THAKEEN STANDARDS` block |
| 3 | Plan / industry (new) | founder (editor, or an approved proposal) | `skills:plan:{plan}`, `skills:industry:{playbookId}` | `THAKEEN STANDARDS FOR YOUR PLAN AND INDUSTRY` block |
| 4 | Client workspace | owner/admin of the workspace (#316) | `skills:{scope}`, items with `agents: "all"` | `for_all_agents` in `<owner_instructions>` |
| 5 | Client per-agent | owner/admin, Pro and up (#316) | `skills:{scope}`, items naming agents | `for_you` in `<owner_instructions>` |

### 4.2 What changes in #316's merge point

`instructionBlocks(layers, target, also)` stays the only renderer. It gains the layer-3 block and the binding order:

- **Order in the prompt**: playbooks (1, already in block 1) → platform (2) → plan/industry (3) → workspace (4, 5). The platform and plan/industry blocks are founder text (trusted, our voice); the workspace block stays fenced data.
- **Precedence lines** (replacing #316's `HOW_TO_USE` sentence "`for_you` wins over `for_all_agents` … both win over a THAKEEN STANDARD not marked [locked]"):
  - Platform header: "THAKEEN STANDARDS (from Thakeen; follow them. They add to your playbook and never contradict it: where one seems to, the playbook wins.)"
  - Plan/industry header: "… (they add to the standards above and never contradict them)".
  - Workspace: "They are the owner's preferences inside the standards above. Where one disagrees with a THAKEEN STANDARD or the playbook, the standard wins. `for_you` adds detail for you and never contradicts `for_all_agents`: where it seems to, `for_all_agents` wins."
- **`lock`**: under D5 every platform item already outranks every workspace item, so `lock` no longer changes precedence. Expand: the field stays stored and readable, the render stops printing `[locked]` and stops ordering by it; the editor hides the checkbox. Contract (a later release): `lock` is dropped from `Draft` and the store.
- **Layer 3 selection**: the plan is `u.plan` (the account's, from the caller's own `User`); the industry is `pickPlaybook(brand.industry)?.id ?? "general"`. Both are enum values from code, so the keys `skills:plan:{plan}` and `skills:industry:{id}` are never built from request text. `loadLayers` reads them in its existing single `mget` (now five keys: platform, paused, plan, industry, workspace).
- **Caps**: layer 3 shares #316's `RENDER_CHARS` budget, taken after the platform layer and before the workspace; 40 items and 2000 characters per item per plan or industry set.
- **Stamp**: `PromptStamp` gains `tier` (content hash of the layer-3 block, `none` when empty) next to `plat` and `ins` (expand; old tasks read without it).
- **Prompt cache**: block 1 stays identical across brands of one plan and industry within one rollout arm (section 9.4); `tests/prompt-cache.test.ts` gains the arm and the layer-3 block as inputs.

This is a behaviour change to #316: its rule 942 (selection and precedence, "locked ones first") and the `HOW_TO_USE` wording pinned with rule 946. It ships as rules 1020-1022 with their own tests, which amend those #316 tests, in the first code PR of this spec, after #316 is on main. #316's rule 947 notes a known gap (a reviewer or judge platform edit does not move the stamp); phase A closes it by adding the reviewer and judge platform hashes to `promptHashes`, because section 8 compares golden runs by those hashes.

## 5. Signals: what the proposer learns from

### 5.1 Sources

| Source | Read from | Tenant data? | Enters the proposer prompt as |
|---|---|---|---|
| Golden failures | latest `golden:runs` run: per case hard-check failures, judge score, dims, notes | no (fictional brands) | case id, failed check names, score, judge note (fenced, model output about fictional brands) |
| Judge results on real items | per agent, per task type: counters `lstat:*` (5.3) and per-workspace `Task.quality` | yes | numbers only: mean score, dims means, auto-fail code counts, by type |
| Thumbs-down | `fblog:{scope}` (chat replies, typed reason) | yes | taxonomy label counts (5.2) |
| Owner edits and rejections | `decisions:{scope}` (action, typed reason, edit share) | yes | approve / edit / reject rates; taxonomy label counts of the reasons |
| Chat "remember" items | #316 `skillprop:*` applied or dismissed | yes | taxonomy label counts |
| Repeated client instructions | #316 `skills:{scope}` active sets | yes | taxonomy label counts with the number of distinct workspaces |

Accounts whose governance has `learning: false` (`gov:{scope}`) are skipped entirely: their decisions already do not steer their own prompts (`feedback.ts`), and they do not steer anyone else's. Golden and the test account (`GOLDEN_EMAIL`) are excluded from tenant sources.

### 5.2 Cross-tenant signals are anonymised before any model sees them

The rule: **a tenant's free text never reaches the proposer, and never reaches another tenant's prompt.** Only labels from a closed list, with counts, cross the tenant boundary.

1. **Collect in scope.** For each workspace (pages of `users:all` and `brands:{email}`, read with `pmap` and `mget`, never `await` in a loop), the weekly job takes the last 7 days of typed reasons and instructions for the agent.
2. **Redact in code** (`redactForLabels`): drop URLs, emails, phone numbers, @handles, every digit, and the workspace's own brand name, product names and city tokens from its `brand:{scope}` (folded with `brand-rules.ts` `normalize`). What is left is at most 300 characters per reason.
3. **Label.** One Haiku 5.5 call per batch of up to 50 redacted reasons (one agent, possibly many workspaces, each reason tagged with an opaque per-run index, never the scope) maps each reason to one label from `LEARN_LABELS`, a closed list in code per agent family (for example `generic_hook`, `too_long`, `wrong_dialect`, `invented_number`, `too_salesy`, `missing_cta`, `banned_word`, `off_brand_tone`, `wrong_channel_format`, `missing_placeholder`, `other`). The answer is validated in code: an index not in the batch or a label not in the list is `other`. The model's text is not kept.
4. **K-anonymity.** A label enters the proposer prompt only when it comes from at least **K = 5** distinct workspaces in the window (`LEARN_K`, a constant). Below K it is counted in the run summary as "below threshold" and nothing else.
5. **Store** the aggregate only: `learn:sig:{agent}:{isoWeek}` holds `{label, items, workspaces}` rows and the numeric stats. No text, no scope.

The founder sees the underlying examples through evidence links (section 6.3), because he may see tenant data; the proposer model never does.

### 5.3 Per-version counters (prompt-stamp linkage)

Every generated task already carries `pb` (`src/lib/prompt-stamp.ts`): `skills`, `review`, `industry`, `code`, and from #316 `plat` and `ins`. This spec adds `tier` (4.2) and `ro` (rollout id and arm, 9.3). To measure a version without scanning tenants:

- `lstat:{agent}:{plat}:{tier}:{day}` (hash, TTL 120 days) with fields `judged`, `scoreSum`, `autofail`, `approved`, `edited`, `editPctSum`, `rejected`, `thumbsUp`, `thumbsDown`, `items`. `HINCRBY` at the two moments the signal is written: when the judge stores `Task.quality` (judge.ts) and when a decision is recorded (decisions.ts), using the task's own `pb`. Chat thumbs use the reply's stamp: `ChatMsg` gains an optional `pb: {plat, tier, ins}` (expand; old messages carry none and are not counted).
- `lstatws:{agent}:{plat}:{tier}` (HyperLogLog, or a set of the first 16 hex of `sha256(scope)` if PFADD is unavailable on Upstash HTTP; TTL 120 days) counts distinct workspaces without storing the scope.
- One extra command per judge result and per decision; no read on the hot path. The counters carry no tenant data, only hashes and numbers.

The Quality section (`/admin/quality`) gains a "by prompt version" table read from these counters (one `mget` of the visible keys).

## 6. Proposals

### 6.1 The weekly proposer cron

`GET /api/cron/learn` (new; `CRON_SECRET` through `sameSecret`, as every cron), Monday `0 2 * * 1` UTC, after Saturday's golden run and Sunday's weekly batches. Added to `vercel.json` for the record and to the hPanel cron list by the founder (Hostinger runs the crons, `architecture.md` section 6).

Per run, under `learn:lock:run` (`SET NX`, 15 minutes):

1. For each target in a fixed order (the eight agents, then `media`), within the route's time budget (`maxDuration = 300`, start budget 240 s; a target not reached is picked up by the next run, and `?resume=1` exists for the founder's manual run):
   1. Build the signals (5.1, 5.2) and read the target's current layers 1-3 text (playbook through `skillsBlock`, platform and plan/industry sets).
   2. **Budget check before every model call**: the estimated cost of the call (input characters / 4 × rate + max output × rate, from the `usage.ts` price table) plus what this week has spent (`learn:budget:{isoWeek}`, usd micro) must stay under the weekly cap; the target's own spend under the per-target cap. Defaults in code: **$10 a week, $1.50 a target**; the control center (companion spec) may lower them, never raise them above the code maximum ($25 a week). Over the cap: the target is skipped with `budget` in the run summary.
   3. One Sonnet 5.5 call (`metered()`, rule 980) with a fixed system prompt: "You improve one agent's instructions. Propose at most 3 edits… Answer only JSON matching the schema." The signals, golden notes and current texts go in the user message as `asData` JSON inside `<signals>`, `<golden>` and `<current>` tags, marked as data.
   4. Validate and screen the answer (6.4); store each accepted proposal (6.2).
2. Push a run summary to `learn:runs` (capped 52): targets done, skipped (budget, no signal, lock), proposals stored, refused (by reason), cost.

Metering: every call is metered as **platform cost** under the internal account `learn@nashr.internal` (like `GOLDEN_EMAIL`) with usage kind `learn` and the target as agent, so `usage:_all` and the Usage section show it apart. No credit is charged: `src/lib/learn*.ts` never imports `credits.ts` or `chargeOnce` (an import test pins it). Expected cost: a proposer call is about 15k input and 2k output tokens on Sonnet 5.5 ($2 / $10 per million) ≈ $0.05; labelling about 10 Haiku calls a target; the week should land near $2, far under the cap.

The founder can also press **"Run proposer now"** for one target: it shows the estimated cost, asks in a confirm dialog, and runs the same code path for that target (`POST /api/admin/learn/run`), inside the same weekly budget.

The cron never writes a layer, never starts a rollout and never calls golden. It only writes `learn:*` records (pinned by an import test: `learn-cron` does not import `instructions-store` writers, `golden.ts` or the rollout module).

### 6.2 Proposal shape

```ts
type LearnTarget =
  | { layer: "base"; file: PlaybookFile; section?: string }       // content/skills/<file>.md, optionally one "## " section
  | { layer: "base-industry"; playbook: PlaybookId }              // an entry of PLAYBOOKS in playbooks.ts
  | { layer: "platform"; agents: "all" | Target[] }               // skills:platform (#316)
  | { layer: "plan"; plan: Plan; agents: "all" | Target[] }       // skills:plan:{plan}
  | { layer: "industry"; playbook: PlaybookId; agents: "all" | Target[] };

type Evidence =
  | { n: number; kind: "golden"; runId: string; caseId: string; score?: number; check?: string }
  | { n: number; kind: "stat"; metric: string; value: number; base?: number; window: string }
  | { n: number; kind: "label"; label: string; items: number; workspaces: number }
  | { n: number; kind: "item"; agent: AgentId; type: TaskType; score?: number; autofail?: string };  // resolves through learn:ev (6.3)

type LearnProposal = {
  id: string;                    // 12 hex
  v: 1;                          // shape version
  for: Target;                   // the agent (or media) the run was for
  target: LearnTarget;
  op: "add" | "replace" | "remove";
  before: string | null;         // the current text being replaced or removed, read by code at proposal time
  after: string | null;          // the proposed text (normalized, screened)
  baseHash: string;              // contentHash of the target's current content; a change since makes the proposal stale
  diff: string;                  // unified diff computed in code from before/after, never model output
  reason: string;                // model-written, at most 600 chars, untrusted, shown as text
  evidence: Evidence[];          // built by code from the signals, never by the model (the model may cite evidence numbers only)
  estCost: { goldenB: number; goldenAB: number; promptCharsDelta: number };  // USD, from the last golden runs; prompt growth
  flags: ScreenFlag[];           // section 6.4: leak, injection, authority, secret, too_long
  status: "open" | "approved" | "approved_pr" | "rejected" | "stale" | "superseded" | "rolling_out" | "live" | "rolled_back";
  createdAt: string;
  by: "learn-cron" | "founder";  // founder = "Run proposer now"
  decision?: { at: string; by: By; action: "approve" | "edit_approve" | "reject"; reason?: string; editedFrom?: string };
  golden?: { runId: string; baselineRunId: string; reused: boolean; delta: number; byCase: Record<string, number>; usd: number; at: string };
  rollout?: { layer: string; id: string };
  pr?: { branch: string; afterHash: string; url?: string };
};
```

Keys: `learn:prop:{id}` (json; no TTL while open, 180 days after a final status), `learn:props` (sorted set by `createdAt`), `learn:open` (set). At most 3 proposals per target per run and 30 open in total: the oldest open proposal for the same target and layer is marked `superseded` when a newer one replaces the same text.

### 6.3 Evidence the founder can open

Evidence of kind `item` points to a real task or chat reply in some workspace. The proposal stores only `n`; the location is server-side in `learn:ev:{id}` (hash, field `n` → `{scope, taskId}` or `{scope, conv, msgId}`, TTL 90 days), written by the cron from the workspaces it read. `GET /api/admin/learn/{id}/evidence/{n}` (founder only) reads the stored location and returns the item's title, type, text excerpt (at most 1,500 characters), the judge's score and note, and the owner's reason, rendered as text. The browser never sends a scope, email or task id (the #316 feed pattern). For each scope used, the cron adds the proposal id to `learn:evof:{email}`; `wipeAccount` deletes the fields that point at the account and that set, so a deleted account leaves no pointer behind and its evidence reads "no longer available".

### 6.4 Prompt-injection and leak defences

Proposal text is derived, through a model, from data that tenants wrote. It is untrusted until the founder approves it, and checked again after.

1. **No tenant text in, so none can come out**: the proposer prompt carries labels, numbers, golden notes (fictional brands) and Thakeen's own current texts only (5.2).
2. **Schema in code**: the answer must parse as `{proposals: [{target, op, before_ref?, after, reason, evidence: number[]}]}` with at most 3 items; `target` must be one of the enums for this run's target (never layer 0, never a workspace layer, never `reviewer` or `judge`); `before` is taken by code from the current text (the model can only point at a section heading or an instruction id that exists); evidence numbers must exist. Anything else is dropped and counted (`refused:schema`).
3. **Screens on `after` and `reason`**: #316's `normalizeInstruction` and `screenInstruction` (`injection`, `authority`, `secret`), a length cap (2000 for layers 2-3; a base section at most +1,500 characters), and a new **leak check**: no URL, email, phone, @handle or long digit run, and no token of the brand names of the workspaces that contributed to this run's signals (the cron holds them in memory, never stores them). A hit sets a flag; a flagged proposal is shown with the reason and **cannot be approved until edited and clean**.
4. **Reviewer and judge are out of reach**: the loop never proposes for them (6.2 schema), because the judge is the measure used in sections 8 and 10.
5. **Never auto-merged, never auto-applied** (D2). Approve is a founder click in the console; a base proposal becomes a PR that the founder merges.
6. **Re-checked at every later step**: on approve (the edited text too), on rollout start, on finish, and at render (#316 already screens every stored item at render). The code gates (layer 0) do not read prompts at all, which stays the real protection.

## 7. The Proposals queue (`/{lang}/admin/skills`, tab "Proposals")

#316's section gets three tabs: **Platform** (its editor, now with a layer picker: Platform, Plan: trial … agency, Industry: each playbook id), **Proposals** (this section) and **Rollouts** (section 9). The section stays one entry of `ADMIN_SECTIONS` (`skills`), so no new nav row.

Proposals tab:
- Filters: target agent, layer, status (open by default). A badge on the nav row counts open proposals.
- A row: agent, layer and file or set, op, a one-line summary, flags, age, estimated golden cost.
- Open a row: the diff (before and after side by side, RTL-aware), the reason (as text), the evidence list (labels with counts, stats, golden cases, and item links that open the evidence viewer in a dialog), the run that made it and its cost.
- Actions, each through `useConfirm` / the console's form dialog (no `window.prompt`, see the companion spec), each audited:
  - **Approve**: for layers 2-3 the proposal becomes `approved` (it does not change any prompt yet; rollout is section 9). For base layers it becomes `approved_pr` and shows the Claude brief (section 11).
  - **Edit, then approve**: the `after` text is editable in place; the edit runs the same screens (6.4); `decision.editedFrom` keeps the model's text.
  - **Reject**: a reason is required (3-200 characters). Rejected proposals and their reasons go back to the next run of that target as "already rejected, do not repeat" (Thakeen's own text, not tenant data).
  - **Golden check**: section 8.
- A proposal whose `baseHash` no longer matches the target (someone edited the set or the playbook since) is shown `stale`; Approve answers 409 `stale` and offers "Re-run proposer for this target".

Every decision runs under `learn:lock:prop:{id}` (`SET NX`, 30 s), checks the status it expects (a second click answers 409 `already_decided`) and pushes `admin:log` through the companion spec's `adminAudit` with section `skills`, action `learn:approve|edit_approve|reject|golden|rollout|finish|rollback`, target `{kind: "proposal", id}`, before/after status and texts, and the reason.

## 8. Golden A/B check, on click only (D3)

- The button shows the server's estimate first: **"Golden check: $0.42 (candidate only, baseline reused from run g-… of 2026-10-10)"** or **"$0.84 (baseline and candidate)"**. The estimate is the measured `usd` of the latest run's cases for this target's agent (per-case cost where recorded, else the run's `usd` divided by its cases), for the cases of that agent only (`runGolden`'s existing `agent` option).
- **Baseline reuse**: the latest normal golden run is reused as the A side only when it has the same `GOLDEN_VERSION`, the same `promptHashes(...)`, the same platform and layer-3 hashes for this agent, and is under 7 days old. Otherwise both sides run.
- The click sends `{confirm: true, nonce}`; the server claims `learn:golden:{nonce}` (`SET NX`, 10 minutes) so a double click runs once. Founder-only, rate-limited (6 an hour, 20 a day), refused while the model is paused.
- The candidate side runs the real pipeline with the candidate applied in memory: for layers 2-3, `loadLayers` is given the candidate set for the target layer; for a base proposal, golden's `generate` receives a `playbookOverride` for that one file (a new option used only by golden, never by customer paths; a source test pins that only `golden.ts` passes it).
- Candidate runs are stored apart (`golden:abruns`, capped 100, rows with `candidate: {proposalId}`), so the weekly run list, its deltas and its regression alerts never see them.
- Result on the proposal: overall delta, per-case delta, hard-check changes, cost. The UI shows the number and a plain note: "one golden run is noisy; under ±2 points means no measurable change".
- Metered as platform cost (`golden@nashr.internal`, kind `golden`), never charged to anyone.
- A good score **does not** approve or activate anything (D2). It is information for the founder's decision.

## 9. Staged rollout (D4)

### 9.1 What can be rolled out

Approved proposals for layers 2 and 3 (Redis layers). Base proposals ship in a release (section 11); to try a base change on real traffic first, the founder can approve it as a platform instruction (layer 2) instead, roll it out, then promote it (11.3).

### 9.2 Starting and ramping

- **Start** (founder click on an approved proposal): pick a share from {5, 10, 25, 50}% (default 10). The server builds the candidate set = the layer's active set with the proposal applied, re-screens it, and writes `Layer.rollout` (expand of #316's `Layer`):

  ```ts
  rollout?: { id: string; proposalId: string; set: InstructionSet; pct: number; salt: string; startedAt: string; by: By; controlV: number; steps: { pct: number; at: string; by: By | "auto-rollback" }[] }
  ```

- One rollout per layer at a time, and one per agent target across layers, so a change in the counters has one cause (409 `rollout_running`).
- While a rollout runs, activating a new version of that layer in the #316 editor answers 409 `rollout_running`: the founder finishes or stops the rollout first.
- **Ramp up** only by founder click, never by the watch job. Default path 10 → 50 → 100 (founder answer Q2, section 18), with 5 and 25 still selectable; the ramp button stays off until the treatment arm has at least 3 days and 30 judged items since the last step. Nothing moves forward automatically (D2).
- **Finish** (at 100%, founder click): the candidate set becomes the active set as a new revision through #316's store (`activate` with `note: "learn:{proposalId}"`), `rollout` is cleared, the proposal becomes `live`.
- **Stop** (founder click, reason required): `rollout` is cleared, the active set (control) stays; the proposal goes back to `approved`.
- Starting a rollout is refused unless the control center flag `learn_rollout` is on (companion spec), which the founder turns on only after the release that carries the rollout reader is live everywhere. This protects the expand step: old code that rewrites a `Layer` without knowing `rollout` cannot run at the same time as a rollout.

### 9.3 Deterministic bucketing

`inTreatment(scope, rollout) = (first 4 bytes of sha256(rollout.salt + ":" + scope) as uint32) mod 10000 < rollout.pct * 100`.

- `salt` is random per rollout, so the same workspaces are not always the first to get changes.
- A workspace stays in the same arm for the rollout's whole life (the scope does not change), and raising `pct` only adds workspaces.
- A plan or industry rollout buckets only the workspaces of that plan or industry (the others never read that layer).
- `scope === null` (golden, the admin test against the sample brand) is always control.
- `loadLayers` applies `rollout.set` in place of `active` for treatment scopes; the task's stamp gets `ro: "{rolloutId}:b"` (or `:a`), and `plat` / `tier` differ between arms by construction, so the counters (5.3) separate the arms.

### 9.4 Prompt cache

Block 1 differs between arms, so a rollout creates a second cached variant of block 1 for the treatment arm. The cost is one cache write per arm per agent type, accepted. `tests/prompt-cache.test.ts` is extended: block 1 is identical for two brands in the same arm.

## 10. Automatic rollback (D4)

`GET /api/cron/learn-watch` (new, `CRON_SECRET`, hourly `0 * * * *`; reads counters only, no model call, cost nil). For each running rollout and each proposal finished in the last 14 days:

- **Compare** treatment against control over the rollout's window from `lstat` (one `mget` of the day keys of both arms): mean judge score, auto-fail rate, rejection rate, edit share, thumbs-down rate, and distinct workspaces.
- **Minimum sample before any judgment**: 30 judged items and 8 distinct workspaces in the treatment arm, and 3 days since the last step. Below that the rollout shows "collecting".
- **Roll back when any is true** (defaults in code; the founder may tighten them in the control center, not loosen them past the code bounds):
  - mean judge score of treatment < control − 4 points;
  - auto-fail rate of treatment > control + 3 percentage points, with at least 3 auto-fails;
  - rejection rate > control + 8 points, with at least 20 decisions;
  - thumbs-down rate > control + 5 points, with at least 20 rated replies;
  - any candidate item refused by the render-time screen (should never happen; it means something changed after approval).
- **Rolling back** during a rollout = clear `rollout` (the control, already the approved active version, stays). After a finish = restore the previous revision through #316's `restore` (an earlier approved version), compared against the 14 days before the finish.
- The watch job can only do those two things: lower to no rollout, or restore an older revision that was active before. A source test pins that it calls no `activate` with a new set and never raises `pct`.
- Every automatic rollback writes `adminAudit` with actor `auto-rollback`, the numbers that triggered it and the rollout id, sets the proposal to `rolled_back`, and notifies the founder (the existing founder notification path, `notifyItem` to `adminEmails()`, and a banner in the console).

## 11. Base-layer proposals: a branch and a PR via Claude

### 11.1 Why not a Redis write

Layer 1 is code-reviewed content that is stamped by file hash (`playbookHash`) and released through staging and a release PR (`flows.md` section 52). Writing it from the app would bypass review, staging and the release; D5 makes it the strongest prompt layer, so it gets the strongest path.

### 11.2 The path

1. Approve a base proposal → status `approved_pr`. The app writes nothing to any prompt.
2. The console shows **"Copy for Claude"**: a short brief the founder pastes into a Claude Code session in the Nashr repo, for example:

   ```
   Apply learning proposal LP-3f9c2a1b07de (approved 2026-10-13 by the founder).
   File: content/skills/marketing.md, section "## Hooks". Base hash: 9a1c… (the file's playbookHash when proposed).
   Diff:
   <unified diff>
   Make branch claude/playbook-LP-3f9c2a1b07de from origin/main, apply only this diff, run npm run check,
   add docs/system/tests/NNNN-playbook-LP-3f9c2a1b07de.md if a rule changes, open a draft PR. Do not push anything else.
   ```

   The brief is data from the app, not instructions to follow blindly: Claude checks the diff touches only that file and section, that the base hash matches the file on main (else it reports stale), and follows CLAUDE.md (draft PR, one push, no merge).
3. The founder merges as any PR, then a release PR moves it live.
4. The app marks the proposal `live` when it sees `playbookHash(file)` equal to the `afterHash` it computed at approval (checked by `learn-watch`), and the counters (5.3) then measure it by the `skills` part of the stamp. Rollback of a base change is a git revert and a release, as for any code.

No GitHub token is added to the app (founder answer Q5, section 18).

### 11.3 Promote to playbook

A platform instruction that has been `live` for 14 days without a rollback can be **promoted**: the console builds a base proposal (append the text to the agent's playbook section), and after the release that carries it is live, offers "Retire from platform layer" (a normal #316 activation removing that item, with a confirm). The platform layer stays short; the playbook holds what has proven itself.

## 12. Stored shapes and releases (rule 679)

| Key or field | Change | Expand | Contract |
|---|---|---|---|
| `learn:prop:{id}`, `learn:props`, `learn:open`, `learn:ev:{id}`, `learn:evof:{email}`, `learn:sig:{agent}:{week}`, `learn:budget:{week}`, `learn:runs`, `learn:lock:*`, `learn:golden:{nonce}`, `golden:abruns` | new keys | new code only | none |
| `lstat:*`, `lstatws:*` | new keys | new code only | none |
| `skills:plan:{plan}`, `skills:industry:{id}` (+ `skillshist:` / `skillslock:` of the same names) | new keys, #316 `Layer` shape | `loadLayers` reads them; absent = empty | none |
| `Layer.rollout` on `skills:platform`, `skills:plan:*`, `skills:industry:*` | new optional field | readers ignore it until the flag `learn_rollout` is turned on; `parseLayer` must keep it (it may not rebuild the object without it) | none |
| `Instruction.lock` | stops affecting precedence | still read and stored; render ignores it | a later release drops it from `Draft` and the editor |
| `PromptStamp.tier`, `PromptStamp.ro` (`Task.pb`, golden rows) | new optional fields | old tasks read as before | none |
| `ChatMsg.pb` | new optional field | old messages have none and are not counted | none |
| `GoldenRun.candidate` (only in `golden:abruns`) | new optional field | weekly list unchanged | none |

No one-time data conversion is needed. `wipeAccount` gains `learn:evof:{email}` and the matching `learn:ev` fields; `skills:plan:*` and `skills:industry:*` are platform keys and are never wiped with an account.

## 13. Routes, auth, rate limits

| Route | Who | Auth first | Rate limit |
|---|---|---|---|
| `GET /api/cron/learn` | C | `sameSecret(bearer, CRON_SECRET)` | lock `learn:lock:run` |
| `GET /api/cron/learn-watch` | C | `sameSecret` | lock `learn:lock:watch` |
| `GET /api/admin/learn` | F | `adminActor(req)` | 300/hour per actor |
| `GET /api/admin/learn/{id}` | F | `adminActor` | 300/hour |
| `GET /api/admin/learn/{id}/evidence/{n}` | F | `adminActor`; location from `learn:ev:{id}` only | 300/hour |
| `POST /api/admin/learn/{id}` (`approve`, `edit_approve`, `reject`, `golden`, `rollout_start`, `rollout_step`, `rollout_finish`, `rollout_stop`, `promote`, `retire`) | F | `adminActor`, then body | writes 120/hour; `golden` 6/hour and 20/day; every 429 with `Retry-After` |
| `POST /api/admin/learn/run` (`{target, confirm, nonce}`) | F | `adminActor` | 4/hour |
| `GET/PUT/POST /api/admin/skills` (#316) | F | `adminActor` | #316's limits; gains `layer: "platform" | "plan:{plan}" | "industry:{id}"`, validated against the enums, never used raw in a key |

No public route is added. No route accepts a scope, email or Redis key from the request.

## 14. Permissions rows (proposed for `permissions.md` section 1.7 and 1.8)

| # | Method | Path | Who | Checks |
|---|---|---|---|---|
| 200 | GET | `/api/cron/learn` | C | `sameSecret`; lock; budget caps before each call; writes `learn:*` only |
| 201 | GET | `/api/cron/learn-watch` | C | `sameSecret`; reads counters; may only clear a rollout or restore an older revision |
| 202 | GET | `/api/admin/learn` | F | `adminActor`; queue, runs, rollouts, budget |
| 203 | GET | `/api/admin/learn/{id}` | F | `adminActor`; one proposal |
| 204 | GET | `/api/admin/learn/{id}/evidence/{n}` | F; location from server-held `learn:ev` | `adminActor`; excerpt capped; no scope in the request |
| 205 | POST | `/api/admin/learn/{id}` | F | `adminActor`; per-proposal lock; status precondition; screens; `adminAudit` |
| 206 | POST | `/api/admin/learn/run` | F | `adminActor`; `confirm` and nonce; weekly budget |
| 207-209 | | reserved | | |

## 15. Environment variables

**None new.** Names this work reads (meaning unchanged): `CRON_SECRET` (both crons), `ANTHROPIC_API_KEY`, `LLM_PROVIDER`, `STRAITLY_API_KEY` (through `anthropic()`), `ADMIN_EMAILS` and `WAITLIST_ADMIN_KEY` (the console gate). Caps and thresholds are code constants with a bounded Redis override in the control center. The two new crons are scheduled in hPanel by the founder (and listed in `vercel.json`).

## 16. Tests and rules (1020-1049)

Listed in `docs/system/tests/1020-agent-learning-loop.md`, all "designed, not pinned" until built.

| # | Rule |
|---|---|
| 1020 | Prompt order and precedence lines follow D5; `for_you` no longer overrides `for_all_agents`; workspace never overrides platform |
| 1021 | Layer 3: `skills:plan:{plan}` / `skills:industry:{id}` keys only from enums; rendered between platform and workspace; one `mget` with the other layers |
| 1022 | `lock` is read and stored but no longer orders or marks items at render (expand) |
| 1023 | `PromptStamp.tier` and `ro`; old tasks read unchanged |
| 1024 | `lstat` counters incremented at judge and decision time from the task's own stamp; no tenant data in the key or the fields |
| 1025 | `ChatMsg.pb` set on new replies; thumbs counted per version; old messages ignored |
| 1026 | Accounts with `learning: false` and the golden account contribute no signal |
| 1027 | No tenant free text in the proposer prompt (source and fixture test: a planted sentence never appears in the request) |
| 1028 | `redactForLabels` removes URLs, emails, phones, handles, digits and the workspace's brand, product and city tokens |
| 1029 | Labels from the closed list only; unknown index or label is `other`; the label model's text is not stored |
| 1030 | K = 5 distinct workspaces before a label enters the prompt |
| 1031 | Cron auth with `sameSecret`; single-run lock; resume |
| 1032 | Budget checked before every model call; weekly and per-target caps; over-cap targets skipped |
| 1033 | Proposer and label calls metered as platform (`learn@nashr.internal`, kind `learn`); no import of credit modules |
| 1034 | Proposer answer validated against the schema; never layer 0, a workspace layer, the reviewer or the judge |
| 1035 | `after` and `reason` screened (#316 screen plus leak check); a flagged proposal cannot be approved until clean |
| 1036 | Diff computed in code; `baseHash` mismatch answers 409 `stale` |
| 1037 | Evidence locations held server-side; the route takes only id and n; account wipe removes them |
| 1038 | Approve, edit-approve, reject under a per-proposal lock, status precondition, reason on reject, `adminAudit` row |
| 1039 | No path from cron or watch to activate, rollout start or ramp (import and source tests) |
| 1040 | Golden check only with `confirm: true` and a fresh nonce; estimate returned before; candidate runs in `golden:abruns` only |
| 1041 | Baseline reuse only with same version, hashes and age under 7 days |
| 1042 | `playbookOverride` passed only by `golden.ts` |
| 1043 | Rollout start only on an approved proposal, with flag `learn_rollout` on; one per layer and per agent target; editor activation refused while running |
| 1044 | Bucketing deterministic, salt per rollout, monotonic in `pct`, null scope always control |
| 1045 | Watch: minimum sample, thresholds, rollback by clearing or restoring an older revision; never forward |
| 1046 | Finish makes the candidate active as a new revision with the proposal noted |
| 1047 | Base proposals write no prompt layer; Claude brief contains file, base hash and diff; `live` only when `playbookHash` equals `afterHash` |
| 1048 | Routes authenticate first; rate limits as section 13; no scope, email or key from the request |
| 1049 | Reserved for follow-ups |

## 17. Build order and estimates

Prerequisite: #316 merged and live; the companion spec's phase 1 (`adminAudit`, control state, flags) for the audit helper and the `learn_rollout` flag.

| Phase | Content | Estimate |
|---|---|---|
| A | Layer 3 store and editor tab, D5 precedence lines, `lock` expand, stamp `tier` (rules 1020-1023) | 1.5 days |
| B | Version counters, `ChatMsg.pb`, Quality "by prompt version" table (1024-1025) | 1.5 days |
| C | Signals: collection, redaction, labels, K threshold (1026-1030) | 2 days |
| D | Proposer cron, budget, proposals store, Proposals tab, evidence viewer, decisions (1031-1039) | 3 days |
| E | Golden A/B on click (1040-1042) | 1.5 days |
| F | Rollout, bucketing, watch cron, auto-rollback, Rollouts tab (1043-1046) | 2.5 days |
| G | Base proposals: Claude brief, live detection, promote and retire (1047) | 1 day |

Total about 13 working days, one draft PR per phase or two, per the CI rules in CLAUDE.md.

## 18. Founder questions, answered

Founder decision 2026-10-11 («موافق على الكل»): every recommended answer below is accepted as written.
The privacy sentence from Q1 is added to the drafts in `docs/legal/` (PR #325) for the lawyer's review.

| # | Question | Decided answer |
|---|---|---|
| Q1 | May anonymised, aggregated signals from all accounts with learning on (labels and counts, never text, at least 5 workspaces) improve the platform defaults? Does the privacy policy need a sentence? | Yes, on for accounts with learning on, off for those with it off; add one sentence to the privacy policy ("we use counts of anonymous feedback categories across accounts to improve the agents; never your content"). |
| Q2 | Rollout defaults: steps and thresholds | Start at 10%, then 50%, then 100%; at least 3 days and 30 judged items in the treatment arm between steps; roll back on −4 judge points, +3 points auto-fail rate, +8 points rejection rate or +5 points thumbs-down rate. |
| Q3 | Weekly budget for the proposer | $10 a week cap, $1.50 per agent, Sonnet 5.5 for proposals, Haiku 5.5 for labels. Expected spend about $2 a week. |
| Q4 | Should the loop also suggest instructions to a single client (layers 4-5), shown to the owner, not to you? | Not in version 1. Later as an owner-facing card in that workspace (the owner approves, as with #316's chat proposals), with the founder feed showing it. |
| Q5 | Base-layer changes: Claude brief pasted into Claude Code, or let the app open PRs with a GitHub token? | Claude brief. No new secret in the app, and every playbook change goes through a Claude session that runs the checks. |
| Q6 | D5 means a client's per-agent instruction can no longer override the same client's general instruction (it could in #316). Confirm? | Yes, as decided: per-agent adds detail; on a direct conflict the general one wins. The Instructions page says so next to the agent picker. |
| Q7 | May the loop ever propose changes to the reviewer or the judge? | No. They are the measure. You edit them by hand in the Platform tab, and a judge change bumps `GOLDEN_VERSION`. |
