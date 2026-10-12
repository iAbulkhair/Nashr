/**
 * How many characters of the owner's notes a generation batch reads (rule 796). One number for the three places that cut them,
 * so none can drift from the others: the generator's prompt (`extra.slice(0, GENERATE_NOTES_READ)` in noor.ts), the reviewer's
 * grounding (`g.notes?.slice(0, GENERATE_NOTES_READ)` in json.ts) and the input gate (`checkGenerationNotes` in agent-scope.ts).
 * The gate reads the same first characters and no more: a longer text would only make a classifier call that can fail on its
 * size, and a failed call lets the text through, while the generator never reads past the cut. A leaf file on purpose: noor.ts
 * and json.ts import it, and agent-scope.ts re-exports it.
 */
export const GENERATE_NOTES_READ = 2000;
