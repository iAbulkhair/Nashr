"use client";
import Scribble from "@/components/Scribble";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./button-class";

type Props = Omit<React.ComponentProps<"button">, "children"> & {
  children: React.ReactNode;
  /** `pill` is the hand-drawn ink pill of the sign-in screens (rule 519) and needs a `seed`; the rest are the `.btn` looks. */
  variant?: ButtonVariant | "pill";
  size?: ButtonSize;
  /** The request is on its way: a spinner shows, the button says it is busy and ignores clicks, and keeps its focus. */
  loading?: boolean;
  /** Replaces the label while loading ("Saving…"), from the caller's dictionary. */
  loadingText?: string;
  /** The pill's stable shape. */
  seed?: string;
  block?: boolean;
};

/** A small ring that turns; still under reduced motion. Hidden from screen readers: `aria-busy` says it instead. */
export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={`${className} shrink-0 animate-spin motion-reduce:animate-none`}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The one button (rule 1082). `type` defaults to "button", so a button inside a form never submits by accident; a
 * submit says `type="submit"`. While `loading` the button is `aria-busy` and `aria-disabled` rather than `disabled`: a
 * disabled button drops the keyboard focus to the page, and the person who pressed Enter loses their place. Its click is
 * cancelled while loading, so a double press never posts twice; the form's own handler still guards with its busy flag,
 * because Enter in a text field submits without touching the button. A caller's own `aria-disabled` (a submit that stays
 * focusable to explain unmet rules) is kept and does not cancel the click.
 */
export default function Button({ variant = "primary", size = "md", loading = false, loadingText, seed, block = false, className = "", type = "button", onClick, children, ...rest }: Props) {
  const busy = loading || undefined;
  const label = loading && loadingText ? loadingText : children;
  const guard = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (loading) { e.preventDefault(); return; }
    onClick?.(e);
  };
  if (variant === "pill") {
    return (
      <button {...rest} type={type} onClick={guard} aria-busy={busy} aria-disabled={loading ? true : rest["aria-disabled"]} className={["s-btn gap-2", block ? "w-full" : "", className].filter(Boolean).join(" ")}>
        <Scribble kind="pill" seed={seed ?? "ui-button"} fill="ink" shadow ring />
        {loading && <Spinner />}
        {label}
      </button>
    );
  }
  return (
    <button {...rest} type={type} onClick={guard} aria-busy={busy} aria-disabled={loading ? true : rest["aria-disabled"]} className={buttonClass({ variant, size, block, className })}>
      {loading && <Spinner />}
      {label}
    </button>
  );
}
