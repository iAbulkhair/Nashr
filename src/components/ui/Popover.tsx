"use client";
import { createContext, useCallback, useContext, useEffect, useId, useRef } from "react";
import { ANCHOR_BY_DATA, closesOnFocusMove, closesOnKey, useFlip, useOpenState, useOutsidePress, type Align, type Side } from "./anchored";
import { cn } from "@/lib/ui-utils";

/** What the trigger render function gets: spread it on the button. */
export type PopoverTriggerProps = React.ComponentProps<"button">;

/** The tabbable things inside a panel, in document order: where focus goes when it opens. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const CloseContext = createContext<(refocus?: boolean) => void>(() => {});

/** The panel's own `close(refocus)`, for a form inside a Popover that closes it when saved (`refocus` gives focus back to the trigger). */
export function usePopoverClose(): (refocus?: boolean) => void {
  return useContext(CloseContext);
}

/**
 * A floating panel hung off a button, for content that is not a list of commands: a form, a short explanation, a filter
 * (rule 3633). `Menu` is for commands; this is the non-modal dialog pattern. The trigger says `aria-haspopup="dialog"`,
 * `aria-expanded` and, while open, `aria-controls`; the panel is `role="dialog"` named by `label`. Opening moves focus to
 * the panel's first field or button (the panel itself when it has none), and Escape closes it and gives focus back to the
 * trigger. A press outside, or Tab to something outside, closes it without taking focus back. Focus leaving the browser
 * window does not close it, so a half-written form survives a look at another window.
 *
 * Controlled (`open` and `onOpenChange`) or uncontrolled (`defaultOpen`). `side` and `align` are the wanted place and are
 * logical: "start" is the inline-start edge, the left in English and the right in Arabic. They flip when the panel would
 * run off the screen (`useFlip`). Content inside can call `usePopoverClose()`. The panel has no width, padding or look of
 * its own beyond the frame: pass them in `panelClassName`, which is joined with `cn`, so nothing it sets is fought by a default.
 */
export default function Popover({ label, trigger, children, open, defaultOpen, onOpenChange, side = "bottom", align = "start", className, panelClassName }: {
  /** The panel's accessible name. */
  label: string;
  trigger: (props: PopoverTriggerProps, open: boolean) => React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: Side;
  align?: Align;
  className?: string;
  panelClassName?: string;
}) {
  const [isOpen, setOpen] = useOpenState({ open, defaultOpen, onOpenChange });
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useFlip(isOpen, box, panel, side, align);

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  }, [setOpen]);
  const clickAway = useCallback(() => close(false), [close]);
  useOutsidePress(isOpen, box, clickAway);

  // Focus goes into the panel when it opens.
  useEffect(() => {
    if (!isOpen) return;
    const p = panel.current;
    (p?.querySelector<HTMLElement>(FOCUSABLE) ?? p)?.focus();
  }, [isOpen]);

  // Escape anywhere in the wrapper closes it and gives focus back; Tab to an element outside closes it. Native listeners on
  // the wrapper: the wrapper is not an interactive element, and a stopped Escape never reaches a Dialog behind it.
  useEffect(() => {
    const b = box.current;
    if (!isOpen || !b) return;
    const key = (e: KeyboardEvent) => { if (closesOnKey(true, e.key)) { e.preventDefault(); e.stopPropagation(); close(true); } };
    const out = (e: FocusEvent) => { if (closesOnFocusMove(true, b, e.relatedTarget)) close(false); };
    b.addEventListener("keydown", key);
    b.addEventListener("focusout", out);
    return () => { b.removeEventListener("keydown", key); b.removeEventListener("focusout", out); };
  }, [isOpen, close]);

  return (
    <div ref={box} className={cn("relative inline-flex", className)}>
      {trigger({
        ref: btn,
        type: "button",
        id: `${id}-button`,
        "aria-haspopup": "dialog",
        "aria-expanded": isOpen,
        "aria-controls": isOpen ? `${id}-panel` : undefined,
        onClick: () => setOpen(!isOpen),
      }, isOpen)}
      {isOpen && (
        <div
          ref={panel}
          id={`${id}-panel`}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          data-side={side}
          data-align={align}
          className={cn("absolute z-50 max-w-[calc(100vw-1rem)] rounded-xl border-[1.5px] border-border-strong bg-popover text-sm text-foreground", ANCHOR_BY_DATA, panelClassName)}
        >
          <CloseContext.Provider value={close}>{children}</CloseContext.Provider>
        </div>
      )}
    </div>
  );
}
