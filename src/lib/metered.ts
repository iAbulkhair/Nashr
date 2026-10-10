import type { AgentId } from "./agents";
import { meterBilled, type BilledUsage, type Kind } from "./usage";

/**
 * Every model call is metered here, so the founder console counts what Anthropic bills (rules 980-986,
 * docs/system/flows.md "Model cost metering").
 *
 * Before 2026-10-10 a call was metered only when it returned a message. Anthropic also bills a call that never did: a
 * stream aborted by its deadline (input plus everything generated before the abort), a non-streamed call that timed out
 * (the API had read the prompt and generated; the client gave up before the reply, and the SDK's retry then paid again),
 * and a server-side fallback's declined attempt (its own iteration, at its own model's rate). The Anthropic Console and
 * the founder console disagreed by exactly those calls.
 *
 * So every call is a stream (no `messages.create` in src, pinned by tests/meter-billed.test.ts). A stream's first event
 * (`message_start`) carries the input usage; from then on the SDK's snapshot (`currentMessage`) holds it, and a failure
 * after that point is metered from it. A failure before the first event (a 4xx, a 429 or 5xx, a connection error, a
 * timeout before the response headers) leaves no snapshot and is metered as nothing; those are also the only attempts the
 * SDK's `maxRetries` repeats (it never retries a stream that has started), so a retry does not hide a metered attempt.
 */
export type MeterTo = {
  /** The account to meter (`undefined` = anonymous, global counters only). */
  email: string | undefined;
  kind: Kind;
  agent?: AgentId;
  /** The model the request asked for: an iteration with no model of its own is priced at it (left out, the reply's). */
  requested?: string;
};

/** What `metered` reads from a reply: the SDK's `Message` and `BetaMessage` both fit. */
type Reply = { model: string; usage: BilledUsage; content: unknown[] };
/** The SDK's `MessageStream` / `BetaMessageStream`, as far as metering needs them. */
type StreamLike<M extends Reply> = { finalMessage(): Promise<M>; currentMessage?: M | undefined; receivedMessages?: M[] };

/**
 * Waits for the stream's message, meters it as billed (`meterBilled`: every iteration at its own model) and returns it.
 * On any failure it meters what the stream had already received (`partialUsage`), then rethrows the same error, so the
 * caller's own handling (a refund, a fallback, "out of time") is unchanged. Metering never throws (`meter` logs).
 */
export async function metered<M extends Reply>(stream: StreamLike<M>, to: MeterTo): Promise<M> {
  let msg: M;
  try {
    msg = await stream.finalMessage();
  } catch (e) {
    const snap = stream.currentMessage ?? stream.receivedMessages?.at(-1);
    if (snap?.usage) await meterBilled(to.email, snap.model, to.kind, partialUsage(snap), to.agent, to.requested);
    throw e;
  }
  await meterBilled(to.email, msg.model, to.kind, msg.usage, to.agent, to.requested);
  return msg;
}

/**
 * The usage of a stream that ended early. Input and cache counts are exact (the first event carries them). The output
 * count in the snapshot is only what the API reported so far, which before the last event is a token or so, so it is
 * raised to `streamedTokens` of what had arrived. A lower bound: thinking the API does not show is billed and not seen.
 */
export function partialUsage(snap: Reply): BilledUsage {
  const u = snap.usage;
  return { ...u, output_tokens: Math.max(u.output_tokens ?? 0, streamedTokens(snap.content)) };
}

/**
 * Estimated output tokens of the blocks received so far: text, thinking and a tool call's input. About 4 characters a
 * token for ASCII (English, JSON) and 2 for anything else (Arabic); an estimate, used only for a stream that never
 * reported its final count.
 */
export function streamedTokens(content: unknown[]): number {
  let ascii = 0, other = 0;
  for (const b of Array.isArray(content) ? content : []) {
    if (!b || typeof b !== "object") continue;
    const x = b as { type?: string; text?: unknown; thinking?: unknown; input?: unknown };
    const s = x.type === "text" ? x.text : x.type === "thinking" ? x.thinking : x.type === "tool_use" ? JSON.stringify(x.input ?? "") : "";
    if (typeof s !== "string") continue;
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) < 128) ascii++;
      else other++;
    }
  }
  return Math.ceil(ascii / 4 + other / 2);
}
