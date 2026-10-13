import { encode } from "uqr";

/** The quiet zone around the code, in modules: the QR standard asks for four (rule 1621). */
export const QR_QUIET = 4;

/** A QR code as one SVG path: `size` modules wide (quiet zone included), `d` draws the dark modules. */
export type QrPath = { size: number; d: string };

/**
 * The QR code of `text` (rule 1620), computed in this process by `uqr` from the text alone: no request, no image
 * service, nothing stored or logged. Error correction M; each run of dark modules on a row is one `M x y h w v1 h-w z`
 * rectangle, so the SVG is built from numbers only and never from markup.
 */
export function qrPath(text: string): QrPath {
  const { data, size } = encode(text, { ecc: "M", border: QR_QUIET });
  const parts: string[] = [];
  for (let y = 0; y < size; y++) {
    const row = data[y];
    for (let x = 0; x < size; x++) {
      if (!row[x]) continue;
      let w = 1;
      while (x + w < size && row[x + w]) w++;
      parts.push(`M${x} ${y}h${w}v1h-${w}z`);
      x += w - 1;
    }
  }
  return { size, d: parts.join("") };
}
