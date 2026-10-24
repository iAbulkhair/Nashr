"use client";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "./Dialog";
import Button from "./Button";
import { MAX_ZOOM, MIN_ZOOM, OUT_PX, ZOOM_STEP, clampState, drawRect, initialState, keyAction, nudge, zoomTo, type CropBox, type CropFit, type CropState } from "@/lib/crop";

type Lang = "ar" | "en";

const COPY = {
  ar: {
    title: "اقتصاص الصورة",
    hint: "اسحب الصورة لتحريكها، والأسهم تحرّكها أيضًا، و + و − للتكبير والتصغير.",
    area: "منطقة الاقتصاص. الأسهم تحرّك الصورة، و + و − للتكبير والتصغير.",
    zoom: "التكبير", zoomIn: "تكبير", zoomOut: "تصغير",
    save: "استخدم الصورة", cancel: "إلغاء", working: "يجهّز…",
    unreadable: "تعذّرت قراءة الصورة. جرّب ملفًا آخر.",
  },
  en: {
    title: "Crop the image",
    hint: "Drag the image to move it; arrow keys move it too, + and − zoom.",
    area: "Crop area. Arrow keys move the image, + and − zoom.",
    zoom: "Zoom", zoomIn: "Zoom in", zoomOut: "Zoom out",
    save: "Use this image", cancel: "Cancel", working: "Preparing…",
    unreadable: "The image could not be read. Try another file.",
  },
} as const;

/** The frame's side on screen, in CSS pixels; the canvas backs it at the device's pixel ratio. */
const VIEW = 256;
/** A picture of more pixels than this is refused here (the server's own limit is 40 million too). */
const MAX_PIXELS = 40_000_000;

/**
 * A square crop with zoom (rules 3618-3620), drawn on a canvas only: no image library, nothing sent anywhere. The file is
 * read locally (an object URL, revoked on close), shown in a square frame and moved by dragging, by the arrow keys
 * (Shift: one pixel) and zoomed by + and − or the slider. "cover" fills the square (a picture); "contain" lets the whole
 * image fit with white around it (a logo). On save the frame is drawn onto a 512 px white square and handed back as a
 * JPEG `Blob`, which goes through the normal upload; the server checks and re-encodes it again. The `Dialog` traps
 * focus and closes on Escape. Movement is physical (never mirrored in RTL); the layout uses logical properties only.
 */
export default function CropDialog({ lang, file, fit = "cover", title, onCropped, onClose }: { lang: Lang; file: File; fit?: CropFit; title?: string; onCropped: (blob: Blob) => Promise<void> | void; onClose: () => void }) {
  const T = COPY[lang];
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = useRef<HTMLButtonElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [bad, setBad] = useState(false);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<CropState>({ x: 0, y: 0, zoom: MIN_ZOOM });
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const box: CropBox | null = img ? { w: img.naturalWidth, h: img.naturalHeight, view: VIEW, fit } : null;

  // Read the file locally; the object URL is revoked when the dialog closes.
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    let live = true;
    im.onload = () => {
      if (!live) return;
      if (!im.naturalWidth || !im.naturalHeight || im.naturalWidth * im.naturalHeight > MAX_PIXELS) return setBad(true);
      const b: CropBox = { w: im.naturalWidth, h: im.naturalHeight, view: VIEW, fit };
      setState(initialState(b));
      setImg(im);
    };
    im.onerror = () => { if (live) setBad(true); };
    im.src = url;
    return () => { live = false; URL.revokeObjectURL(url); };
  }, [file, fit]);

  // Draw the preview whenever the state changes.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !img) return;
    const b: CropBox = { w: img.naturalWidth, h: img.naturalHeight, view: VIEW, fit };
    const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const side = Math.round(VIEW * ratio);
    if (c.width !== side) { c.width = side; c.height = side; }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, side, side);
    const r = drawRect(b, state, side);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, r.dx, r.dy, r.dw, r.dh);
  }, [img, state, fit]);

  const apply = (next: (b: CropBox, s: CropState) => CropState) => { if (box) setState((s) => next(box, s)); };

  function onKey(e: React.KeyboardEvent) {
    const a = keyAction(e.key, e.shiftKey);
    if (!a) return;
    e.preventDefault();
    if ("move" in a) apply((b, s) => nudge(b, s, a.move[0], a.move[1]));
    else apply((b, s) => zoomTo(b, s, s.zoom + a.zoom));
  }

  // Pointer drag: the frame's own pixels, scaled from its drawn size to VIEW.
  const unit = () => VIEW / (frame.current?.getBoundingClientRect().width || VIEW);
  function down(e: React.PointerEvent) {
    if (!box) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }
  function move(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const k = unit();
    const dx = (e.clientX - d.x) * k;
    const dy = (e.clientY - d.y) * k;
    drag.current = { id: d.id, x: e.clientX, y: e.clientY };
    apply((b, s) => nudge(b, s, dx, dy));
  }
  const up = (e: React.PointerEvent) => { if (drag.current?.id === e.pointerId) drag.current = null; };

  async function save(e: React.MouseEvent<HTMLButtonElement>) {
    const dlg = e.currentTarget.closest("dialog");
    if (!img || !box || busy) return;
    setBusy(true);
    try {
      const out = document.createElement("canvas");
      out.width = OUT_PX;
      out.height = OUT_PX;
      const ctx = out.getContext("2d");
      if (!ctx) throw new Error("no_canvas");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, OUT_PX, OUT_PX);
      ctx.imageSmoothingQuality = "high";
      const r = drawRect(box, clampState(box, state), OUT_PX);
      ctx.drawImage(img, r.dx, r.dy, r.dw, r.dh);
      const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/jpeg", 0.92));
      if (!blob) throw new Error("no_blob");
      await onCropped(blob);
      setBusy(false);
      dlg?.close();
    } catch {
      setBusy(false);
      setBad(true);
    }
  }

  return (
    <Dialog lang={lang} title={title ?? T.title} description={T.hint} onClose={onClose} blockClose={busy} className="max-w-sm">
      {bad ? (
        <p role="alert" className="field-error">{T.unreadable}</p>
      ) : (
        <div className="grid justify-items-center gap-4">
          {/* A button, so the frame is a real control: it takes focus first, its arrows move and +/− zoom; a click does nothing. */}
          <button
            ref={frame}
            type="button"
            aria-label={T.area}
            aria-busy={!img}
            onKeyDown={onKey}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            className="block aspect-square w-full max-w-64 cursor-grab touch-none overflow-hidden rounded-lg border-[1.5px] border-border-strong bg-background-muted p-0 outline-offset-2 active:cursor-grabbing"
          >
            <canvas ref={canvas} aria-hidden className="block h-full w-full" />
          </button>
          <div className="flex w-full items-center gap-2">
            <Button variant="ghost" size="sm" aria-label={T.zoomOut} disabled={!img || busy} onClick={() => apply((b, s) => zoomTo(b, s, s.zoom - ZOOM_STEP))}>−</Button>
            <input
              type="range"
              aria-label={T.zoom}
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.01}
              value={state.zoom}
              disabled={!img || busy}
              onChange={(e) => { const z = Number(e.target.value); apply((b, s) => zoomTo(b, s, z)); }}
              className="min-w-0 flex-1"
            />
            <Button variant="ghost" size="sm" aria-label={T.zoomIn} disabled={!img || busy} onClick={() => apply((b, s) => zoomTo(b, s, s.zoom + ZOOM_STEP))}>+</Button>
          </div>
        </div>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-3">
        <Button variant="secondary" size="sm" disabled={busy} onClick={(e) => e.currentTarget.closest("dialog")?.close()}>{T.cancel}</Button>
        {!bad && <Button variant="primary" size="sm" loading={busy} loadingText={T.working} disabled={!img} onClick={(e) => void save(e)}>{T.save}</Button>}
      </div>
    </Dialog>
  );
}
