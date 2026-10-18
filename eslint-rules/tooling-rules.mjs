/**
 * Rules 2090-2097 (wave 2e): which jsx-a11y and type-aware rules are errors and which are warnings counted by the ratchet.
 * A rule with no violation in src/ is an error, so a new one fails `npm run lint`. A rule that still has violations is a
 * warning and its count sits in eslint-rules/ratchet.json: tests/lint-ratchet.test.ts fails when the count goes up, and
 * `node scripts/lint-ratchet.mjs --write` lowers the file after a clean-up. Move a rule from RATCHETED to errors only
 * when its count reaches 0 (delete its line in ratchet.json in the same change).
 */

/** jsx-a11y rules that still have violations in src/. Everything else in the recommended set is an error. */
export const A11Y_RATCHETED = [
  "jsx-a11y/click-events-have-key-events",
  "jsx-a11y/media-has-caption",
  "jsx-a11y/no-autofocus",
  "jsx-a11y/no-noninteractive-element-interactions",
  "jsx-a11y/no-noninteractive-tabindex",
  "jsx-a11y/no-static-element-interactions",
];

/**
 * Options that differ from the plugin default, each with the reason:
 *  - aria-role ignoreNonDOM: `<ChatBubble role="user">` is a component prop, not a DOM role.
 *  - label-has-associated-control depth 3: a label that wraps the input and nests two spans for title and hint is labelled.
 *  - no-redundant-roles ul/ol "list": `list-style: none` removes the list role in Safari with VoiceOver, so lists keep it.
 */
const OPTIONS = {
  "jsx-a11y/aria-role": { ignoreNonDOM: true },
  "jsx-a11y/label-has-associated-control": { depth: 3 },
  "jsx-a11y/no-redundant-roles": { ul: ["list"], ol: ["list"] },
};

/**
 * The flat rules object for the jsx-a11y recommended set. `recommended` is `jsxA11y.flatConfigs.recommended.rules`.
 * Rules the recommended set keeps off (control-has-associated-label) stay off.
 */
/** @param {Record<string, any>} recommended @returns {Record<string, any>} */
export function a11yRules(recommended) {
  const out = /** @type {Record<string, any>} */ ({});
  for (const [name, entry] of Object.entries(recommended)) {
    const sev = Array.isArray(entry) ? entry[0] : entry;
    if (sev === "off" || sev === 0) continue;
    const base = Array.isArray(entry) ? entry[1] : undefined;
    const options = OPTIONS[name] ? { ...base, ...OPTIONS[name] } : base;
    const level = A11Y_RATCHETED.includes(name) ? "warn" : "error";
    out[name] = options ? [level, options] : level;
  }
  return out;
}

/** Type-aware typescript-eslint rules (need parserOptions.projectService). TYPE_RATCHETED ones are warnings. */
export const TYPE_RATCHETED = ["@typescript-eslint/await-thenable"];
const level = (r) => (TYPE_RATCHETED.includes(r) ? "warn" : "error");
export const typeAwareRules = {
  "@typescript-eslint/no-floating-promises": level("@typescript-eslint/no-floating-promises"),
  // A promise-returning handler in a JSX prop (`onClick={async () => ...}`) is how React code is written; React ignores the
  // return value and every handler here catches its own failure. The other checks (conditionals, arguments, spreads) stay on.
  "@typescript-eslint/no-misused-promises": [level("@typescript-eslint/no-misused-promises"), { checksVoidReturn: { attributes: false } }],
  "@typescript-eslint/await-thenable": level("@typescript-eslint/await-thenable"),
};
