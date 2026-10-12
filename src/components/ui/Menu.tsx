"use client";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";

/** One row of a menu: a link, or an action. */
export type MenuItem = { key: string; label: React.ReactNode; href?: string; onSelect?: () => void; external?: boolean };

/** Where focus lands when the menu opens or moves: the item at `i`, wrapped into range. Pure, so a test can drive it. */
export function menuIndex(key: string, i: number, n: number): number | null {
  if (n === 0) return null;
  if (key === "ArrowDown") return (i + 1 + n) % n;
  if (key === "ArrowUp") return (i - 1 + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return null;
}

/**
 * A menu button (rule 1112), the WAI-ARIA pattern: the trigger says `aria-haspopup="menu"` and whether it is open; the
 * list is `role="menu"` with `role="menuitem"` rows. Opening puts focus on the first row (ArrowUp on the trigger: the
 * last); ArrowDown and ArrowUp move and wrap, Home and End jump, Escape closes and gives focus back to the trigger, and
 * focus leaving the menu (Tab past the footer) or a click outside closes it. Rows are links or actions; choosing one closes the menu. `footer` is drawn under the rows
 * and outside the menu role (a language switch, a sign-out form), reachable with Tab. `trigger` renders the button from
 * the props it is given, so the caller keeps its look; every row is at least 44px tall on touch screens.
 */
export default function Menu({ label, items, trigger, footer, placement = "bottom", align = "start", className = "" }: {
  /** The menu's accessible name, also used when the trigger has no text of its own. */
  label: string;
  items: MenuItem[];
  trigger: (props: React.ComponentProps<"button">, open: boolean) => React.ReactNode;
  footer?: React.ReactNode;
  placement?: "top" | "bottom";
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const first = useRef<"first" | "last">("first");
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const rows = useRef<(HTMLElement | null)[]>([]);
  const id = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const n = items.length;
    rows.current[first.current === "last" ? n - 1 : 0]?.focus();
    const outside = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) close(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, items.length, close]);

  function onTriggerKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      first.current = e.key === "ArrowUp" ? "last" : "first";
      setOpen(true);
    }
  }
  function onMenuKey(e: React.KeyboardEvent<HTMLUListElement>) {
    const at = rows.current.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); return; }
    const next = menuIndex(e.key, at, items.length);
    if (next !== null) { e.preventDefault(); rows.current[next]?.focus(); }
  }
  const choose = (it: MenuItem) => { close(false); it.onSelect?.(); };
  const row = "flex min-h-[var(--hit-min)] w-full items-center gap-2 rounded-lg px-3 text-start text-sm text-foreground-muted hover:bg-background-muted hover:text-foreground focus-visible:bg-background-muted focus-visible:text-foreground pointer-fine:min-h-9";

  return (
    // Focus leaving the trigger, the rows and the footer (Tab past the end, a click elsewhere) closes the menu; Tab from a
    // row goes on to the footer, which stays open for it.
    <div ref={box} className={`relative ${className}`} onBlur={(e) => { if (open && !box.current?.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
      {trigger({
        ref: btn,
        type: "button",
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": open ? `${id}-menu` : undefined,
        id: `${id}-button`,
        onClick: () => { first.current = "first"; setOpen((v) => !v); },
        onKeyDown: onTriggerKey,
      }, open)}
      {open && (
        <div className={`absolute z-50 min-w-56 rounded-xl border-[1.5px] border-border-strong bg-popover p-2 text-sm text-foreground ${placement === "top" ? "bottom-full mb-1" : "top-full mt-1"} ${align === "start" ? "start-0" : "end-0"}`}>
          <ul id={`${id}-menu`} role="menu" aria-label={label} onKeyDown={onMenuKey} className="grid gap-0.5">
            {items.map((it, i) => (
              <li key={it.key} role="none">
                {it.href ? (
                  it.external
                    ? <a ref={(el) => { rows.current[i] = el; }} role="menuitem" tabIndex={-1} href={it.href} target="_blank" rel="noreferrer" onClick={() => choose(it)} className={row}>{it.label}</a>
                    : <Link ref={(el) => { rows.current[i] = el; }} role="menuitem" tabIndex={-1} href={it.href} onClick={() => choose(it)} className={row}>{it.label}</Link>
                ) : (
                  <button ref={(el) => { rows.current[i] = el; }} role="menuitem" tabIndex={-1} type="button" onClick={() => choose(it)} className={row}>{it.label}</button>
                )}
              </li>
            ))}
          </ul>
          {footer && <div className="mt-2 border-t border-border pt-2">{footer}</div>}
        </div>
      )}
    </div>
  );
}
