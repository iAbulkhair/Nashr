import { brotliDecompressSync } from "node:zlib";

/**
 * Reads a WOFF2 file into a plain sfnt (OpenType) buffer, in memory (rule 3141).
 *
 * Why: the share-card maker draws with `next/og` (Satori), which reads TTF, OTF and WOFF but refuses WOFF2 ("Unsupported
 * OpenType signature wOF2"), and the site's Arabic display font exists only as WOFF2 under `src/app/fonts`. The font
 * licence (src/app/fonts/thmanyah-serif-display/LICENSE.md) keeps those files unmodified and unconverted on disk, so the
 * file is never touched: the bytes are unwrapped here, in the server's memory, the way a browser unwraps them, and only
 * the rendered pixels leave. Nothing is written, served or linked.
 *
 * Only what those files need is implemented: a WOFF2 whose tables are stored as they are (CFF outlines, no `glyf`/`loca`
 * transform, no `hmtx` transform). A transformed table throws, naming it, instead of producing a broken font.
 */

/** The 63 tags a WOFF2 table directory can name by number (W3C WOFF2 §5.1). */
const KNOWN = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT",
  "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH",
  "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar",
  "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

/** The sum of the table's big-endian 32-bit words, the last word padded with zeros: the checksum an sfnt table record holds. */
function checksum(b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < b.length; i += 4) {
    const w = b.length - i >= 4 ? b.readUInt32BE(i) : (Buffer.concat([b.subarray(i), Buffer.alloc(4)]).readUInt32BE(0));
    sum = (sum + w) >>> 0;
  }
  return sum;
}

export function woff2ToSfnt(woff: Buffer): ArrayBuffer {
  if (woff.length < 48 || woff.toString("ascii", 0, 4) !== "wOF2") throw new Error("not a WOFF2 file");
  const flavor = woff.readUInt32BE(4);
  const numTables = woff.readUInt16BE(12);
  const compressedSize = woff.readUInt32BE(20);

  let pos = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const byte = woff[pos++];
      if (byte === undefined) throw new Error("WOFF2 table directory ends early");
      v = v * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return v;
    }
    throw new Error("WOFF2 table directory has a bad length");
  };

  const dir: { tag: string; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = woff[pos++];
    const idx = flags & 0x3f, version = flags >> 6;
    const tag = idx === 63 ? woff.toString("ascii", pos, (pos += 4)) : KNOWN[idx];
    const length = base128();
    // glyf and loca are stored transformed unless the version says "null" (3); every other table the other way round.
    const transformed = tag === "glyf" || tag === "loca" ? version !== 3 : version !== 0;
    if (transformed) throw new Error(`WOFF2 table "${tag}" is transformed, which this reader does not unwrap`);
    dir.push({ tag, length });
  }

  const data = brotliDecompressSync(woff.subarray(pos, pos + compressedSize));
  const tables: { tag: string; body: Buffer }[] = [];
  let at = 0;
  for (const { tag, length } of dir) {
    tables.push({ tag, body: data.subarray(at, at + length) });
    at += length;
  }
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));

  // sfnt: a 12-byte header, 16 bytes per table record, then each table padded to a 4-byte boundary.
  const n = tables.length;
  const entrySelector = Math.floor(Math.log2(n));
  const searchRange = 2 ** entrySelector * 16;
  const out = Buffer.alloc(12 + 16 * n + tables.reduce((s, t) => s + ((t.body.length + 3) & ~3), 0));
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(n, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(n * 16 - searchRange, 10);
  let offset = 12 + 16 * n;
  tables.forEach((t, i) => {
    const rec = 12 + 16 * i;
    out.write(t.tag, rec, 4, "ascii");
    out.writeUInt32BE(checksum(t.body), rec + 4);
    out.writeUInt32BE(offset, rec + 8);
    out.writeUInt32BE(t.body.length, rec + 12);
    t.body.copy(out, offset);
    offset += (t.body.length + 3) & ~3;
  });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}
