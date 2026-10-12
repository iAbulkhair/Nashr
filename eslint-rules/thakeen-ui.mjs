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
// The codemod (rule 1200) split `bg-ink` into `bg-inverse` (a panel) and `bg-foreground` (a dot or a bar); both read as
// the ink fill this rule always allowed lemon beside.
const INVERSE = (tokens) => tokens.some((t) => ["bg-ink", "bg-inverse", "bg-foreground", "card-inverse"].includes(baseOf(t)));

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

/**
 * Raw palette colours (rules 1200-1201, UI/UX phase 5). A colour utility that names a palette primitive (ink, paper,
 * white, black, ground, lilac, muted), with or without an opacity, or an arbitrary colour value, keeps one colour in both
 * themes, so it shows ink on the dark ground. Components use the semantic roles instead (`text-foreground`,
 * `text-foreground-muted`, `bg-surface`, `bg-background`, `border-border`, `bg-inverse`...), which the dark block in
 * src/app/theme-dark.css points at its own values. Lemon, gold, danger and the agent colours are brand and status
 * colours, not raw: they keep their own rules (1095, 1096).
 */
export const RAW_COLOUR = /^(?:bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|fill|stroke|divide|from|to|via|decoration|placeholder|shadow|caret|accent)-(?:ink|paper|white|black|ground|lilac|muted)(?:\/(?:\d+|\[[^\]]+\]))?$/;
export const ARBITRARY_COLOUR = /^(?:bg|text|border(?:-[xytrblse])?|ring|outline|fill|stroke|divide|from|to|via|decoration|shadow|caret|accent)-\[(?:#|rgba?\(|hsla?\(|oklch\(|oklab\(|color-mix\(|var\(--(?:primitive-)?color-(?:ink|paper|white|ground|lilac|muted)\))/;

/** A bright fill whose colour does not change with the theme: text on it stays ink in both themes. */
const FIXED_FILL = /(?:^|\s|:)(?:bg-(?:lemon|gold|agent-[a-z]+|accent)|btn-accent|badge-accent)(?=\s|$)/;
/** A class list that paints a panel or a pill with its own text (rather than a dot, a bar or a line). */
const PANEL = /(?:^|\s|:)(?:text-(?:paper|white|lilac|lemon|ground|inverse-[a-z]+)|card\b|p[xy]?-\d|rounded-(?:xl|2xl|lg))/;

/** The exact replacements: the report's §5.1 table and the roles tokens.css already had. */
const EXACT = {
  "text-ink": "text-foreground",
  "text-ink/70": "text-foreground-muted",
  "text-ink/80": "text-foreground-muted",
  "text-ink/85": "text-foreground",
  "text-ink/90": "text-foreground",
  "text-muted": "text-foreground-muted",
  "bg-ink/40": "bg-overlay",
  "bg-black/40": "bg-overlay",
  "bg-white": "bg-surface",
  "bg-paper": "bg-surface",
  "bg-ground": "bg-background",
  "bg-lilac": "bg-background-muted",
  "text-lilac": "text-inverse-muted",
  "text-paper": "text-inverse-foreground",
  "text-white": "text-inverse-foreground",
  "text-ground": "text-inverse-foreground",
  "border-ink": "border-border-strong",
  "border-ink/15": "border-border",
  "border-ink/20": "border-border",
  "ring-ink": "ring-ring",
  "ring-paper": "ring-surface",
  "accent-ink": "accent-foreground",
  "divide-ink": "divide-border-strong",
};
/** The palette name each family's opacity form moves onto. */
const FAMILY = { ink: "foreground", ground: "background", lilac: "background-muted", paper: "surface", white: "surface" };

/**
 * The semantic class for a raw colour (no variant prefix), given the rest of its class list. `bg-ink` is a panel or pill
 * (`bg-inverse`) when its list also sets text or padding, else a dot or a bar (`bg-foreground`); ink text on a fixed
 * bright fill stays ink (`text-accent-foreground`). Returns undefined for a token that is not raw.
 */
export function semanticColour(base, list = "") {
  if (!RAW_COLOUR.test(base)) return undefined;
  if (FIXED_FILL.test(list) && (base === "text-ink" || base === "text-muted" || base === "text-ink/70" || base === "text-ink/80")) return "text-accent-foreground";
  if (base === "bg-ink") return PANEL.test(list) ? "bg-inverse" : "bg-foreground";
  if (EXACT[base]) return EXACT[base];
  const m = /^(.*)-(ink|ground|lilac|paper|white)(\/.+)$/.exec(base);
  if (m) {
    // Lilac, paper and white lines or text sit on ink: they are the inverse surface's own colours.
    if (m[1] !== "bg" && m[2] === "lilac") return `${m[1]}-inverse-muted${m[3]}`;
    if (m[1] !== "bg" && m[2] !== "ink") return `${m[1]}-inverse-foreground${m[3]}`;
    return `${m[1]}-${FAMILY[m[2]]}${m[3]}`;
  }
  return undefined;
}

/** SVG shapes carry the scribble's own class names (`ring-paper`, `ink`), which are not Tailwind utilities. */
const SVG_SHAPES = new Set(["path", "circle", "rect", "ellipse", "line", "polyline", "polygon"]);

const noRawColour = {
  meta: { type: "problem", docs: { description: "Colours come from the semantic roles, so both themes work." }, schema: [], messages: { raw: "`{{token}}` is a raw palette colour and stays the same in the dark theme. Use `{{semantic}}` (rules 1200-1201)." } },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const check = (node, text) => {
      if (typeof text !== "string" || !/-(?:ink|paper|white|black|ground|lilac|muted|\[)/.test(text)) return;
      const ancestors = sourceCode.getAncestors ? sourceCode.getAncestors(node) : context.getAncestors();
      const owner = [...ancestors].reverse().find((a) => a.type === "JSXOpeningElement");
      if (owner && SVG_SHAPES.has(elementName(owner))) return;
      for (const token of text.split(/\s+/).filter(Boolean)) {
        const base = baseOf(token);
        if (RAW_COLOUR.test(base) || ARBITRARY_COLOUR.test(base)) {
          context.report({ node, messageId: "raw", data: { token, semantic: semanticColour(base, text) ?? "a semantic colour role" } });
        }
      }
    };
    return {
      Literal(node) { check(node, node.value); },
      TemplateElement(node) { check(node, node.value.cooked ?? node.value.raw); },
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
    "no-raw-colour": noRawColour,
  },
};

/** The rules that fail the lint (rule 1201): a raw colour would come back dark-blind. */
export const errors = {
  "thakeen-ui/no-raw-colour": "error",
};

/** The four rules as warnings, for `eslint.config.mjs`. */
export const warnings = {
  "thakeen-ui/danger-text-needs-alert": "warn",
  "thakeen-ui/lemon-on-ink": "warn",
  "thakeen-ui/no-date-slice": "warn",
  "thakeen-ui/no-physical-direction": "warn",
};

export default plugin;
