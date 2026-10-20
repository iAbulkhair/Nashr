# WhatsApp inbound: talk to the team from WhatsApp (design)

Status: **Draft, waiting on the founder's decisions in section 10; no code until then; post-launch (after 2026-11-01).** Written 2026-10-20 on branch `claude/whatsapp-inbound-spec` from main `051e437`. Item 5 of the OpenDots adoption order (`docs/OpenDots_Adoption.md` section 4). Rules **2540-2549** are reserved for this work, not yet pinned.

## 1. Why

PRODUCT.md calls the Gulf SMB owner "WhatsApp-heavy". Today an owner reaches the team only in the web app or through a connected assistant over MCP. OpenDots' Slack channel shows a pattern that fits:

- the owner messages an agent from the channel they already live in;
- the turn runs through the same gates as the app;
- anything that needs an approval card answers "continue in the app".

This spec takes that pattern for WhatsApp. It is **inbound conversation only**: the owner, or a named teammate, talks to Noor. Sending marketing messages to the brand's customers is a different product (Meta's template review, opt-in, the brand's own number) and is not in scope (section 9).

## 2. What exists today (read from the code at `051e437`)

| Piece | Where | What it gives this design |
|---|---|---|
| The chat turn | `src/lib/chat.ts` `chat(user, text, conv, agentId, opts)` | One entry for every turn. It saves the owner's message, runs the agent-scope input gate, reads governance and tool authority (`getGov`, `toolsFor(agentId, gov.toolPolicy)`, `policyNote`), and loops tools under the per-message ceiling (`CHAT_TURN_MAX_USD`, `src/lib/pricing.ts:226`). `ChatOpts.via` is `"app" \| "mcp"` (`src/lib/chat-reply.ts:41`). |
| A non-app channel already | `src/app/api/mcp/route.ts:90-115` | MCP `ask_noor` runs the web chat's gates in the web chat's order: the plan includes the agent (rule 782), `trialOver`, `chatRefusal` with `agentScopePreflight`, the shared monthly allowance `reserveChatTurn` (`src/lib/chat-allowance.ts`), then `chat(..., { by: tokenBy(user), via: "mcp" })` inside `runChatTurn`. WhatsApp follows the same sequence. |
| What a non-app channel may not do | `src/lib/chat-run-tool.ts` | With `via === "mcp"`: no publishing (`:240`), no core-memory overwrite (`:209`), no catalog import (`:370`), no handoff, instruction, away or meeting proposals (`:299`, `:313`, `:328`, `:356`), and brand changes wait for the owner's Save in the app (`:190-197`). |
| Paid work | `src/lib/chat-gates.ts:61-76` `spendGate` | Paid work runs straight away only when the owner's own message asked for it in words. Otherwise the app gets a card (`proposeSpend`), and MCP is refused, since MCP cannot show a card. Ask first (rule 2433) always needs the card. |
| Who is talking | `src/lib/mcp.ts:71` `userFromBearer`, `src/lib/actor.ts:61` `tokenBy` | A bearer resolves only to an owner account. Activity rows name the connected app, not "owner". |
| An inbound webhook pattern | `src/app/api/ops/telegram/callback/route.ts`, `src/lib/ops.ts:36-39` (#405) | Per-IP `allow(...)` first, then a provider secret header compared with `sameSecret` (401 while unset), then always 200, so the provider does not resend. |
| WhatsApp today | `src/lib/connectors/registry.ts:116,133`, `src/lib/integrations.ts:18`, `src/lib/help.ts:106` | WhatsApp Business is listed as Composio-only, and on the founder page as "soon": templates are written for Meta's review and the owner sends them. Nothing in the code receives WhatsApp messages. |
| The owner's phone | `src/lib/auth.ts:96,396` | `User.phone` is typed at signup and normalised, but never verified. It must not identify a sender (section 4.2). |
| Secrets at rest | `src/lib/connectors/store.ts` | AES-256-GCM with `CONNECT_SECRET` and key versions (rule 1351). |

## 3. What OpenDots does (from `docs/OpenDots_Adoption.md`, the Slack row)

- Mention a Dot and continue in the thread.
- A workspace and user allowlist.
- Edits and bot messages are ignored.
- Approval-gated tools are not available in Slack: "continue in the web app".
- Errors are reduced to a name and a status.

It has a single owner, so its allowlist maps to that owner. Thakeen must map each sender to a real login with a role (section 4.2).

## 4. Design

### 4.1 Provider (founder decision 1)

| Option | What it is | For | Against |
|---|---|---|---|
| A. Meta's WhatsApp Cloud API, direct | Thakeen's own Meta app, a Thakeen business number, and a webhook to Thakeen | No middleman; Meta's own signature on every webhook; prices straight from Meta | Thakeen does Meta business verification and number registration itself; one more vendor relationship |
| B. A Meta Business Solution Provider (BSP) | A BSP hosts the number and forwards webhooks | Faster onboarding; support in the region | A second party sees every message; BSP fees on top of Meta's; a different signature scheme per BSP |
| C. Composio's WhatsApp toolkit | The registry's current listing (`COMPOSIO_ONLY`) | Already a vendor | Rule 652: no model reaches Composio. Whether Composio forwards *inbound* messages at all is unverified. Not recommended for a conversational channel. |

**Recommendation: A.** Inbound conversation is a security surface (sender identity, untrusted text), and the fewest parties in the path is safest. One Thakeen number serves every customer, and the sender, not the number, picks the account.

### 4.2 Linking a WhatsApp number to a login (proof, not the signup phone)

`User.phone` is unverified, so a message from a number that equals some account's `phone` proves nothing. Linking is explicit and proves possession:

1. In the app (Settings → Connections → WhatsApp), a signed-in person presses "Link WhatsApp". The app shows a one-time code, 8 characters from a 32-character alphabet, valid 10 minutes, one at a time per person and account. It also shows a `wa.me` link to Thakeen's number with the code prefilled.
2. The person sends the code from their phone. The webhook finds the code (`globalKey.waLinkCode(hash)`, the SHA-256 of the code, never the code itself) and links the sender's number to that person in that account. The code is deleted, so it works once.
3. The link is `{ pid, aid, scope, role at link time, linkedAt }` under `globalKey.waSender(hash of E.164)`. Every message re-reads the person, the account and the membership, as a session does (multi-workspace M1, flows section 93 item 6): a removed, paused or suspended membership is refused at the next message. A plain phone number is never used in a key, so a key leak does not list numbers.
4. Unlinking is a button in the app. Removing the member (`deleteMembership`) and deleting the account (`wipeAccount`) also delete the link: both are added to the wipe lists, as #404 did for run receipts.

Who may link (founder decision 4): **owner only** (recommended for v1), or any member with `chat` access.

### 4.3 The inbound route

`/api/whatsapp/webhook` (under option A):

- **GET**, Meta's subscription check: answers the challenge only when `hub.verify_token` equals `WHATSAPP_VERIFY_TOKEN` (`sameSecret`); otherwise 403.
- **POST**, in this order, mirroring the Telegram callback:
  1. Per-IP `allow("wa:ip:"+ip, ...)`.
  2. Read the body with `readCapped` (`src/lib/read-capped.ts`), then check the `X-Hub-Signature-256` HMAC-SHA256 of the raw body against `WHATSAPP_APP_SECRET`, compared with `sameSecret`; 401 while either is unset. Assumption to verify against Meta's current documentation: header name, algorithm and raw-body requirement.
  3. Answer 200 at once for anything well signed, and do the work in `after()`, so Meta does not resend because of the model's latency.
  4. Dedupe on Meta's message id with a `setNx` marker for 7 days (`globalKey.waSeen(id)`): a resent webhook runs nothing twice.
  5. Ignore status updates, reactions, edits and messages from numbers that are not linked. An unlinked number gets at most one reply a day: "This number is not linked to a Thakeen account. Link it from the app." A link code is the one exception.
  6. Text messages only in v1. A voice note, image or document gets a polite "text only for now" (voice notes are the voice spec's job, `2026-10-20-voice-design.md`).
  7. Per linked sender `allow("wa:sender:"+hash, ...)`, then the MCP route's gates in the same order (section 2). The turn is `chat(user, text, conv, "noor", { by: waBy(user), via: "whatsapp" })`, where `conv` is one conversation per linked sender (`wsKey.convs` as today).
  8. The reply goes out through Meta's send API, which only `src/lib/whatsapp.ts` calls, with a timeout. The reply is the model's text as plain text (no HTML; `render` in `src/lib/md.ts` is for the app's pages), cut to Meta's length limit (to confirm), with a deep link to the conversation in the app.

### 4.4 What can run from WhatsApp

`via` gains `"whatsapp"`. Every refusal that today reads `ctx.via === "mcp"` reads "not in the app" instead (`ctx.via !== "app"`), so a new channel never silently gets more than MCP has. Today's `ctx.via === "mcp"` checks are rewritten in one place with a test that lists them (rule 2545).

Paid work differs from MCP in one way, and it is the founder's call (decision 3):

- **3a (recommended).** The card is stored as in the app (`proposeSpend`, with the same `SPEND_CARDS_PER_REPLY`). The WhatsApp reply says what it would cost and gives the link to the conversation, where the owner presses Run in a signed-in session. Approval stays in the app, bound to the stored call.
- **3b.** As MCP: refused, "say it in the app".
- **3c.** A WhatsApp reply of "Run" runs the card. **Not recommended:** a message from a linked number is weaker proof than a signed-in session, and a "yes" sent by mistake would spend credits.

Publishing, brand changes, core memory, catalog import and every other card stay app-only, as for MCP.

### 4.5 Proactive messages (not in v1)

Meta allows free-form replies only inside a customer-service window after the person's last message. Assumption: 24 hours; verify against Meta's current rules. Outside it, only pre-approved templates may be sent. v1 replies only to messages it receives. Notices (a held run, a refund, a draft waiting) stay in-app and email. A later step could send one approved template ("You have N items waiting in Thakeen"). That step needs Meta's template approval and the owner's opt-in, and it is out of scope here.

### 4.6 Security checklist (CLAUDE.md)

- **Authentication first:** Meta's signature, and the verify token for GET.
- **Rate limits** per IP and per sender, from `src/lib/rate.ts`.
- **Tenant isolation:** the scope comes from the stored link and the re-read membership, never from the message.
- **Untrusted input:** the message text is the owner's words, but the reply may quote tool output. The model is never the only approval: cards stay in the app.
- **Secrets:** compared with `sameSecret`, never logged; the access token is used only in `src/lib/whatsapp.ts`.
- **Redis:** no `await db.*` in a loop. One webhook body can carry several messages: handle them with `pmap`.
- **Logs** hold the message id and the outcome, never the text or the phone number.

## 5. Money

- **Thakeen's side:** each inbound message is one chat turn and counts against the monthly chat allowance (`reserveChatTurn`), exactly as MCP `ask_noor` does. Overflow on credits works the same. No new credit price.
- **Meta's side:** **to confirm with Meta (or the BSP).** Questions to ask:
  - Are replies to user-started conversations charged in KSA today, and how is a "conversation" counted?
  - Per-message or per-conversation pricing for service versus utility versus marketing categories in Saudi Arabia.
  - Business verification requirements and any monthly fee.
  - Throughput and tier limits for a new number.
  - Webhook retry behaviour.
- **The margin floor (60%, `src/lib/pricing.ts`):** if Meta charges per reply, that cost is added to the message's metered cost before the floor check. The founder chooses whether Thakeen absorbs it or WhatsApp is limited to plans whose margin covers it (decision 2).

## 6. KSA specifics (assumptions marked)

- **PDPL** (Saudi Personal Data Protection Law): phone numbers and message text are personal data. Questions for counsel:
  - Does the processing location of Meta's Cloud API (assumption: outside KSA) need a cross-border transfer basis?
  - Does the privacy policy need a WhatsApp paragraph?

  Not answered here.
- **Arabic:** the chat already answers in the owner's language. WhatsApp text arrives as typed. No new dialect risk, unlike voice.
- **Meta policy:** the business number must follow WhatsApp Business policy. Assumption: an assistant replying to its own customers is allowed; verify.

## 7. Shapes and releases (rule 679)

- **Expand.**
  - New keys: `waSender:`, `waLinkCode:`, `waSeen:`, `waConv:` (builders in `src/lib/keys.ts`).
  - New `ChatOpts.via` value `"whatsapp"`; new `By` kind `whatsapp` for activity rows.
  - Older code never reads these keys. A rolled-back build ignores the webhook route, which then answers 404, and Meta retries until it gives up (to verify).
- **Contract.** None.
- **Environment variables** (named in `docs/system/variables.md` when built; never pasted): `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`.

## 8. Tests (rules 2540-2549, reserved, not yet pinned)

| Rule | Pins |
|---|---|
| 2540 | GET answers only the right verify token; POST without a valid signature is 401 and runs nothing |
| 2541 | A duplicate message id runs one turn |
| 2542 | An unlinked number gets one reply a day and no turn; a link code links exactly once, then is gone |
| 2543 | A removed, paused or suspended membership is refused at the next message; account deletion and member removal delete the link |
| 2544 | The turn passes the app's gates in order: plan, trial, burst, agent scope, allowance |
| 2545 | Every `via` refusal holds for `"whatsapp"`; a scan lists them so a new channel cannot be missed |
| 2546 | Paid work leaves a card and a link and charges nothing (decision 3a) |
| 2547 | Logs hold no text and no number; the access token appears only in `src/lib/whatsapp.ts` |
| 2548-2549 | Held for the build's findings |

## 9. Not in this spec

- Messages to the brand's customers: marketing, cart recovery, broadcast.
- Group chats.
- Media messages (voice notes go to the voice spec).
- Choosing an agent other than Noor by name in the message. v1 is Noor only, and a later "@Sami" prefix is easy to add.

## 10. Founder decisions needed

1. **Provider:** Meta Cloud API direct (recommended), a BSP (which one), or wait.
2. **Who pays Meta's fee:** absorbed under the margin floor, or WhatsApp limited to some plans (which).
3. **Paid work from WhatsApp:** card in the app plus a link (recommended), refuse as MCP does, or run on a WhatsApp "Run" (not recommended).
4. **Who may link a number:** owner only (recommended for v1), or members with chat access too.
5. **PDPL review** of Meta's processing location before launch of the feature: yes or no, and by whom.

## 11. Size and release steps

**M**, about 4-6 days with tests, once Meta's business verification and the number are ready. That paperwork has its own lead time, which I don't know; ask Meta or the BSP.

1. Founder: Meta app, business verification, number. Variables set in hPanel.
2. Build behind the variables. Unset means the route answers 401 to everything, and the Connections page hides the Link button.
3. Release (expand), link one founder number, and run a week of founder-only use.
4. Turn on the Link button for owners.
