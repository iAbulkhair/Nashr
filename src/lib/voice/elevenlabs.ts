import { responseJson } from "../read-capped";
import { SttError, type SttRequest, type SttResult } from "./types";

/**
 * ElevenLabs Scribe v2 (rule 3586). One multipart POST to the fixed official host with the key in `xi-api-key`; plain
 * fetch, no SDK. No language is sent: Scribe detects it, which keeps a Saudi sentence with English product names whole.
 * No webhook, no cloud URL: the bytes go in the request and the transcript comes back in the answer.
 *
 * A failure is an `SttError` with a code only. The provider's body, the key and the audio never reach a log or a caller.
 */
const HOST = "https://api.elevenlabs.io";
export const ELEVENLABS_MODEL = "scribe_v2";
/** A two-minute transcript with word timings is tens of kilobytes; anything past this is not a transcript. */
const REPLY_MAX_BYTES = 1024 * 1024;

export async function elevenlabsTranscribe(req: SttRequest): Promise<SttResult> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new SttError("unavailable");
  const form = new FormData();
  form.append("model_id", ELEVENLABS_MODEL);
  form.append("tag_audio_events", "false");
  form.append("diarize", "false");
  form.append("file", new Blob([new Uint8Array(req.bytes)], { type: req.mime }), `note.${req.ext}`);
  let res: Response;
  try {
    res = await fetch(`${HOST}/v1/speech-to-text`, { method: "POST", headers: { "xi-api-key": key }, body: form, signal: req.signal, redirect: "error" });
  } catch {
    throw new SttError("timeout");
  }
  if (res.status === 429) throw new SttError("rate_limited");
  if (res.status === 401 || res.status === 402 || res.status === 403) throw new SttError("unavailable", res.status);
  if (!res.ok) throw new SttError("provider", res.status);
  let body: { text?: unknown; audio_duration_secs?: unknown; language_code?: unknown };
  try {
    body = await responseJson(res, REPLY_MAX_BYTES);
  } catch {
    throw new SttError("provider", res.status);
  }
  if (typeof body?.text !== "string") throw new SttError("provider", res.status);
  const secs = typeof body.audio_duration_secs === "number" && Number.isFinite(body.audio_duration_secs) && body.audio_duration_secs >= 0 ? body.audio_duration_secs : undefined;
  const lang = typeof body.language_code === "string" && /^[a-z]{2,3}$/.test(body.language_code) ? body.language_code : undefined;
  return { text: body.text, ...(secs !== undefined ? { seconds: secs } : {}), ...(lang ? { language: lang } : {}) };
}
