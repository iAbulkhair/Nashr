/**
 * Thakeen UI lint rules (rules 1095-1098, UI/UX report phase 1). They are warnings, never errors: they point at the old
 * patterns the primitives in src/components/ui replace, so each screen can move over in its own change. Each rule reads
 * only the class strings written in the JSX (string literals and template text inside `className`), never runtime values.
 */

/** Every string written inside a node: literals and template text, through conditionals and calls. */
function strings(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "Literal" && typeof node.value === "string") out.push(node.value);
  else if (node.type === "TemplateElement") out.push(node.value.cooked ?? node.value.raw);
  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => strings(c, out));
    else if (v && typeof v === "object" && typeof v.type === "string") strings(v, out);
  }
  return out;
}

/** The class tokens an opening element writes, from `className` (and `class`). */
function classTokens(opening) {
  const attr = opening.attributes.find((a) => a.type === "JSXAttribute" && (a.name.name === "className" || a.name.name === "class"));
  if (!attr || !attr.value) return { attr, tokens: [] };
  return { attr, tokens: strings(attr.value).join(" ").split(/\s+/).filter(Boolean) };
}

/** A token without its variants (`sm:`, `rtl:`, `hover:`) and its `!` or `-` prefix. */
export function baseOf(token) {
  return token.split(":").pop().replace(/^!/, "").replace(/^-/, "");
}

const attrValue = (opening, name) => {
  const a = opening.attributes.find((x) => x.type === "JSXAttribute" && x.name.name === name);
  if (!a) return undefined;
  if (!a.value) return true;
  if (a.value.type === "Literal") return a.value.value;
  return strings(a.value).join(" ") || true;
};

const elementName = (opening) => (opening.name.type === "JSXIdentifier" ? opening.name.name : opening.name.type === "JSXMemberExpression" ? opening.name.property.name : "");

/** Physical sides: Arabic first means the start and end of the line, never left and right (rule 1098). */
export const PHYSICAL = /^(?:m[lr]|p[lr]|scroll-[mp][lr]|left|right|rounded-[lr]|rounded-[tb][lr]|border-[lr]|(?:text|float|clear)-(?:left|right))(?:-|$)/;

/** What a physical class becomes. */
const LOGICAL = { ml: "ms", mr: "me", pl: "ps", pr: "pe", left: "start", right: "end", "rounded-l": "rounded-s", "rounded-r": "rounded-e", "border-l": "border-s", "border-r": "border-e", "text-left": "text-start", "text-right": "text-end", "float-left": "float-start", "float-right": "float-end" };

const noPhysicalDirection = {
  meta: { type: "suggestion", docs: { description: "Use logical sides (ms/me/ps/pe/start/end/text-start) so the layout mirrors in Arabic." }, schema: [], messages: { physical: "`{{token}}` is a physical side; use `{{logical}}` so the layout mirrors in Arabic (rule 1098)." } },
  create(context) {
    return {
      JSXOpeningElement(node) {
        const { attr, tokens } = classTokens(node);
        for (const token of tokens) {
          const base = baseOf(token);
          if (!PHYSICAL.test(base)) continue;
          const head = Object.keys(LOGICAL).filter((k) => base === k || base.startsWith(`${k}-`)).sort((a, b) => b.length - a.length)[0];
          context.report({ node: attr, messageId: "physical", data: { token, logical: head ? token.replace(head, LOGICAL[head]) : "a logical class" } });
        }
      },
    };
  },
};

/** An element that names a destructive action may be red; any other red text must be an error a screen reader hears. */
const ACTION_ELEMENTS = new Set(["button", "a", "Link", "Button", "summary", "label"]);

const dangerTextNeedsAlert = {
  meta: { type: "suggestion", docs: { description: "Red text is an error (role=alert) or a destructive action, never decoration." }, schema: [], messages: { decorative: "`text-danger` here is neither an error with role=\"alert\" nor a destructive action. Use <Callout tone=\"danger\"> for an error or <Badge tone=\"danger\"> for a state (rule 1095)." } },
  create(context) {
    return {
      JSXOpeningElement(node) {
        const { attr, tokens } = classTokens(node);
        if (!tokens.some((t) => baseOf(t) === "text-danger" || baseOf(t).startsWith("text-danger/"))) return;
        if (ACTION_ELEMENTS.has(elementName(node))) return;
        const role = attrValue(node, "role");
        if (role === "alert" || attrValue(node, "aria-live") !== undefined) return;
        context.report({ node: attr, messageId: "decorative" });
      },
    };
  },
};

const LEMON = /^(?:bg|text|border|fill|stroke|ring|outline|decoration|from|to|via)-lemon(?:\/|$)/;
const INVERSE = (tokens) => tokens.some((t) => ["bg-ink", "card-inverse"].includes(baseOf(t)));

const lemonOnInk = {
  meta: { type: "suggestion", docs: { description: "Lemon reads only on ink: on paper or lilac it fails contrast." }, schema: [], messages: { light: "`{{token}}` outside an ink surface. Lemon passes contrast only on ink (bg-ink, card-inverse, data-surface=\"inverse\"); on a light ground use lilac or a Badge (rule 1096)." } },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      JSXOpeningElement(node) {
        const { attr, tokens } = classTokens(node);
        const lemon = tokens.filter((t) => LEMON.test(baseOf(t)));
        if (!lemon.length || INVERSE(tokens)) return;
        const ancestors = sourceCode.getAncestors ? sourceCode.getAncestors(node) : context.getAncestors();
        const insideInk = ancestors.some((a) => a.type === "JSXElement" && (INVERSE(classTokens(a.openingElement).tokens) || attrValue(a.openingElement, "data-surface") === "inverse"));
        if (insideInk) return;
        for (const token of lemon) context.report({ node: attr, messageId: "light", data: { token } });
      },
    };
  },
};

const DATE_CUTS = new Set([10, 16, 19]);

const noDateSlice = {
  meta: { type: "suggestion", docs: { description: "Show dates with <Time>, not by cutting an ISO string." }, schema: [], messages: { slice: "`.slice(0, {{n}})` on a date shows the raw ISO form in both languages. Use <Time value={...} lang={lang} /> from src/components/ui/Time (rule 1097)." } },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed || callee.property.name !== "slice" || node.arguments.length !== 2) return;
        const [a, b] = node.arguments;
        if (a.type !== "Literal" || a.value !== 0 || b.type !== "Literal" || !DATE_CUTS.has(b.value)) return;
        const ancestors = sourceCode.getAncestors ? sourceCode.getAncestors(node) : context.getAncestors();
        if (!ancestors.some((x) => x.type === "JSXExpressionContainer")) return;
        context.report({ node, messageId: "slice", data: { n: String(b.value) } });
      },
    };
  },
};

const plugin = {
  meta: { name: "thakeen-ui" },
  rules: {
    "danger-text-needs-alert": dangerTextNeedsAlert,
    "lemon-on-ink": lemonOnInk,
    "no-date-slice": noDateSlice,
    "no-physical-direction": noPhysicalDirection,
  },
};

/** The four rules as warnings, for `eslint.config.mjs`. */
export const warnings = {
  "thakeen-ui/danger-text-needs-alert": "warn",
  "thakeen-ui/lemon-on-ink": "warn",
  "thakeen-ui/no-date-slice": "warn",
  "thakeen-ui/no-physical-direction": "warn",
};

export default plugin;
