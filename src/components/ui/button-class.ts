/**
 * The class string for a button look (rule 1082), kept apart from `Button.tsx` so a server component can style a
 * `<Link>` or an `<a>` the same way: a function exported from a "use client" file cannot be called on the server.
 * The look is the `.btn` family in globals.css; this only picks the classes, so the old class names keep working.
 */
export type ButtonVariant = "primary" | "secondary" | "accent" | "danger" | "danger-solid" | "ghost" | "ghost-inverse";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  accent: "btn-accent",
  danger: "btn-danger",
  "danger-solid": "btn-danger-solid",
  ghost: "btn-ghost",
  "ghost-inverse": "btn-ghost-inverse",
};

/** sm is 36px for dense rows (above the 24px floor); md is the 44px main target; lg is the 48px page CTA. */
const SIZE: Record<ButtonSize, string> = {
  sm: "btn-sm btn-h-sm",
  md: "btn-h-md",
  lg: "btn-lg btn-h-lg",
};

export function buttonClass({ variant = "primary", size = "md", block = false, className = "" }: { variant?: ButtonVariant; size?: ButtonSize; block?: boolean; className?: string } = {}): string {
  return ["btn", VARIANT[variant], SIZE[size], block ? "btn-block" : "", className].filter(Boolean).join(" ");
}
