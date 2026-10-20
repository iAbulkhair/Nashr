import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Rules 1430-1435. Redis is HTTP per command (CLAUDE.md): an `await db.*` inside a loop is one round trip after another.
 * This scan reads every file under src/ and fails on a new `await db.` in the condition or body of a `for`, `for await`,
 * `while` or `do` loop. The loops that must stay sequential (a lock retried until it is free, a batch cursor, a worker
 * that bounds its own concurrency) are listed below by file and enclosing function, each with why. A new one is either
 * rewritten with `Promise.all`, `pmap` (src/lib/parallel.ts) or `mgetChunked` (src/lib/db.ts), or added here in review.
 */
const REVIEWED: Record<string, string> = {
  // Lock spin-waits: SET NX (or the owned form) retried with a short sleep until the lock is free. Sequential by design:
  // the next try only makes sense after the last one failed.
  "src/app/api/tasks/[id]/route.ts appendPreferences": "lock retry",
  "src/lib/booking-token.ts revokeOne": "lock retry",
  "src/lib/brand-proposals.ts withBrandLock": "lock retry",
  "src/lib/brand.ts updateTask": "lock retry",
  "src/lib/brands.ts withBrandsLock": "lock retry",
  "src/lib/connectors/fresh.ts getFreshConnection": "lock retry while another request refreshes the token",
  "src/lib/conversations.ts withConversationLock": "lock retry",
  "src/lib/credits.ts withUserLock": "lock retry",
  "src/lib/staff.ts withStaffLock": "lock retry",
  "src/lib/staff-admin.ts withNamedLock": "lock retry",
  "src/lib/feed-token.ts revokeFeed": "lock retry",
  "src/lib/governance.ts saveGovAs": "lock retry",
  "src/lib/handoffs.ts withShortLock": "lock retry",
  "src/lib/instructions-store.ts withLock": "lock retry",
  "src/lib/locks.ts withNamedLock": "lock retry (team.ts and person.ts locks)",
  "src/lib/notifications.ts withBellLock": "lock retry",
  "src/lib/partners.ts withLock": "lock retry",
  "src/lib/routines.ts holdBatch": "lock retry",
  "src/lib/secretary-gcal.ts withCalLock": "lock retry",
  "src/lib/secretary-store.ts withLock": "lock retry",
  // A worker inside a bounded pool: each worker records its attempt before the work, in order; the pool runs the workers
  // side by side (`concurrency`), so the cost is bounded by the pool, not by the list.
  "src/lib/cron-batch.ts runCronBatch": "bounded worker pool",
};

/** Same length as the input, with comments, strings, template text and regex literals blanked, so braces match. */
export function blank(src: string): string {
  const out = src.split("");
  const wipe = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  let i = 0;
  let prev = ""; // last significant character, to tell a regex from a division
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") { const e = src.indexOf("\n", i); const end = e < 0 ? src.length : e; wipe(i, end); i = end; continue; }
    if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? src.length : e + 2; wipe(i, end); i = end; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      wipe(i + 1, j); i = j + 1; prev = c; continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /\b(return|typeof|case|of|in)\s*$/.test(src.slice(Math.max(0, i - 8), i)))) {
      let j = i + 1;
      let cls = false;
      while (j < src.length && src[j] !== "\n" && (cls || src[j] !== "/")) { if (src[j] === "\\") j++; else if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; j++; }
      if (src[j] === "/") { wipe(i + 1, j); i = j + 1; prev = "/"; continue; }
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

/** Index just past the bracket matching the one at `open`. */
function close(s: string, open: number): number {
  const pair: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const want = pair[s[open]];
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    if (s[k] === s[open]) depth++;
    else if (s[k] === want && --depth === 0) return k + 1;
  }
  return s.length;
}

/** End of the statement starting at `at`: a block, or up to the first `;` outside brackets. */
function statementEnd(s: string, at: number): number {
  let k = at;
  while (/\s/.test(s[k] ?? "")) k++;
  if (s[k] === "{") return close(s, k);
  for (; k < s.length; k++) {
    if ("({[".includes(s[k])) k = close(s, k) - 1;
    else if (s[k] === ";" || s[k] === "}") return k;
  }
  return s.length;
}

/**
 * Where a function's body starts, from the end of its parameters: past a return type (`<>`, `()`, `[]` and object types
 * skipped by depth), the first `{` that does not open a type, or the expression after `=>`. Null when neither comes.
 */
function bodyAfter(s: string, k: number): { at: number; arrow: boolean } | null {
  let depth = 0;
  let prev = ")";
  for (let j = k; j < s.length; j++) {
    const c = s[j];
    if (/\s/.test(c)) continue;
    if (depth === 0 && c === "=" && s[j + 1] === ">") { j += 2; while (/\s/.test(s[j] ?? "")) j++; return { at: j, arrow: true }; }
    if (depth === 0 && c === "{" && !":|&,<(".includes(prev)) return { at: j, arrow: false };
    if (depth === 0 && (c === ";" || c === "}" || (c === "=" && s[j + 1] !== ">"))) return null;
    if ("<([{".includes(c)) depth++;
    else if (">)]}".includes(c) && !(c === ">" && s[j - 1] === "=")) depth = Math.max(0, depth - 1);
    prev = c;
  }
  return null;
}

/** The innermost function, method or arrow constant whose body holds `at`: the allow-list's key. */
function enclosing(s: string, at: number): string {
  const re = /(?:function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:<[^>]*>)?\(|^\s*(?:export\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\()/gm;
  let name = "(top level)";
  for (let m = re.exec(s); m && m.index < at; m = re.exec(s)) {
    const n = m[1] ?? m[2] ?? m[3];
    if (!n || ["if", "for", "while", "switch", "catch", "return", "await"].includes(n)) continue;
    // Past the parameters and any return type, the body: a block, or an arrow's expression.
    const b = bodyAfter(s, close(s, m.index + m[0].length - 1));
    if (!b || (m[2] && !b.arrow)) continue; // a call assigned to a constant, not an arrow
    const k = b.at;
    const end = s[k] === "{" ? close(s, k) : b.arrow ? statementEnd(s, k) : -1;
    if (end > at && k <= at) name = n;
  }
  return name;
}

/** Every `await db.` in a loop's condition or body: `file function` and the line. */
export function loopAwaits(file: string, src: string): { key: string; line: number }[] {
  const s = blank(src);
  const hits: { key: string; line: number }[] = [];
  const seen = new Set<number>();
  const loop = /\b(for\s+await|for|while|do)\b/g;
  for (let m = loop.exec(s); m; m = loop.exec(s)) {
    let from = m.index;
    let to: number;
    if (m[1] === "do") {
      to = statementEnd(s, m.index + 2);
      const w = /^\s*while\s*\(/.exec(s.slice(to));
      if (w) to = close(s, to + w[0].length - 1);
    } else {
      const p = s.indexOf("(", m.index + m[1].length);
      if (p < 0 || s.slice(m.index + m[1].length, p).trim() !== "") continue;
      const head = close(s, p);
      to = statementEnd(s, head);
      // A for-of or for-in header runs once: an await there (the list to walk) is one call, not one per pass.
      if (m[1] !== "while" && /^\(\s*(?:const|let|var)\s+[^;]*?\s(?:of|in)\s/.test(s.slice(p, head))) from = head;
    }
    const body = s.slice(from, to);
    const aw = /\bawait\s+db\./g;
    for (let a = aw.exec(body); a; a = aw.exec(body)) {
      const at = from + a.index;
      if (seen.has(at)) continue;
      seen.add(at);
      hits.push({ key: `${file} ${enclosing(s, m.index)}`, line: s.slice(0, at).split("\n").length });
    }
    from = to;
  }
  return hits;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe("no await db.* inside a loop (rules 1430-1435)", () => {
  const root = process.cwd();
  const all = files(join(root, "src")).flatMap((p) => loopAwaits(relative(root, p), readFileSync(p, "utf8")));

  it("rule 1435: every await db.* in a loop is a reviewed exception", () => {
    const fresh = all.filter((h) => !(h.key in REVIEWED)).map((h) => `${h.key}:${h.line}`);
    expect(fresh, "Batch it (Promise.all, pmap, mgetChunked) or add a reviewed exception to REVIEWED with why").toEqual([]);
  });

  it("rule 1435: the allow-list has no stale entries", () => {
    const used = new Set(all.map((h) => h.key));
    expect(Object.keys(REVIEWED).filter((k) => !used.has(k))).toEqual([]);
  });

  it("rule 1435: the scanner sees loops, conditions and do-while, and ignores comments, strings and Promise.all", () => {
    const src = [
      "async function a(ids: string[]) { for (const id of ids) { await db.get(id); } }",
      "async function b() { while (!(await db.lock('k', 5))) await sleep(50); }",
      "async function c() { do { await db.del('x'); } while (more); }",
      "async function d(ids: string[]) { // for (x) { await db.get(x) }\n const s = 'for (;;) { await db.get(1) }'; await Promise.all(ids.map((id) => db.get(id))); }",
      "async function e(ids: string[]) { for (const id of ids) if (id) await db.set(id, 1); }",
      "async function f() { const r = /for\\{/; await db.get('after'); }",
    ].join("\n");
    expect(loopAwaits("x.ts", src).map((h) => h.key)).toEqual(["x.ts a", "x.ts b", "x.ts c", "x.ts e"]);
  });
});
