// Print the lint ratchet counts; `--write` lowers eslint-rules/ratchet.json to them. Run from the repository root.
import { measure, readRatchet, writeRatchet } from "../eslint-rules/ratchet.mjs";

const { counts, errors } = await measure();
const { rules } = readRatchet();
for (const [rule, max] of Object.entries(rules)) console.log(`${String(counts[rule] ?? 0).padStart(4)} / ${String(max).padStart(4)}  ${rule}`);
if (errors.length) console.log(`${errors.length} lint errors, fix them first`);
if (process.argv.includes("--write")) console.log("wrote", writeRatchet(counts));
