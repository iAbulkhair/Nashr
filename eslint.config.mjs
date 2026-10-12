import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import thakeenUi, { warnings as thakeenUiWarnings } from "./eslint-rules/thakeen-ui.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Rules 1095-1098: the UI patterns the src/components/ui primitives replace, as warnings while screens move over.
  { files: ["src/**/*.{ts,tsx}"], plugins: { "thakeen-ui": thakeenUi }, rules: thakeenUiWarnings },
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
