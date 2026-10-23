# Thakeen (code name Nashr)

Thakeen (ذكين) is a multi-tenant web application that gives a small business a team of named AI marketing and sales agents. The owner connects a brand, the agents prepare content and plans, and the owner approves before anything is published. The repository and its identifiers keep the code name Nashr. It is built with Next.js (app router), Upstash Redis and the Anthropic SDK.

## Set up

Node 22 or later is required (`engines` in `package.json`).

```bash
npm ci
cp .env.example .env.local   # fill in only what you need; names only are listed, never commit values
npm run dev
```

Without Redis credentials outside production the app uses an in-memory store. What each variable does is in `docs/system/variables.md`.

## Checks

```bash
npm run check           # type-check, lint, unit tests (run before every commit)
npx next build          # run before every commit when code changed
npm run test:coverage   # optional, local only, writes ./coverage (not part of CI)
```

## Where the rules live

- `CLAUDE.md` and `AGENTS.md`: the rules every change must keep, for people and coding agents.
- `docs/system/architecture.md`, `docs/system/flows.md`, `docs/system/permissions.md`, `docs/system/variables.md`, and the rule-to-test lists `docs/system/tests.md` and `docs/system/tests/`. Update them in the same commit when a route, permission or environment variable changes.
- `PRODUCT.md`: product description and users.
