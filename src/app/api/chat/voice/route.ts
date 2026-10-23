import { NextResponse } from "next/server";
import { trialOver } from "@/lib/auth";
import { acct } from "@/lib/account-id";
import { isAgentId } from "@/lib/agents";
import { accountKey } from "@/lib/keys";
import { handler } from "@/lib/api-handler";
import { renewIfDue, renewalDue } from "@/lib/credits";
import { entitlements } from "@/lib/entitlements";
import { fairUseGate } from "@/lib/fair-use";
import { VOICE_MAX_BYTES, VOICE_MAX_SECONDS } from "@/lib/pricing";
import { VOICE_NOTES_PER_DAY, VOICE_NOTES_PER_HOUR, WINDOW, allow, retryLater } from "@/lib/rate";
import { audioInfo } from "@/lib/voice/audio";
import { sttProvider } from "@/lib/voice/config";
import { transcribeNote, type VoiceError } from "@/lib/voice/transcribe";

/**
 * POST multipart {file, agent?} → `{ ok, text, charged, credits }`: a voice note from the chat composer, as text for the
 * composer's box (rules 3580-3590, docs/superpowers/specs/2026-10-23-voice-stt.md). Nothing is sent to an agent: the
 * person reads, edits and sends the text like anything they typed, so the model never acts on unreviewed speech.
 *
 * Order: the session (401), `chat` (any member, 403), 30 notes an hour per login (429, before the body is read),
 * Content-Length over VOICE_MAX_BYTES + 64 KB (413), then the switch: with no provider (`VOICE_STT_PROVIDER` unset or its
 * key missing) 404 `not_found`, and nothing else is read. Then the note: no file 400 `bad_request`; over VOICE_MAX_BYTES
 * 413 `too_large`; not audio by its magic numbers 415 `not_audio`; longer than VOICE_MAX_SECONDS where the container
 * says 413 `too_long`; an agent the plan does not include 403; an ended trial 402 `trial_over`; the fair-use pause 402
 * `fair_use`; 120 notes a day per login 429. Only then are credits charged (src/lib/voice/transcribe.ts).
 *
 * The scope is `sc(u)` from the wrapper. The `agent` field only says whose monthly cap the note counts against.
 */
export const maxDuration = 60;

const STATUS: Record<VoiceError, number> = { no_credits: 402, agent_cap: 402, too_long: 413, empty: 422, voice_busy: 503, voice_failed: 502 };
const no = (error: string, status: number, extra: Record<string, unknown> = {}) => NextResponse.json({ ok: false, error, ...extra }, { status });

export const POST = handler(
  { auth: "user", role: "chat", rate: { bucket: "voice:h", max: VOICE_NOTES_PER_HOUR, window: WINDOW.hour }, maxBytes: VOICE_MAX_BYTES + 64 * 1024 },
  async ({ req, u, scope }) => {
    const provider = sttProvider();
    if (!provider) return no("not_found", 404);
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof Blob) || !file.size) return no("bad_request", 400);
    if (file.size > VOICE_MAX_BYTES) return no("too_large", 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = audioInfo(bytes);
    if (!info) return no("not_audio", 415);
    if (info.seconds !== undefined && info.seconds > VOICE_MAX_SECONDS + 1) return no("too_long", 413, { max: VOICE_MAX_SECONDS });
    const a = form?.get("agent");
    const agent = isAgentId(a) ? a : "noor";
    if (!entitlements(u).agents.includes(agent)) return no("agent_not_included", 403);
    if (trialOver(u)) return no("trial_over", 402, { limit: "trial", credits: u.credits });
    if (await fairUseGate(u)) return no("fair_use", 402, { credits: u.credits });
    if (!(await allow(accountKey.voiceDayBucket(u.email), VOICE_NOTES_PER_DAY, WINDOW.day))) return retryLater({ ok: false, error: "slow_down", retry: "day" }, WINDOW.day);
    // A paid account's monthly credits arrive before its first charge of the month (rule 332).
    if (renewalDue(u)) await renewIfDue(acct(u));
    const out = await transcribeNote(u, scope, agent, provider, info, bytes);
    if (!out.ok) {
      const { error, credits, need, agent: capped, spent, cap } = out;
      const rest = { credits, need, agent: capped, spent, cap };
      return no(error, STATUS[error], error === "no_credits" || error === "agent_cap" ? { ...rest, limit: error === "agent_cap" ? "agent_cap" : "credits" } : rest);
    }
    return NextResponse.json({ ok: true, text: out.text, charged: out.charged, credits: out.credits, ...(out.seconds !== undefined ? { seconds: Math.round(out.seconds) } : {}) });
  },
);
