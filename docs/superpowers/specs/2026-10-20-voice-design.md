# Voice: talk to the team, through the same gated turn (design)

Status: **Draft, waiting on the founder's decisions in section 10; no code until then; post-launch (after 2026-11-01).** Written 2026-10-20 on branch `claude/voice-spec` from main `051e437`. Item 7 of the OpenDots adoption order (`docs/OpenDots_Adoption.md` section 4). Rules **2560-2569** are reserved for this work, not yet pinned.

## 1. Why

Gulf owners send voice notes more than they type. A voice entry would let an owner ask Noor or Reem something between meetings. The study's verdict on OpenDots' voice was "Later, founder decision": cost and Arabic-dialect quality are unproven. The bridge pattern is the part worth keeping: **voice never acts directly; it asks a normal, gated turn.** This spec turns that verdict into options the founder can choose between, with the questions to settle first.

## 2. What exists today (read from the code at `051e437`)

| Piece | Where | What it gives this design |
|---|---|---|
| The chat turn | `src/lib/chat.ts:49` `chat(user, text, conv, agentId, opts)` | The one gated turn. Every voice option ends in a call to it with text. |
| The chat route's time limit | `src/app/api/chat/route.ts:18` `maxDuration = 300` | A request lives at most 300 s. A live voice call cannot be held inside one Thakeen request (section 4.2). |
| The spend gate reads typed words only | `src/lib/spend-intent.ts:3-16`, `src/lib/chat-gates.ts:61` | Paid work runs at once only when "the owner's typed text" asked for it in words; otherwise a card. **Speech-to-text output is not typed text.** This spec treats every voice turn as not explicit, so paid work always waits on a card (section 4.4). |
| Chat allowance and ceiling | `src/lib/chat-allowance.ts`, `src/lib/pricing.ts:226` `CHAT_TURN_MAX_USD` | Each turn is counted and capped. Voice adds the audio cost on top (section 5). |
| Audio today | `src/lib/secretary-meeting.ts:33-35,362` | Reem's meeting "transcript" is **pasted text** (up to 40,000 characters, `MEETING_TRANSCRIPT_COST` 1 credit, `src/lib/pricing.ts:297`). The text is fenced, never stored, never logged. There is **no speech-to-text and no text-to-speech** anywhere in the code. |
| Media providers | `src/lib/media/` (fal, kie, higgsfield), `src/lib/media-catalog.ts:43` | Image and video renders with durable jobs and a sweep (`media/jobs.ts`). One video model renders with sound. None of them is a speech model in the code today, so voice would be a new vendor (decision 1). |
| Charging once | `src/lib/credits.ts` `chargeOnce`/`refundOnce` with claims | A voice minute charge can use a claim per call, as meetings and scheduled runs do. |

## 3. What OpenDots does (from the study)

- A realtime speech model with **one tool, `ask_compute`**, that runs a normal agent turn.
- One call at a time.
- A 15-minute cap.
- Six compute calls per call.
- Receipts posted into the thread.

## 4. Design

### 4.1 Three options (decision 2)

| Option | How it works | For | Against |
|---|---|---|---|
| A. Voice notes (record, then answer) | The owner records up to 60 s in the app chat. Thakeen sends the audio to a speech-to-text vendor and shows the transcript for the owner to **confirm or edit**. The confirmed text goes through `chat()` as a normal turn. The reply is text, with an optional "listen" button (text-to-speech) | Fits the 300 s request limit; the owner sees and fixes dialect errors before anything runs; the cheapest; the same path later serves WhatsApp voice notes (`2026-10-20-whatsapp-inbound-design.md` section 4.3 step 6) | Not a conversation; a few seconds of wait per note |
| B. Live call through a bridge (OpenDots' shape) | The browser opens a realtime session **directly with the vendor**, using a short-lived token Thakeen mints. The vendor's model has one tool, `ask_thakeen`. Each tool call is a normal authenticated request to Thakeen, which runs `chat()` and returns the reply text for the voice model to speak | Feels like a call; the gates are unchanged because every action is still a `chat()` turn | The vendor hears everything (data-residency question); per-minute cost is the highest; the voice model may paraphrase Thakeen's answer wrongly; the session lives outside Thakeen's limits, so caps must be enforced by token lifetime and by counting `ask_thakeen` calls |
| C. Wait | Nothing until a vendor proves Gulf-dialect quality on a test set | No spend | No voice |

**Recommendation: A first**, built so B can be added later on the same `chat()` bridge. A answers the real habit (voice notes), keeps a human confirm step in front of the gated turn, and costs only speech-to-text, plus text-to-speech when "listen" is pressed.

### 4.2 Why B cannot run inside a Thakeen request

Routes end within 300 s, and Hostinger's Node app is not built to hold long-lived sockets per user. Under B, the audio stream runs between the browser and the vendor. Thakeen sees only:

1. the token request (authenticated, rate-limited, one live call per account);
2. each `ask_thakeen` call, an ordinary POST with the session cookie, which runs one `chat()` turn.

Assumption to verify per vendor: an ephemeral client token with a server-set expiry, and tool calls returned to the browser. The token's expiry is the call's cap (proposed 15 minutes, as OpenDots). Thakeen also counts `ask_thakeen` calls per call (proposed 6) and refuses past them.

### 4.3 Flow for option A

1. **Record.** The chat composer gains a microphone button. Recording stops at 60 s. The audio stays in the browser until sent.
2. **Upload.** `POST /api/chat/voice`:
   - `currentUser()` first, then the same gates as a chat turn (plan, trial, burst, agent scope, allowance).
   - A size cap: about 1 MB. To confirm per codec.
   - `allow("voice:"+acct, VOICE_NOTES_PER_HOUR)`, proposed 20.
3. **Transcribe.** Sent to the speech-to-text vendor with a deadline. The audio is **not stored** by Thakeen, and the vendor's own retention is decision 4. The answer is the transcript only.
4. **Confirm.** The transcript is shown in the composer, editable. Nothing runs until the owner presses Send. That text is then sent as a normal message, marked `source: "voice"`.
5. **Reply.** Text, as today. "Listen" calls `POST /api/chat/speak` with the message id, never free text. The audio is generated from the stored reply, counted and capped, and streamed back without being stored.

### 4.4 Gates that change for voice

- **Paid work:** a message whose `source` is `voice` never passes `spendIntent`. Paid work always waits on a card, even when the confirmed transcript says "write 3 posts". A misheard word must not spend credits. The card already carries the price.
- **Everything else** (publishing, brand changes, core memory, governance) already needs a card or the app's own controls. Voice changes none of it.
- **Option B adds:**
  - `ask_thakeen` runs as `via: "voice"`, which takes every `via !== "app"` refusal, as WhatsApp does;
  - cards created during a call are shown in the app after the call;
  - the voice model is never given any other tool.

### 4.5 Security checklist (CLAUDE.md)

- Every route authenticates first and is rate-limited (`src/lib/rate.ts`).
- Vendor keys live only in the server module that calls the vendor. Under B, the browser gets only the short-lived token.
- Audio is not stored or logged. Transcripts are stored only as the owner's confirmed chat message.
- The transcript is the owner's words, but under B the vendor model's paraphrase is not: Thakeen acts only on `ask_thakeen` text, and that text is untrusted model output treated as a fresh message to the gated turn.
- No `await db.*` in a loop.

## 5. Money

All vendor prices are **to confirm with the vendor**. Questions to ask each candidate:

- Price per audio minute for speech-to-text, and whether it is billed per second or rounded up.
- Text-to-speech price per character or per minute, and whether Arabic voices cost more.
- Under B, the realtime price per minute for input and output audio, and the cost of tool calls.
- Minimum commitments, and the rate limits on a new account.
- The processing region, and audio retention by default and on request (zero retention?).

How Thakeen would charge (decision 3):

- **3a.** Each voice note counts as one chat message plus a small credit price per started 30 s, charged with `chargeOnce` under a claim `voice:{scope}:{noteId}` and refunded if the transcription fails. Priced so the margin stays above the 60% floor (`src/lib/pricing.ts`, pinned by `tests/pricing-floor.test.ts`).
- **3b.** Free inside the chat allowance, up to a monthly minute allowance per plan.
- **3c.** Option B only: credits per started minute of a call, held at call start with `chargeOnce` and the unused part refunded at the end, as the meeting transcript is charged before it runs.

## 6. Arabic quality and KSA specifics

- **Dialect quality is the gate (decision 5).** Before any vendor is chosen, run a fixed test set: about 50 short owner-style requests in Najdi, Hijazi, Gulf and Egyptian-accented Arabic, plus English and Arabic-English mixing, recorded by real speakers with consent. Measure word error on the brand's own nouns (product names, prices, dates). I don't have reliable figures for any vendor on these dialects, so the founder should see the numbers before choosing.
- **Text-to-speech voice:** Saudi-accented male and female voices, if the vendor offers them; assumption, verify. It must read numbers and SAR prices correctly.
- **PDPL:** a voice recording is personal data, and possibly biometric under some readings; ask counsel. Questions:
  - Is a cross-border transfer basis needed for the vendor's region?
  - Does the privacy policy need a voice paragraph?
  - Is explicit consent needed on first use? (proposed: a one-time consent screen)

## 7. Shapes and releases (rule 679)

- **Expand.**
  - Optional chat-message field `source: "voice"`.
  - New routes `/api/chat/voice` and `/api/chat/speak`, plus `/api/chat/voice/session` for B only.
  - Rate buckets, and claims `voice:` in `User.paidOnce`, which older code reads only by exact claim.
  - A rolled-back build shows the message as plain text and ignores `source`.
- **Contract.** None.
- **Environment variables** (named in `docs/system/variables.md` when built): one key per chosen vendor, for example `STT_API_KEY` and `TTS_API_KEY`. The names are fixed when the vendor is chosen, never pasted.

## 8. Tests (rules 2560-2569, reserved, not yet pinned)

| Rule | Pins |
|---|---|
| 2560 | `/api/chat/voice` authenticates first, then the chat gates in order, the size cap and the rate limit |
| 2561 | Nothing runs before the owner confirms the transcript; the confirmed text is one normal turn |
| 2562 | A `source: "voice"` message never passes `spendIntent`: paid work leaves a card |
| 2563 | Audio is never stored or logged (a source scan for the upload body) |
| 2564 | "Listen" speaks only a stored reply by id, counted and capped |
| 2565 | The charge is one claim per note, refunded when transcription fails (decision 3a) |
| 2566 | B only: one live call per account, the token's expiry is the cap, `ask_thakeen` is counted and refused past the limit, and runs as `via: "voice"` |
| 2567-2569 | Held for the build's findings |

## 9. Not in this spec

- Phone-line calls (a number customers dial).
- Voice for the brand's customers.
- Voice cloning of the owner.
- Translating a voice note into a post. That can later be a normal "write a post from this" turn on the confirmed text.

## 10. Founder decisions needed

1. **Vendor shortlist:** which speech-to-text and text-to-speech vendors to test. Decided after the test set (decision 5).
2. **Option:** A, voice notes with a confirm step (recommended); B, a live call; or C, wait.
3. **Charging:** a small credit price per note (3a, recommended), free inside an allowance (3b), or per minute (3c, B only).
4. **Retention:** require a vendor setting of zero audio retention? Recommended yes, if offered.
5. **The quality bar:** what word-error level on the Gulf test set is good enough to ship, and who records the set.
6. **PDPL review** before launch of the feature: yes or no, and by whom.

## 11. Size and release steps

- **A: M**, about 4-6 days with tests, once a vendor is chosen.
- **B: L**, about 8-12 days more on top of A.

1. Founder: shortlist, test set, quality bar.
2. Run the test set against the shortlist and record the results in this spec.
3. Choose the vendor and set its variables.
4. Build A behind a code switch `VOICE_NOTES = false`. Release (expand). Founder-only use for a week.
5. Turn on for every plan, or the plans decision 3 names.
6. Decide on B from A's usage.
