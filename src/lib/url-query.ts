/**
 * A list's filter, sort and page kept in the address (rule 2007), so a view can be shared as a link and the back button
 * steps through it. Pure functions over a codec: `parse` validates every value it reads (an unknown value falls back to
 * its default) and `params` writes only what differs from the defaults. The server reads the same query and checks it
 * again; nothing here widens what a route returns.
 */
export type QueryCodec<Q> = { parse: (p: URLSearchParams) => Q; params: (q: Q) => URLSearchParams };

/** The address a change leads to: the current query, then `reset` (a page back to 1), then the change itself. */
export function queryHref<Q extends object>(pathname: string, search: string, patch: Partial<Q>, codec: QueryCodec<Q>, reset: Partial<Q> = {}): string {
  const now = codec.parse(new URLSearchParams(search));
  const p = codec.params({ ...now, ...reset, ...patch }).toString();
  return p ? `${pathname}?${p}` : pathname;
}

/**
 * A new history entry or not: a change of typed text (the search box, debounced) replaces the entry, so the back button
 * is not a step per word; a filter, a sort or a page is a step of its own.
 */
export function historyFor<Q extends object>(patch: Partial<Q>, typed: readonly (keyof Q)[]): "push" | "replace" {
  const keys = Object.keys(patch) as (keyof Q)[];
  return keys.length > 0 && keys.every((k) => typed.includes(k)) ? "replace" : "push";
}

/**
 * The address as the codec writes it, when the one in the bar differs (an unknown sort, a page of -3, a size not offered,
 * a value repeated): the bar is put right, so a shared link never carries a value the list ignored. Null when it is
 * already canonical. Parameters the codec does not know are dropped too.
 */
export function canonicalHref<Q>(pathname: string, search: string, codec: QueryCodec<Q>): string | null {
  const have = new URLSearchParams(search);
  const want = codec.params(codec.parse(have));
  const a = [...have.entries()].sort().join("&");
  const b = [...want.entries()].sort().join("&");
  if (a === b) return null;
  const p = want.toString();
  return p ? `${pathname}?${p}` : pathname;
}
