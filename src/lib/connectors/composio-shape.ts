import type { Connection } from "./store";
import type { Toolkit } from "./composio-catalog";

/**
 * Reading Composio's answers. Composio wraps each platform's answer differently per tool, so values are found by name
 * with a bounded breadth-first search rather than a fixed path; the measured run on real accounts pins the shapes
 * (plan Task 8). No calls here: the modules that call Composio import these.
 */

export const isComposio = (c: Pick<Connection, "meta"> | null | undefined) => c?.meta?.via === "composio";

/** First string or number found under one of `keys`, breadth-first, at most `maxDepth` levels down (four by default). */
export function pick(o: unknown, keys: string[], maxDepth = 4): string | undefined {
  let level: unknown[] = [o];
  for (let depth = 0; depth < maxDepth && level.length; depth++) {
    const next: unknown[] = [];
    for (const v of level) {
      if (!v || typeof v !== "object") continue;
      if (!Array.isArray(v)) {
        for (const k of keys) {
          const x = (v as Record<string, unknown>)[k];
          if (typeof x === "string" && x) return x;
          if (typeof x === "number") return String(x);
        }
      }
      next.push(...(Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)));
    }
    level = next;
  }
  return undefined;
}

/**
 * The first value under one of `keys` that `ok` accepts (any value by default), breadth-first, at most `maxDepth` levels
 * down (five by default); undefined when there is none. The one search the readers share for a value Composio nests in
 * its own keys: YouTube's `rows` and `columnHeaders`, TikTok's `cursor`, GA4's `dimensionHeaders`.
 */
export function findKey(o: unknown, keys: string[], ok: (v: unknown) => boolean = () => true, maxDepth = 5): unknown {
  let level: unknown[] = [o];
  for (let depth = 0; depth < maxDepth && level.length; depth++) {
    const next: unknown[] = [];
    for (const v of level) {
      if (!v || typeof v !== "object") continue;
      if (!Array.isArray(v)) {
        const r = v as Record<string, unknown>;
        for (const k of keys) if (k in r && ok(r[k])) return r[k];
      }
      next.push(...(Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)));
    }
    level = next;
  }
  return undefined;
}

/** The first array of objects that carry `key` (an `id` by default), at most five levels down. */
export function listOf(o: unknown, key = "id"): Record<string, unknown>[] {
  let level: unknown[] = [o];
  for (let depth = 0; depth < 5 && level.length; depth++) {
    const next: unknown[] = [];
    for (const v of level) {
      if (Array.isArray(v)) {
        const rows = v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && key in x);
        if (rows.length) return rows;
        next.push(...v);
      } else if (v && typeof v === "object") next.push(...Object.values(v as Record<string, unknown>));
    }
    level = next;
  }
  return [];
}

/** A number from a platform value (Google and TikTok send numbers as strings), or null. */
export const num = (v: unknown): number | null => {
  const x = typeof v === "string" && v.trim() ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : null;
};

/** The value at the first of `paths` (dotted) that holds one: Google's answers come camelCase or snake_case. */
export function at(o: unknown, ...paths: string[]): unknown {
  for (const p of paths) {
    let v: unknown = o;
    for (const k of p.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
    if (v != null && v !== "") return v;
  }
  return undefined;
}

/** The Composio account id stored for this toolkit, or `not_connected`. */
export function accountOf(c: Connection, t: Toolkit): string {
  const id = c.data[t];
  if (!id) throw new Error("not_connected");
  return id;
}
