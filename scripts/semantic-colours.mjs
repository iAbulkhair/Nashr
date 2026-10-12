#!/usr/bin/env node
/**
 * UI/UX phase 5 codemod (rule 1200): raw palette colour utilities in src/**\/*.tsx become the semantic roles, with the
 * same table the `thakeen-ui/no-raw-colour` lint rule suggests (eslint-rules/thakeen-ui.mjs `semanticColour`). Idempotent:
 * a second run finds nothing. `--check` lists what would change and exits 1 when anything would.
 *
 *   node scripts/semantic-colours.mjs [--check] [--verbose]
 */
import fs from "node:fs";
import path from "node:path";
import { semanticColour, baseOf } from "../eslint-rules/thakeen-ui.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const check = process.argv.includes("--check");
const verbose = process.argv.includes("--verbose");
/** The scribble art's class names (`ring-paper`, `ink`) are its own, not Tailwind utilities. */
const SKIP = new Set(["src/components/ScribbleArt.tsx"]);

const TOKEN = /(?<![\w\-/:[])((?:[\w-]+:)*!?-?(?:bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|fill|stroke|divide|from|to|via|decoration|placeholder|shadow|caret|accent)-(?:ink|paper|white|black|ground|lilac|muted)(?:\/\d+)?)(?![\w\-/])/g;
const STOP = /["'`{}]/;

function segment(text, at, len) {
  let a = at;
  while (a > 0 && !STOP.test(text[a - 1]) && text[a - 1] !== "\n") a--;
  let b = at + len;
  while (b < text.length && !STOP.test(text[b]) && text[b] !== "\n") b++;
  return text.slice(a, b);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

let changed = 0;
let files = 0;
for (const file of walk(path.join(ROOT, "src"))) {
  const rel = path.relative(ROOT, file);
  if (SKIP.has(rel)) continue;
  const text = fs.readFileSync(file, "utf8");
  let n = 0;
  const next = text.replace(TOKEN, (token, _g, offset) => {
    const base = baseOf(token);
    const to = semanticColour(base, segment(text, offset, token.length));
    if (!to) return token;
    n++;
    const head = token.slice(0, token.length - base.length);
    if (verbose) console.log(`${rel}: ${token} -> ${head}${to}   [${segment(text, offset, token.length).trim().slice(0, 90)}]`);
    return `${head}${to}`;
  });
  if (n) {
    files++;
    changed += n;
    if (!check) fs.writeFileSync(file, next);
  }
}
console.log(`${check ? "would change" : "changed"} ${changed} classes in ${files} files`);
if (check && changed) process.exit(1);
