/** Word-bigram Dice similarity, 0..1. Cheap and language-agnostic. */
export function similarity(a: string, b: string): number {
  const grams = (s: string) => { const w = s.toLowerCase().split(/\s+/).filter(Boolean); const g = new Map<string, number>(); for (let i = 0; i < w.length - 1; i++) { const k = w[i] + " " + w[i + 1]; g.set(k, (g.get(k) ?? 0) + 1); } return g; };
  const A = grams(a), B = grams(b);
  if (!A.size && !B.size) return 1;
  let inter = 0; for (const [k, n] of A) inter += Math.min(n, B.get(k) ?? 0);
  const size = [...A.values()].reduce((s, n) => s + n, 0) + [...B.values()].reduce((s, n) => s + n, 0);
  return size ? (2 * inter) / size : 0;
}
/** How much an edit changed the agent's text, 0..100: the light task index and the decision records share this measure. */
export const editPctOf = (body: string, edited: string): number => Math.round((1 - similarity(body, edited)) * 100);
