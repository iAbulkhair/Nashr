import { readdirSync, readFileSync } from "node:fs";

/**
 * The founder console's source, every file under src/components/admin together (rule 874 split the old AdminConsole.tsx
 * into one component per section plus shared.tsx). Source checks about "the console" read this, so a handler or a string
 * can move between the section files without the check losing it.
 */
export function adminConsoleSrc(): string {
  const dir = "src/components/admin";
  return readdirSync(dir).filter((f) => f.endsWith(".tsx")).sort().map((f) => readFileSync(`${dir}/${f}`, "utf8")).join("\n");
}
