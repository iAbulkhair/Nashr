/**
 * The brand file as rules the code enforces, not only prose the model reads.
 *
 * Until this module, the owner's banned words reached the model as a prompt line (noor.ts), the reviewer as a
 * checklist item and the judge as a score, and nothing else. A draft that said "مضمون" when the owner banned it could
 * be approved, auto-approved or published, because the model was the only check. Here the same list becomes rules
 * that the approval route, the publish routes, auto-approval and the MCP `check_brand` tool apply in code, and that
 * name themselves when they fire.
 *
 * Import-free on purpose (types are erased): the inbox runs the same check in the browser as the owner edits, so the
 * card and the server can never disagree about why an item is held.
 */
import type { Brand } from "./brand";
import type { TaskType } from "./tasks";

export type BrandRule = { id: string; kind: "banned"; term: string };
export type Violation = { ruleId: string; kind: BrandRule["kind"]; term: string; excerpt: string };

/**
 * Types whose text reaches the business's customers. Internal documents (a strategy review, a pricing memo, a sales
 * script's objection notes) may quote a banned word to warn against it, and holding them would punish the warning.
 * Shared with the golden evals, which apply the same split.
 */
export const CUSTOMER_FACING: TaskType[] = ["social", "article", "whatsapp", "ads", "gbp", "followup_seq", "cart_recovery"];
export const isCustomerFacing = (type: TaskType) => CUSTOMER_FACING.includes(type);

// Diacritics, Quranic marks and tatweel carry no meaning for a banned-word match, and the letters that Gulf writers
// use interchangeably (alef forms, alef maqsura and yaa, taa marbuta and haa) are folded to one form.
const DROP = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/;
const FOLD: Record<string, string> = { "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي" };
const ARABIC = /[؀-ۿ]/;
const LETTER = /[\p{L}\p{N}]/u;

/** Folded text plus, for each folded character, its index in the original (so an excerpt quotes what was written). */
function fold(s: string): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (DROP.test(c)) continue;
    const f = (FOLD[c] ?? c).toLowerCase();
    text += f;
    for (let k = 0; k < f.length; k++) at.push(i);
  }
  return { text, at };
}
export const normalize = (s: string) => fold(s).text.replace(/\s+/g, " ").trim();

/** Owner's banned list, split the way the brand form invites: commas (Latin or Arabic), semicolons or new lines. */
export function bannedTerms(banned: string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (banned ?? "").split(/[,،;؛\n]/)) {
    const term = raw.trim().replace(/^["'«“]+|["'»”]+$/g, "").trim();
    const key = normalize(term);
    // One letter is never a word worth blocking, and matching it would hold nearly every draft.
    if (key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(term.slice(0, 80));
  }
  return out.slice(0, 100);
}

export function brandRules(brand: Pick<Brand, "banned"> | null | undefined): BrandRule[] {
  return bannedTerms(brand?.banned).map((term) => ({ id: `banned:${normalize(term)}`, kind: "banned", term }));
}

/**
 * Where `needle` occurs in `hay` as a word, or as the stem of an Arabic word. Arabic attaches prefixes (و، ب، ال، ف)
 * to the word, so "بالأفضل" must match "الأفضل" and "وأرخص" must match "أرخص"; Latin and short Arabic terms must stand
 * alone, so "cheap" does not fire inside "cheapest" and a two-letter Arabic term does not fire inside a longer word.
 */
const PREFIX = /^(?:[وف]?[بلك]?(?:ال)?)$/;
function find(hay: string, needle: string): number {
  const arabicStem = ARABIC.test(needle) && needle.replace(/\s/g, "").length >= 3;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    let s = i;
    while (s > 0 && LETTER.test(hay[s - 1])) s--;
    const after = hay[i + needle.length];
    // Suffixes are part of the same Arabic word ("مضمونة" is still "مضمون"); a Latin word must end where the term does.
    const endOk = !after || !LETTER.test(after) || arabicStem;
    const startOk = s === i || (arabicStem && PREFIX.test(hay.slice(s, i)));
    if (startOk && endOk) return i;
  }
  return -1;
}

export function checkText(rules: BrandRule[], text: string): Violation[] {
  if (!rules.length || !text) return [];
  const { text: hay, at } = fold(text);
  const out: Violation[] = [];
  for (const r of rules) {
    const needle = fold(r.term).text.replace(/\s+/g, " ");
    const i = find(hay, needle);
    if (i < 0) continue;
    const from = at[i];
    const to = (at[i + needle.length - 1] ?? from) + 1;
    out.push({ ruleId: r.id, kind: r.kind, term: r.term, excerpt: `${from > 30 ? "…" : ""}${text.slice(Math.max(0, from - 30), to + 30).replace(/\s+/g, " ").trim()}${to + 30 < text.length ? "…" : ""}` });
  }
  return out;
}

type Checkable = { type: TaskType; title?: string; body: string; editedBody?: string };

/** What the owner would approve or publish: the edited text when there is one, plus the title customers may see. */
export const textOf = (t: Checkable) => `${t.title ?? ""}\n${t.editedBody ?? t.body}`;

/** Violations that hold this item back from approval and publishing. Internal documents are not held. */
export function gateTask(brand: Pick<Brand, "banned"> | null | undefined, t: Checkable): Violation[] {
  return isCustomerFacing(t.type) ? checkText(brandRules(brand), textOf(t)) : [];
}

/** Auto-approval never skips the gate: an item that breaks a rule waits in the inbox with the rule named. */
export function initialStatus(autoApprove: boolean | undefined, brand: Pick<Brand, "banned"> | null | undefined, t: Checkable): "approved" | "pending" {
  return autoApprove && gateTask(brand, t).length === 0 ? "approved" : "pending";
}

/** One line for an agent, a tool result or an error message: which rule fired and on what. */
export function explain(v: Violation[], lang: "ar" | "en" = "en"): string {
  if (!v.length) return lang === "ar" ? "يطابق قواعد العلامة." : "Passes the brand rules.";
  const terms = v.map((x) => `"${x.term}"`).join(lang === "ar" ? "، " : ", ");
  return lang === "ar"
    ? `محجوز بقاعدة الكلمات الممنوعة في ملف العلامة: ${terms}. عدّل النص أو احذف الكلمة من ملف العلامة.`
    : `Held by the brand file's banned-words rule: ${terms}. Edit the text, or remove the word from the brand file.`;
}
