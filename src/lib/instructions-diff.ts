import type { By } from "./actor";
import type { Instruction, InstructionSet, Revision } from "./instructions-store";

/**
 * The comparison of two instruction sets, apart from the store so the customer page (a client component) can use it
 * without pulling in the database. Type imports only: nothing here reads or writes a key.
 */

const same = (a: Instruction, b: Instruction) =>
  a.text === b.text &&
  a.on === b.on &&
  !!a.lock === !!b.lock &&
  JSON.stringify(a.agents === "all" ? a.agents : [...a.agents].sort()) === JSON.stringify(b.agents === "all" ? b.agents : [...b.agents].sort()) &&
  JSON.stringify(a.refs ?? []) === JSON.stringify(b.refs ?? []);

export type SetDiff = { added: Instruction[]; removed: Instruction[]; changed: { before: Instruction; after: Instruction }[] };

/** What differs between two sets, matched by item id. A change of the edit time alone is not a change. */
export function diffSets(a: InstructionSet, b: InstructionSet): SetDiff {
  const was = new Map(a.items.map((i) => [i.id, i]));
  const now = new Map(b.items.map((i) => [i.id, i]));
  return {
    added: b.items.filter((i) => !was.has(i.id)),
    removed: a.items.filter((i) => !now.has(i.id)),
    changed: b.items.flatMap((after) => {
      const before = was.get(after.id);
      return before && !same(before, after) ? [{ before, after }] : [];
    }),
  };
}

/**
 * One line of the History list: when, who, and how much that version changed, without the two sets. A workspace can hold
 * 120 items of 600 characters in each set of each of 20 versions; the page is sent this, and a version's full
 * comparison is fetched when someone presses Compare.
 */
export type HistoryRow = { id: string; v: number; at: string; by: By; rollbackOf?: string; note?: string; count: number; added: number; removed: number; changed: number };

/** `r.by` is expected to be public already (`publicRevision`): this copies it as it is. */
export function summarizeRevision(r: Revision): HistoryRow {
  const d = diffSets(r.before, r.after);
  return {
    id: r.id,
    v: r.v,
    at: r.at,
    by: r.by,
    ...(r.rollbackOf ? { rollbackOf: r.rollbackOf } : {}),
    ...(r.note ? { note: r.note } : {}),
    count: r.after.items.filter((i) => i.on).length,
    added: d.added.length,
    removed: d.removed.length,
    changed: d.changed.length,
  };
}
