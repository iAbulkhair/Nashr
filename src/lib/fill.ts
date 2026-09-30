/**
 * Fill a template's `{key}` slots in one pass, with a function replacer: a value is inserted exactly as written, never
 * read as a replacement pattern (`$'`, `$&`, `$$` stay as typed), and a value that itself contains `{title}` is never
 * filled again by a later slot. For every template that takes text a person or an agent wrote (a title, a name).
 * Import-free: the server and the browser share it.
 */
export function fill(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (slot, key: string) => (Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : slot));
}
