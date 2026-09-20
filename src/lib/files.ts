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
export function safeName(n: string) {
  return n.toLowerCase().replace(/[^\p{L}\p{N}._-]/gu, "-").replace(/-+/g, "-").slice(0, 60) || "file.md";
}

export async function listFiles(email: string): Promise<WFile[]> {
  const names = await db.smembers(SET(email));
  const out = (await pmap(names, (n) => db.get<WFile>(KEY(email, n)))).filter((f): f is WFile => !!f);
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
export async function readFile(email: string, name: string) {
  return db.get<WFile>(KEY(email, safeName(name)));
}
export async function writeFile(email: string, name: string, content: string, by: WFile["by"] = "noor") {
  const n = safeName(name);
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
/** Core files Noor reads on every generation. */
export async function memoryBlock(email: string) {
  const wanted = ["brand.md", "products.md", "strategy.md", "market-research.md", "preferences.md"];
  // Five files, one round trip each: read together, keep the fixed order (stable text also helps prompt caching).
  const files = await Promise.all(wanted.map((n) => readFile(email, n)));
  return wanted.map((n, i) => (files[i]?.content ? `--- ${n} ---\n${files[i]!.content.slice(0, 6000)}` : "")).filter(Boolean).join("\n\n");
}
