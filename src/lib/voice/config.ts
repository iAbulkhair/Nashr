/**
 * Which speech-to-text provider this deployment uses for voice notes, if any (rules 3580-3581). Server-only: it reads the
 * environment, and the rate table is our margin.
 *
 * `VOICE_STT_PROVIDER` is the switch. Unset, empty or a name not in `STT_PROVIDERS`: the feature is off, the composer
 * shows no microphone and `POST /api/chat/voice` answers 404 after the session check. A known name whose key is missing
 * is also off: a switch never turns on a provider that cannot be called.
 */

export const STT_PROVIDERS = ["elevenlabs"] as const;
export type SttProviderId = (typeof STT_PROVIDERS)[number];
const isProvider = (v: string): v is SttProviderId => (STT_PROVIDERS as readonly string[]).includes(v);

/**
 * Each provider's list price per minute of audio, in USD (docs/superpowers/specs/2026-10-23-voice-stt.md). ElevenLabs
 * Scribe v2: $0.22 an hour, read from elevenlabs.io/pricing/api on 2026-10-23. VOICE_CREDITS_PER_MINUTE
 * (src/lib/pricing.ts) must cover the dearest of these at the margin floor (tests/voice-stt.test.ts).
 */
export const STT_USD_PER_MINUTE: Readonly<Record<SttProviderId, number>> = { elevenlabs: 0.22 / 60 };

/** The provider's API key variable. Names only (docs/system/variables.md); the value is never logged or returned. */
export const STT_KEY_VAR: Readonly<Record<SttProviderId, string>> = { elevenlabs: "ELEVENLABS_API_KEY" };

/** The provider voice notes go to now, or null when the feature is off. Read at call time, like every other variable. */
export function sttProvider(): SttProviderId | null {
  const v = (process.env.VOICE_STT_PROVIDER ?? "").trim().toLowerCase();
  if (!isProvider(v)) return null;
  return process.env[STT_KEY_VAR[v]] ? v : null;
}

export const voiceEnabled = (): boolean => sttProvider() !== null;
