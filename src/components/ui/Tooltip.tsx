"use client";
import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { placeFixed, type Align, type Side } from "./anchored";
import { cn, mergeRefs, mergeTriggerProps } from "@/lib/ui-utils";

/** How long the pointer rests on a trigger before its tooltip shows, in ms. Keyboard focus shows it at once. */
export const TIP_DELAY = 400;

/** Where a tooltip is: showing, or waiting for the delay to pass. */
export type TipState = { open: boolean; waiting: boolean };
export type TipEvent = "enter" | "leave" | "focus" | "blur" | "escape" | "press" | "delay" | "scroll";

/**
 * The tooltip's rules as a pure step (rule 3634), so a test can drive them. A mouse or pen resting on the trigger waits
 * out the delay and then shows; keyboard focus shows at once; leaving, blur, Escape, a press and a scroll hide it. A touch
 * pointer does nothing: a touch screen has no hover, so the first tap is the button's own tap and no tooltip stands in
 * its way. The component runs the delay timer while `waiting` is on.
 */
export function tipStep(s: TipState, e: TipEvent, pointer: "mouse" | "pen" | "touch" = "mouse"): TipState {
  switch (e) {
    case "enter": return pointer === "touch" || s.open ? s : { open: false, waiting: true };
    case "delay": return s.waiting ? { open: true, waiting: false } : s;
    case "focus": return { open: true, waiting: false };
    default: return { open: false, waiting: false };
  }
}

/**
 * A hint for a control (rule 3634): a short line on hover (after `TIP_DELAY`) and on keyboard focus, gone on Escape, blur,
 * mouse leave, a press or a scroll. It describes, it never names: an icon button keeps its own `aria-label`, and the
 * tooltip repeats it for sighted mouse users. The tooltip is `role="tooltip"`, in the page but `hidden` while closed, and
 * the trigger gets `aria-describedby` pointing at it, unless the trigger's `aria-label` already says exactly `label` (a
 * screen reader would read it twice). The tooltip never takes pointer events, so it cannot sit in the way of a tap; on
 * touch it does not show on tap at all.
 *
 * `children` is the one trigger element, a DOM element or a component that passes `ref` and its props on to one. Its own
 * handlers and ref are kept (`mergeTriggerProps`), so it can also be a Popover's or a Menu's trigger. The tooltip is drawn
 * with fixed coordinates, flipped and clamped to stay on screen, with "start" and "end" mirrored in Arabic. It fades in
 * only where the person has not asked for less motion (`.tip` in globals.css).
 */
export default function Tooltip({ label, children, side = "top", align = "center", defaultOpen = false, className }: {
  label: string;
  children: React.ReactElement<Record<string, unknown>>;
  side?: Side;
  align?: Align;
  /** Starts shown. For the server-rendered markup in a test; the page leaves it off. */
  defaultOpen?: boolean;
  className?: string;
}) {
  const id = useId();
  const [state, setState] = useState<TipState>({ open: defaultOpen, waiting: false });
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const tip = useRef<HTMLSpanElement>(null);

  const send = useCallback((e: TipEvent, pointer?: "mouse" | "pen" | "touch") => {
    setState((s) => {
      const next = tipStep(s, e, pointer);
      return next.open === s.open && next.waiting === s.waiting ? s : next;
    });
  }, []);

  // The delay: runs while the pointer rests, and is cleared the moment `waiting` turns off (leave, press, blur).
  useEffect(() => {
    if (!state.waiting) return;
    const t = setTimeout(() => send("delay"), TIP_DELAY);
    return () => clearTimeout(t);
  }, [state.waiting, send]);

  // Escape hides it wherever focus is, and only it: the press is taken so a dialog behind does not also close.
  useEffect(() => {
    if (!state.open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); send("escape"); } };
    const away = () => send("scroll");
    document.addEventListener("keydown", esc, true);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => { document.removeEventListener("keydown", esc, true); window.removeEventListener("scroll", away, true); window.removeEventListener("resize", away); };
  }, [state.open, send]);

  // Placed once it is shown and before it is painted, so it never appears in the wrong place first. It writes the DOM,
  // not state: the position is not something the page renders from.
  useLayoutEffect(() => {
    const p = tip.current;
    if (!state.open || !trigger || !p) return;
    const r = trigger.getBoundingClientRect();
    const at = placeFixed({
      anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      panel: { width: p.offsetWidth, height: p.offsetHeight },
      viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
      side,
      align,
      rtl: getComputedStyle(trigger).direction === "rtl",
    });
    p.style.left = `${at.left}px`;
    p.style.top = `${at.top}px`;
  }, [state.open, trigger, side, align, label]);

  const own = children.props;
  // One ref for the trigger's own and ours, kept the same between renders: a new function each render would be detached
  // and attached again on every commit.
  const ownRef = own.ref as Ref<HTMLElement> | undefined;
  const ref = useMemo(() => mergeRefs<HTMLElement>(ownRef, setTrigger), [ownRef]);
  // The aria-label already says it: describing it again would read it twice.
  const describe = own["aria-label"] !== label;
  const merged = mergeTriggerProps(own, {
    "aria-describedby": describe ? id : undefined,
    onPointerEnter: (e: React.PointerEvent) => send("enter", e.pointerType as "mouse" | "pen" | "touch"),
    onPointerLeave: () => send("leave"),
    onPointerDown: () => send("press"),
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      // Only a keyboard focus: a tap or a click on a button also focuses it, and must not raise a tooltip.
      let visible = true;
      try { visible = e.currentTarget.matches(":focus-visible"); } catch { /* an old engine: show on focus */ }
      if (visible) send("focus");
    },
    onBlur: () => send("blur"),
  });

  return (
    <>
      {cloneElement(children, { ...merged, ref })}
      <span
        ref={tip}
        id={id}
        role="tooltip"
        hidden={!state.open}
        style={state.open ? { position: "fixed" } : undefined}
        className={cn("tip pointer-events-none z-[60] w-max max-w-64 rounded-lg bg-inverse px-2.5 py-1.5 text-xs font-medium leading-snug text-inverse-foreground", className)}
      >
        {label}
      </span>
    </>
  );
}
