/**
 * The answer a page shows when `POST /api/generate` refuses the owner's notes (rule 796): `agent_scope` (the notes are outside
 * what the team works on, 422) or `slow_down` (too many such requests or too many checks, 429). The server wrote `message` in the
 * owner's language, so the page shows it as it is, as text and never as HTML. Null for any other answer, so the page's own
 * messages (no credits, trial over) are read as before. A client-safe file with no imports, used by GeneratePanel and ReportsPanel,
 * which both post to that route.
 */
export function scopeRefusalText(j: { error?: unknown; message?: unknown }): string | null {
  return (j.error === "agent_scope" || j.error === "slow_down") && typeof j.message === "string" && j.message ? j.message : null;
}
