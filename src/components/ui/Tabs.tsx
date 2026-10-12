"use client";
import { useRef } from "react";

/**
 * The tab a key moves to (rule 1113): ArrowRight goes toward the inline end, which is the previous tab in a right-to-left
 * row, so the arrow always moves the way it points. Home and End jump; anything else is not a move. Pure for the tests.
 */
export function tabStep(key: string, i: number, n: number, rtl: boolean): number | null {
  if (n === 0) return null;
  const fwd = rtl ? "ArrowLeft" : "ArrowRight";
  const back = rtl ? "ArrowRight" : "ArrowLeft";
  if (key === fwd) return (i + 1) % n;
  if (key === back) return (i - 1 + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return null;
}

/**
 * Tabs (rule 1113), the WAI-ARIA pattern with automatic activation: one `role="tablist"` row of `role="tab"` buttons, the
 * chosen one `aria-selected` and the only one in the Tab order; the arrows move and choose (RTL-aware, `tabStep`), Home
 * and End jump. Each tab names the panel it controls: render that panel with `TabPanel` and the same `idBase`. Each tab is
 * 44px tall on touch screens and the choice is marked by fill and weight, not colour alone.
 */
export default function Tabs<T extends string>({ idBase, label, value, onChange, items, className = "" }: {
  idBase: string;
  label: string;
  value: T;
  onChange: (v: T) => void;
  items: { id: T; label: React.ReactNode }[];
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKey(e: React.KeyboardEvent<HTMLElement>, i: number) {
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const next = tabStep(e.key, i, items.length, rtl);
    if (next === null) return;
    e.preventDefault();
    onChange(items[next].id);
    refs.current[next]?.focus();
  }
  return (
    <div role="tablist" aria-label={label} className={`inline-flex rounded-full border border-border p-0.5 ${className}`}>
      {items.map((it, i) => {
        const on = it.id === value;
        return (
          <button
            key={it.id}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${it.id}`}
            aria-selected={on}
            aria-controls={`${idBase}-panel-${it.id}`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(it.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={`min-h-[var(--hit-min)] rounded-full px-4 text-sm pointer-fine:min-h-8 pointer-fine:px-3 pointer-fine:text-xs ${on ? "bg-inverse font-semibold text-inverse-foreground" : "text-foreground-muted hover:text-foreground"}`}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

/** The panel one tab controls; hidden while another tab is chosen. */
export function TabPanel({ idBase, id, value, className, children }: { idBase: string; id: string; value: string; className?: string; children: React.ReactNode }) {
  if (id !== value) return null;
  return (
    <div role="tabpanel" id={`${idBase}-panel-${id}`} aria-labelledby={`${idBase}-tab-${id}`} tabIndex={0} className={className}>
      {children}
    </div>
  );
}
