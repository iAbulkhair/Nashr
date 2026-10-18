/**
 * The lint ratchet (rules 2092, 2096): counts the warnings of the rules in eslint-rules/ratchet.json over src/ with the
 * project's own ESLint config. Used by tests/lint-ratchet.test.ts and `node scripts/lint-ratchet.mjs [--write]`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ESLint } from "eslint";

export const RATCHET_FILE = new URL("./ratchet.json", import.meta.url);

export const readRatchet = () => JSON.parse(readFileSync(RATCHET_FILE, "utf8"));

/** Lint src/ once and return the count of every rule's messages, plus the messages that are errors. */
export async function measure() {
  const eslint = new ESLint({ cwd: new URL("..", import.meta.url).pathname });
  const results = await eslint.lintFiles(["src"]);
  const counts = /** @type {Record<string, number>} */ ({});
  const errors = [];
  for (const r of results) {
    for (const m of r.messages) {
      if (m.ruleId) counts[m.ruleId] = (counts[m.ruleId] ?? 0) + (m.severity === 1 ? 1 : 0);
      if (m.severity === 2) errors.push(`${r.filePath}:${m.line} ${m.ruleId ?? ""} ${m.message}`);
    }
  }
  return { counts, errors };
}

/** Rewrite ratchet.json with the current counts of the ratcheted rules (only ever lower, never adds a rule). */
export function writeRatchet(counts) {
  const current = readRatchet();
  const next = /** @type {Record<string, number>} */ ({});
  for (const rule of Object.keys(current.rules)) {
    const n = counts[rule] ?? 0;
    if (n > 0) next[rule] = Math.min(n, current.rules[rule]);
  }
  writeFileSync(RATCHET_FILE, JSON.stringify({ note: current.note, rules: next }, null, 2) + "\n");
  return next;
}
