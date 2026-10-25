/**
 * The arithmetic of the square crop dialog (rules 3618-3620, src/components/ui/CropDialog.tsx), pure so a test can drive
 * it without a canvas. A frame of side `view` (CSS pixels) looks at the image drawn at `scale` with its top-left corner
 * at (`x`, `y`) inside the frame. `scale` is `base(...) * zoom`:
 *
 *  - "cover" (a picture): zoom 1 fills the frame with the image's short side, so the crop is always all image;
 *  - "contain" (a logo): zoom 1 shows the WHOLE image inside the frame (the rest is white), and zooming in crops, so a
 *    wide or tall mark can be kept whole.
 *
 * Positions are physical (x to the right), whatever the page's direction: the picture is an image, never mirrored in
 * RTL, and an arrow key moves it the way the arrow points.
 */

export type CropFit = "cover" | "contain";
export type CropState = { x: number; y: number; zoom: number };
export type CropBox = { w: number; h: number; view: number; fit: CropFit };

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
/** One zoom key or button step. */
export const ZOOM_STEP = 0.1;
/** One arrow key step, in frame pixels (Shift moves one pixel). */
export const NUDGE = 10;
/** The side of the square the dialog hands to the upload (the server makes its own 256 px copy from it). */
export const OUT_PX = 512;

const clampN = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The scale at zoom 1: the short side fills the frame ("cover") or the long side fits it ("contain"). */
export function baseScale(b: CropBox): number {
  if (!(b.w > 0 && b.h > 0 && b.view > 0)) return 1;
  return b.fit === "cover" ? b.view / Math.min(b.w, b.h) : b.view / Math.max(b.w, b.h);
}

export const scaleOf = (b: CropBox, zoom: number) => baseScale(b) * clampN(zoom, MIN_ZOOM, MAX_ZOOM);

/**
 * Keep the image where it may be: an image wider than the frame covers it (no empty band on either side); one narrower
 * than the frame stays inside it. The same on each axis.
 */
export function clampState(b: CropBox, s: CropState): CropState {
  const zoom = clampN(Number.isFinite(s.zoom) ? s.zoom : MIN_ZOOM, MIN_ZOOM, MAX_ZOOM);
  const k = scaleOf(b, zoom);
  const axis = (pos: number, size: number) => {
    const room = b.view - size * k;
    const p = Number.isFinite(pos) ? pos : room / 2;
    return clampN(p, Math.min(0, room), Math.max(0, room));
  };
  return { x: axis(s.x, b.w), y: axis(s.y, b.h), zoom };
}

/** The opening state: zoom 1, the image centred. */
export const initialState = (b: CropBox): CropState => {
  const k = scaleOf(b, MIN_ZOOM);
  return clampState(b, { x: (b.view - b.w * k) / 2, y: (b.view - b.h * k) / 2, zoom: MIN_ZOOM });
};

/** Move the image by (dx, dy) frame pixels, kept in bounds. */
export const nudge = (b: CropBox, s: CropState, dx: number, dy: number): CropState => clampState(b, { ...s, x: s.x + dx, y: s.y + dy });

/** Zoom to `zoom`, keeping the point at the frame's centre where it is, kept in bounds. */
export function zoomTo(b: CropBox, s: CropState, zoom: number): CropState {
  const from = scaleOf(b, s.zoom);
  const z = clampN(zoom, MIN_ZOOM, MAX_ZOOM);
  const to = scaleOf(b, z);
  const c = b.view / 2;
  // The image point under the centre, in image pixels, before and after.
  const ix = (c - s.x) / from;
  const iy = (c - s.y) / from;
  return clampState(b, { x: c - ix * to, y: c - iy * to, zoom: z });
}

/**
 * Where to draw the whole image on an output square of side `out` so it shows exactly what the frame shows: the
 * arguments of `ctx.drawImage(img, dx, dy, dw, dh)` after filling the square white. Drawing the whole image (never a
 * source rectangle) keeps browsers from disagreeing about a crop that reaches past the image's edge.
 */
export function drawRect(b: CropBox, s: CropState, out: number): { dx: number; dy: number; dw: number; dh: number } {
  const c = clampState(b, s);
  const k = scaleOf(b, c.zoom);
  const f = out / b.view;
  return { dx: c.x * f, dy: c.y * f, dw: b.w * k * f, dh: b.h * k * f };
}

/** What a key does in the frame: a move, a zoom, or nothing (left to the dialog: Escape, Tab). */
export function keyAction(key: string, shift: boolean): { move: [number, number] } | { zoom: number } | null {
  const step = shift ? 1 : NUDGE;
  switch (key) {
    case "ArrowLeft": return { move: [-step, 0] };
    case "ArrowRight": return { move: [step, 0] };
    case "ArrowUp": return { move: [0, -step] };
    case "ArrowDown": return { move: [0, step] };
    case "+": case "=": return { zoom: ZOOM_STEP };
    case "-": case "_": return { zoom: -ZOOM_STEP };
    default: return null;
  }
}
