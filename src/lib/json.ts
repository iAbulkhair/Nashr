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

/**
 * Serialise untrusted text for a model prompt so it cannot close the tag it sits in. Item bodies are model output and
 * brand fields were written by a model from a crawled website: both are untrusted input, and a body containing
 * "</items>" must not be able to end the data block and start speaking to the model. Still valid JSON — "<" becomes
 * the escape "\u003c", which any JSON reader turns back into "<".
 */
export const asData = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
