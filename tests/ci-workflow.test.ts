import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Rule 771: CI stays inside the plan's Actions minutes without losing a check. Every pull request and every push to main
 * runs the job and reports "Nashr CI" (Vercel's Deployment Check waits for it); draft PRs and pushes to main skip the
 * end-to-end suite, which runs once a PR is ready for review; a change to docs only runs the unit tests alone. The
 * Scope step's shell is executed here for real, in throwaway git repositories, so the test pins what CI decides.
 */
const yml = readFileSync(".github/workflows/ci.yml", "utf8");
/** One step's text, from its `- name:` line to the next step. */
const step = (name: string) => {
  const at = yml.indexOf(`      - name: ${name}\n`);
  if (at < 0) throw new Error(`no step ${name}`);
  const next = yml.indexOf("\n      - ", at + 1);
  return yml.slice(at, next < 0 ? yml.length : next);
};
/** The Scope step's `run: |` block, de-indented. */
const scopeScript = step("Scope").split("run: |\n")[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@test.example", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@test.example" } }).trim();
const write = (root: string, files: string[]) => { for (const f of files) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), `${f} ${Math.random()}\n`); } };

/** A repository with a base commit, then `files` changed either as a PR (GitHub's merge commit) or as a push. */
function scope(files: string[], how: { event: "pull_request"; draft: boolean } | { event: "push"; newBranch?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "ci-scope-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  write(root, ["src/app.ts", "docs/a.md"]);
  git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  const before = git(root, "rev-parse", "HEAD");
  if (how.event === "pull_request") {
    git(root, "checkout", "-qb", "feature");
    write(root, files);
    git(root, "add", "-A"); git(root, "commit", "-qm", "change");
    git(root, "checkout", "-q", "main");
    write(root, ["unrelated-on-main.txt"]);
    git(root, "add", "-A"); git(root, "commit", "-qm", "main moved");
    git(root, "merge", "-q", "--no-ff", "-m", "merge ref", "feature");
  } else {
    write(root, files);
    git(root, "add", "-A"); git(root, "commit", "-qm", "push");
  }
  const out = join(root, "github_output");
  writeFileSync(out, "");
  execFileSync("bash", ["-e", "-c", scopeScript], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: out,
      EVENT: how.event,
      DRAFT: how.event === "pull_request" ? String(how.draft) : "",
      BEFORE: how.event === "push" ? (how.newBranch ? "0".repeat(40) : before) : "",
    },
  });
  return Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => l.split("=") as [string, string]));
}

describe("rule 771: CI checks every change and runs the end-to-end suite where it counts", () => {
  it("the job always runs and reports Nashr CI: no workflow-level path filter, drafts marked ready start a run", () => {
    expect(yml).toMatch(/\n    name: Nashr CI\n/);
    const on = yml.slice(yml.indexOf("\non:"), yml.indexOf("\nconcurrency:"));
    expect(on).not.toMatch(/paths(-ignore)?:/);
    expect(on).toMatch(/branches: \[main\]/);
    expect(on).toMatch(/types: \[opened, synchronize, reopened, ready_for_review\]/);
  });

  it("unit tests run on every run; build, type-check and lint skip only docs-only changes; the e2e suite follows Scope", () => {
    expect(step("Unit tests")).not.toMatch(/\bif:/);
    for (const s of ["Build", "Type-check", "Lint"]) expect(step(s), s).toMatch(/if: steps\.scope\.outputs\.docs_only != 'true'/);
    for (const s of ["Install Playwright browsers", "End-to-end tests"]) expect(step(s), s).toMatch(/if: steps\.scope\.outputs\.e2e == 'true'/);
    expect(step("Upload Playwright report")).toMatch(/if: failure\(\) && steps\.scope\.outputs\.e2e == 'true'/);
  });

  it("a ready PR that touches code runs everything; a draft skips only the e2e suite", () => {
    expect(scope(["src/lib/x.ts"], { event: "pull_request", draft: false })).toEqual({ docs_only: "false", e2e: "true" });
    expect(scope(["src/lib/x.ts", "docs/b.md"], { event: "pull_request", draft: true })).toEqual({ docs_only: "false", e2e: "false" });
  });

  it("docs/, .archify/ and top-level .md files alone are docs-only; product content in .md is not", () => {
    expect(scope(["docs/system/tests.md", "README.md", ".archify/x/y.png"], { event: "pull_request", draft: false })).toEqual({ docs_only: "true", e2e: "false" });
    expect(scope(["content/skills/ads.md"], { event: "pull_request", draft: false })).toEqual({ docs_only: "false", e2e: "true" });
    expect(scope([".github/workflows/ci.yml"], { event: "pull_request", draft: false })).toEqual({ docs_only: "false", e2e: "true" });
  });

  it("a push to main runs the fast checks without the e2e suite; an unknown `before` counts as code", () => {
    expect(scope(["src/lib/x.ts"], { event: "push" })).toEqual({ docs_only: "false", e2e: "false" });
    expect(scope(["docs/c.md"], { event: "push" })).toEqual({ docs_only: "true", e2e: "false" });
    expect(scope(["docs/c.md"], { event: "push", newBranch: true })).toEqual({ docs_only: "false", e2e: "false" });
  });
});
