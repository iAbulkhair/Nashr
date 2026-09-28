import { db } from "./db";
import { deleteFile, writeFile } from "./files";
import { learningsMarkdown, type PerfSnapshot } from "./perf-import";

export const LEARNINGS_FILE = "performance-learnings.md";
const KEY = (scope: string) => `perfimport:${scope}`;

/** The latest campaign import for this workspace, or null. One at a time: a new upload replaces the last. */
export async function getPerf(scope: string) {
  return db.get<PerfSnapshot>(KEY(scope));
}

/** Keep the findings and hand Noor the same findings as performance-learnings.md, which her memory reads. */
export async function savePerf(scope: string, snap: PerfSnapshot) {
  await Promise.all([db.set(KEY(scope), snap), writeFile(scope, LEARNINGS_FILE, learningsMarkdown(snap), "noor")]);
}

export async function clearPerf(scope: string) {
  await Promise.all([db.del(KEY(scope)), deleteFile(scope, LEARNINGS_FILE)]);
}
