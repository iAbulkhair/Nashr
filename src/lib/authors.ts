import { readFileSync } from "fs";
import { join } from "path";
import type { Lang } from "./i18n";

/**
 * The people a post may be signed by (rule 3315), from `content/authors.json`. A post names one in its front matter
 * (`author: abulkhair-hejazy`); without the line it keeps the organisation byline (the Article data names the brand, and the
 * page shows no person). Only real people are listed here: this file is not for a made-up writer, a team or a pen name, and a
 * post is never given an author by default.
 *
 *     { "id": { "name": {"ar": ..., "en": ...}, "role": {"ar": ..., "en": ...}, "link": "https://..." } }
 *
 * `link` is optional and https only. There is no photo field: the page draws the person's initials, so no portrait is
 * published without a decision and a code change. Any other key is a mistake and fails the build.
 */
export type AuthorEntry = { name: Record<Lang, string>; role: Record<Lang, string>; link?: string };
export type Authors = Record<string, AuthorEntry>;
/** An author as a post shows them, in one language. */
export type PostAuthor = { id: string; name: string; role: string; link?: string };

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEYS = new Set(["name", "role", "link"]);
const TEXT_MAX = 80;
const LINK_MAX = 200;

/** What is wrong with the text of `content/authors.json`, empty when nothing is. Pure. */
export function authorFileProblems(raw: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return ["content/authors.json is not valid JSON"];
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return ["content/authors.json must be an object of authors by id"];
  const out: string[] = [];
  for (const [id, v] of Object.entries(data as Record<string, unknown>)) {
    const at = `authors.json "${id.slice(0, 40)}"`;
    if (!ID.test(id)) out.push(`${at}: the id must be lowercase words joined by hyphens`);
    if (!v || typeof v !== "object" || Array.isArray(v)) { out.push(`${at}: must be an object`); continue; }
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!KEYS.has(k)) out.push(`${at}: "${k}" is not a field (name, role and link only; there is no photo)`);
    for (const f of ["name", "role"] as const) {
      const t = o[f] as Record<string, unknown> | undefined;
      if (!t || typeof t !== "object" || Array.isArray(t)) { out.push(`${at}: ${f} needs an Arabic and an English text`); continue; }
      for (const l of ["ar", "en"] as const) {
        const s = t[l];
        if (typeof s !== "string" || !s.trim()) out.push(`${at}: ${f}.${l} is missing`);
        else if (s.length > TEXT_MAX) out.push(`${at}: ${f}.${l} is ${s.length} characters; the most is ${TEXT_MAX}`);
        else if (s !== s.trim() || /[<>\n\r]/.test(s)) out.push(`${at}: ${f}.${l} must be plain text on one line with no markup`);
      }
      for (const k of Object.keys(t)) if (k !== "ar" && k !== "en") out.push(`${at}: ${f}.${k} is not a language (ar and en only)`);
    }
    if (o.link !== undefined) {
      const link = o.link;
      let ok = false;
      if (typeof link === "string" && link.length <= LINK_MAX) {
        try { const u = new URL(link); ok = u.protocol === "https:" && !u.username && !u.password; } catch { /* not a URL */ }
      }
      if (!ok) out.push(`${at}: link must be an https address of at most ${LINK_MAX} characters, without a login in it`);
    }
  }
  return out;
}

/** The authors of a checked file's text. Throws, naming every problem, so a bad file stops the build instead of publishing. */
export function parseAuthors(raw: string): Authors {
  const problems = authorFileProblems(raw);
  if (problems.length) throw new Error(`content/authors.json has ${problems.length} problem(s): ${problems.join("; ")}`);
  return JSON.parse(raw) as Authors;
}

let cache: Authors | undefined;
/** `content/authors.json`, read and checked once. */
export function authors(): Authors {
  return (cache ??= parseAuthors(readFileSync(join(process.cwd(), "content", "authors.json"), "utf8")));
}

/** What is wrong with a post's `author` line, empty when there is none or it names a listed person. */
export function authorProblems(file: string, meta: Record<string, string>, known: Authors): string[] {
  const a = meta.author;
  if (a === undefined) return [];
  if (!a) return [`${file}: author is empty (leave the line out for the organisation byline)`];
  if (!Object.prototype.hasOwnProperty.call(known, a)) return [`${file}: author "${a.slice(0, 40)}" is not in content/authors.json (${Object.keys(known).join(", ") || "none listed"})`];
  return [];
}

/** The author `id` as shown in `lang`, or null for no author or an unknown id. */
export function authorIn(known: Authors, id: string | undefined, lang: Lang): PostAuthor | null {
  if (!id || !Object.prototype.hasOwnProperty.call(known, id)) return null;
  const e = known[id];
  return { id, name: e.name[lang], role: e.role[lang], ...(e.link ? { link: e.link } : {}) };
}

/** The first letter of up to the first two words of a name, for the round mark that stands in for a photo. */
export function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => Array.from(w)[0] ?? "").join("");
}
