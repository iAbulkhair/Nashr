"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { VOICE_CREDITS_PER_MINUTE, VOICE_MAX_BYTES, VOICE_MAX_SECONDS } from "@/lib/pricing";
import { Icon } from "./Icons";
import { limitFromError } from "./LimitModal";
import { announceCredits } from "./WorkspaceContext";

/**
 * The chat composer's microphone (rules 3591-3594). Press once to record, press again to stop; the note goes to
 * POST /api/chat/voice and the text comes back into the composer's box through `onText`, where the person reads, edits
 * and sends it. It is never sent by itself (rule 3590). Cancel, or Escape while recording, throws the recording away
 * without uploading or charging. Recording stops by itself at VOICE_MAX_SECONDS.
 *
 * Shown only when the server says the feature is on (`voice` from the chat page, `voiceEnabled()`). The audio stays in
 * this tab's memory until it is uploaded once; nothing is kept on the device either.
 */

export const VOICE_COPY = {
  ar: {
    record: "سجّل رسالة صوتية",
    stop: "أوقف التسجيل وحوّله إلى نص",
    cancel: "ألغِ التسجيل",
    recording: "جارٍ التسجيل",
    sending: "جارٍ تحويل الصوت إلى نص…",
    added: "أُضيف النص إلى خانة الكتابة. راجعه ثم أرسله.",
    cancelled: "أُلغي التسجيل ولم يُرسل شيء.",
    cost: `${VOICE_CREDITS_PER_MINUTE} رصيد لكل دقيقة، حتى ${VOICE_MAX_SECONDS / 60} دقيقة`,
    unsupported: "متصفحك لا يدعم التسجيل الصوتي هنا. اكتب رسالتك بدلًا من ذلك.",
    denied: "لم يُسمح باستخدام الميكروفون. فعّله من إعدادات المتصفح ثم حاول مرة أخرى.",
    tooShort: "التسجيل قصير جدًا. اضغط ثم تحدّث، ثم اضغط مرة أخرى للإيقاف.",
    tooLong: `الرسالة الصوتية أطول من ${VOICE_MAX_SECONDS / 60} دقيقة. سجّل رسالة أقصر.`,
    tooLarge: "الملف الصوتي أكبر من المسموح. سجّل رسالة أقصر.",
    notAudio: "لم نتعرف على هذا التسجيل كملف صوتي. حاول مرة أخرى.",
    empty: "لم نلتقط كلامًا في التسجيل، ولم يُخصم رصيد. حاول مرة أخرى.",
    slow: "سجّلت رسائل صوتية كثيرة. انتظر قليلًا ثم حاول مرة أخرى.",
    busy: "خدمة تحويل الصوت مشغولة الآن، ولم يُخصم رصيد. حاول بعد قليل.",
    failed: "تعذّر تحويل الصوت إلى نص، ولم يُخصم رصيد. حاول مرة أخرى أو اكتب رسالتك.",
    credits: "رصيدك لا يكفي لتحويل هذه الرسالة الصوتية.",
  },
  en: {
    record: "Record a voice note",
    stop: "Stop and turn into text",
    cancel: "Cancel recording",
    recording: "Recording",
    sending: "Turning your voice into text…",
    added: "The text is in the message box. Check it, then send.",
    cancelled: "Recording cancelled. Nothing was sent.",
    cost: `${VOICE_CREDITS_PER_MINUTE} credit a minute, up to ${VOICE_MAX_SECONDS / 60} minutes`,
    unsupported: "Your browser cannot record audio here. Type your message instead.",
    denied: "Microphone access was not allowed. Turn it on in your browser settings and try again.",
    tooShort: "That was too short. Press, speak, then press again to stop.",
    tooLong: `Voice notes can be up to ${VOICE_MAX_SECONDS / 60} minutes. Record a shorter one.`,
    tooLarge: "That recording is too large. Record a shorter one.",
    notAudio: "We could not read that recording as audio. Try again.",
    empty: "We did not catch any speech, and no credits were used. Try again.",
    slow: "That is a lot of voice notes. Wait a little, then try again.",
    busy: "Speech-to-text is busy right now, and no credits were used. Try again shortly.",
    failed: "We could not turn that into text, and no credits were used. Try again or type your message.",
    credits: "Your balance does not cover this voice note.",
  },
} as const;

/** The first container this browser records that the server accepts: WebM or Ogg Opus, else MP4 (Safari). */
const MIME_CHOICES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
/** Bit rate asked of the recorder: speech needs little, and two minutes stay near 0.5 MB. */
const BITS_PER_SECOND = 32_000;
const MIN_SECONDS = 0.6;

type Phase = "idle" | "starting" | "recording" | "sending";
type Copy = (typeof VOICE_COPY)["ar" | "en"];

/** Pure: the message for a refused or failed note. Exported for the tests. */
export function voiceErrorText(c: Copy, error: string | undefined): string {
  switch (error) {
    case "too_long": return c.tooLong;
    case "too_large": return c.tooLarge;
    case "not_audio": case "bad_request": return c.notAudio;
    case "empty": return c.empty;
    case "slow_down": return c.slow;
    case "voice_busy": return c.busy;
    case "no_credits": case "agent_cap": case "trial_over": case "fair_use": return c.credits;
    default: return c.failed;
  }
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export default function VoiceButton({ lang, agent, disabled = false, onText, onNotice }: { lang: "ar" | "en"; agent: string; disabled?: boolean; onText: (text: string) => void; onNotice: (message: string) => void }) {
  const c = VOICE_COPY[lang];
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState("");
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const cancelled = useRef(false);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  const release = useCallback(() => {
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  // Leaving the page mid-recording stops the microphone and uploads nothing.
  useEffect(() => () => {
    cancelled.current = true;
    if (rec.current && rec.current.state !== "inactive") rec.current.stop();
    release();
  }, [release]);

  const upload = useCallback(async (blob: Blob, seconds: number) => {
    if (seconds < MIN_SECONDS) { setPhase("idle"); onNotice(c.tooShort); return; }
    if (blob.size > VOICE_MAX_BYTES) { setPhase("idle"); onNotice(c.tooLarge); return; }
    setPhase("sending");
    setStatus(c.sending);
    const fd = new FormData();
    const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
    fd.append("file", blob, `note.${ext}`);
    fd.append("agent", agent);
    const r = await fetch("/api/chat/voice", { method: "POST", body: fd, headers: { "x-lang": lang } }).catch(() => null);
    const j = (await r?.json().catch(() => null)) as { ok?: boolean; text?: string; credits?: number; error?: string } | null;
    setPhase("idle");
    if (typeof j?.credits === "number") announceCredits(j.credits);
    if (r?.ok && j?.ok && typeof j.text === "string") {
      onText(j.text);
      setStatus(c.added);
      return;
    }
    setStatus("");
    limitFromError(j?.error);
    onNotice(voiceErrorText(c, j?.error));
  }, [agent, c, lang, onNotice, onText]);

  const stop = useCallback((cancel: boolean) => {
    const r = rec.current;
    if (!r || r.state === "inactive") return;
    cancelled.current = cancel;
    r.stop();
  }, []);

  const start = useCallback(async () => {
    onNotice("");
    setStatus("");
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { onNotice(c.unsupported); return; }
    setPhase("starting");
    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setPhase("idle");
      onNotice(c.denied);
      return;
    }
    stream.current = s;
    const mimeType = MIME_CHOICES.find((m) => MediaRecorder.isTypeSupported?.(m));
    let r: MediaRecorder;
    try {
      r = new MediaRecorder(s, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: BITS_PER_SECOND });
    } catch {
      release();
      setPhase("idle");
      onNotice(c.unsupported);
      return;
    }
    chunks.current = [];
    cancelled.current = false;
    r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    r.onstop = () => {
      const seconds = (Date.now() - started.current) / 1000;
      release();
      rec.current = null;
      const blob = new Blob(chunks.current, { type: r.mimeType || mimeType || "audio/webm" });
      chunks.current = [];
      if (cancelled.current) { setPhase("idle"); setStatus(c.cancelled); return; }
      void upload(blob, seconds);
    };
    rec.current = r;
    started.current = Date.now();
    setElapsed(0);
    r.start();
    setPhase("recording");
    setStatus(c.recording);
    tick.current = setInterval(() => {
      const sec = (Date.now() - started.current) / 1000;
      setElapsed(sec);
      if (sec >= VOICE_MAX_SECONDS) stop(false);
    }, 250);
  }, [c, onNotice, release, stop, upload]);

  // Escape cancels a recording from anywhere on the page, as the Cancel button does.
  useEffect(() => {
    if (phase !== "recording") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); stop(true); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase, stop]);

  const recording = phase === "recording";
  return (
    <>
      {recording && (
        <button type="button" onClick={() => stop(true)} className="btn btn-secondary btn-lg shrink-0" aria-label={c.cancel} title={c.cancel}>
          <Icon name="x" className="h-4 w-4" />
        </button>
      )}
      <button
        type="button"
        onClick={() => (recording ? stop(false) : void start())}
        disabled={disabled || phase === "starting" || phase === "sending"}
        aria-pressed={recording}
        aria-label={recording ? c.stop : c.record}
        aria-describedby="chat-voice-cost"
        title={recording ? c.stop : `${c.record} · ${c.cost}`}
        className={`btn btn-lg shrink-0 ${recording ? "btn-accent" : "btn-secondary"}`}
      >
        {phase === "sending"
          ? <span className="h-2 w-2 animate-pulse rounded-full bg-foreground" aria-hidden="true" />
          : <Icon name={recording ? "stop" : "mic"} className="h-4 w-4" />}
        {recording && <span className="tnum text-xs" dir="ltr">{clock(elapsed)} / {clock(VOICE_MAX_SECONDS)}</span>}
      </button>
      <span id="chat-voice-cost" className="sr-only">{c.cost}</span>
      <span role="status" className="sr-only">{status}</span>
    </>
  );
}
