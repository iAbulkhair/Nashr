import { db } from "./db";

/** Workspace files = Noor's memory. Markdown the user can read, edit, delete. */
export type WFile = { name: string; content: string; updatedAt: string; by: "noor" | "user" };

const SET = (e: string) => `files:${e}`;
const KEY = (e: string, n: string) => `file:${e}:${n}`;

export function safeName(n: string) {
  return n.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 60) || "file.md";
}

export async function listFiles(email: string): Promise<WFile[]> {
  const names = await db.smembers(SET(email));
  const out: WFile[] = [];
  for (const n of names) {
    const f = await db.get<WFile>(KEY(email, n));
    if (f) out.push(f);
  }
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
  await db.del(KEY(email, n));
  // sets have no srem in our adapter; mark tombstone
  await db.set(KEY(email, n), null);
}
/** Core files Noor reads on every generation. */
export async function memoryBlock(email: string) {
  const wanted = ["brand.md", "products.md", "strategy.md", "market-research.md", "preferences.md"];
  const parts: string[] = [];
  for (const n of wanted) {
    const f = await readFile(email, n);
    if (f?.content) parts.push(`--- ${n} ---\n${f.content.slice(0, 6000)}`);
  }
  return parts.join("\n\n");
}
