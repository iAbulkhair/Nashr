/**
 * Parse a model reply that should be a JSON array of objects. Tolerates code
 * fences, prose around the JSON, a single object instead of a one-item array,
 * and bracketed placeholders such as [رقم] inside the text.
 */
export function parseObjectArray(text: string): Array<Record<string, unknown>> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = cleaned.search(/\[\s*\{/), z = cleaned.lastIndexOf("]");
  if (a >= 0 && z > a) {
    try {
      const v = JSON.parse(cleaned.slice(a, z + 1)) as unknown;
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    } catch {
      // fall through to the single-object form
    }
  }
  const o = cleaned.indexOf("{"), c = cleaned.lastIndexOf("}");
  if (o >= 0 && c > o) {
    const v = JSON.parse(cleaned.slice(o, c + 1)) as unknown;
    return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [v as Record<string, unknown>];
  }
  throw new Error("no_json_in_reply");
}
