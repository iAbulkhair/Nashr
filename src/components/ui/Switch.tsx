"use client";

/**
 * An on/off switch (rule 1085): a `<button role="switch">` whose `aria-checked` says the state, named by `label` (shown
 * beside it by the caller, or given here for screen readers). The hit area is 44px square around a 44 by 24 track, and the
 * thumb moves along the inline axis, so it starts on the right in Arabic. State is never colour alone: the thumb's place
 * says it too, and in forced colours the track keeps its border.
 */
export default function Switch({ checked, onChange, label, labelledBy, disabled = false, className = "", ...rest }: Omit<React.ComponentProps<"button">, "onChange" | "role" | "children"> & {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The accessible name when no visible label points at the switch. */
  label?: string;
  /** The id of a visible label, preferred over `label`. */
  labelledBy?: string;
}) {
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`switch ${className}`.trim()}
    >
      <span className="switch-track" aria-hidden><span className="switch-thumb" /></span>
    </button>
  );
}
