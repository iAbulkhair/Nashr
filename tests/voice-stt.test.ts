import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newMember, newUser, signIn, signOut, withHeaders } from "./helpers/session";
import { currentUser, getUser, saveUser, sc, type User } from "@/lib/auth";
import { acct } from "@/lib/account-id";
import { BRAND_HEADER } from "@/lib/brand-path";
import { BRAND_API } from "@/lib/brand-guard";
import { addBrand } from "@/lib/brands";
import { adjust, personSpendFor } from "@/lib/credits";
import { setAccess } from "@/lib/team";
import { VOICE_CREDITS_PER_MINUTE, VOICE_MAX_BYTES, VOICE_MAX_SECONDS, maxCostPerCreditUsd, voiceCredits } from "@/lib/pricing";
import { VOICE_NOTES_PER_HOUR } from "@/lib/rate";
import { audioInfo, sniffAudio } from "@/lib/voice/audio";
import { STT_PROVIDERS, STT_USD_PER_MINUTE, sttProvider, voiceEnabled } from "@/lib/voice/config";
import { VOICE_TEXT_MAX, cleanTranscript } from "@/lib/voice/transcribe";
import { VOICE_COPY, voiceErrorText } from "@/components/app/VoiceButton";
import * as voiceRoute from "@/app/api/chat/voice/route";

// No network: every provider call goes to a stubbed fetch that records what it was sent. The key below is a test value.
const TEST_KEY = "el-test-key-not-a-real-secret-3580";
const PROVIDER_BODY = "provider-internal-detail-should-never-leak";

// ---- audio fixtures, built byte by byte ----

const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** A WAV whose data really holds `seconds` at `byteRate` bytes a second (the parser never trusts a size past the file). */
function wav(seconds: number, byteRate = 100): Uint8Array {
  const data = Math.round(seconds * byteRate);
  const fmt = [1, 0, 1, 0, ...u32le(byteRate), ...u32le(byteRate), 1, 0, 8, 0];
  return new Uint8Array([...ascii("RIFF"), ...u32le(36 + data), ...ascii("WAVE"), ...ascii("fmt "), ...u32le(16), ...fmt, ...ascii("data"), ...u32le(data), ...new Array(data).fill(0x80)]);
}
/** Ogg Opus: an OpusHead page, then a last page whose granule position is `seconds` at 48 kHz. */
function ogg(seconds: number): Uint8Array {
  const page = (granule: number, body: number[]) => {
    const gb = Array.from({ length: 8 }, (_, i) => Math.floor(granule / 2 ** (8 * i)) % 256);
    return [...ascii("OggS"), 0, 0, ...gb, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, body.length ? 1 : 0, ...(body.length ? [body.length] : []), ...body];
  };
  return new Uint8Array([...page(0, ascii("OpusHead")), ...page(Math.round(seconds * 48_000), [])]);
}
/** MP4/M4A with a version-0 movie header of `seconds` at a 1000 timescale. */
function mp4(seconds: number): Uint8Array {
  const ftyp = [...u32be(16), ...ascii("ftypM4A "), 0, 0, 0, 0];
  const mvhd = [...u32be(28), ...ascii("mvhd"), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32be(1000), ...u32be(Math.round(seconds * 1000))];
  return new Uint8Array([...ftyp, ...u32be(8 + mvhd.length), ...ascii("moov"), ...mvhd]);
}
/** WebM as MediaRecorder writes it: unknown-size Segment and Clusters, no Duration; length from the last block. */
function webm(clusters: Array<[number, number]>, docType = "webm"): Uint8Array {
  const dt = ascii(docType);
  const header = [0x1a, 0x45, 0xdf, 0xa3, 0x80 | (3 + dt.length), 0x42, 0x82, 0x80 | dt.length, ...dt];
  const segment = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  const body = clusters.flatMap(([ms, off]) => [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7, 0x84, ...u32be(ms), 0xa3, 0x85, 0x81, (off >> 8) & 0xff, off & 0xff, 0x80, 0x00]);
  return new Uint8Array([...header, ...segment, ...body]);
}

// ---- requests ----

function voiceReq(bytes: Uint8Array | null, opts: { type?: string; agent?: string; length?: number } = {}): Request {
  const fd = new FormData();
  if (bytes) fd.append("file", new Blob([new Uint8Array(bytes)], { type: opts.type ?? "audio/webm" }), "note.webm");
  if (opts.agent) fd.append("agent", opts.agent);
  const headers: Record<string, string> = opts.length !== undefined ? { "content-length": String(opts.length) } : {};
  return new Request("https://nashr.test/api/chat/voice", { method: "POST", body: fd, headers });
}
const post = (req: Request) => voiceRoute.POST(req);
const credits = async (u: User) => (await getUser(u.email))!.credits;

type Seen = { url: string; init: RequestInit };
function provider(reply: () => Response) {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit = {}) => { seen.push({ url: String(url), init }); return reply(); }));
  return seen;
}
const ok = (body: Record<string, unknown>) => () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fail = (status: number) => () => new Response(PROVIDER_BODY, { status });

/** Everything the code wrote to the console in this test, as one string. */
function captureLogs() {
  const out: unknown[] = [];
  for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { out.push(a); });
  return () => JSON.stringify(out);
}
const on = () => { vi.stubEnv("VOICE_STT_PROVIDER", "elevenlabs"); vi.stubEnv("ELEVENLABS_API_KEY", TEST_KEY); };

beforeEach(() => signOut());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("voice notes: the switch (rules 3580-3581)", () => {
  it("rule 3580: off by default; a name without its key, or an unknown name, is off too", () => {
    vi.stubEnv("VOICE_STT_PROVIDER", "");
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    expect(sttProvider()).toBeNull();
    expect(voiceEnabled()).toBe(false);
    vi.stubEnv("VOICE_STT_PROVIDER", "elevenlabs");
    expect(sttProvider()).toBeNull();
    vi.stubEnv("ELEVENLABS_API_KEY", TEST_KEY);
    expect(sttProvider()).toBe("elevenlabs");
    vi.stubEnv("VOICE_STT_PROVIDER", " ElevenLabs ");
    expect(sttProvider()).toBe("elevenlabs");
    vi.stubEnv("VOICE_STT_PROVIDER", "whisper");
    expect(sttProvider()).toBeNull();
  });

  it("rule 3580: with the switch off the route is 404 for a signed-in member, and calls no provider", async () => {
    const seen = provider(ok({ text: "x" }));
    vi.stubEnv("VOICE_STT_PROVIDER", "");
    const u = await newUser("v80");
    await signIn(u.email);
    const r = await post(voiceReq(wav(3)));
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("not_found");
    vi.stubEnv("VOICE_STT_PROVIDER", "elevenlabs");
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    expect((await post(voiceReq(wav(3)))).status).toBe(404);
    expect(seen).toHaveLength(0);
    expect(await credits(u)).toBe(u.credits);
  });

  it("rule 3581: the session comes first: no session is 401 whether the switch is on or off", async () => {
    const seen = provider(ok({ text: "x" }));
    expect((await post(voiceReq(wav(3)))).status).toBe(401);
    on();
    expect((await post(voiceReq(wav(3)))).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("rule 3581: the chat page shows the microphone only from voiceEnabled(), and the composer only off onboarding", () => {
    const page = readFileSync("src/app/[lang]/app/b/[brand]/chat/page.tsx", "utf8");
    expect(page).toMatch(/voice=\{voiceEnabled\(\)\}/);
    const panel = readFileSync("src/components/app/ChatPanel.tsx", "utf8");
    expect(panel).toMatch(/\{voice && !onboardUrl && <VoiceButton/);
  });
});

describe("voice notes: what is accepted (rules 3582-3583)", () => {
  it("rule 3582: the container is judged by its magic numbers", () => {
    expect(sniffAudio(wav(1))).toBe("wav");
    expect(sniffAudio(ogg(1))).toBe("ogg");
    expect(sniffAudio(mp4(1))).toBe("mp4");
    expect(sniffAudio(webm([[0, 0]]))).toBe("webm");
    // Matroska video, a PNG, text, an empty or short file: not a voice note.
    expect(sniffAudio(webm([[0, 0]], "matroska"))).toBeNull();
    expect(sniffAudio(new Uint8Array([0x89, ...ascii("PNG\r\n\x1a\n"), 0, 0, 0, 13]))).toBeNull();
    expect(sniffAudio(new TextEncoder().encode("<script>alert(1)</script>"))).toBeNull();
    expect(sniffAudio(new Uint8Array(0))).toBeNull();
    expect(sniffAudio(new Uint8Array([...ascii("OggS")]))).toBeNull();
  });

  it("rule 3583: the length is read from each container, and a broken one is unknown, never a crash", () => {
    expect(audioInfo(wav(12))).toEqual({ kind: "wav", mime: "audio/wav", seconds: 12 });
    expect(audioInfo(ogg(42.5))?.seconds).toBeCloseTo(42.5, 3);
    expect(audioInfo(mp4(61.25))).toEqual({ kind: "mp4", mime: "audio/mp4", seconds: 61.25 });
    expect(audioInfo(webm([[30_000, 500], [60_000, 1_000]]))?.seconds).toBeCloseTo(61, 3);
    expect(audioInfo(webm([[0, 0]]))?.mime).toBe("audio/webm");
    // A WAV that claims more data than it holds is measured by what it holds.
    const lying = wav(2);
    lying.set(u32le(10_000_000), 40);
    expect(audioInfo(lying)?.seconds).toBe(2);
    // Truncated: the kind stands, the length is unknown.
    expect(audioInfo(mp4(5).subarray(0, 30))).toEqual({ kind: "mp4", mime: "audio/mp4" });
    // Ogg without OpusHead (Vorbis): no length.
    const vorbis = ogg(5);
    vorbis.set(ascii("Vorbis!!"), 28);
    expect(audioInfo(vorbis)?.seconds).toBeUndefined();
  });

  it("rule 3582: a file the browser calls audio but is not refused with 415 before any charge", async () => {
    on();
    const seen = provider(ok({ text: "x" }));
    const u = await newUser("v82");
    await signIn(u.email);
    const r = await post(voiceReq(new TextEncoder().encode("#!/bin/sh\necho not audio at all here\n"), { type: "audio/webm" }));
    expect(r.status).toBe(415);
    expect((await r.json()).error).toBe("not_audio");
    expect((await post(voiceReq(null))).status).toBe(400);
    expect(seen).toHaveLength(0);
    expect(await credits(u)).toBe(u.credits);
  });

  it("rule 3583: over the byte cap is 413, by Content-Length before reading and by the file's size after", async () => {
    on();
    const seen = provider(ok({ text: "x" }));
    const u = await newUser("v83");
    await signIn(u.email);
    const big = await post(voiceReq(wav(1), { length: VOICE_MAX_BYTES + 64 * 1024 + 1 }));
    expect(big.status).toBe(413);
    const over = new Uint8Array(VOICE_MAX_BYTES + 1);
    over.set(wav(1));
    const r = await post(voiceReq(over));
    expect(r.status).toBe(413);
    expect((await r.json()).error).toBe("too_large");
    expect(seen).toHaveLength(0);
  });

  it("rule 3583: a note whose container says it is longer than the cap is 413 too_long, uncharged", async () => {
    on();
    const seen = provider(ok({ text: "x" }));
    const u = await newUser("v83l");
    await signIn(u.email);
    const r = await post(voiceReq(wav(VOICE_MAX_SECONDS + 10)));
    expect(r.status).toBe(413);
    expect(await r.json()).toMatchObject({ error: "too_long", max: VOICE_MAX_SECONDS });
    expect(seen).toHaveLength(0);
    expect(await credits(u)).toBe(u.credits);
  });
});

describe("voice notes: price and limits (rules 3584-3585)", () => {
  it("rule 3584: whole started minutes, at least one, at most the cap's", () => {
    expect(voiceCredits(0.5)).toBe(VOICE_CREDITS_PER_MINUTE);
    expect(voiceCredits(60)).toBe(VOICE_CREDITS_PER_MINUTE);
    expect(voiceCredits(60.1)).toBe(2 * VOICE_CREDITS_PER_MINUTE);
    expect(voiceCredits(10_000)).toBe(voiceCredits(VOICE_MAX_SECONDS));
    expect(voiceCredits(Number.NaN)).toBe(voiceCredits(VOICE_MAX_SECONDS));
    expect(voiceCredits(-5)).toBe(voiceCredits(VOICE_MAX_SECONDS));
  });

  it("rule 3584: a credit a minute covers the dearest provider's minute at the margin floor", () => {
    const dearest = Math.max(...STT_PROVIDERS.map((p) => STT_USD_PER_MINUTE[p]));
    expect(VOICE_CREDITS_PER_MINUTE).toBeGreaterThanOrEqual(Math.ceil(dearest / maxCostPerCreditUsd()));
    expect(VOICE_CREDITS_PER_MINUTE * maxCostPerCreditUsd()).toBeGreaterThan(dearest);
  });

  it("rule 3585: 30 notes an hour per login, then 429 before the body is read", async () => {
    on();
    provider(ok({ text: "x" }));
    const u = await newUser("v85");
    await signIn(u.email);
    for (let i = 0; i < VOICE_NOTES_PER_HOUR; i++) expect((await post(voiceReq(null))).status).toBe(400);
    const r = await post(voiceReq(null));
    expect(r.status).toBe(429);
  });

  it("rule 3585: any member may record (role chat), and the gate order is in the route", async () => {
    on();
    provider(ok({ text: "hello", audio_duration_secs: 3 }));
    const owner = await newUser("v85o");
    const m = await newMember(owner, "member");
    await signIn(m.email);
    const r = await post(voiceReq(wav(3)));
    expect(r.status).toBe(200);
    // The member's note is charged to the account they work in.
    expect(await credits(owner)).toBe(owner.credits - 1);
  });
});

describe("voice notes: the provider and the money (rules 3586-3588)", () => {
  it("rule 3586: one POST to the fixed ElevenLabs host, the key in a header, no redirect, the sniffed type", async () => {
    on();
    const seen = provider(ok({ text: "مرحبا", audio_duration_secs: 3, language_code: "ar" }));
    const u = await newUser("v86");
    await signIn(u.email);
    const r = await post(voiceReq(wav(3), { type: "video/mp4" }));
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(seen[0].url).not.toContain(TEST_KEY);
    expect(seen[0].init.redirect).toBe("error");
    expect((seen[0].init.headers as Record<string, string>)["xi-api-key"]).toBe(TEST_KEY);
    const body = seen[0].init.body as FormData;
    expect(body.get("model_id")).toBe("scribe_v2");
    expect(body.get("language_code")).toBeNull();
    expect((body.get("file") as Blob).type).toBe("audio/wav");
  });

  it("rule 3587: charged before the call, settled on the provider's length, the rest refunded", async () => {
    on();
    const u = await newUser("v87");
    await signIn(u.email);
    const before = await credits(u);
    // The container hides its length (MP4 cut short), so the longest note is held; the provider says 40 s.
    provider(() => {
      // Mid-call, the hold is already taken.
      return new Response(JSON.stringify({ text: "  hello‮ there  ", audio_duration_secs: 40 }), { status: 200 });
    });
    let during = -1;
    vi.mocked(fetch).mockImplementationOnce(async () => {
      during = await credits(u);
      return new Response(JSON.stringify({ text: "  hello‮ there  ", audio_duration_secs: 40 }), { status: 200 });
    });
    const r = await post(voiceReq(mp4(5).subarray(0, 30)));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(during).toBe(before - voiceCredits(VOICE_MAX_SECONDS));
    expect(j).toMatchObject({ ok: true, text: "hello there", charged: 1, credits: before - 1, seconds: 40 });
    expect(await credits(u)).toBe(before - 1);
  });

  it("rule 3588: a provider failure refunds the whole hold and says busy or failed, never the provider's words", async () => {
    on();
    const logs = captureLogs();
    const u = await newUser("v88");
    await signIn(u.email);
    const before = await credits(u);
    for (const [status, error, http] of [[500, "voice_failed", 502], [429, "voice_busy", 503], [401, "voice_failed", 502]] as const) {
      provider(fail(status));
      const r = await post(voiceReq(wav(70)));
      expect(r.status).toBe(http);
      const text = await r.text();
      expect(JSON.parse(text).error).toBe(error);
      expect(text).not.toContain(PROVIDER_BODY);
      expect(text).not.toContain(TEST_KEY);
      expect(await credits(u)).toBe(before);
    }
    // A network failure or timeout is busy, refunded.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`connect failed ${TEST_KEY}`); }));
    const r = await post(voiceReq(wav(3)));
    expect(r.status).toBe(503);
    expect(await credits(u)).toBe(before);
    const all = logs();
    expect(all).toContain("voice transcription failed");
    expect(all).not.toContain(TEST_KEY);
    expect(all).not.toContain(PROVIDER_BODY);
  });

  it("rule 3588: a reply that is not a transcript is a failure, refunded", async () => {
    on();
    captureLogs();
    const u = await newUser("v88b");
    await signIn(u.email);
    const before = await credits(u);
    provider(ok({ nope: true }));
    expect((await post(voiceReq(wav(3)))).status).toBe(502);
    provider(() => new Response("not json", { status: 200 }));
    expect((await post(voiceReq(wav(3)))).status).toBe(502);
    expect(await credits(u)).toBe(before);
  });

  it("rule 3588: no speech is 422 and refunded; a note the provider says ran past the cap keeps its hold", async () => {
    on();
    const u = await newUser("v88c");
    await signIn(u.email);
    const before = await credits(u);
    provider(ok({ text: " ‏ ", audio_duration_secs: 4 }));
    const r = await post(voiceReq(wav(4)));
    expect(r.status).toBe(422);
    expect(await credits(u)).toBe(before);
    provider(ok({ text: "a long speech", audio_duration_secs: VOICE_MAX_SECONDS + 60 }));
    const long = await post(voiceReq(mp4(5).subarray(0, 30)));
    expect(long.status).toBe(413);
    const j = await long.json();
    expect(j.error).toBe("too_long");
    expect(j.text).toBeUndefined();
    expect(await credits(u)).toBe(before - voiceCredits(VOICE_MAX_SECONDS));
  });

  it("rule 3587: an empty balance is 402 with the limit, and the provider is never called", async () => {
    on();
    const seen = provider(ok({ text: "x" }));
    const u = await newUser("v87p");
    await adjust(u.email, -(await credits(u)));
    await signIn(u.email);
    const r = await post(voiceReq(wav(3)));
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ error: "no_credits", limit: "credits" });
    expect(seen).toHaveLength(0);
  });
});

describe("voice notes: nothing kept, nothing sent by itself (rules 3589-3590)", () => {
  it("rule 3589: the store holds no audio and no transcript after a note", async () => {
    on();
    provider(ok({ text: "secret plan for tomorrow", audio_duration_secs: 3 }));
    const u = await newUser("v89");
    await signIn(u.email);
    const mem = (globalThis as unknown as { __nashrMem: { kv: Map<string, unknown>; lists: Map<string, unknown>; hashes?: Map<string, unknown> } }).__nashrMem;
    expect((await post(voiceReq(wav(3)))).status).toBe(200);
    const dump = JSON.stringify([...mem.kv.values(), ...mem.lists.values(), ...(mem.hashes?.values() ?? [])], (_k, v) => (v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v));
    expect(dump).not.toContain("secret plan for tomorrow");
  });

  it("rule 3590: the transcript is cleaned as untrusted text", () => {
    expect(cleanTranscript("a\r\nb\u0000c‮d⁦e   f")).toBe("a\nb c d e f");
    expect(cleanTranscript("x".repeat(VOICE_TEXT_MAX + 50))).toHaveLength(VOICE_TEXT_MAX);
    expect(cleanTranscript("  \n  ")).toBe("");
  });

  it("rule 3590: the composer puts the text in the box and never sends it", () => {
    const panel = readFileSync("src/components/app/ChatPanel.tsx", "utf8");
    const add = panel.slice(panel.indexOf("const addSpoken"), panel.indexOf("const addSpoken") + 600);
    expect(add).toMatch(/setText\(/);
    expect(add).not.toMatch(/\bsend\(/);
    expect(panel).toMatch(/onText=\{addSpoken\}/);
    const button = readFileSync("src/components/app/VoiceButton.tsx", "utf8");
    expect(button).not.toMatch(/\/api\/chat["'`]/);
  });
});

describe("voice notes: the button (rules 3591-3594)", () => {
  it("rule 3592: every error has Arabic and English words, and the cost is stated", () => {
    for (const lang of ["ar", "en"] as const) {
      const c = VOICE_COPY[lang];
      for (const e of ["too_long", "too_large", "not_audio", "empty", "slow_down", "voice_busy", "voice_failed", "no_credits", "agent_cap", "trial_over", "fair_use", undefined]) {
        expect(voiceErrorText(c, e).length).toBeGreaterThan(10);
      }
      expect(c.cost).toContain(String(VOICE_CREDITS_PER_MINUTE));
    }
    expect(Object.keys(VOICE_COPY.ar).sort()).toEqual(Object.keys(VOICE_COPY.en).sort());
  });

  it("rule 3593: keyboard and screen readers: a real button with a pressed state, Escape cancels, a live status", () => {
    const button = readFileSync("src/components/app/VoiceButton.tsx", "utf8");
    expect(button).toMatch(/type="button"/);
    expect(button).toMatch(/aria-pressed=\{recording\}/);
    expect(button).toMatch(/e\.key === "Escape"/);
    expect(button).toMatch(/role="status"/);
    expect(button).toMatch(/dir="ltr"/);
  });

  it("rule 3594: the site lets this origin use the microphone and nothing else gets it", () => {
    const cfg = readFileSync("next.config.ts", "utf8");
    expect(cfg).toMatch(/camera=\(\), microphone=\(self\), geolocation=\(\)/);
  });
});

describe("voice notes and the customer team (rules 3595-3597, with rules 3752, 3757, 3770-3771)", () => {
  /** The session of a signed-in address, as the routes resolve it. */
  async function as(email: string): Promise<User> {
    await signIn(email);
    const u = await currentUser();
    if (!u) throw new Error(`no session for ${email}`);
    return u;
  }
  const spentBy = async (owner: User, pid: string) => personSpendFor((await getUser(acct(owner)))!, pid);

  it("rule 3595: an Editor over the owner's cap for them is refused as no credits, before the provider; a refund lowers their spend", async () => {
    on();
    const owner = await newUser("v95o");
    const editor = await newMember(owner, "member", "v95e");
    const o = await as(owner.email);
    expect(await setAccess(o, o.actor!, editor.email, { creditCap: 1 })).toEqual({ ok: true });
    const e = await as(editor.email);
    const pid = e.actor!.pid;

    // A 90-second note holds 2 credits; the cap is 1: refused under the lock, nothing taken, no provider call.
    const refused = provider(ok({ text: "never", audio_duration_secs: 90 }));
    const r = await post(voiceReq(wav(90)));
    expect(r.status).toBe(402);
    expect(await r.json()).toMatchObject({ ok: false, error: "no_credits", limit: "credits" });
    expect(refused).toHaveLength(0);
    expect(await credits(owner)).toBe(owner.credits);
    expect(await spentBy(owner, pid)).toBe(0);

    // Under a larger cap: the hold of 2 is counted, the provider bills 30 s, so 1 is refunded and the counter drops to 1.
    const o2 = await as(owner.email);
    expect(await setAccess(o2, o2.actor!, editor.email, { creditCap: 10 })).toEqual({ ok: true });
    await as(editor.email);
    provider(ok({ text: "short", audio_duration_secs: 30 }));
    const paid = await post(voiceReq(wav(90)));
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ ok: true, charged: 1 });
    expect(await spentBy(owner, pid)).toBe(1);

    // A provider failure refunds the whole hold, and the member's counter with it.
    provider(fail(500));
    expect((await post(voiceReq(wav(90)))).status).toBe(502);
    expect(await spentBy(owner, pid)).toBe(1);
    expect(await credits(owner)).toBe(owner.credits - 1);
  });

  it("rule 3596: a Viewer may not record (role chat is an Editor's and up): 403, nothing charged, no provider call", async () => {
    on();
    const seen = provider(ok({ text: "never", audio_duration_secs: 3 }));
    const owner = await newUser("v96o");
    const viewer = await newMember(owner, "viewer", "v96v");
    await signIn(viewer.email);
    const r = await post(voiceReq(wav(3)));
    expect(r.status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(await credits(owner)).toBe(owner.credits);
  });

  it("rule 3597: a member scoped to one brand records in that brand only; a selector for another brand is not found", async () => {
    on();
    expect(BRAND_API).toContain("/api/chat/voice");
    const owner = await newUser("v97o");
    await saveUser({ ...(await getUser(owner.email))!, plan: "business" });
    const editor = await newMember(owner, "member", "v97e");
    const o = await as(owner.email);
    const b = await addBrand(o, "Second");
    if ("error" in b) throw new Error(`addBrand: ${b.error}`);
    expect(await setAccess(o, o.actor!, editor.email, { brands: [b.id] })).toEqual({ ok: true });
    const e = await as(editor.email);
    expect(e.brandId).toBe(b.id);
    expect(sc(e)).not.toBe(sc(o));

    // The other brand's page: the session refuses the selector before the route reads a byte.
    const seen = provider(ok({ text: "hello", audio_duration_secs: 3 }));
    const outside = await withHeaders({ [BRAND_HEADER]: "default" }, async () => {
      try {
        return String((await post(voiceReq(wav(3)))).status);
      } catch (err) {
        return (err as { digest?: string }).digest ?? String(err);
      }
    });
    expect(outside).toMatch(/404/);
    expect(seen).toHaveLength(0);
    expect(await credits(owner)).toBe(owner.credits);

    // Its own brand's page: charged, once.
    const inside = await withHeaders({ [BRAND_HEADER]: b.id }, () => post(voiceReq(wav(3))));
    expect(inside.status).toBe(200);
    expect(seen).toHaveLength(1);
  });
});
