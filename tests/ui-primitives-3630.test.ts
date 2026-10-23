// cn, mergeTriggerProps, the shared anchoring, Popover, Tooltip and components.json: rules 3630-3636, listed in
// docs/system/tests/3630-ui-primitives.md. Source-reading checks (no DOM in this suite), static renders and the pure helpers.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createElement as h, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cn, mergeRefs, mergeTriggerProps } from "@/lib/ui-utils";
import { ANCHOR_BY_DATA, anchorClass, closesOnFocusMove, closesOnKey, flipPlacement, isOutside, physicalSpan, placeFixed, type Box } from "@/components/ui/anchored";
import Popover, { usePopoverClose } from "@/components/ui/Popover";
import Tooltip, { TIP_DELAY, tipStep } from "@/components/ui/Tooltip";
import CopyButton from "@/components/ui/CopyButton";

const read = (f: string) => readFileSync(f, "utf8");
// The components take typed props; the tests build them loosely.
const PopoverC = Popover as unknown as ComponentType<Record<string, unknown>>;
const TooltipC = Tooltip as unknown as ComponentType<Record<string, unknown>>;

describe("rule 3630: cn joins class names and nothing else", () => {
  it("skips falsy values and joins strings, arrays and maps in order", () => {
    expect(cn("a", false, null, undefined, 0, "", "b")).toBe("a b");
    expect(cn("a", ["b", [false, "c"]], { d: true, e: false, f: 1 })).toBe("a b c d f");
    expect(cn()).toBe("");
    expect(cn(7, "x")).toBe("7 x");
  });
  it("is not tailwind-merge: two classes for one property both stay, so primitives set no default a caller overrides", () => {
    expect(cn("p-3", "p-0")).toBe("p-3 p-0");
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of ["tailwind-merge", "clsx", "class-variance-authority", "@base-ui/react", "@radix-ui/react-popover", "@radix-ui/react-tooltip"]) expect(all[name], name).toBeUndefined();
  });
});

describe("rule 3631: mergeTriggerProps puts a component's trigger props on an element with its own", () => {
  const ev = (defaultPrevented = false) => ({ defaultPrevented });
  it("chains a handler both have, the element's own first", () => {
    const seen: string[] = [];
    const m = mergeTriggerProps({ onClick: () => seen.push("own") }, { onClick: () => seen.push("component"), onFocus: () => seen.push("focus") });
    (m.onClick as (e: unknown) => void)(ev());
    (m.onFocus as (e: unknown) => void)(ev());
    expect(seen).toEqual(["own", "component", "focus"]);
  });
  it("skips the component's handler when the element's own called preventDefault", () => {
    const seen: string[] = [];
    const m = mergeTriggerProps({ onClick: () => seen.push("own") }, { onClick: () => seen.push("component") });
    (m.onClick as (e: unknown) => void)(ev(true));
    expect(seen).toEqual(["own"]);
  });
  it("fills both refs, function and object", () => {
    const got: unknown[] = [];
    const obj: { current: unknown } = { current: null };
    const m = mergeTriggerProps({ ref: (n: unknown) => got.push(n) }, { ref: obj });
    (m.ref as (n: unknown) => void)("node");
    expect(got).toEqual(["node"]);
    expect(obj.current).toBe("node");
    const only = mergeRefs<string>(undefined, undefined);
    expect(() => only("x")).not.toThrow();
  });
  it("joins id lists, keeps the element's other aria attributes, lets the component's state win and never erases with undefined", () => {
    const m = mergeTriggerProps(
      { "aria-label": "Notifications", "aria-describedby": "hint a", "aria-expanded": false, "aria-controls": "own-panel" },
      { "aria-describedby": "tip a", "aria-expanded": true, "aria-haspopup": "dialog", "aria-controls": undefined },
    );
    expect(m["aria-label"]).toBe("Notifications");
    expect(m["aria-describedby"]).toBe("hint a tip");
    expect(m["aria-expanded"]).toBe(true);
    expect(m["aria-haspopup"]).toBe("dialog");
    expect(m["aria-controls"]).toBe("own-panel");
  });
  it("joins className with cn and merges style, the component's winning", () => {
    const m = mergeTriggerProps({ className: "icon-btn", style: { color: "red", top: 1 } }, { className: "x", style: { color: "blue" } });
    expect(m.className).toBe("icon-btn x");
    expect(m.style).toEqual({ color: "blue", top: 1 });
    expect("className" in mergeTriggerProps({}, {})).toBe(false);
  });
});

describe("rule 3632: panels hang off a button with logical placement that flips at the screen edge and mirrors in Arabic", () => {
  const vp = { width: 1000, height: 800 };
  const panel = { width: 300, height: 200 };
  const box = (left: number, top: number, w = 40, h = 40): Box => ({ left, top, right: left + w, bottom: top + h });

  it("anchorClass is the class pair Menu always used for start and end, and a centred one for the tooltip", () => {
    expect(anchorClass("bottom", "start")).toBe("top-full mt-1 start-0");
    expect(anchorClass("bottom", "end")).toBe("top-full mt-1 end-0");
    expect(anchorClass("top", "start")).toBe("bottom-full mb-1 start-0");
    expect(anchorClass("top", "end")).toBe("bottom-full mb-1 end-0");
    expect(anchorClass("top", "center")).toContain("rtl:translate-x-1/2");
    expect(anchorClass("bottom", "start")).not.toMatch(/(^|\s)(left|right)-/);
  });
  it("start is the left edge in English and the right edge in Arabic", () => {
    const a = box(100, 100);
    expect(physicalSpan(a, 300, "start", false)).toEqual({ left: 100, right: 400 });
    expect(physicalSpan(a, 300, "start", true)).toEqual({ left: -160, right: 140 });
    expect(physicalSpan(a, 300, "end", false)).toEqual({ left: -160, right: 140 });
    expect(physicalSpan(a, 300, "end", true)).toEqual({ left: 100, right: 400 });
    expect(physicalSpan(a, 300, "center", false)).toEqual({ left: -30, right: 270 });
  });
  it("an anchor near the left edge fits an English start-aligned panel but flips an Arabic one to the other edge", () => {
    const a = box(20, 100);
    expect(flipPlacement({ anchor: a, panel, viewport: vp, side: "bottom", align: "start", rtl: false })).toEqual({ side: "bottom", align: "start" });
    expect(flipPlacement({ anchor: a, panel, viewport: vp, side: "bottom", align: "start", rtl: true })).toEqual({ side: "bottom", align: "end" });
  });
  it("mirrors: an anchor near the right edge flips the English start and keeps the Arabic start", () => {
    const a = box(940, 100);
    expect(flipPlacement({ anchor: a, panel, viewport: vp, side: "bottom", align: "start", rtl: false })).toEqual({ side: "bottom", align: "end" });
    expect(flipPlacement({ anchor: a, panel, viewport: vp, side: "bottom", align: "start", rtl: true })).toEqual({ side: "bottom", align: "start" });
  });
  it("flips to the top when there is no room below and more above, and keeps the side when both are short", () => {
    expect(flipPlacement({ anchor: box(400, 700), panel, viewport: vp, side: "bottom", align: "start", rtl: false }).side).toBe("top");
    expect(flipPlacement({ anchor: box(400, 50), panel, viewport: vp, side: "top", align: "start", rtl: false }).side).toBe("bottom");
    expect(flipPlacement({ anchor: box(400, 300), panel, viewport: vp, side: "bottom", align: "start", rtl: false }).side).toBe("bottom");
    expect(flipPlacement({ anchor: box(400, 100), panel: { width: 300, height: 900 }, viewport: vp, side: "bottom", align: "start", rtl: false }).side).toBe("bottom");
  });
  it("keeps what was asked when nothing fits", () => {
    expect(flipPlacement({ anchor: box(10, 100), panel: { width: 990, height: 50 }, viewport: vp, side: "bottom", align: "start", rtl: false }).align).toBe("start");
  });
  it("placeFixed gives fixed coordinates clamped into the screen, with the tooltip centred over a trigger", () => {
    const tip = { width: 100, height: 30 };
    const mid = placeFixed({ anchor: box(400, 400), panel: tip, viewport: vp, side: "top", align: "center", rtl: false });
    expect(mid).toEqual({ side: "top", align: "center", left: 370, top: 366 });
    const edge = placeFixed({ anchor: box(0, 400), panel: tip, viewport: vp, side: "top", align: "center", rtl: false });
    expect(edge.left).toBe(8);
    const rtlEdge = placeFixed({ anchor: box(960, 400), panel: tip, viewport: vp, side: "top", align: "center", rtl: true });
    expect(rtlEdge.left + tip.width).toBeLessThanOrEqual(992);
    const under = placeFixed({ anchor: box(400, 10), panel: tip, viewport: vp, side: "top", align: "center", rtl: false });
    expect(under).toMatchObject({ side: "bottom", top: 54 });
  });
  it("Menu keeps its own look and uses the shared class pair and click-away, its keyboard code untouched", () => {
    const src = read("src/components/ui/Menu.tsx");
    expect(src).toContain("${anchorClass(placement, align)}");
    expect(src).toContain("useOutsidePress(open, box, clickAway)");
    expect(src).not.toContain('"bottom-full mb-1"');
    expect(src).toContain("onMenuKey");
    expect(src).toContain('"aria-haspopup": "menu"');
  });
});

describe("rule 3633: Popover is a non-modal dialog hung off a button", () => {
  const trigger = (p: Record<string, unknown>) => h("button", p, "Open");
  const render = (props: Record<string, unknown>) => renderToStaticMarkup(h(PopoverC, { label: "Filters", trigger: trigger as never, ...props }, h("input", { name: "q" })));
  const attr = (html: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];

  it("open: the trigger says aria-haspopup=dialog, aria-expanded and aria-controls, and the panel is that id as a named dialog", () => {
    const html = render({ defaultOpen: true });
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="true"');
    const controls = attr(html, "aria-controls");
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}"`);
    expect(html).toMatch(/role="dialog"[^>]*aria-label="Filters"/);
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('<input name="q"/>');
  });
  it("closed: aria-expanded=false, no aria-controls, no panel", () => {
    const html = render({});
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain("aria-controls");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("<input");
  });
  it("controlled: open decides, whatever defaultOpen says", () => {
    expect(render({ open: true, defaultOpen: false })).toContain('role="dialog"');
    expect(render({ open: false, defaultOpen: true })).not.toContain('role="dialog"');
  });
  it("placement is logical in the markup (data-side and data-align turned into start-0 or end-0 classes, never left or right) and panelClassName is joined, not fought", () => {
    const html = render({ defaultOpen: true, align: "end", side: "top", panelClassName: "w-72 p-4" });
    expect(html).toContain('data-side="top"');
    expect(html).toContain('data-align="end"');
    expect(html).toContain("data-[side=top]:bottom-full");
    expect(html).toContain("data-[align=end]:end-0");
    expect(html).toContain("w-72 p-4");
    expect(ANCHOR_BY_DATA).not.toMatch(/(?:^|\s)(?:[a-z\-\[\]=:]*:)?(?:left|right)-/);
  });
  it("content inside reaches the panel's close through usePopoverClose, which is a no-op outside a Popover", () => {
    expect(typeof usePopoverClose).toBe("function");
    const src = read("src/components/ui/Popover.tsx");
    expect(src).toContain("<CloseContext.Provider value={close}>");
    expect(src).toContain("export function usePopoverClose()");
  });
  it("Escape closes with focus back to the trigger, from anywhere in the wrapper, and only while open", () => {
    expect(closesOnKey(true, "Escape")).toBe(true);
    expect(closesOnKey(false, "Escape")).toBe(false);
    expect(closesOnKey(true, "Enter")).toBe(false);
    const src = read("src/components/ui/Popover.tsx");
    expect(src).toMatch(/closesOnKey\(true, e\.key\)\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); close\(true\); \}/);
    expect(src).toContain('b.addEventListener("keydown", key)');
    expect(src).toMatch(/if \(refocus\) btn\.current\?\.focus\(\);/);
  });
  it("a press outside closes it without taking focus back; Tab to another element closes it, leaving the window does not", () => {
    const inside = { contains: (n: Node) => (n as unknown as { in?: boolean }).in === true };
    const el = (isIn: boolean) => ({ nodeType: 1, in: isIn }) as unknown as Node;
    expect(isOutside(inside, el(false))).toBe(true);
    expect(isOutside(inside, el(true))).toBe(false);
    expect(isOutside(null, el(false))).toBe(false);
    expect(closesOnFocusMove(true, inside, el(false))).toBe(true);
    expect(closesOnFocusMove(true, inside, el(true))).toBe(false);
    expect(closesOnFocusMove(true, inside, null)).toBe(false);
    expect(closesOnFocusMove(false, inside, el(false))).toBe(false);
    const src = read("src/components/ui/Popover.tsx");
    expect(src).toContain("useOutsidePress(isOpen, box, clickAway)");
    expect(src).toContain('b.addEventListener("focusout", out)');
    expect(src).toMatch(/const clickAway = useCallback\(\(\) => close\(false\), \[close\]\)/);
  });
  it("opening moves focus to the first field or button, else to the panel itself", () => {
    const src = read("src/components/ui/Popover.tsx");
    expect(src).toMatch(/\(p\?\.querySelector<HTMLElement>\(FOCUSABLE\) \?\? p\)\?\.focus\(\)/);
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(!isOpen\) return;/);
  });
  it("the shared state hook is controlled when open is passed and tells onOpenChange in both modes", () => {
    const src = read("src/components/ui/anchored.ts");
    expect(src).toMatch(/const controlled = open !== undefined;[\s\S]*?if \(!controlled\) setOwn\(next\);\s*onOpenChange\?\.\(next\);/);
  });
});

describe("rule 3634: Tooltip is a hover and focus hint that is never the only label", () => {
  const btn = (props: Record<string, unknown> = {}) => h("button", { type: "button", ...props }, "i");
  const render = (props: Record<string, unknown>, child = btn()) => renderToStaticMarkup(h(TooltipC, { label: "Copy reply", ...props }, child));

  it("shows after the delay on hover, at once on focus, and hides on leave, blur, Escape, a press and a scroll", () => {
    const idle = { open: false, waiting: false };
    const hovering = tipStep(idle, "enter", "mouse");
    expect(hovering).toEqual({ open: false, waiting: true });
    expect(tipStep(hovering, "delay")).toEqual({ open: true, waiting: false });
    expect(tipStep(idle, "delay")).toEqual(idle);
    expect(tipStep(idle, "focus")).toEqual({ open: true, waiting: false });
    expect(tipStep(tipStep(idle, "enter", "pen"), "delay").open).toBe(true);
    const shown = { open: true, waiting: false };
    for (const e of ["leave", "blur", "escape", "press", "scroll"] as const) expect(tipStep(shown, e), e).toEqual(idle);
    expect(tipStep(hovering, "leave")).toEqual(idle);
    expect(TIP_DELAY).toBeGreaterThan(0);
    expect(TIP_DELAY).toBeLessThanOrEqual(600);
  });
  it("on touch the first tap is the button's: a touch pointer never starts the tooltip and the tooltip takes no pointer events", () => {
    expect(tipStep({ open: false, waiting: false }, "enter", "touch")).toEqual({ open: false, waiting: false });
    const src = read("src/components/ui/Tooltip.tsx");
    expect(src).toContain("pointer-events-none");
    expect(src).toMatch(/matches\(":focus-visible"\)/);
    expect(src).not.toMatch(/onClick|onTouch/);
    expect(src).toContain('onPointerDown: () => send("press")');
  });
  it("Escape is taken at the document so it hides the tooltip first, and only it", () => {
    const src = read("src/components/ui/Tooltip.tsx");
    expect(src).toMatch(/document\.addEventListener\("keydown", esc, true\)/);
    expect(src).toMatch(/e\.key === "Escape"\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); send\("escape"\)/);
  });
  it("wires role=tooltip and aria-describedby from the trigger to it, when the label is not already the name", () => {
    const html = render({ defaultOpen: true }, btn({ "aria-label": "Copy" }));
    const tipId = /<span[^>]*id="([^"]*)"[^>]*role="tooltip"/.exec(html)?.[1] ?? /role="tooltip"[^>]*id="([^"]*)"/.exec(html)?.[1];
    expect(tipId).toBeTruthy();
    expect(html).toContain(`aria-describedby="${tipId}"`);
    expect(html).toContain('aria-label="Copy"');
    expect(html).toContain(">Copy reply</span>");
    expect(html).not.toContain('hidden=""');
  });
  it("keeps the trigger's own aria-describedby and joins ours onto it", () => {
    const html = render({}, btn({ "aria-label": "Copy", "aria-describedby": "note" }));
    expect(html).toMatch(/aria-describedby="note [^"]+"/);
  });
  it("does not repeat a name: when the trigger's aria-label is the label, nothing describes it, and the icon button keeps its label", () => {
    const html = render({}, btn({ "aria-label": "Copy reply" }));
    expect(html).not.toContain("aria-describedby");
    expect(html).toContain('aria-label="Copy reply"');
  });
  it("closed it is in the page but hidden, so a screen reader can read the description", () => {
    const html = render({}, btn({ "aria-label": "Copy" }));
    expect(html).toMatch(/<span[^>]*role="tooltip"[^>]*hidden=""|<span[^>]*hidden=""[^>]*role="tooltip"/);
    expect(html).toContain("aria-describedby");
  });
  it("is drawn with fixed coordinates that mirror in Arabic and are measured before paint", () => {
    const src = read("src/components/ui/Tooltip.tsx");
    expect(src).toContain("placeFixed");
    expect(src).toContain('getComputedStyle(trigger).direction === "rtl"');
    expect(src).toMatch(/useLayoutEffect/);
  });
  it("fades in only where motion is allowed and the site's pause switch is not off", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*html:not\(\[data-motion="off"\]\) \.tip \{ animation: tip-in/);
    expect(css).not.toMatch(/^\.tip \{[^}]*animation/m);
  });
  it("the icon-only CopyButton uses it instead of title and keeps its aria-label", () => {
    const html = renderToStaticMarkup(h(CopyButton, { text: "x", lang: "en", label: "Copy reply", iconOnly: true }));
    expect(html).toContain('aria-label="Copy reply"');
    expect(html).toContain('role="tooltip"');
    expect(html).not.toContain("title=");
    const text = renderToStaticMarkup(h(CopyButton, { text: "x", lang: "en", label: "Copy reply" }));
    expect(text).not.toContain('role="tooltip"');
  });
});

describe("rule 3635: components.json points the shadcn CLI at this project", () => {
  const cfg = JSON.parse(read("components.json")) as {
    $schema: string; rtl?: boolean; rsc: boolean; tsx: boolean;
    tailwind: { config: string; css: string; cssVariables: boolean };
    aliases: Record<string, string>;
  };
  const ts = JSON.parse(read("tsconfig.json")) as { compilerOptions: { paths: Record<string, string[]> } };
  const toPath = (alias: string) => {
    expect(alias.startsWith("@/")).toBe(true);
    expect(ts.compilerOptions.paths["@/*"]).toEqual(["./src/*"]);
    return `src/${alias.slice(2)}`;
  };

  it("uses the shadcn schema, TypeScript, server components, and turns RTL on", () => {
    expect(cfg.$schema).toBe("https://ui.shadcn.com/schema.json");
    expect(cfg.tsx).toBe(true);
    expect(cfg.rsc).toBe(true);
    expect(cfg.rtl).toBe(true);
    expect(cfg.tailwind.config).toBe("");
    expect(cfg.tailwind.cssVariables).toBe(true);
  });
  it("every path it names exists: the Tailwind entry css, the ui folder, the components and lib folders, and the cn file", () => {
    expect(existsSync(cfg.tailwind.css), cfg.tailwind.css).toBe(true);
    expect(read(cfg.tailwind.css)).toContain('@import "tailwindcss"');
    for (const key of ["components", "ui", "lib", "hooks"]) expect(existsSync(toPath(cfg.aliases[key])), `${key} -> ${cfg.aliases[key]}`).toBe(true);
    expect(cfg.aliases.ui).toBe("@/components/ui");
    const utils = toPath(cfg.aliases.utils);
    expect(existsSync(`${utils}.ts`), utils).toBe(true);
    expect(read(`${utils}.ts`)).toMatch(/export function cn\(/);
  });
  it("is documented where the next person looks: pulled components are made logical and rewritten on our primitives", () => {
    const doc = read("docs/system/architecture.md");
    expect(doc).toContain("components.json");
    expect(doc).toContain("`rtl: true`");
    expect(doc).toContain("ms-");
  });
});

describe("rule 3636: the bell and the icon-only copy button use them", () => {
  it("NotificationCenter is a Popover with a Tooltip on its trigger, and its own open/click-away/Escape code is gone", () => {
    const src = read("src/components/app/NotificationCenter.tsx");
    expect(src).toContain("<Popover");
    expect(src).toContain("<Tooltip label={name}>");
    expect(src).toContain("<button {...p} aria-label={name}");
    expect(src).not.toContain("title={name}");
    expect(src).not.toContain("pointerdown");
    expect(src).not.toMatch(/key === "Escape"/);
  });
  it("CopyButton no longer sets a native title on the icon button", () => {
    expect(read("src/components/ui/CopyButton.tsx")).not.toContain("title=");
  });
});
