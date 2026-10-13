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
import { isRegulated } from "./regulated";

export type BrandRule = { id: string; kind: "banned"; term: string };
/** `placeholder`: an unfilled slot such as [رقم] or {{1}} (placeholderHits below), held like a banned word. */
export type Violation = { ruleId: string; kind: BrandRule["kind"] | "placeholder"; term: string; excerpt: string };

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

/**
 * Unfilled placeholders. The agents are told to write an unknown fact as [رقم], [date] or [دليل مطلوب / proof needed]
 * rather than invent it (noor.ts, chat.ts), cart recovery replaces a discount the offers do not allow with [رقم]%, and
 * WhatsApp drafts carry {{1}} variables. Nothing held any of them, so a post could be approved, auto-approved and
 * published to X, Telegram or Facebook with "[رقم]" in it. Brackets in customer-facing copy are read as placeholders:
 * a markdown link ([text](https://…)), a checkbox ([ ], [x]), a footnote ([1], [^2]) and a script's direction label
 * ([VO], [VISUAL], [TEXT], which the marketing playbook asks for in TikTok and Reels scripts) are not. "[رقم](تقريبي)"
 * is: only a link target that looks like an address makes brackets a link.
 *
 * A personalisation slot ({{1}}, [الاسم], [name]) is filled per recipient by whoever sends it, so a WhatsApp, email,
 * SMS or call-script draft may be approved with one: the owner pastes it into a template, or the caller says the name.
 * No connector personalises, so at publish every placeholder holds the item.
 */
const BRACKET = /\[([^[\]\n{}]{1,80})\](?!\((?:https?:|www\.|mailto:|tel:|\/|#))/g;
const CURLY = /\{\{[^{}\n]{0,30}\}\}/g;
const SLOT_WORD = /^(?:(?:first|last|full|customer|client|shopper|contact)\s+)?name$|^(?:ال)?اسم(?:\s+(?:ال)?(?:عميل|متسوق|شخص|اول|كامل|مستلم))?$/;
/**
 * Direction labels of a video, story or voice script: stage directions for the creator, never text waiting for a value.
 * Matched on the folded label (normalize: ة→ه, ى→ي, lower case). A scene label may carry a number, a time range and a
 * description ("[Scene 1: المحمصة]", "[لقطة قريبة للقهوة]", "[Hook 0-2s]"); a bare label only a number or a colon
 * note ("[CTA]", "[TEXT: قهوة ريف]"). A label that names a value ("[VO: السعر]") is still a placeholder.
 */
const SCENE_LABEL = "vo|v\\.o\\.?|voice ?over|visuals?|sfx|music|audio|b-?roll|shot|scene|snap|slide|frame|transition|intro|outro|hook|صوت|تعليق صوتي|مشهد|لقطه|مؤثرات|موسيقي|سناب|شريحه|انتقال|الخطاف|خطاف";
const BARE_LABEL = "text|on-?screen text|super|cta|cut|beat|نص|النص|نص علي الشاشه|النص علي الشاشه|دعوه لاتخاذ اجراء";
const DIRECTION = new RegExp(`^(?:(?:${SCENE_LABEL})(?:[\\s:：\\-–—\\d].{0,79})?|(?:${BARE_LABEL})(?:\\s*\\d+(?:\\s*[-–]\\s*\\d+\\s*s?)?)?(?:\\s*[:：\\-–—]\\s*.{0,70})?)$`);
const VALUE_WORD = /رقم|number|date|تاريخ|price|سعر|دليل|proof|اسم|name/;
const PERSONAL_CHANNELS = ["whatsapp", "email", "sms", "call"];

/**
 * The placeholders in `text`, each once, in order. `slot` marks a personalisation slot. With `publish`, a script's
 * direction labels count too: a post that goes out never carries "[VO]" or "[CTA]".
 */
export function placeholderHits(text: string, opts: { publish?: boolean } = {}): { term: string; slot: boolean; at: number }[] {
  const out: { term: string; slot: boolean; at: number }[] = [];
  const seen = new Set<string>();
  const add = (term: string, slot: boolean, at: number) => {
    const k = normalize(term);
    if (seen.has(k) || out.length >= 10) return;
    seen.add(k);
    out.push({ term, slot, at });
  };
  for (const m of text.matchAll(BRACKET)) {
    const inner = m[1].trim();
    // A slot needs words: two letters at least, and no link or address inside. A script's direction label is not one.
    if ((inner.match(/\p{L}/gu) ?? []).length < 2 || /https?:|www\.|@/.test(inner)) continue;
    const folded = normalize(inner);
    if (!opts.publish && DIRECTION.test(folded) && !VALUE_WORD.test(folded)) continue;
    add(m[0], SLOT_WORD.test(normalize(inner)), m.index ?? 0);
  }
  for (const m of text.matchAll(CURLY)) add(m[0], true, m.index ?? 0);
  return out.sort((a, b) => a.at - b.at);
}

type Checkable = { type: TaskType; channel?: string; title?: string; body: string; editedBody?: string };

/** What the owner would approve or publish: the edited text when there is one, plus the title customers may see. */
export const textOf = (t: Checkable) => `${t.title ?? ""}\n${t.editedBody ?? t.body}`;

/**
 * The text a placeholder is looked for in: the body the owner can edit, and the title only where a connector publishes it
 * (an article's title becomes the post title on WordPress or Shopify). No screen edits a title, so a placeholder there
 * on any other type could never be cleared.
 */
const placeholderText = (t: Checkable) => (t.type === "article" ? textOf(t) : t.editedBody ?? t.body);

/**
 * Publish targets whose numbered {{n}} slots are the platform's own variables, filled per recipient by the platform:
 * a WhatsApp template (connectors/via-composio.ts) declares them for Meta's review. Any other placeholder still holds.
 */
const TEMPLATE_TARGETS = ["whatsapp"];
const TEMPLATE_VAR = /^\{\{\s*\d{1,2}\s*\}\}$/;

function placeholderViolations(t: Checkable, publish: boolean, provider?: string): Violation[] {
  const text = placeholderText(t);
  const personal = !publish && PERSONAL_CHANNELS.includes(String(t.channel ?? ""));
  const templateVars = publish && TEMPLATE_TARGETS.includes(String(provider ?? ""));
  return placeholderHits(text, { publish })
    .filter((h) => !(h.slot && personal))
    .filter((h) => !(templateVars && TEMPLATE_VAR.test(h.term)))
    .map((h) => ({ ruleId: `placeholder:${normalize(h.term)}`, kind: "placeholder" as const, term: h.term, excerpt: `${h.at > 30 ? "…" : ""}${text.slice(Math.max(0, h.at - 30), h.at + h.term.length + 30).replace(/\s+/g, " ").trim()}${h.at + h.term.length + 30 < text.length ? "…" : ""}` }));
}

/**
 * Violations that hold this item back from approval and publishing. Internal documents are not held. `publish` is the
 * stricter check of the publish route and tool: a personalisation slot is fine in a WhatsApp draft, never in a post.
 * `provider` is the publish target: a WhatsApp template keeps its {{n}} variables (TEMPLATE_TARGETS).
 */
export function gateTask(brand: Pick<Brand, "banned"> | null | undefined, t: Checkable, opts: { publish?: boolean; provider?: string } = {}): Violation[] {
  return isCustomerFacing(t.type) ? [...checkText(brandRules(brand), textOf(t)), ...placeholderViolations(t, !!opts.publish, opts.provider)] : [];
}

/**
 * Auto-approval never skips the gate: an item that breaks a rule waits in the inbox with the rule named. And a brand in a
 * regulated sector (health, pharmacy, real estate, law, finance: src/lib/regulated.ts, rule 1521) is never auto-approved,
 * whatever governance says: every item waits for a person. `industry` is optional so a caller without it keeps its answer.
 */
export function initialStatus(autoApprove: boolean | undefined, brand: (Pick<Brand, "banned"> & { industry?: unknown }) | null | undefined, t: Checkable): "approved" | "pending" {
  return autoApprove && !isRegulated(brand) && gateTask(brand, t).length === 0 ? "approved" : "pending";
}

/** One line for an agent, a tool result or an error message: which rule fired and on what. */
export function explain(v: Violation[], lang: "ar" | "en" = "en"): string {
  if (!v.length) return lang === "ar" ? "يطابق قواعد العلامة." : "Passes the brand rules.";
  const list = (kind: Violation["kind"]) => v.filter((x) => x.kind === kind).map((x) => `"${x.term}"`).join(lang === "ar" ? "، " : ", ");
  const banned = list("banned"), slots = list("placeholder");
  const parts = lang === "ar"
    ? [banned && `محجوز بقاعدة الكلمات الممنوعة في ملف العلامة: ${banned}. عدّل النص أو احذف الكلمة من ملف العلامة.`, slots && `فيه خانات لم تُعبّأ: ${slots}. ضع القيمة الحقيقية مكان كل خانة أو احذفها، فلا يُعتمد ولا يُنشر نص فيه خانة فارغة، ولا يُنشر كما هو نص فيه توجيه تصوير مثل [VO] أو خانة مثل {{1}}.`]
    : [banned && `Held by the brand file's banned-words rule: ${banned}. Edit the text, or remove the word from the brand file.`, slots && `Held for unfilled placeholders: ${slots}. Replace each with the real value or remove it; text with an empty placeholder is never approved or published, and a script direction such as [VO] or a slot such as {{1}} is never published as written.`];
  return parts.filter(Boolean).join(" ");
}
