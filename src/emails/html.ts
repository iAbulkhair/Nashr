import { fill } from "../lib/fill";

/**
 * Email HTML without React. `react-dom/server` throws under the `react-server` condition Next uses for route handlers,
 * and react-email v6 ships its CLI's dependencies at run time, so the templates build their markup with the tagged
 * template below instead (docs/superpowers/specs/2026-10-08-supastarter-adoption-design.md §1, rules 685-689).
 *
 * The one rule: every interpolated value is escaped. Only markup this module made is inserted as it is: the result of
 * another `html` template, or `raw()` for a constant written in the source. Task titles, Reem's bodies, the inviter's
 * address and every other value a person or a model wrote go in as text and come out as text.
 */

const MAKE: unique symbol = Symbol("SafeHtml");

/** Markup that is safe to insert as it is. Only `html`, `raw` and the helpers in this module can make one. */
export class SafeHtml {
  private constructor(private readonly markup: string) {}
  /** The module's own constructor, behind a symbol no other module holds. */
  static [MAKE](markup: string): SafeHtml {
    return new SafeHtml(markup);
  }
  toString(): string {
    return this.markup;
  }
}

/** What a template slot accepts: text (escaped), safe markup, a list of either, or nothing. */
export type Slot = string | number | SafeHtml | null | undefined | false | readonly Slot[];

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text as HTML: the five characters that can open a tag, an entity or leave a quoted attribute become entities. */
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ENTITIES[c]);

/** One slot as markup: safe markup as it is, lists joined, nothing as nothing, everything else escaped. */
function part(v: Slot): string {
  if (v instanceof SafeHtml) return v.toString();
  if (Array.isArray(v)) return v.map(part).join("");
  if (v === null || v === undefined || v === false) return "";
  return esc(String(v));
}

/** The tag: the literal parts are the template's own markup, every `${…}` is escaped unless it is already SafeHtml. */
export function html(strings: TemplateStringsArray, ...values: Slot[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return SafeHtml[MAKE](out);
}

/**
 * Constant markup written in the source, such as a line break. The type takes a string literal only: a variable of type
 * `string` (anything read, received or built at run time) does not compile here.
 */
export function raw<T extends string>(markup: string extends T ? never : T): SafeHtml {
  return SafeHtml[MAKE](markup);
}

/**
 * A copy line with `{slot}`s (src/emails/copy.ts), filled through `fill()` from src/lib/fill.ts. The line is escaped
 * first, so a slot name survives (braces and word characters are not escaped), then each value goes in as markup: text
 * escaped, SafeHtml as it is. `fill` fills in one pass, so a value that itself contains `{role}` is never filled again.
 */
export function fillHtml(line: string, vars: Readonly<Record<string, string | SafeHtml>>): SafeHtml {
  return SafeHtml[MAKE](fill(esc(line), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, part(v)]))));
}

/**
 * Left-to-right runs inside a line: web addresses and email addresses. Inside an Arabic paragraph the bidi algorithm
 * would otherwise reorder their dots, slashes and `@` around the Arabic words next to them.
 */
const LTR_RUN = /https?:\/\/[^\s<>"«»]+|[^\s<>"«»()@:]+@[^\s<>"«»()@]+\.[^\s<>"«»()@]+/g;
/** Sentence punctuation after an address belongs to the sentence, not to the address. */
const TRAILING = /[.,،؛;:!?)\]]+$/;

/** One line of plain text as escaped markup, its addresses wrapped in `<span dir="ltr">`. */
export function ltrRuns(line: string): SafeHtml {
  const out: SafeHtml[] = [];
  let last = 0;
  for (const m of line.matchAll(LTR_RUN)) {
    const run = m[0].replace(TRAILING, "");
    const at = m.index ?? 0;
    out.push(html`${line.slice(last, at)}<span dir="ltr">${run}</span>`);
    last = at + run.length;
  }
  out.push(html`${line.slice(last)}`);
  return html`${out}`;
}

/** Plain text, possibly over several lines, as escaped markup: one `<br>` per line break, addresses kept left to right. */
export function plain(text: string): SafeHtml {
  return html`${text.split(/\r?\n/).map((line, i) => (i ? html`${raw("<br>")}${ltrRuns(line)}` : ltrRuns(line)))}`;
}

/** Plain text split into paragraphs on blank lines, each trimmed; empty paragraphs are dropped. */
export const paragraphs = (text: string): string[] => text.split(/\r?\n[ \t]*\r?\n/).map((p) => p.trim()).filter(Boolean);
