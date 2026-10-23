/** The provider seam for voice notes (rule 3586). Import-free, so a test can build requests without the store. */

export type SttRequest = {
  bytes: Uint8Array;
  /** From the sniffed container (src/lib/voice/audio.ts), never from the request. */
  mime: string;
  ext: string;
  signal: AbortSignal;
};

export type SttResult = {
  /** Untrusted text: it only ever goes back into the composer for the person to read, edit and send. */
  text: string;
  /** The length the provider billed, when it says. */
  seconds?: number;
  language?: string;
};

/**
 * Why a transcription failed, as a code. `status` is the provider's HTTP status for the log; it is never shown to a
 * customer. Nothing else is carried: no body, no key, no audio.
 */
export type SttErrorCode = "unavailable" | "rate_limited" | "timeout" | "provider";
export class SttError extends Error {
  constructor(readonly code: SttErrorCode, readonly status?: number) {
    super(`stt_${code}`);
    this.name = "SttError";
  }
}

export type SttProvider = (req: SttRequest) => Promise<SttResult>;
