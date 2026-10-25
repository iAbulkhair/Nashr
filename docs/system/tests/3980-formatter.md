# Coverage: formatter settings (rule 3980)

Status on 2026-10-24 on branch `claude/sup-formatter` (cut from main 5392d04a). Settings only: no file was reformatted, so the open branches do not collide. A one-time full reformat is a separate decision.

| # | Rule | Verified today | First test to write |
|---|---|---|---|
| 3980 | Prettier is configured (`.prettierrc.json`: 120 columns, double quotes, semicolons, trailing commas, matching the code as it is) and `npm run format:check` looks only at code files changed against `origin/main` (merge base, working tree included), never the whole repository. Markdown, `content/`, `docs/`, `public/`, `node_modules` and the lockfile are left alone. `npm run format` rewrites the same set | yes | `tests/formatter-config.test.ts` |
