import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";
/**
 * What the panels that hang off a button share (rule 3632): `Menu`, `Popover` and `Tooltip`. Where a panel sits is stated
 * in logical terms (`align` "start" is the inline-start edge: the left in English, the right in Arabic), so a screen never
 * says left or right. `Menu` and `Popover` place their panel with CSS (`anchorClass`, which the page's direction mirrors)
 * and ask `flipPlacement` only whether that placement runs off the screen; `Tooltip`, which draws no wrapper around its
 * trigger, is placed with fixed coordinates (`placeFixed`).
 */
export type Side = "top" | "bottom";
export type Align = "start" | "center" | "end";
/** The corners of a rectangle in viewport pixels: what `getBoundingClientRect()` gives. */
export type Box = { left: number; right: number; top: number; bottom: number };
export type Size = { width: number; height: number };

/** The gap between a trigger and its panel, and the margin a panel keeps from the screen edge, in px. */
export const GAP = 4;
export const EDGE = 8;

/**
 * The Tailwind classes that hang an `absolute` panel off a `relative` wrapper: under the trigger (`bottom`) or over it
 * (`top`), flush with its inline-start edge, inline-end edge, or centred. Logical, so Arabic mirrors it for free; the
 * centred one needs the translate flipped in a right-to-left page.
 */
export function anchorClass(side: Side, align: Align): string {
  const v = side === "top" ? "bottom-full mb-1" : "top-full mt-1";
  const h = align === "start" ? "start-0" : align === "end" ? "end-0" : "start-1/2 -translate-x-1/2 rtl:translate-x-1/2";
  return `${v} ${h}`;
}

/** The physical left and right edges of a panel `width` wide whose logical `align` is set against `anchor`. */
export function physicalSpan(anchor: Box, width: number, align: Align, rtl: boolean): { left: number; right: number } {
  let left: number;
  if (align === "center") left = anchor.left + (anchor.right - anchor.left - width) / 2;
  else if ((align === "start") !== rtl) left = anchor.left; // start in English, end in Arabic: the panel grows rightwards from the anchor's left edge
  else left = anchor.right - width;
  return { left, right: left + width };
}

export type Fit = { anchor: Box; panel: Size; viewport: Size; side: Side; align: Align; rtl: boolean; gap?: number; margin?: number };

/**
 * The side and alignment a panel really gets: the wanted ones when the panel fits there, else the opposite side when that
 * has more room, and the first alignment (the wanted one, then the other edge, then centred) whose span stays inside the
 * screen less `margin`. When nothing fits it keeps what was asked. `rtl` matters because "start" is the right edge in
 * Arabic: an anchor near the left edge of the screen has room for an English start-aligned panel and none for an Arabic one.
 */
export function flipPlacement({ anchor, panel, viewport, side, align, rtl, gap = GAP, margin = EDGE }: Fit): { side: Side; align: Align } {
  const below = viewport.height - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  const room = side === "bottom" ? below : above;
  const other = side === "bottom" ? above : below;
  const flipped: Side = panel.height > room && other > room ? (side === "bottom" ? "top" : "bottom") : side;
  const fits = (a: Align) => {
    const s = physicalSpan(anchor, panel.width, a, rtl);
    return s.left >= margin && s.right <= viewport.width - margin;
  };
  const order: Align[] = align === "center" ? ["center", "start", "end"] : align === "start" ? ["start", "end", "center"] : ["end", "start", "center"];
  return { side: flipped, align: order.find(fits) ?? align };
}

/** Fixed coordinates for a panel (the tooltip): `flipPlacement`, then clamped into the screen so it is never cut off. */
export function placeFixed(f: Fit): { side: Side; align: Align; left: number; top: number } {
  const { side, align } = flipPlacement(f);
  const gap = f.gap ?? GAP;
  const margin = f.margin ?? EDGE;
  const span = physicalSpan(f.anchor, f.panel.width, align, f.rtl);
  const left = Math.max(margin, Math.min(span.left, f.viewport.width - margin - f.panel.width));
  const top = side === "bottom" ? f.anchor.bottom + gap : f.anchor.top - gap - f.panel.height;
  return { side, align, left, top };
}

const asBox = (r: DOMRect): Box => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
const isRtl = (el: Element) => getComputedStyle(el).direction === "rtl";

/**
 * Keeps an open CSS-placed panel on screen: measured after it opens (before the browser paints, so nothing jumps) and
 * again on resize and scroll, then written to the panel's `data-side` and `data-align` (`ANCHOR_BY_DATA` turns them into
 * classes). It writes the DOM and not React state, so a flip costs no extra render. `anchor` is the `relative` wrapper the
 * panel hangs from.
 */
export function useFlip(open: boolean, anchor: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, side: Side, align: Align): void {
  useLayoutEffect(() => {
    const a = anchor.current;
    const p = panel.current;
    if (!open || !a || !p) return;
    const place = () => {
      const next = flipPlacement({
        anchor: asBox(a.getBoundingClientRect()),
        panel: { width: p.offsetWidth, height: p.offsetHeight },
        viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
        side,
        align,
        rtl: isRtl(a),
      });
      p.setAttribute("data-side", next.side);
      p.setAttribute("data-align", next.align);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, anchor, panel, side, align]);
}

/**
 * The classes for a panel whose side and alignment are read from its `data-side` and `data-align` attributes, which
 * `useFlip` rewrites when the panel would run off the screen. The same logical placement as `anchorClass`, so Arabic mirrors.
 */
export const ANCHOR_BY_DATA = "data-[side=bottom]:top-full data-[side=bottom]:mt-1 data-[side=top]:bottom-full data-[side=top]:mb-1 data-[align=start]:start-0 data-[align=end]:end-0 data-[align=center]:start-1/2 data-[align=center]:-translate-x-1/2 data-[align=center]:rtl:translate-x-1/2";

/** Whether a press at `target` is outside `box`: the click-away test. No box (not mounted) is never outside. Pure for the tests. */
export function isOutside(box: { contains(n: Node): boolean } | null, target: Node): boolean {
  return !!box && !box.contains(target);
}

/** Whether a key closes an open panel and takes focus back to its trigger: Escape, only while it is open. Pure for the tests. */
export function closesOnKey(open: boolean, key: string): boolean {
  return open && key === "Escape";
}

/**
 * Whether focus moving to `next` closes an open Popover: only when it lands on another element outside the panel's
 * wrapper (Tab past the end). Focus going to no element (another window, the browser's own controls) does not, so a
 * half-written form survives a look at another window. Pure for the tests.
 */
export function closesOnFocusMove(open: boolean, wrapper: { contains(n: Node): boolean } | null, next: EventTarget | null): boolean {
  return open && next !== null && typeof (next as Node).nodeType === "number" && isOutside(wrapper, next as Node);
}

/** Calls `onOutside` when a press lands outside `box` while `open`: the click-away of a menu or a popover (rule 1112). */
export function useOutsidePress(open: boolean, box: RefObject<HTMLElement | null>, onOutside: () => void): void {
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (isOutside(box.current, e.target as Node)) onOutside(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, box, onOutside]);
}

/**
 * Open state that is the caller's when `open` is passed (controlled: `onOpenChange` asks, the caller decides) and the
 * component's own otherwise (uncontrolled, starting at `defaultOpen`). `onOpenChange` is told in both modes.
 */
export function useOpenState({ open, defaultOpen = false, onOpenChange }: { open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void }): [boolean, (next: boolean) => void] {
  const [own, setOwn] = useState(defaultOpen);
  const controlled = open !== undefined;
  const value = controlled ? open : own;
  const set = useCallback((next: boolean) => {
    if (!controlled) setOwn(next);
    onOpenChange?.(next);
  }, [controlled, onOpenChange]);
  return [value, set];
}
