/**
 * What a voice note's bytes are, judged by their magic numbers and never by the file name or the type the browser sent
 * (rule 3582), and how long it is where the container says so cheaply (rule 3583). Pure: no I/O, no imports.
 *
 * Accepted: the containers a browser's MediaRecorder writes. WebM (Chrome, Edge, Firefox; EBML with DocType "webm"), Ogg
 * (Firefox), MP4/M4A (Safari) and WAV (a recorder that writes PCM). Anything else is refused before a credit is charged.
 *
 * The length is a best effort: WAV is exact, Ogg Opus is the last page's granule position, WebM is the Info Duration when
 * present (MediaRecorder leaves it out) or the last block's timestamp found by walking the clusters, MP4 is the movie
 * header's duration (zero in Safari's fragmented files). `undefined` means the container did not say; the route then
 * holds the credits of the longest note and settles on the provider's reported length.
 */

export type AudioKind = "webm" | "ogg" | "mp4" | "wav";
export type AudioInfo = { kind: AudioKind; mime: string; seconds?: number };

const MIME: Record<AudioKind, string> = { webm: "audio/webm", ogg: "audio/ogg", mp4: "audio/mp4", wav: "audio/wav" };

const ascii = (b: Uint8Array, at: number, n: number) => (at + n <= b.length ? String.fromCharCode(...b.subarray(at, at + n)) : "");
const finite = (s: number | undefined) => (typeof s === "number" && Number.isFinite(s) && s >= 0 ? s : undefined);

/** The kind of audio container, or null for anything else (an image, a script, a video-only file, random bytes). */
export function sniffAudio(b: Uint8Array): AudioKind | null {
  if (b.length < 12) return null;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return ebmlDocType(b) === "webm" ? "webm" : null;
  if (ascii(b, 0, 4) === "OggS") return "ogg";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE") return "wav";
  if (ascii(b, 4, 4) === "ftyp") return "mp4";
  return null;
}

/** The kind, the type sent to the provider (from the kind, never from the request) and the length when known. */
export function audioInfo(b: Uint8Array): AudioInfo | null {
  const kind = sniffAudio(b);
  if (!kind) return null;
  let seconds: number | undefined;
  try {
    seconds = finite(kind === "wav" ? wavSeconds(b) : kind === "ogg" ? oggSeconds(b) : kind === "webm" ? webmSeconds(b) : mp4Seconds(b));
  } catch {
    seconds = undefined;
  }
  return { kind, mime: MIME[kind], ...(seconds !== undefined ? { seconds } : {}) };
}

// ---- WAV ----

function wavSeconds(b: Uint8Array): number | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let byteRate = 0;
  for (let at = 12; at + 8 <= b.length; ) {
    const id = ascii(b, at, 4);
    const size = v.getUint32(at + 4, true);
    if (id === "fmt " && at + 16 <= b.length) byteRate = v.getUint32(at + 16, true);
    if (id === "data") return byteRate > 0 ? Math.min(size, b.length - at - 8) / byteRate : undefined;
    at += 8 + size + (size & 1);
  }
  return undefined;
}

// ---- Ogg (Opus) ----

function oggSeconds(b: Uint8Array): number | undefined {
  // Opus always counts granules at 48 kHz; another codec (Vorbis) is left unknown.
  if (indexOf(b, "OpusHead", 0, 512) < 0) return undefined;
  for (let at = b.length - 27; at >= 0; at--) {
    if (b[at] === 0x4f && ascii(b, at, 4) === "OggS") {
      const v = new DataView(b.buffer, b.byteOffset + at, 27);
      const g = Number(v.getBigInt64(6, true));
      return g >= 0 ? g / 48_000 : undefined;
    }
  }
  return undefined;
}

// ---- MP4 ----

function mp4Seconds(b: Uint8Array): number | undefined {
  const at = indexOf(b, "mvhd", 0, b.length);
  if (at < 4) return undefined;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = b[at + 4];
  const base = at + 8;
  if (version === 1) {
    if (base + 28 > b.length) return undefined;
    const scale = v.getUint32(base + 16);
    const dur = Number(v.getBigUint64(base + 20));
    return scale > 0 && dur > 0 ? dur / scale : undefined;
  }
  if (base + 16 > b.length) return undefined;
  const scale = v.getUint32(base + 8);
  const dur = v.getUint32(base + 12);
  return scale > 0 && dur > 0 && dur !== 0xffffffff ? dur / scale : undefined;
}

// ---- WebM (EBML) ----

const ID = { EBML: 0x1a45dfa3, DocType: 0x4282, Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489, Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1 };
/** Level-1 elements: the end of a cluster written with an unknown size is the next of these. */
const TOP = new Set([0x1f43b675, 0x1c53bb6b, 0x1549a966, 0x1654ae6b, 0x114d9b74, 0x1254c367, 0x1941a469, 0x1043a770]);

type Vint = { value: number; len: number; unknown: boolean };
function readId(b: Uint8Array, at: number): Vint | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  const len = Math.clz32(first) - 23;
  if (len < 1 || len > 4 || at + len > b.length) return null;
  let value = 0;
  for (let i = 0; i < len; i++) value = value * 256 + b[at + i];
  return { value, len, unknown: false };
}
function readSize(b: Uint8Array, at: number): Vint | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  const len = Math.clz32(first) - 23;
  if (len < 1 || len > 8 || at + len > b.length) return null;
  let value = first & (0xff >> len);
  let allOnes = value === 0xff >> len;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[at + i];
    if (b[at + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: allOnes };
}
const uint = (b: Uint8Array, at: number, n: number) => {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[at + i];
  return v;
};

function ebmlDocType(b: Uint8Array): string {
  const id = readId(b, 0);
  const size = id && readSize(b, id.len);
  if (!id || !size) return "";
  const end = Math.min(b.length, id.len + size.len + (size.unknown ? 64 : size.value));
  for (let at = id.len + size.len; at < end; ) {
    const cid = readId(b, at);
    const cs = cid && readSize(b, at + cid.len);
    if (!cid || !cs || cs.unknown) return "";
    const body = at + cid.len + cs.len;
    if (cid.value === ID.DocType) return ascii(b, body, Math.min(cs.value, 16)).replace(/\0+$/, "");
    at = body + cs.value;
  }
  return "";
}

function webmSeconds(b: Uint8Array): number | undefined {
  // The EBML header, then the Segment (MediaRecorder writes it with an unknown size).
  const h = readId(b, 0);
  const hs = h && readSize(b, h.len);
  if (!h || !hs || hs.unknown) return undefined;
  let at = h.len + hs.len + hs.value;
  const seg = readId(b, at);
  const ss = seg && readSize(b, at + seg.len);
  if (!seg || !ss || seg.value !== ID.Segment) return undefined;
  at += seg.len + ss.len;
  const segEnd = ss.unknown ? b.length : Math.min(b.length, at + ss.value);
  let scale = 1_000_000;
  let declared: number | undefined;
  let last = -1;
  while (at < segEnd) {
    const id = readId(b, at);
    const sz = id && readSize(b, at + id.len);
    if (!id || !sz) break;
    const body = at + id.len + sz.len;
    if (id.value === ID.Info && !sz.unknown) {
      for (let c = body; c < Math.min(segEnd, body + sz.value); ) {
        const cid = readId(b, c);
        const cs = cid && readSize(b, c + cid.len);
        if (!cid || !cs || cs.unknown) break;
        const cb = c + cid.len + cs.len;
        if (cid.value === ID.TimecodeScale && cs.value >= 1 && cs.value <= 8) scale = uint(b, cb, cs.value) || scale;
        if (cid.value === ID.Duration && (cs.value === 4 || cs.value === 8) && cb + cs.value <= b.length) {
          const v = new DataView(b.buffer, b.byteOffset + cb, cs.value);
          declared = cs.value === 4 ? v.getFloat32(0) : v.getFloat64(0);
        }
        c = cb + cs.value;
      }
    }
    if (id.value === ID.Cluster) {
      const end = sz.unknown ? segEnd : Math.min(segEnd, body + sz.value);
      let cluster = 0;
      let c = body;
      while (c < end) {
        const cid = readId(b, c);
        const cs = cid && readSize(b, c + cid.len);
        if (!cid || !cs) break;
        if (sz.unknown && TOP.has(cid.value)) break;
        if (cs.unknown) break;
        const cb = c + cid.len + cs.len;
        if (cid.value === ID.Timecode && cs.value >= 1 && cs.value <= 8) cluster = uint(b, cb, cs.value);
        if (cid.value === ID.SimpleBlock) last = Math.max(last, cluster + blockOffset(b, cb));
        if (cid.value === ID.BlockGroup) {
          const inner = readId(b, cb);
          const is = inner && readSize(b, cb + inner.len);
          if (inner && is && inner.value === ID.Block) last = Math.max(last, cluster + blockOffset(b, cb + inner.len + is.len));
        }
        c = cb + cs.value;
      }
      at = c;
      continue;
    }
    if (sz.unknown) break;
    at = body + sz.value;
  }
  if (declared !== undefined && declared > 0) return (declared * scale) / 1e9;
  return last >= 0 ? (last * scale) / 1e9 : undefined;
}

/** A block's timestamp relative to its cluster: after the track number (a vint), a signed 16-bit big-endian value. */
function blockOffset(b: Uint8Array, at: number): number {
  const track = readSize(b, at);
  if (!track || at + track.len + 2 > b.length) return 0;
  const v = (b[at + track.len] << 8) | b[at + track.len + 1];
  return v & 0x8000 ? v - 0x10000 : v;
}

function indexOf(b: Uint8Array, s: string, from: number, max: number): number {
  const end = Math.min(b.length - s.length, from + max);
  outer: for (let i = from; i <= end; i++) {
    for (let j = 0; j < s.length; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}
