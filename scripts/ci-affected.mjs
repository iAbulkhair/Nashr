/**
 * Affected unit tests for a draft pull request's CI run (rules 2553-2556, docs/system/tests/2550-ci-reuse.md).
 *
 * `node scripts/ci-affected.mjs <file listing the changed paths>` prints the test files to run, one per line, or the
 * single line `all`. It reads the repository from the working directory. Only CI's "Select unit tests" step calls it,
 * and only on a draft; a ready pull request, one into `production`, and every run this script cannot narrow safely run
 * the whole suite.
 *
 * A test is affected when it, or a module it imports (directly or through others), is changed, mentions a changed
 * path in its text (`readFileSync("src/lib/x.ts")`, a templated `src/components/home/${f}.tsx`), or reads a directory
 * (`readdirSync`, `git ls-files`: such a test may read any file, so it always runs). Mentions count in tests, scripts,
 * e2e and config files, not in src/: app code reads files at run time only through the always-run scanners and the
 * content/ folder, and a path named in a comment of a module half the app imports would select every test. A change
 * under content/ runs every test, because src/lib/skills.ts reads it by folder at run time. Stylesheets and JSON
 * follow the import graph like code. It over-selects on purpose: a mention in a test's comment counts too.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, normalize } from "node:path";

/**
 * Changing any of these runs every unit test: the install, the test runner's own setup, the store every test runs on,
 * the key names, the shared test helpers, CI itself and this script. Exact paths, or prefixes ending in "/".
 */
export const SHARED = [
  "package.json",
  "package-lock.json",
  ".npmrc",
  "vitest.config.mts",
  "tsconfig.json",
  "tests/helpers/",
  "tests/fixtures/",
  "src/lib/db.ts",
  "src/lib/keys.ts",
  "src/lib/key-registry.ts",
  ".github/workflows/ci.yml",
  "scripts/ci-affected.mjs",
];

/** Files the app reads from disk by folder at run time (src/lib/skills.ts): a change there runs every test. */
const RUNTIME_READ = /^content\//;
/** Modules read for the import graph. */
const CODE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
/** A test file, as vitest.config.mts includes them. */
const TEST = /^tests\/.+\.test\.ts$/;
/** Reads a whole directory or the file list: the module may read any file, so it is always affected. */
const SCANS = /\breaddirSync\b|\breaddir\(|\bglobSync\b|\bopendirSync\b|\bls-files\b|\bfs\.glob\b/;
/** Import specifiers: static and dynamic imports, re-exports, require, and vitest's mocks. */
const IMPORTS = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+|\brequire\s*\(\s*|\bvi\.(?:mock|doMock|importActual|importMock)\s*(?:<[^>]*>)?\s*\(\s*)["'`]([^"'`$]+)["'`]/gm;
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx", ".json", "/index.ts", "/index.tsx", "/index.mjs", "/index.js"];

/** True when `path` is one of the shared files or under a shared folder. */
export const isShared = (path) => SHARED.some((s) => (s.endsWith("/") ? path.startsWith(s) : path === s));

/** The repository path an import specifier in `from` points at, or null for a package. */
export function resolveImport(from, spec, exists) {
  let base;
  if (spec.startsWith("@/")) base = "src/" + spec.slice(2);
  else if (spec.startsWith(".")) base = normalize(join(dirname(from), spec)).replace(/\\/g, "/");
  else return null;
  for (const ext of EXTENSIONS) if (exists(base + ext)) return base + ext;
  return null;
}

/** Path-like tokens in a module's text that start with one of the repository's top-level folders. */
function pathTokens(text, roots) {
  const re = new RegExp(`(?<![\\w.@/-])(?:${roots.map((r) => r.replace(/[.]/g, "\\.")).join("|")})/[\\w.\\-\\[\\]()@$/{}]*`, "g");
  const out = [];
  for (const m of text.matchAll(re)) {
    let t = m[0].replace(/[.,:;]+$/, "");
    while (t.endsWith(")") && (t.match(/\(/g) ?? []).length < (t.match(/\)/g) ?? []).length) t = t.slice(0, -1);
    out.push(t);
  }
  return out;
}

/** Does `text` name `changed`: the exact path, the path without its extension, or a template over it (`src/lib/${n}.ts`). */
export function mentions(text, changed, roots) {
  if (text.includes(changed)) return true;
  const bare = changed.replace(/\.[^./]+$/, "");
  for (const t of pathTokens(text, roots)) {
    if (t.includes("${")) {
      const parts = t.split(/\$\{[^}]*\}?/);
      const re = new RegExp("^" + parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
      if (re.test(changed) || re.test(bare)) return true;
    } else if (t === bare) return true;
  }
  return false;
}

/**
 * The affected test files, sorted, or "all".
 * @param {string[]} changed repository paths changed by the pull request (deleted ones included)
 * @param {Map<string, string>} files every module's path and text
 * @param {string[]} roots the repository's top-level folders
 * @param {Set<string>} tracked every tracked path, so an import of a stylesheet or JSON file resolves too
 */
export function affectedTests(changed, files, roots, tracked = new Set(files.keys())) {
  if (changed.length === 0 || changed.some((c) => isShared(c) || RUNTIME_READ.test(c))) return "all";
  const exists = (p) => tracked.has(p);
  /** Reverse import graph: module -> the modules that import it. */
  const importers = new Map();
  for (const [path, text] of files) {
    for (const m of text.matchAll(IMPORTS)) {
      const to = resolveImport(path, m[1], exists);
      if (!to) continue;
      if (!importers.has(to)) importers.set(to, new Set());
      importers.get(to).add(path);
    }
  }
  const hit = new Set();
  const queue = [];
  const mark = (p) => { if (!hit.has(p)) { hit.add(p); queue.push(p); } };
  for (const c of changed) mark(c);
  for (const [path, text] of files) {
    if (SCANS.test(text) || (!path.startsWith("src/") && changed.some((c) => mentions(text, c, roots)))) mark(path);
  }
  while (queue.length) for (const by of importers.get(queue.pop()) ?? []) mark(by);
  return [...hit].filter((p) => TEST.test(p) && files.has(p)).sort();
}

/** CLI: read the repository's tracked code and print the selection. */
function main() {
  const list = process.argv[2];
  if (!list) throw new Error("usage: node scripts/ci-affected.mjs <changed-paths-file>");
  const changed = readFileSync(list, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\0").filter(Boolean);
  const roots = [...new Set(tracked.filter((p) => p.includes("/")).map((p) => p.slice(0, p.indexOf("/"))))];
  const files = new Map();
  for (const p of tracked) if (CODE.test(p)) files.set(p, readFileSync(p, "utf8"));
  const picked = affectedTests(changed, files, roots, new Set(tracked));
  const total = tracked.filter((p) => TEST.test(p)).length;
  console.error(picked === "all" ? `all ${total} test files (no change listed, a shared file, or content/)` : `${picked.length} of ${total} test files`);
  console.log(picked === "all" ? "all" : picked.join("\n"));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
