// Formatting check for the files a branch changed against origin/main (rule 3980). It never touches the rest of the
// repository, so a branch is not asked to reformat code it did not write and the open branches do not collide.
//   npm run format:check            lists changed files that are not formatted, exits 1 when there are any
//   npm run format                  rewrites those files
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXT = /\.(?:[cm]?[jt]sx?|json|css|mjs)$/;
// Prettier would reflow these, and they are data or generated, not code a person edits by hand.
const SKIP = /(?:^|\/)(?:package-lock\.json|\.next\/|node_modules\/|public\/)/;

/** The paths worth checking, from the lines `git diff --name-only` printed. */
export function pickFiles(lines) {
  return lines.map((l) => l.trim()).filter((l) => l && EXT.test(l) && !SKIP.test(l));
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function changedFiles() {
  const base = git("merge-base", "origin/main", "HEAD").trim();
  // Against the working tree, so uncommitted edits count; deleted files are left out.
  return pickFiles(git("diff", "--name-only", "--diff-filter=ACMR", base).split("\n"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes("--write");
  const files = changedFiles();
  if (files.length === 0) {
    console.log("format: no changed files to check");
  } else {
    try {
      execFileSync("npx", ["prettier", write ? "--write" : "--check", ...files], { stdio: "inherit" });
    } catch {
      process.exit(1);
    }
  }
}
