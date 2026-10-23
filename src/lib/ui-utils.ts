import type { Ref, RefCallback } from "react";

/** What `cn` takes: class strings, falsy gaps, arrays, and `{ "class": condition }` maps. */
export type ClassValue = string | number | false | null | undefined | ClassValue[] | { [name: string]: unknown };

/**
 * Joins class names (rule 3630), skipping anything falsy: `cn("btn", busy && "opacity-60", { "ms-2": gap })`. It only
 * joins. It does not resolve two classes that fight over one property (`p-3` and `p-0`): which one wins is the order in
 * the stylesheet, not in the string. The ui primitives keep to that: a primitive's own classes never set what a caller is
 * expected to override (size, padding, width), so tailwind-merge is not needed and not a dependency.
 */
export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  const add = (v: ClassValue): void => {
    if (!v) return;
    if (typeof v === "string") out.push(v);
    else if (typeof v === "number") out.push(String(v));
    else if (Array.isArray(v)) v.forEach(add);
    else for (const k of Object.keys(v)) if (v[k]) out.push(k);
  };
  inputs.forEach(add);
  return out.join(" ");
}

/** One ref that fills every ref it is given, function or object, and ignores the missing ones. */
export function mergeRefs<T>(...refs: (Ref<T> | undefined)[]): RefCallback<T> {
  return (node) => {
    for (const r of refs) {
      if (typeof r === "function") r(node);
      else if (r) (r as { current: T | null }).current = node;
    }
  };
}

type Props = Record<string, unknown>;

/** The aria attributes that hold a list of ids: two sources both keep their ids instead of one replacing the other. */
const ID_LISTS = new Set(["aria-describedby", "aria-labelledby", "aria-controls", "aria-owns", "aria-details", "aria-flowto"]);
const isHandler = (k: string) => /^on[A-Z]/.test(k);

/**
 * Puts a component's trigger props (`injected`: ref, handlers, aria state) onto an element that already has its own
 * props (`own`), so one element can carry two behaviours, a Popover's and a Tooltip's (rule 3631):
 * - a handler both sides have runs the element's own first, then the component's, unless the own one called
 *   `event.preventDefault()` (the caller opted out of the component's reaction to that event);
 * - refs are merged, so both get the node;
 * - `aria-describedby`, `aria-labelledby`, `aria-controls` and the other id lists are joined without repeats; every other
 *   aria attribute the element has stays unless the component sets it (it knows the state: `aria-expanded`), and a
 *   component prop that is `undefined` never erases the element's own value;
 * - `className` is joined with `cn` and `style` is merged, the component's winning on a clash.
 */
export function mergeTriggerProps(own: Props, injected: Props): Props & { ref: RefCallback<unknown> } {
  const out: Props = { ...own };
  for (const k of Object.keys(injected)) {
    const a = own[k];
    const b = injected[k];
    if (k === "ref" || k === "className" || k === "style") continue;
    if (b === undefined) continue;
    if (isHandler(k) && typeof a === "function" && typeof b === "function") {
      out[k] = (e: unknown) => {
        (a as (e: unknown) => void)(e);
        if (!(e as { defaultPrevented?: boolean } | null)?.defaultPrevented) (b as (e: unknown) => void)(e);
      };
    } else if (ID_LISTS.has(k) && typeof a === "string" && typeof b === "string") {
      out[k] = [...new Set(`${a} ${b}`.split(/\s+/).filter(Boolean))].join(" ");
    } else {
      out[k] = b;
    }
  }
  out.ref = mergeRefs(own.ref as Ref<unknown> | undefined, injected.ref as Ref<unknown> | undefined);
  const cls = cn(own.className as ClassValue, injected.className as ClassValue);
  if (cls) out.className = cls;
  if (own.style || injected.style) out.style = { ...(own.style as object), ...(injected.style as object) };
  return out as Props & { ref: RefCallback<unknown> };
}
