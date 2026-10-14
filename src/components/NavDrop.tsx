"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import Scribble from "./Scribble";
import ScribbleStatic from "./ScribbleStatic";

export type NavItem = { href: string; label: string; note?: string };

/**
 * The desktop dropdown in the site nav (rule 1855). It opens on hover and on keyboard focus, as before, with CSS alone;
 * the script only closes it. Escape closes the panel and puts focus back on the tab's own link, whether the pointer or
 * the keyboard opened it, and the panel stays shut until the pointer leaves or focus moves out of the menu. ArrowDown on
 * the tab opens it again and moves focus to the first item. The tab is a plain link to its page: no `aria-haspopup`,
 * because it is not a menu button, and a link that announces a popup it does not open by itself misleads a screen reader.
 */
export default function NavDrop({ label, href, items, rtl }: { label: string; href: string; items: NavItem[]; rtl: boolean }) {
  const [shut, setShut] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const tab = useRef<HTMLAnchorElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = box.current;
      if (e.key !== "Escape" || !el) return;
      const focusIn = el.contains(document.activeElement);
      if (!focusIn && !el.matches(":hover")) return;
      setShut(true);
      if (focusIn) tab.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const open = shut ? "" : "group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100";
  return (
    <div
      ref={box}
      className="group relative"
      data-nav-drop
      onMouseLeave={() => setShut(false)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setShut(false); }}
    >
      <Link
        ref={tab}
        href={href}
        className="s-link flex min-h-[var(--hit-min)] items-center gap-1 text-foreground"
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown") return;
          e.preventDefault();
          setShut(false);
          // The panel turns visible on this render; focus its first link once it can take focus.
          requestAnimationFrame(() => panel.current?.querySelector<HTMLAnchorElement>("a")?.focus());
        }}
      >
        <ScribbleStatic kind="underline" seed={`nav-${href}`} rtl={rtl} />
        {label}
        <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      </Link>
      <div ref={panel} className={`invisible absolute start-0 top-full z-50 w-72 isolate p-2 opacity-0 transition-opacity ${open}`}>
        <Scribble kind="box" seed={`drop-${href}`} fill="paper" />
        {items.map((i) => (
          <Link key={i.href} href={i.href} className="flex min-h-[var(--hit-min)] flex-col justify-center rounded-md px-3 py-1.5 text-sm text-foreground hover:bg-background-muted">
            <span className="font-medium">{i.label}</span>
            {i.note && <span className="block text-xs text-foreground-muted">{i.note}</span>}
          </Link>
        ))}
      </div>
    </div>
  );
}
