import { createHash } from "crypto";
import { db } from "./db";
import { pmap } from "./parallel";

/** Workspace files = Noor's memory. Markdown the user can read, edit, delete. */
export type WFile = { name: string; content: string; updatedAt: string; by: "noor" | "user" };

const SET = (e: string) => `files:${e}`;
const KEY = (e: string, n: string) => `file:${e}:${n}`;

/**
 * Normalise a file name into something safe to put in a Redis key.
 *
 * Unicode letters and digits are KEPT. The previous version allowed only `[a-z0-9._-]`, which turned every Arabic name
 * into a row of dashes — "ملاحظات.md" and "خطة-التسويق.md" both became "-.md" — so in an Arabic-first product the
 * second file the owner created silently destroyed the first. What must still never survive is anything that could
 * split or forge a key: ":" and "#" separate scope from id (src/lib/auth.ts `validEmail`), and "/" would let a name
 * imitate a path.
 */
const MAX_NAME = 60;
const shortHash = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 6);
export function safeName(n: string) {
  const cleaned = n.toLowerCase().replace(/[^\p{L}\p{N}._-]/gu, "-").replace(/-+/g, "-");
  // Truncate the BASE and keep the extension. Slicing the whole string at 60 dropped the ".md" from any longer name
  // and collapsed names differing only near their end — "...-2026-q1.md" and "...-2026-q2.md" became one key, and
  // writeFile overwrites without looking.
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 6 ? cleaned.slice(dot) : "";
  const base = ext ? cleaned.slice(0, dot) : cleaned;
  if (!base) return "file.md";
  if (base.length + ext.length <= MAX_NAME) return base + ext;
  // Truncation alone still collapses names that differ only past the limit — two quarterly strategies whose titles
  // diverge at character 60 produced one key, and writeFile overwrites without looking. A short digest of the full
  // cleaned name keeps them apart. Names that fit are untouched, so nothing already stored moves.
  return base.slice(0, MAX_NAME - ext.length - 7) + "-" + shortHash(cleaned) + ext;
}

export async function listFiles(email: string): Promise<WFile[]> {
  const names = await db.smembers(SET(email));
  const out = (await pmap(names, (n) => db.get<WFile>(KEY(email, n)))).filter((f): f is WFile => !!f);
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
/**
 * Just the names, one Redis command.
 *
 * The chat turn only ever shows the agent a list of file names, but it used to call `listFiles`, which fetches every
 * file's full body — the whole workspace pulled over HTTP and thrown away on every message, including the five files
 * `memoryBlock` was fetching alongside it in the same Promise.all. Sorted so the prompt text is stable: `listFiles`
 * orders by updatedAt, which changes the system prompt on every save and costs the prompt cache.
 */
export async function listFileNames(email: string): Promise<string[]> {
  return (await db.smembers(SET(email))).sort();
}
export async function readFile(email: string, name: string) {
  return db.get<WFile>(KEY(email, safeName(name)));
}
/**
 * How many files one workspace may hold. `listFiles` reads every one of them on the Files page and on several API
 * routes, so an unbounded index is not merely untidy: past a few thousand entries the page stops answering at all,
 * and nothing could ever bring the count back down except deleting them one at a time. Nothing legitimate comes
 * close — the core memory is five files.
 */
export const MAX_FILES = 200;
export class FileLimitError extends Error {
  constructor() { super("file_limit"); this.name = "FileLimitError"; }
}

export async function writeFile(email: string, name: string, content: string, by: WFile["by"] = "noor") {
  let n = safeName(name);
  // The agent must not destroy what the owner wrote by hand. import_catalog and write_file are chosen by the model,
  // and crawled pages and catalogs reach that model, so an ordinary chat turn could replace a curated products.md —
  // margins, "do not promote X", Ramadan bundles — with a scrape, unrecoverably. An agent write over an owner-written
  // file goes to a sibling name instead, and the caller reports the name it actually got.
  if (by === "noor") {
    const existing = await db.get<WFile>(KEY(email, n));
    if (existing && existing.by === "user" && existing.content !== content) {
      const dot = n.lastIndexOf(".");
      const ext = dot > 0 ? n.slice(dot) : "";
      n = safeName((ext ? n.slice(0, dot) : n) + "-imported" + ext);
    }
  }
  // Only a NEW name counts against the ceiling: rewriting products.md for the thousandth time is free, and a
  // workspace already over the limit can still be edited and tidied rather than being frozen outright.
  if (!(await db.get<WFile>(KEY(email, n)))) {
    if ((await db.smembers(SET(email))).length >= MAX_FILES) throw new FileLimitError();
  }
  const f: WFile = { name: n, content: content.slice(0, 40000), updatedAt: new Date().toISOString(), by };
  await db.set(KEY(email, n), f);
  await db.sadd(SET(email), n);
  return f;
}
export async function deleteFile(email: string, name: string) {
  const n = safeName(name);
  // Both halves: the record and its name in the index. Leaving the name behind made every listFiles pay a read for a
  // file that is gone, and the set grew without a bound.
  await Promise.all([db.del(KEY(email, n)), db.srem(SET(email), n)]);
}
/** Characters of each core file that go into a prompt. Beyond this the file is cut and the cut is declared. */
const MEMORY_BUDGET = 6000;

/**
 * The one-line OUTPUT goal written at onboarding (`onboardplan:{scope}`, src/lib/onboard.ts). It used to reach only the
 * trial activation bar, so no agent knew what the owner had agreed to aim for. The model wrote it from the crawled site,
 * so it is flattened to one short line: it must not be able to open a "--- file ---" section of its own.
 */
export const goalLine = (goal: unknown) => String(goal ?? "").replace(/\s+/g, " ").replace(/-{2,}/g, "-").trim().slice(0, 140);

/**
 * The core memory: the files every agent reads on every generation and chat turn (`memoryBlock` below).
 * Deleting one changes what every agent knows about the business, so DELETE /api/files needs admin or owner for these;
 * any member may delete the other files. tests/role-gates.test.ts keeps this list equal to the one `memoryBlock` reads.
 * It lives here rather than in the route file because a Next.js route module may export only handlers and route config.
 */
export const CORE_FILES: readonly string[] = ["brand.md", "products.md", "store-sales.md", "performance-learnings.md", "strategy.md", "market-research.md", "preferences.md"];

/** Core files every agent reads on every generation and chat turn, preceded by the owner's goal when there is one. */
export async function memoryBlock(email: string) {
  const wanted = ["brand.md", "products.md", "store-sales.md", "performance-learnings.md", "strategy.md", "market-research.md", "preferences.md"];
  // One round trip per file, read together, keep the fixed order (stable text also helps prompt caching).
  const [files, plan] = await Promise.all([Promise.all(wanted.map((n) => readFile(email, n))), db.get<{ goal?: string }>(`onboardplan:${email}`)]);
  const goal = goalLine(plan?.goal);
  const head = goal ? `--- OWNER GOAL (output target agreed at onboarding; not a file) ---\n${goal}` : "";
  return [head, ...wanted
    .map((n, i) => {
      const content = files[i]?.content;
      if (!content) return "";
      if (content.length <= MEMORY_BUDGET) return `--- ${n} ---\n${content}`;
      // preferences.md grows at the end (one dated line per owner edit or reason, cut from the front at 20,000
      // characters), so its first 6,000 characters were the OLDEST notes and every agent stopped seeing the newest.
      if (n === "preferences.md") return `--- ${n} (showing the newest ${MEMORY_BUDGET} of ${content.length} characters; use read_file for the older notes) ---\n${content.slice(-MEMORY_BUDGET)}`;
      // An imported catalog of 50 products is ~16,000 characters, so the budget hides most of it. Declaring the cut is
      // what lets the agent call read_file for the rest instead of writing as though those products do not exist.
      return `--- ${n} (showing the first ${MEMORY_BUDGET} of ${content.length} characters; use read_file for the rest) ---\n${content.slice(0, MEMORY_BUDGET)}`;
    })]
    .filter(Boolean)
    .join("\n\n");
}
