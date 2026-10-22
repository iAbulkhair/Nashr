import { hasArtwork } from "./media-catalog";

/**
 * The version of an item's published content: what an approval or a publish is bound to.
 *
 * Any member may edit a pending draft ("drafts", src/lib/roles.ts) while approving and publishing need an admin or the
 * owner. Without a version, an admin who opened a card earlier could approve or publish text a member wrote a moment ago,
 * and it went out under the admin's name. So every request that ends approved (PATCH /api/tasks/[id]) and every publish
 * (POST /api/publish/[id]) carries the version of the card the person saw; the server compares it with the item as
 * stored now, under the task lock or the publish lock, and answers 409 `changed` when they differ.
 *
 * It covers what a connector sends (src/lib/connectors/publish.ts): the title (WordPress and Shopify), the text (the
 * edit when there is one) and the generated image (Facebook and Instagram). A placeholder card is not published and is
 * not counted, so a card that does not show the image (the chat's ItemCard) still matches an item without artwork.
 *
 * SHA-256, hex. Written out here rather than taken from node:crypto or crypto.subtle so that one synchronous function
 * runs in the browser, inside `updateTask`'s synchronous mutate and in `publishOnce`'s check. A short or weak hash would
 * let a member search for an edit with the same version as the text the admin saw.
 */
export type Versioned = { title: string; body: string; editedBody?: string; imageUrl?: string; imageProvider?: string };

export function taskVersion(t: Versioned): string {
  return sha256(JSON.stringify([t.title ?? "", t.editedBody ?? t.body ?? "", hasArtwork(t) ? t.imageUrl : ""]));
}

/**
 * When the latest generated image or clip landed on an item (rule 3012, set only by the media engine's `withResult`,
 * src/lib/media/jobs.ts). Rule 679 expand: a new optional field of the stored task, typed here so the stored `Task` type
 * (src/lib/brand.ts) needs no change in this step; older code ignores it, and an item without it is judged as before.
 */
export type MediaStamped = { mediaAt?: string };

/**
 * How long before its `at` a publish record may have read the item it sent: the inbox route's publish lock (70 s) plus
 * the task lock's wait, rounded up. A record younger than the media by less than this may have sent the older media.
 */
export const PUBLISH_READ_MARGIN_MS = 120_000;

type Reviewable = MediaStamped & { decidedAt?: string; published?: { at: string }[] };

/**
 * Whether a person has seen the item as it is now, for the chat's `publish_item` (src/lib/chat-run-tool.ts). Before media
 * stamps (no `mediaAt`): a person's decision (`decidedAt`) or any publish, as before. With one: a decision after the
 * media landed, or a publish whose record is more than PUBLISH_READ_MARGIN_MS younger than it (the inbox publish is bound
 * to the card's version, image included, so it read the new media). A publish made before the media, or during the
 * seconds of one, says nothing about media nobody saw. A stamp that does not parse counts as unseen.
 */
export function personSawCurrent(t: Reviewable): boolean {
  if (t.mediaAt === undefined) return !!t.decidedAt || !!t.published?.length;
  const media = Date.parse(t.mediaAt);
  if (Number.isNaN(media)) return false;
  const after = (at: string | undefined, margin: number) => typeof at === "string" && Date.parse(at) > media + margin;
  return after(t.decidedAt, 0) || (t.published ?? []).some((p) => after(p.at, PUBLISH_READ_MARGIN_MS));
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(text: string): string {
  const data = new TextEncoder().encode(text);
  const bits = data.length * 8;
  // Message, 0x80, zero padding, then the length in bits as a 64-bit big-endian number.
  const n = (((data.length + 9 + 63) >> 6) << 6);
  const m = new Uint8Array(n);
  m.set(data);
  m[data.length] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(n - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(n - 4, bits >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, r: number) => (x >>> r) | (x << (32 - r));
  for (let off = 0; off < n; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}
