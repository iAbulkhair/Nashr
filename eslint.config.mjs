import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";
import { a11yRules, typeAwareRules } from "./eslint-rules/tooling-rules.mjs";
import thakeenUi, { errors as thakeenUiErrors, warnings as thakeenUiWarnings } from "./eslint-rules/thakeen-ui.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Rules 1095-1098: the UI patterns the src/components/ui primitives replace, as warnings while screens move over.
  { files: ["src/**/*.{ts,tsx}"], plugins: { "thakeen-ui": thakeenUi }, rules: thakeenUiWarnings },
  // Rules 1200-1201: a raw palette colour stays the same in the dark theme, so it fails the lint; use the semantic role.
  { files: ["src/**/*.{ts,tsx}"], plugins: { "thakeen-ui": thakeenUi }, rules: thakeenUiErrors },
  // Rules 2090-2093: the jsx-a11y recommended set (the plugin itself is registered by eslint-config-next). A rule with no
  // violation in src is an error; a rule with violations stays a warning, counted in eslint-rules/ratchet.json (it may only go down).
  { files: ["src/**/*.tsx"], rules: a11yRules(jsxA11y.flatConfigs.recommended.rules) },
  // Rules 2094-2097: the three type-aware promise rules, same split. projectService reads tsconfig.json, so only files it
  // covers are type-checked; tests, scripts and config files stay on the fast syntax-only rules.
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: typeAwareRules,
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent worktrees are full checkouts (with their own build output) inside the repo folder.
    ".claude/**",
  ]),
]);

export default eslintConfig;
