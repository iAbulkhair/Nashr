import { acct } from "../account-id";
import type { AgentId } from "../agents";
import type { User } from "../auth";
import { charge, personOf, refund, type AgentCharge } from "../credits";
import { providerTimeout } from "../fetch-timeout";
import { getGov } from "../governance";
import { log } from "../log";
import { VOICE_MAX_SECONDS, voiceCredits } from "../pricing";
import { meterRender } from "../usage";
import type { AudioInfo } from "./audio";
import { STT_USD_PER_MINUTE, type SttProviderId } from "./config";
import { elevenlabsTranscribe } from "./elevenlabs";
import { SttError, type SttProvider } from "./types";

/**
 * One voice note: charge, transcribe, settle (rules 3584-3588). The money order is the ledger's rule (src/lib/credits.ts):
 * the credits are taken BEFORE the provider is called, under the account's lock, counted against the agent the composer
 * is talking to in this brand scope (its monthly cap applies), and given back when the call fails.
 *
 * The hold is the note's length rounded up to whole minutes when the container says how long it is, else the longest
 * note's (VOICE_MAX_SECONDS). After the call the note is billed on the length the provider reports (else ours, else the
 * hold) and the rest of the hold is refunded in the same request. A note the provider says is longer than the cap (a file
 * whose container hid its length, sent around the composer) keeps its hold and returns no text.
 *
 * The audio exists only in this request's memory: it is sent to the provider and dropped, never written to the store,
 * Redis or a log (rule 3589). The transcript is returned, never saved: it lands in the composer for the person to edit and
 * send, and the model reads it only then, as any typed message (rule 3590).
 */

/** Rule 3586: the provider seam. A new provider adds its adapter here, its rate and key in config.ts. */
const PROVIDERS: Readonly<Record<SttProviderId, SttProvider>> = { elevenlabs: elevenlabsTranscribe };

/** A provider length this far past the cap is a note the container misreported, not rounding. */
const LENGTH_SLACK_S = 5;
/** The composer's box takes 4,000 characters (POST /api/chat trims to the same). */
export const VOICE_TEXT_MAX = 4_000;

const EXT: Record<AudioInfo["kind"], string> = { webm: "webm", ogg: "ogg", mp4: "m4a", wav: "wav" };

export type VoiceError = "no_credits" | "agent_cap" | "too_long" | "empty" | "voice_busy" | "voice_failed";
export type VoiceOutcome =
  | { ok: true; text: string; charged: number; credits: number; seconds?: number; language?: string }
  | { ok: false; error: VoiceError; credits?: number; need?: number; agent?: AgentId; spent?: number; cap?: number };

/**
 * Untrusted text made safe for a text box: control characters out (new lines kept), runs of spaces folded, trimmed and cut
 * to VOICE_TEXT_MAX. Nothing here makes it trusted: it is the person's draft until they send it.
 */
export function cleanTranscript(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/(?!\n)[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim()
    .slice(0, VOICE_TEXT_MAX);
}

export async function transcribeNote(u: User, scope: string, agent: AgentId, provider: SttProviderId, info: AudioInfo, bytes: Uint8Array): Promise<VoiceOutcome> {
  const account = acct(u);
  const hold = voiceCredits(info.seconds ?? VOICE_MAX_SECONDS);
  const gov = await getGov(scope);
  // The spending member (rule 3770): from the session's actor, never the request. Their monthly cap is checked under the
  // same lock, and a refund below lowers their counter through the receipt (`c.person`).
  const c: AgentCharge = await charge(account, hold, { scope, agent, cap: gov.agentCaps[agent], person: personOf(u) });
  if (!c.ok) {
    if (c.reason === "agent_cap") return { ok: false, error: "agent_cap", credits: c.credits, agent: c.agent, spent: c.spent, cap: c.cap };
    // A member over the owner's cap for them reads as "no credits", as the other spenders show it (rule 3771).
    return { ok: false, error: "no_credits", credits: c.credits, need: hold };
  }
  const giveBack = async (n: number): Promise<number> => {
    if (n <= 0) return c.credits;
    try {
      return await refund(account, n, c);
    } catch (e) {
      log.error("voice refund failed", e);
      return c.credits;
    }
  };
  let res;
  try {
    res = await PROVIDERS[provider]({ bytes, mime: info.mime, ext: EXT[info.kind], signal: providerTimeout() });
  } catch (e) {
    const code = e instanceof SttError ? e.code : "provider";
    // The code and the provider's status only: never the audio, the key or the provider's body.
    log.warn("voice transcription failed", { provider, reason: code, status: e instanceof SttError ? e.status : undefined });
    const credits = await giveBack(hold);
    return { ok: false, error: code === "rate_limited" || code === "timeout" ? "voice_busy" : "voice_failed", credits };
  }
  const seconds = res.seconds ?? info.seconds;
  // What the provider bills us, for the founder's per-account cost (the media cost counter, rule 1531).
  const usd = ((seconds ?? VOICE_MAX_SECONDS) / 60) * STT_USD_PER_MINUTE[provider];
  await meterRender(account, usd).catch((e) => log.error("voice cost meter failed", e));
  if (seconds !== undefined && seconds > VOICE_MAX_SECONDS + LENGTH_SLACK_S) return { ok: false, error: "too_long", credits: c.credits };
  const text = cleanTranscript(res.text);
  if (!text) return { ok: false, error: "empty", credits: await giveBack(hold) };
  const billed = Math.min(hold, seconds !== undefined ? voiceCredits(seconds) : hold);
  const credits = await giveBack(hold - billed);
  return { ok: true, text, charged: billed, credits, ...(seconds !== undefined ? { seconds } : {}), ...(res.language ? { language: res.language } : {}) };
}
