# Outbound MCP client: agents use a workspace's own tools (design)

Status: **Decided in part on 2026-10-21 (section 10): yes, option A (any public server), Agency plan only. Still open: decisions 3 to 5. No code until those are settled; post-launch (after 2026-11-01).** Written 2026-10-20 on branch `claude/outbound-mcp-spec` from main `051e437`. Item 6 of the OpenDots adoption order (`docs/OpenDots_Adoption.md` section 4). Rules **2610-2619** are reserved for this work, not yet pinned.

## 1. Why

Agencies (segment 3) run their own systems: a CRM, a reporting stack, a content calendar. More and more of these expose an MCP server. Thakeen today is an MCP **server**: other assistants call Thakeen. It is not a client, so Thakeen's agents cannot read an agency's CRM or post a lead into it.

OpenDots lets the owner add any MCP server and gives each agent the discovered tools. That is valuable. It is also the riskiest item on the roadmap, because every outside tool's description and every result reaches the model as text the workspace does not control.

## 2. What exists today (read from the code at `051e437`)

| Piece | Where | What it gives this design |
|---|---|---|
| Tool authority | `src/lib/tool-authority.ts` | Five capabilities × eight agents, `on` / `ask` / `off`. `authorityOf` reads a **missing value as `on`** (`:45-51`), and `ask` only exists where a card can run the stored call (`ASKABLE`, `:35`). Outside tools cannot simply join `TOOL_CAPS`: their default must be `ask`, not `on` (section 4.3). |
| Enforcement points | `src/lib/chat.ts:113-117`, `src/lib/chat-run-tool.ts`, `src/lib/chat-gates.ts:61`, `src/lib/spend-proposals.ts` | The tool is not offered (`toolsFor`), refused at the call from the setting read then (`runTool`), turned into a card (`spendGate` with `ask`), and re-checked at the card's Run (`decideSpend`, 409 `revoked`). An outside write reuses all four, with its own card. |
| Approval bound to the stored call | spend, brand, file, instruction and handoff cards | Run executes the stored record, never the request body. Claims make a run happen once (`spendprop-claim:` `setNx`). |
| Outbound requests | `src/lib/safe-fetch.ts:103` `safeFetch` | http(s) only, no credentials in the URL, no private, loopback, link-local or metadata targets, every redirect hop re-checked, DNS pinned at connect time (rule 1342), a deadline on every call (rule 1343, `PROVIDER_TIMEOUT_MS` 30 s, `src/lib/fetch-timeout.ts:7`). |
| Capped reads | `src/lib/read-capped.ts` | `readCapped` with a byte limit and `TooLargeError`. |
| Secrets at rest | `src/lib/connectors/store.ts` | `saveConnection`/`getConnection` per brand scope (`wsKey.conn`), AES-256-GCM with `CONNECT_SECRET`, key versions and rotation (rule 1351). |
| Untrusted text for a model | `src/lib/json.ts:33` `asData`, `:41` `fenceMemory` | Serialises untrusted text so it cannot close its tag. Crawled pages, catalogs and files already go through it. |
| Composio | `docs/OpenDots_Adoption.md` (Composio row) | Reached only by code paths with a pinned read/write allowlist; no model ever reaches it (rule 652). Thakeen is stricter than OpenDots here, and this design keeps that posture. |
| MCP server | `src/app/api/mcp/route.ts`, `src/lib/mcp.ts` | Inbound only. Its `via: "mcp"` refusals show which actions Thakeen keeps app-only. |

## 3. What OpenDots does (from the study)

- The owner adds any MCP server.
- Tools are discovered, at most 100, with schemas at most 16 KB, under stable names.
- `readOnlyHint` seeds read-only "as a hint only".
- Tokens never leave the server, and URLs carrying credentials are rejected.
- Per-Dot, per-tool `enabled` plus `requiresApproval`. A global switch and a per-Dot switch are both required.
- A gated call returns an `approvalId`, and execution runs the stored arguments.

## 4. Design

### 4.1 A connection

A workspace (brand scope) adds an MCP server on Settings → Connections → "Your own tools". Only the owner may do this, through a new action `ext_tools` in `src/lib/roles.ts` whose minimum role is `owner`. It is stricter than today's `connectors` action (`admin`, `roles.ts:54`) because an outside server can reach every agent. The action is blocked while the founder impersonates the account (`IMPERSONATION_BLOCKED`).

- **URL.** https only, public host. `assertPublicUrl` at save time and `safeFetch` on every call. Streamable HTTP transport only: Thakeen runs no local process (no stdio servers).
- **Credential.** v1: a static bearer token or one header value the owner pastes. It is sealed with `saveConnection` under provider id `mcp:{n}` and never shown again, only replaced. OAuth to the outside server (the MCP authorization flow) is decision 4.
- **Limits.** At most `MCP_SERVERS_PER_SCOPE` connections (proposed 3), each with at most 50 tools. Each tool's description is cut to 1,000 characters and its input schema to 16 KB. A server over the limits is refused with the reason.
- **Health.** The last discovery's time and error code. Shown to the owner, never the server's raw error text.

### 4.2 Discovery and the owner's review

On save and on the owner's "Refresh", Thakeen calls `tools/list` through `safeFetch` with `readCapped`. Each tool is stored under a stable name, `ext_{n}_{toolName}` (sanitised, at most 64 characters), with:

- its description, fenced;
- its schema;
- the server's `readOnlyHint` as a **hint**.

**Nothing is offered to any agent until the owner reviews the list.** For each tool, the owner picks for each agent: Not allowed (the default for every agent), Ask first, or Allowed. Allowed is offered only for tools the owner marks "this only reads" (decision 3). The hint pre-fills that box; the owner's tick is what counts.

A tool whose description or schema changes on a later refresh goes back to Not allowed until it is reviewed again. A server can otherwise change what an approved tool does.

### 4.3 The policy (separate from `toolPolicy`)

`Governance.extPolicy: { [toolName]: { [agent]: "ask" | "on" } }`, where a **missing entry means `off`**, the opposite of `toolPolicy`. It is written by the same governance save, so it gets a revision, history and restore (`govDiff` paths `extPolicy.{tool}.{agent}`), and members see it read-only, as `toolPolicy` already is.

### 4.4 A call

1. **Offer.** `toolsFor` adds only the outside tools whose `extPolicy` for this agent is `ask` or `on`, with their names and fenced descriptions. A turn offers at most 20 outside tools.
2. **Call.** `runTool` re-reads the policy and the connection at the call. `off` or a removed connection refuses, and nothing is sent. Then:
   - `ask`: an **outside-tool card** (`ext-proposal`) stores `{tool, args, agent, conn, schemaHash}` and nothing is sent. The card shows the tool, its server's host and the arguments in plain text. Run re-reads the policy, the connection and the schema hash (any change: 409 `revoked`). A claim (`setNx`) makes it run once, and it sends the **stored** arguments.
   - `on` (read tools the owner ticked): the request is sent at once.
3. **Send.** A JSON-RPC `tools/call` through `safeFetch`: deadline 15 s, the reply read with `readCapped` at 256 KB. An audit row is written **before** dispatch (OpenDots' "audit before dispatch"): scope, agent, tool, a hash of the arguments, and who approved.
4. **Result.** Fenced as data (`<external_tool_result source="{host}">` with `asData`) and cut to 8,000 characters for the model. It never reaches core memory directly: `write_file` over a core file stays a file card (rule 2306).
5. **Never from MCP or WhatsApp.** Outside tools are offered only when `via === "app"`. A connected assistant or a phone message cannot drive an agency's CRM.

### 4.5 What the model can never do

- Add, edit or remove a connection.
- Change `extPolicy`.
- Choose the server URL, the credential or the host in a call. The call names a stored tool. Thakeen sends to the stored URL with the stored credential.
- Pass an outside result into publishing, a brand change or a spend without the card that action already needs.

## 5. Money

- An outside call costs Thakeen no model tokens beyond the turn it runs in, so **no credit price** is proposed. The turn's tokens are already metered under `CHAT_TURN_MAX_USD`. Results are cut to 8,000 characters partly to keep that ceiling.
- Bounded by rate, not credits: `allow("ext:scope:"+scope, EXT_CALLS_PER_HOUR)` (proposed 60) and per connection.
- Outside servers may charge the agency. That is between the agency and its vendor. The card's text says "this calls {host}; that service may charge you".

## 6. KSA specifics

- **PDPL:** an agency's CRM holds its customers' personal data. A tool result that passes through the model is processed by the model provider. Question for counsel: does this need wording in the agency's terms, and what does the data processing agreement say about where the model runs? Not answered here.
- Arabic: no specific risk. Results are data and are shown as received.

## 7. Shapes and releases (rule 679)

- **Expand.**
  - `Governance.extPolicy` (optional; absent means every outside tool is off).
  - Connection records with provider id `mcp:{n}`, which older code lists as unknown providers. To verify: `listConnections` callers ignore an unknown id.
  - `wsKey.extTools(scope, n)` for the discovered list, and `ext-proposal` cards next to the spend cards.
  - A rolled-back build offers no outside tool, because it does not read `extPolicy`.
- **Contract.** None.
- **Environment:** no new variable. Proposed code constants: `MCP_SERVERS_PER_SCOPE`, `EXT_CALLS_PER_HOUR`.

## 8. Tests (rules 2610-2619, reserved, not yet pinned)

| Rule | Pins |
|---|---|
| 2610 | Save refuses a private, loopback, metadata or credentialed URL. Every call goes through `safeFetch` (a source scan, as for crawls) |
| 2611 | A discovered tool is offered to no agent until reviewed; a changed description or schema goes back to off |
| 2612 | A missing `extPolicy` entry is off; `ask` leaves a card and sends nothing; Run sends the stored arguments once, and 409 after a policy, connection or schema change |
| 2613 | The audit row is written before dispatch |
| 2614 | Results are fenced and cut; a result containing `</external_tool_result>` cannot end the block |
| 2615 | No outside tool over MCP or WhatsApp |
| 2616 | Tokens are sealed, never returned by any route, never logged |
| 2617 | Rate limits per scope and per connection |
| 2618-2619 | Held for the build's findings |

## 9. Options (founder decision 1)

| Option | For | Against |
|---|---|---|
| A. Any public MCP server, every tool off until reviewed, writes always Ask first (this spec) | Agencies connect what they already run | The widest attack surface: a hostile server's descriptions reach the model (fenced, offered only after review) |
| B. A curated directory: only servers the founder approves by host | Far smaller surface; the founder vets each vendor | Slower to grow; the founder becomes the bottleneck |
| C. Read-only tools only, no writes at all in v1 | No outside write can ever happen | Half the value (posting a lead, creating a CRM task) |

**Recommendation: A, limited to the Agency plan for v1**, with C's rule as a switch the founder can flip if A shows abuse. B is a good fallback if the first agencies ask for the same three or four servers.

## 10. Founder decisions needed

1. **Yes or no**, and which option: A (recommended), B or C.
2. **Which plans:** Agency only (recommended for v1), or Business too.
3. **May read tools ever be Allowed** (run without a card), or is everything Ask first?
4. **Credentials:** a static token or header only in v1 (recommended), or OAuth to outside servers too, which is more work and more secrets to hold.
5. **Terms:** does the agency agreement need a paragraph on outside tools and personal data (counsel)?

### Decided by the founder on 2026-10-21

- **1. Yes, option A:** any public MCP server the owner adds, every discovered tool off until reviewed, every write behind a card.
- **2. Agency plan only** for v1.
- **PDPL:** a review before any feature that carries personal data through a third party ships (a standing decision, not to be asked again). Outside tools can carry customer data to the agency's own servers, so decision 5 (the agency terms) goes to the same review.
- **Still open:** 3 (may read tools ever run without a card; the recommendation stands: Ask first for everything in v1), 4 (static token only in v1; the recommendation stands), 5 (agency terms, with the PDPL review).

## 11. Size and release steps

**L**, about 8-12 days with tests: the connection screen, discovery, the review grid, `extPolicy` in governance, the card, the fencing and the audit.

1. Founder decisions.
2. Build behind a code switch `EXT_MCP = false`, as `MULTI_ORG` is.
3. Release (expand); founder-only testing against one public MCP server.
4. Turn on for the Agency plan.
