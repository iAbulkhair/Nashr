import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SHARED, affectedTests, isShared, mentions } from "../scripts/ci-affected.mjs";

/**
 * Rules 2580-2587: a tree that already passed the full check is not checked again, and a draft runs only the unit tests
 * its change reaches. docs/system/tests/2580-ci-reuse.md lists the rules. The workflow's shell is executed here for
 * real, in throwaway git repositories, and every step's `if:` is evaluated against Scope's outputs, so the test pins
 * what CI decides, the way tests/ci-workflow.test.ts does for rule 772.
 */
const yml = readFileSync(".github/workflows/ci.yml", "utf8");
const steps = yml.slice(yml.indexOf("    steps:\n")).split("\n      - ").slice(1).map((s) => "      - " + s);
const nameOf = (s: string) => s.match(/^ {6}- name: (.+)$/m)?.[1] ?? s.match(/uses: (\S+)/)?.[1] ?? "?";
const step = (name: string) => {
  const s = steps.find((x) => nameOf(x) === name);
  if (!s) throw new Error(`no step ${name}`);
  return s;
};
/** A step's `run: |` block (or one-line `run:`), de-indented. */
const script = (name: string) => {
  const s = step(name);
  if (s.includes("run: |\n")) return s.split("run: |\n")[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  return s.match(/run: (.+)$/m)![1];
};

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tmp = (p: string) => { const r = mkdtempSync(join(tmpdir(), p)); roots.push(r); return r; };
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@test.example", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@test.example" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();
const put = (root: string, f: string, text: string) => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); };
const outputs = (file: string) => Object.fromEntries(readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

/** Run a step's script in `cwd` with `env`; returns what it wrote to GITHUB_OUTPUT. */
function runStep(name: string, cwd: string, env: Record<string, string>) {
  const out = join(cwd, ".github_output");
  writeFileSync(out, "");
  execFileSync("bash", ["-e", "-c", script(name)], { cwd, encoding: "utf8", env: { ...process.env, ...env, GITHUB_OUTPUT: out } });
  return outputs(out);
}

/** A repo with a base commit and a PR checked out as GitHub's merge commit (as in tests/ci-workflow.test.ts). */
function mergeCheckout(files: string[]) {
  const root = tmp("ci-reuse-");
  git(root, "init", "-q", "-b", "main");
  put(root, "src/app.ts", "base\n"); put(root, "docs/a.md", "a\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature");
  for (const f of files) put(root, f, `${f}\n`);
  git(root, "add", "-A"); git(root, "commit", "-qm", "change");
  git(root, "checkout", "-q", "main");
  put(root, "main-moved.txt", "x\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "main moved");
  git(root, "merge", "-q", "--no-ff", "-m", "merge ref", "feature");
  return root;
}

type Scope = { build: string; e2e: string; unit: string; reused: string };
/** Scope's outputs for a PR changing `files`, with the green record as given. */
function scope(files: string[], o: { draft: boolean; base?: string; hit?: boolean; record?: string; tree?: string }): Scope {
  const root = mergeCheckout(files);
  const tree = o.tree ?? git(root, "rev-parse", "HEAD^{tree}");
  const green = join(root, ".ci-green");
  if (o.record !== undefined) writeFileSync(green, o.record);
  return runStep("Scope", root, { DRAFT: String(o.draft), BASE_REF: o.base ?? "main", GREEN_HIT: String(!!o.hit), GREEN_FILE: green, TREE: tree }) as Scope;
}

/** Evaluate a step's `if:` as Actions would, given Scope's outputs, on a run where every earlier step passed. */
function runs(name: string, sc: Scope, e2eVersion = "1.0.0") {
  const cond = step(name).match(/^ {8}if: (.+)$/m)?.[1];
  if (!cond) return true;
  const js = cond
    .replace(/success\(\)/g, "true")
    .replace(/failure\(\)/g, "false")
    .replace(/steps\.scope\.outputs\.(\w+)/g, (_, k: keyof Scope) => JSON.stringify(sc[k]))
    .replace(/steps\.playwright\.outputs\.version/g, JSON.stringify(sc.e2e === "true" ? e2eVersion : ""))
    .replace(/steps\.[\w-]+\.outputs\.cache-hit/g, "''");
  expect(js, `${name}: ${cond}`).not.toMatch(/steps\.|\$\{\{/);
  return Boolean(new Function(`return (${js});`)());
}
const ran = (sc: Scope) => steps.map(nameOf).filter((n) => runs(n, sc));

describe("rule 2580: the green key is the merge commit's tree plus the workflow, and nothing else", () => {
  const key = (root: string) => runStep("Green key", root, { WORKFLOW_HASH: "wf", RUNNER_OS: "Linux" });

  it("the key is built from HEAD's tree, the OS and a hash of ci.yml and the selector; the lookup is exact", () => {
    expect(step("Green key")).toMatch(/WORKFLOW_HASH: \$\{\{ hashFiles\('\.github\/workflows\/ci\.yml', 'scripts\/ci-affected\.mjs'\) \}\}\n/);
    expect(script("Green key")).toContain("tree=$(git rev-parse 'HEAD^{tree}')");
    expect(script("Green key")).toContain('echo "key=ci-green-v1-$RUNNER_OS-$tree-$WORKFLOW_HASH" >> "$GITHUB_OUTPUT"');
    const find = step("Find green run");
    expect(find).toMatch(/id: green\n/);
    expect(find).toMatch(/uses: actions\/cache\/restore@[0-9a-f]{40} # v4\.\d+\.\d+\n/);
    expect(find).toMatch(/path: \$\{\{ runner\.temp \}\}\/ci-green\n/);
    expect(find).toMatch(/key: \$\{\{ steps\.green-key\.outputs\.key \}\}\n/);
    expect(find).not.toMatch(/restore-keys/);
    const order = steps.map(nameOf);
    expect(order.indexOf("Green key")).toBeLessThan(order.indexOf("Find green run"));
    expect(order.indexOf("Find green run")).toBeLessThan(order.indexOf("Scope"));
  });

  it("the same tree reached by another commit (a re-run, a merge whose tree equals a green one) gives the same key", () => {
    const root = mergeCheckout(["src/lib/x.ts"]);
    const first = key(root);
    expect(first.tree).toBe(git(root, "rev-parse", "HEAD^{tree}"));
    expect(first.key).toBe(`ci-green-v1-Linux-${first.tree}-wf`);
    git(root, "commit", "-q", "--allow-empty", "-m", "same tree, new commit");
    expect(key(root)).toEqual(first);
    git(root, "checkout", "-qb", "other", "HEAD~1");
    git(root, "merge", "-q", "--no-ff", "-m", "merge with nothing new", "main");
    expect(key(root).key).toBe(first.key);
  });

  it("any change to any tracked file, a mode bit, a new or a deleted file, gives a new key", () => {
    const root = mergeCheckout(["src/lib/x.ts", "docs/b.md"]);
    const seen = new Set([key(root).key]);
    const change = (what: () => void) => { what(); git(root, "add", "-A"); git(root, "commit", "-qm", "c"); const k = key(root).key; expect(seen.has(k)).toBe(false); seen.add(k); };
    change(() => put(root, "src/lib/x.ts", "src/lib/x.ts\n "));
    change(() => put(root, "docs/b.md", "one byte\n"));
    change(() => put(root, "new.txt", "\n"));
    change(() => rmSync(join(root, "new.txt")));
    change(() => chmodSync(join(root, "src/app.ts"), 0o755));
    change(() => put(root, ".github/workflows/ci.yml", "x\n"));
    expect(seen.size).toBe(7);
  });

  it("the workflow hash is part of the key, so a CI change alone never matches an older record", () => {
    const root = mergeCheckout(["src/lib/x.ts"]);
    expect(runStep("Green key", root, { WORKFLOW_HASH: "a", RUNNER_OS: "Linux" }).key).not.toBe(runStep("Green key", root, { WORKFLOW_HASH: "b", RUNNER_OS: "Linux" }).key);
  });
});

describe("rule 2581: a reused run passes after the secret scan alone; reuse needs a record naming this very tree", () => {
  it("an exact hit whose record names the tree is reused; a miss, a missing or a different record is not", () => {
    const reused = { build: "false", e2e: "false", unit: "none", reused: "true" };
    const root = mergeCheckout(["src/lib/x.ts"]);
    const tree = git(root, "rev-parse", "HEAD^{tree}");
    expect(scope(["src/lib/x.ts"], { draft: false, hit: true, tree, record: `tree=${tree}\nhead=abc\nrun=r\n` })).toEqual(reused);
    expect(scope(["src/lib/x.ts"], { draft: true, hit: true, tree, record: `tree=${tree}\n` })).toEqual(reused);
    const fresh = { build: "true", e2e: "true", unit: "all", reused: "false" };
    expect(scope(["src/lib/x.ts"], { draft: false, hit: false, tree, record: `tree=${tree}\n` })).toEqual(fresh);
    expect(scope(["src/lib/x.ts"], { draft: false, hit: true, tree })).toEqual(fresh);
    expect(scope(["src/lib/x.ts"], { draft: false, hit: true, tree, record: `tree=${"0".repeat(40)}\n` })).toEqual(fresh);
    expect(scope(["src/lib/x.ts"], { draft: false, hit: true, tree, record: `tree=${tree}x\n` })).toEqual(fresh);
    expect(scope(["src/lib/x.ts"], { draft: false, hit: true, tree: "", record: "tree=\n" })).toEqual(fresh);
  });

  it("a reused run runs checkout, the key, the lookup, Scope and the secret scan, and nothing that installs or tests", () => {
    const sc = { build: "false", e2e: "false", unit: "none", reused: "true" };
    expect(ran(sc)).toEqual([steps.map(nameOf)[0], "Green key", "Find green run", "Scope", "Secret scan"]);
    expect(step("Secret scan")).not.toMatch(/\n {8}if:/);
    for (const s of ["Set up Node", "Install"]) expect(step(s), s).toMatch(/if: steps\.scope\.outputs\.reused != 'true'\n/);
  });

  it("the job still reports Nashr CI and keeps its one job (a skipped job would not pass a required check)", () => {
    expect(yml).toMatch(/\n    name: Nashr CI\n/);
    expect(yml.slice(yml.indexOf("\njobs:\n")).match(/^ {2}[a-z][\w-]*:\s*$/gm)).toEqual(["  check:"]);
  });
});

describe("rule 2582: only a run that checked everything records its tree", () => {
  it("Record and Save run only when every earlier step passed and Scope ran the end-to-end suite; they are last", () => {
    for (const s of ["Record green run", "Save green run"]) expect(step(s), s).toMatch(/if: success\(\) && steps\.scope\.outputs\.e2e == 'true'\n/);
    expect(steps.map(nameOf).slice(-2)).toEqual(["Record green run", "Save green run"]);
    const save = step("Save green run");
    expect(save).toMatch(/uses: actions\/cache\/save@[0-9a-f]{40} # v4\.\d+\.\d+\n/);
    expect(save).toMatch(/path: \$\{\{ runner\.temp \}\}\/ci-green\n/);
    expect(save).toMatch(/key: \$\{\{ steps\.green\.outputs\.cache-primary-key \}\}/);
    expect(step("Record green run")).toMatch(/TREE: \$\{\{ steps\.green-key\.outputs\.tree \}\}\n/);
  });

  it("the record names the tree in the exact line Scope looks for", () => {
    const root = tmp("ci-record-");
    execFileSync("bash", ["-e", "-c", script("Record green run")], { cwd: root, env: { ...process.env, RUNNER_TEMP: root, TREE: "abc123", HEAD_SHA: "h", RUN_URL: "u" } });
    expect(readFileSync(join(root, "ci-green"), "utf8")).toBe("tree=abc123\nhead=h\nrun=u\n");
  });

  it("whenever Scope runs the e2e suite it builds and runs every unit test; a draft, docs-only or reused run records nothing", () => {
    const cases: [string[], { draft: boolean; base?: string }][] = [
      [["src/lib/x.ts"], { draft: false }], [["src/lib/x.ts"], { draft: true }], [["docs/x.md"], { draft: false }],
      [["docs/x.md"], { draft: true }], [["src/lib/x.ts"], { draft: false, base: "production" }], [["src/lib/x.ts"], { draft: true, base: "production" }],
    ];
    for (const [files, o] of cases) {
      const sc = scope(files, o);
      const records = runs("Record green run", sc) && runs("Save green run", sc);
      if (sc.e2e === "true") expect(sc, JSON.stringify(o)).toMatchObject({ build: "true", unit: "all", reused: "false" });
      expect(records, JSON.stringify([files, o])).toBe(sc.e2e === "true");
      if (records) for (const s of ["Build", "Type-check", "Lint", "Unit tests", "End-to-end tests"]) expect(runs(s, sc), s).toBe(true);
      if (records) expect(runs("Select unit tests", sc)).toBe(false);
    }
  });
});

describe("rule 2583: a draft into main runs the affected unit tests; ready and release pull requests run them all", () => {
  it("Scope: draft into main is affected; ready, a release PR into production, and no diff are all", () => {
    expect(scope(["src/lib/x.ts"], { draft: true }).unit).toBe("affected");
    expect(scope(["docs/x.md"], { draft: true }).unit).toBe("affected");
    expect(scope(["src/lib/x.ts"], { draft: false }).unit).toBe("all");
    expect(scope(["src/lib/x.ts"], { draft: true, base: "production" }).unit).toBe("all");
    expect(scope(["src/lib/x.ts"], { draft: false, base: "production" }).unit).toBe("all");
    expect(step("Scope")).toMatch(/BASE_REF: \$\{\{ github\.base_ref \}\}\n/);
    expect(script("Scope")).toContain('if [ -n "$changed" ] && [ "$DRAFT" = true ] && [ "$BASE_REF" != production ]; then unit=affected; fi');
  });

  it("the workflow still runs on pull requests only and the e2e suite still needs a ready PR (rule 772 unchanged)", () => {
    const on = yml.slice(yml.indexOf("\non:"), yml.indexOf("\nconcurrency:"));
    expect(on).toMatch(/types: \[opened, synchronize, reopened, ready_for_review\]\n$/);
    expect(on).not.toMatch(/push:/);
    expect(step("End-to-end tests")).toMatch(/if: steps\.scope\.outputs\.e2e == 'true'\n/);
    expect(script("Scope")).toContain('if [ "$build" = true ] && [ "$DRAFT" != true ]; then e2e=true; fi');
  });

  it("Select runs only on affected; Unit tests passes the list to vitest, or runs everything on all, an empty or no list", () => {
    expect(step("Select unit tests")).toMatch(/if: steps\.scope\.outputs\.unit == 'affected'\n/);
    expect(script("Select unit tests")).toContain('git diff --name-only --no-renames HEAD^1 HEAD > "$RUNNER_TEMP/changed.txt"');
    expect(script("Select unit tests")).toContain('node scripts/ci-affected.mjs "$RUNNER_TEMP/changed.txt" > "$RUNNER_TEMP/unit-tests.txt"');
    expect(script("Select unit tests")).toContain('echo all > "$RUNNER_TEMP/unit-tests.txt"');
    const root = tmp("ci-unit-");
    put(root, "bin/npx", '#!/bin/sh\nprintf "%s|" "$@" > "$CALLS"\n');
    chmodSync(join(root, "bin/npx"), 0o755);
    const call = (list: string | undefined) => {
      const calls = join(root, "calls");
      let LIST = "";
      if (list !== undefined) { LIST = join(root, "list.txt"); writeFileSync(LIST, list); }
      execFileSync("bash", ["-e", "-c", script("Unit tests")], { cwd: root, env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, CALLS: calls, LIST } });
      return readFileSync(calls, "utf8");
    };
    expect(call("tests/a.test.ts\ntests/b c.test.ts\n")).toBe("vitest|run|tests/a.test.ts|tests/b c.test.ts|");
    expect(call("all\n")).toBe("vitest|run|");
    expect(call("")).toBe("vitest|run|");
    expect(call(undefined)).toBe("vitest|run|");
  });

  it("type-check and lint still cover every file on a draft: they follow build alone", () => {
    for (const s of ["Type-check", "Lint"]) expect(step(s), s).toMatch(/\n {8}if: steps\.scope\.outputs\.build == 'true'\n/);
    expect(runs("Type-check", scope(["src/lib/x.ts"], { draft: true }))).toBe(true);
  });
});

describe("rule 2584: a shared file, content/ or an empty diff runs every unit test", () => {
  it("the shared list is explicit", () => {
    expect(SHARED).toEqual([
      "package.json", "package-lock.json", ".npmrc", "vitest.config.mts", "tsconfig.json", "tests/helpers/", "tests/fixtures/",
      "src/lib/db.ts", "src/lib/keys.ts", "src/lib/key-registry.ts", ".github/workflows/ci.yml", "scripts/ci-affected.mjs",
    ]);
    for (const p of ["package.json", "tests/helpers/session.ts", "tests/fixtures/a.json", "src/lib/db.ts", "src/lib/keys.ts", ".github/workflows/ci.yml"]) expect(isShared(p), p).toBe(true);
    for (const p of ["src/lib/db-helpers.ts", "tests/helpers.test.ts", "src/lib/keys/x.ts", "package.json.bak"]) expect(isShared(p), p).toBe(false);
  });

  it("each of them, content/ and an empty diff select all", () => {
    const files = new Map([["tests/a.test.ts", 'import "@/lib/a";'], ["src/lib/a.ts", ""]]);
    for (const c of [...SHARED.map((s) => (s.endsWith("/") ? s + "x.ts" : s)), "content/skills/ads.md"]) expect(affectedTests([c, "src/lib/a.ts"], files, ["src", "tests"]), c).toBe("all");
    expect(affectedTests([], files, ["src", "tests"])).toBe("all");
  });
});

describe("rule 2585: the affected tests follow imports, path mentions outside src/, and always include folder readers", () => {
  const roots = ["src", "tests", "docs", "scripts", "e2e"];
  const files = new Map<string, string>([
    ["src/lib/a.ts", 'import { b } from "./b";\nimport "./a.css";'],
    ["src/lib/b.ts", "export const b = 1;"],
    ["src/lib/c.ts", "export const c = 1;"],
    ["src/lib/hub.ts", "// see docs/system/flows.md and src/lib/c.ts\nexport const hub = 1;"],
    ["src/components/home/Day.tsx", "export default 1;"],
    ["tests/imports-a.test.ts", 'import { a } from "@/lib/a";'],
    ["tests/relative.test.ts", 'import { b } from "../src/lib/b";'],
    ["tests/mocks-c.test.ts", 'vi.mock("@/lib/c", () => ({}));'],
    ["tests/dynamic-c.test.ts", 'const m = await import("@/lib/c");'],
    ["tests/hub.test.ts", 'import { hub } from "@/lib/hub";'],
    ["tests/reads-flows.test.ts", 'const f = readFileSync("docs/system/flows.md", "utf8");'],
    ["tests/template.test.ts", "const home = (f: string) => read(`src/components/home/${f}.tsx`);"],
    ["tests/bare.test.ts", 'const lib = read("src/lib/c");'],
    ["tests/scans.test.ts", 'for (const f of readdirSync("src")) {}'],
    ["tests/unrelated.test.ts", "expect(1).toBe(1);"],
  ]);
  const tracked = new Set([...files.keys(), "src/lib/a.css"]);
  const pick = (...changed: string[]) => affectedTests(changed, files, roots, tracked);

  it("imports through @/, relative paths, chains, mocks and dynamic imports; stylesheets resolve through tracked files", () => {
    expect(pick("src/lib/b.ts")).toEqual(["tests/imports-a.test.ts", "tests/relative.test.ts", "tests/scans.test.ts"]);
    expect(pick("src/lib/c.ts")).toEqual(["tests/bare.test.ts", "tests/dynamic-c.test.ts", "tests/mocks-c.test.ts", "tests/scans.test.ts"]);
    expect(pick("src/lib/a.css")).toEqual(["tests/imports-a.test.ts", "tests/scans.test.ts"]);
  });

  it("a test that names a changed path runs; a path named inside src/ does not drag in every importer", () => {
    expect(pick("docs/system/flows.md")).toEqual(["tests/reads-flows.test.ts", "tests/scans.test.ts"]);
    expect(pick("src/components/home/Day.tsx")).toEqual(["tests/scans.test.ts", "tests/template.test.ts"]);
    expect(pick("docs/other.md")).toEqual(["tests/scans.test.ts"]);
  });

  it("a changed test runs itself, a deleted one is dropped, and an unrelated test never runs", () => {
    expect(pick("tests/unrelated.test.ts")).toEqual(["tests/scans.test.ts", "tests/unrelated.test.ts"]);
    expect(pick("tests/gone.test.ts")).toEqual(["tests/scans.test.ts"]);
    for (const c of ["src/lib/b.ts", "src/lib/c.ts", "docs/system/flows.md"]) expect(pick(c), c).not.toContain("tests/unrelated.test.ts");
  });

  it("mentions match the path, the path without extension, or a template over it, and not a mere folder", () => {
    expect(mentions('read("src/lib/x.ts")', "src/lib/x.ts", roots)).toBe(true);
    expect(mentions('read("src/lib/x")', "src/lib/x.ts", roots)).toBe(true);
    expect(mentions("read(`src/lib/${n}.ts`)", "src/lib/x.ts", roots)).toBe(true);
    expect(mentions("read(`src/lib/${n}.ts`)", "src/app/x.ts", roots)).toBe(false);
    expect(mentions('walk("src/lib")', "src/lib/x.ts", roots)).toBe(false);
    expect(mentions('read("src/lib/xy.ts")', "src/lib/x.ts", roots)).toBe(false);
  });

  it("on this repository: a change to one library file selects its tests and leaves most of the suite out", () => {
    const dir = tmp("ci-affected-");
    const run = (changed: string[]) => {
      writeFileSync(join(dir, "changed.txt"), changed.join("\n") + "\n");
      return execFileSync("node", ["scripts/ci-affected.mjs", join(dir, "changed.txt")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n");
    };
    const csp = run(["src/lib/csp.ts"]);
    expect(csp).toContain("tests/csp-nonce.test.ts");
    expect(csp).toContain("tests/ci-reuse.test.ts");
    const all = execFileSync("git", ["ls-files", "tests"], { encoding: "utf8" }).split("\n").filter((p) => /^tests\/.+\.test\.ts$/.test(p));
    expect(csp.length).toBeLessThan(all.length / 2);
    for (const t of csp) expect(all, t).toContain(t);
    expect(run(["src/lib/keys.ts"])).toEqual(["all"]);
    expect(run(["scripts/ci-affected.mjs"])).toEqual(["all"]);
  });
});

describe("rule 2587: the docs name the change", () => {
  it("flows section 62 and the coverage file describe it", () => {
    const flows = readFileSync("docs/system/flows.md", "utf8");
    for (const r of ["rules 2580-2586", "rule 2582", "rules 2583 and 2585", "rule 2584", "scripts/ci-affected.mjs"]) expect(flows, r).toContain(r);
    const f = readFileSync("docs/system/tests/2580-ci-reuse.md", "utf8");
    for (let r = 2580; r <= 2587; r++) expect(f).toContain(`| ${r} |`);
  });
});
