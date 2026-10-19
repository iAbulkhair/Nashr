import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";
import { MULTI_ORG } from "@/lib/multi-org";

/**
 * Source scans of multi-workspace membership, release M1 expand (docs/specs/2026-10-18-multi-org.md, rules 2112, 2132,
 * 2137). Each scan reads the TypeScript syntax tree, so comments never count and a template, a string or a call is found
 * wherever it is written.
 *
 * - Rule 2112 (the scan half): no file under src/app reads a person or an account id (`pid`, `acct`, `aid`,
 *   `accountId`, `ownerPid`) from a path parameter, a body, a form, a query or a header. The switch route and the
 *   workspace handle in the URL come with release M2 (decision 7) and pin the other half.
 * - Rule 2137: the nine new key families are produced only by src/lib/keys.ts. No other file holds a `person:`,
 *   `lock:person:`, `orgs:`, `lastorg:`, `mbr:` or `teamlog:` template or string; the legacy per-login `activebrand:`,
 *   `sec:feedof:`, `sec:bookof:`, `lock:feed:` and `lock:book:` templates outside keys.ts keep their legacy placeholder
 *   count, so none of them builds the per-(person, account) shape. The files the raw-key ratchet lists
 *   (tests/key-registry-ratchet.test.ts `RAW_KEYS`) are all in the scan, and the ratchet total is the number it had
 *   before release M1.
 * - Rule 2132: `MULTI_ORG` is false and only src/lib/team.ts and src/lib/membership.ts may branch on it; `p_` person
 *   ids are made only in src/lib/auth.ts (`createUser` with `person: "p"`) and src/lib/team.ts (`createMember` with
 *   `pid`), and no product code passes either option.
 */

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const posix = (f: string) => f.split(sep).join("/");
const ALL = sources("src").map(posix).sort();
const APP = ALL.filter((f) => f.startsWith("src/app/"));
const KEYS = "src/lib/keys.ts";

const parsed = new Map<string, ts.SourceFile>();
function tree(f: string): ts.SourceFile {
  let sf = parsed.get(f);
  if (!sf) {
    sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    parsed.set(f, sf);
  }
  return sf;
}
function walk(n: ts.Node, fn: (n: ts.Node) => void) {
  fn(n);
  n.forEachChild((c) => walk(c, fn));
}
const where = (sf: ts.SourceFile, n: ts.Node) => `${sf.fileName}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

// ---------------------------------------------------------------------------------------------------------------------
// Rule 2112
// ---------------------------------------------------------------------------------------------------------------------

const ID_NAMES = new Set(["pid", "acct", "aid", "accountId", "ownerPid"]);
/**
 * An expression whose value comes from the request: its body, form, text, path parameters, query or headers, directly or
 * through the route wrapper's checked `input`, `query` and `params` (src/lib/api-handler.ts).
 */
const FROM_REQUEST = /\b(req|request)\.(json|formData|text)\(|\bparams\b|\bsearchParams\b|\bquery\b|\binput\b|\bbody\b|\bheaders\(\)|\.headers\b/;
const REQUEST_PARTS = /^(params|searchParams|query|input|body)$/;

/**
 * Names that are not a Thakeen person or account id although they are spelled like one, each with the one use the scan
 * accepts. In M1 the list of Thakeen ids a route may read from a request is empty; this is not that list.
 * `accountId` in POST /api/connect/{provider} is an ad platform's account id (Google Ads, Meta, TikTok), matched by
 * `selectAdAccount` only against the brand connection's own `adAccounts`, which the active scope's record holds.
 */
const NOT_A_THAKEEN_ID: { file: string; name: string; only: RegExp }[] = [
  { file: "src/app/api/connect/[provider]/route.ts", name: "accountId", only: /^selectAdAccount\(c, String\(b\.accountId \?\? ""\)\)$/ },
];

function requestIdReads(sf: ts.SourceFile): { at: string; name: string; text: string; calls: string[] }[] {
  // Every variable this file initializes from the request, by name (scoping ignored: over-approximates on purpose).
  const fromRequest = new Set<string>();
  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer && FROM_REQUEST.test(n.initializer.getText(sf))) {
      if (ts.isIdentifier(n.name)) fromRequest.add(n.name.text);
    }
    if (ts.isParameter(n) && ts.isIdentifier(n.name) && /^(params|searchParams|ctx|context|props)$/.test(n.name.text)) fromRequest.add(n.name.text);
  });
  const sourced = (e: ts.Expression): boolean => {
    const t = e.getText(sf);
    if (FROM_REQUEST.test(t)) return true;
    let x: ts.Expression = e;
    while (ts.isParenthesizedExpression(x) || ts.isAwaitExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
    return ts.isIdentifier(x) && fromRequest.has(x.text);
  };
  /** The calls the read sits in, innermost first, up to its statement. */
  const enclosingCalls = (n: ts.Node): string[] => {
    const found: string[] = [];
    for (let p = n.parent; p && !ts.isBlock(p) && !ts.isSourceFile(p); p = p.parent) if (ts.isCallExpression(p)) found.push(p.getText(sf));
    return found;
  };
  const out: { at: string; name: string; text: string; calls: string[] }[] = [];
  const hit = (n: ts.Node, name: string) => out.push({ at: where(sf, n), name, text: n.getText(sf).slice(0, 120), calls: enclosingCalls(n) });
  walk(sf, (n) => {
    // searchParams.get("acct"), form.get("pid"), headers.get("aid"): any .get("<id name>") call in a route or page.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "get") {
      const a = n.arguments[0];
      if (a && ts.isStringLiteralLike(a) && ID_NAMES.has(a.text)) hit(n, a.text);
    }
    // body.acct, b.pid, (await params).aid, query.ownerPid, b?.accountId
    if (ts.isPropertyAccessExpression(n) && ID_NAMES.has(n.name.text) && sourced(n.expression)) hit(n, n.name.text);
    // body["acct"]
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && ID_NAMES.has(n.argumentExpression.text) && sourced(n.expression)) hit(n, n.argumentExpression.text);
    // const { acct } = await req.json() / = await params
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && sourced(n.initializer)) {
      for (const el of n.name.elements) {
        const key = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : "";
        if (ID_NAMES.has(key)) hit(el, key);
      }
    }
    // the wrapper's ({ input: { acct }, query: { pid } }) or a page's ({ params: { aid } }) in a signature
    if (ts.isBindingElement(n) && ts.isIdentifier(n.name) && ID_NAMES.has((n.propertyName && ts.isIdentifier(n.propertyName) ? n.propertyName : n.name).text)) {
      const outer = n.parent.parent;
      if (ts.isBindingElement(outer) && REQUEST_PARTS.test((outer.propertyName && ts.isIdentifier(outer.propertyName) ? outer.propertyName : (outer.name as ts.Identifier)).text ?? "")) hit(n, (n.propertyName && ts.isIdentifier(n.propertyName) ? n.propertyName : n.name).text);
    }
    // a page or route signature that types its params or query with an id: { params: Promise<{ acct: string }> }
    if (ts.isParameter(n) && n.type) {
      walk(n.type, (t) => {
        if (ts.isPropertySignature(t) && ts.isIdentifier(t.name) && /^(params|searchParams)$/.test(t.name.text) && t.type) {
          walk(t.type, (m) => {
            if (ts.isPropertySignature(m) && ts.isIdentifier(m.name) && ID_NAMES.has(m.name.text)) hit(m, m.name.text);
          });
        }
      });
    }
    // a zod schema for a body or a query: { acct: z.string() }
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && ID_NAMES.has(n.name.text) && /^z\./.test(n.initializer.getText(sf))) hit(n, n.name.text);
  });
  return out;
}

describe("rule 2112 (scan half): no route or page reads a person or an account id from the request", () => {
  it("no dynamic path segment is named after an id", () => {
    const segs = APP.flatMap((f) => f.split("/").filter((s) => /^\[{1,2}(\.\.\.)?[A-Za-z]+\]{1,2}$/.test(s)));
    const named = [...new Set(segs)].filter((s) => ID_NAMES.has(s.replace(/[[\].]/g, "")));
    expect(named).toEqual([]);
  });

  it("no params, body, form, query or header read of pid, acct, aid, accountId or ownerPid", () => {
    const offenders = APP.flatMap((f) =>
      requestIdReads(tree(f)).filter((r) => !NOT_A_THAKEEN_ID.some((x) => x.file === f && x.name === r.name && r.calls.some((c) => x.only.test(c)))),
    );
    expect(offenders.map((r) => `${r.at} ${r.text}`)).toEqual([]);
  });

  it("each name the scan accepts as not a Thakeen id is still used only the way its entry says", () => {
    for (const x of NOT_A_THAKEEN_ID) {
      const reads = requestIdReads(tree(x.file)).filter((r) => r.name === x.name);
      expect(reads.length, `${x.file} no longer reads ${x.name}: drop its entry`).toBeGreaterThan(0);
      expect(reads.filter((r) => !r.calls.some((c) => x.only.test(c))).map((r) => r.at)).toEqual([]);
    }
  });

  it("the scan catches each way a route could read an id from the request", () => {
    const probe = (code: string) => requestIdReads(ts.createSourceFile("probe.ts", code, ts.ScriptTarget.Latest, true)).map((r) => r.name);
    expect(probe(`export async function GET(req: Request) { const u = new URL(req.url); return u.searchParams.get("acct"); }`)).toEqual(["acct"]);
    expect(probe(`export async function POST(req: Request) { const b = (await req.json()) as { pid?: string }; return b.pid; }`)).toEqual(["pid"]);
    expect(probe(`export async function POST(req: Request) { const { aid } = await req.json(); return aid; }`)).toEqual(["aid"]);
    expect(probe(`export async function GET(_r: Request, { params }: { params: Promise<{ ownerPid: string }> }) { return (await params).ownerPid; }`)).toEqual(["ownerPid", "ownerPid"]);
    expect(probe(`export async function POST(req: Request) { const f = await req.formData(); return f.get("accountId"); }`)).toEqual(["accountId"]);
    expect(probe(`export async function GET(req: Request) { return req.headers.get("acct"); }`)).toEqual(["acct"]);
    expect(probe(`const S = z.object({ acct: z.string() });`)).toEqual(["acct"]);
    expect(probe(`export const POST = handler({ auth: "user" }, async ({ u, input: { acct } }) => acct);`)).toEqual(["acct"]);
    expect(probe(`export const GET = handler({ auth: "user" }, async ({ u, query }) => query.pid);`)).toEqual(["pid"]);
    expect(probe(`export const PUT = handler({ auth: "user" }, async ({ input }) => { const b = input as { aid?: string }; return b.aid; });`)).toEqual(["aid"]);
    expect(probe(`export async function GET() { const u = await currentUser(); return u.acct ?? who.pid; }`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Rule 2137
// ---------------------------------------------------------------------------------------------------------------------

/** The prefixes only src/lib/keys.ts may produce: `personKey.person`, `.lock`, `.orgs`, `.lastOrg`, `accountKey.membership`, `.teamLog`. */
const NEW_ONLY = /^(person|lock:person|orgs|lastorg|mbr|teamlog):/;
/**
 * Prefixes shared by a legacy per-login key and its per-(person, account) family (`personKey.activeBrand`, `.feedOf`,
 * `.bookOf`, `.feedLock`, `.bookLock`): outside keys.ts a template may hold at most the legacy number of placeholders.
 */
const LEGACY_PLACEHOLDERS: [RegExp, number][] = [
  [/^activebrand:$/, 1],
  [/^sec:feedof:$/, 1],
  [/^sec:bookof:$/, 2],
  [/^lock:feed:$/, 1],
  [/^lock:book:$/, 2],
];

function keyLiterals(sf: ts.SourceFile): { at: string; head: string; spans: number }[] {
  const out: { at: string; head: string; spans: number }[] = [];
  walk(sf, (n) => {
    if (ts.isTemplateExpression(n)) out.push({ at: where(sf, n), head: n.head.text, spans: n.templateSpans.length });
    else if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) out.push({ at: where(sf, n), head: n.text, spans: 0 });
  });
  return out;
}

const RAW = /`[a-z][A-Za-z0-9_-]*(?::[A-Za-z0-9_-]+)*:\$\{/g;
/** The raw-key ratchet total at the base of release M1 (3e0d19b6, tests/key-registry-ratchet.test.ts `RAW_KEYS`). */
const RAW_TOTAL_BEFORE_M1 = 524;
const RATCHET = readFileSync(join("tests", "key-registry-ratchet.test.ts"), "utf8");
const RAW_KEYS: Record<string, number> = Object.fromEntries(
  [...(RATCHET.match(/const RAW_KEYS[^]*?\n};/)?.[0] ?? "").matchAll(/^\s*"([^"]+)": (\d+),/gm)].map((m) => [m[1], Number(m[2])]),
);

describe("rule 2137 (producer scan): the new key families come only from src/lib/keys.ts", () => {
  const OUTSIDE = ALL.filter((f) => f !== KEYS);

  it("no template or string outside keys.ts opens with person:, lock:person:, orgs:, lastorg:, mbr: or teamlog:", () => {
    const found = OUTSIDE.flatMap((f) => keyLiterals(tree(f)).filter((l) => NEW_ONLY.test(l.head)).map((l) => `${l.at} ${l.head}`));
    expect(found).toEqual([]);
  });

  it("legacy per-login templates outside keys.ts never take the per-(person, account) shape", () => {
    const found = OUTSIDE.flatMap((f) =>
      keyLiterals(tree(f))
        .filter((l) => l.spans > 0 && LEGACY_PLACEHOLDERS.some(([re, max]) => re.test(l.head) && l.spans > max))
        .map((l) => `${l.at} ${l.head} (${l.spans} placeholders)`),
    );
    expect(found).toEqual([]);
  });

  it("covers every file the raw-key ratchet lists", () => {
    const listed = Object.keys(RAW_KEYS);
    expect(listed.length).toBeGreaterThan(100);
    expect(listed.filter((f) => !OUTSIDE.includes(f))).toEqual([]);
    // The raw templates of each listed file are in the scan above; none opens with a new family's prefix.
    const raw = listed.flatMap((f) => keyLiterals(tree(f)).filter((l) => l.spans > 0 && NEW_ONLY.test(l.head)).map((l) => l.at));
    expect(raw).toEqual([]);
  });

  it("the raw-key ratchet total is unchanged by release M1, in the list and in the tree", () => {
    expect(Object.values(RAW_KEYS).reduce((a, b) => a + b, 0)).toBe(RAW_TOTAL_BEFORE_M1);
    const inTree = OUTSIDE.reduce((n, f) => n + (readFileSync(f, "utf8").match(RAW) ?? []).length, 0);
    expect(inTree).toBe(RAW_TOTAL_BEFORE_M1);
  });

  it("keys.ts itself builds each new family from branded ids", () => {
    const src = readFileSync(KEYS, "utf8");
    for (const sig of [
      "person: (p: PersonId) => `person:${p}`",
      "lock: (p: PersonId) => `lock:person:${p}`",
      "orgs: (p: PersonId) => `orgs:${p}`",
      "lastOrg: (p: PersonId) => `lastorg:${p}`",
      "activeBrand: (p: PersonId, a: AccountId) => `activebrand:${p}:${a}`",
      "feedOf: (p: PersonId, a: AccountId) => `sec:feedof:${p}:${a}`",
      "bookOf: (p: PersonId, a: AccountId, prov: string) => `sec:bookof:${p}:${a}:${prov}`",
      "membership: (a: AccountId, p: PersonId) => `mbr:${a}:${p}`",
      "teamLog: (a: AccountId) => `teamlog:${a}`",
    ]) expect(src).toContain(sig);
  });

  it("the scan catches a raw new-family key and skips comments", () => {
    const probe = (code: string) => keyLiterals(ts.createSourceFile("probe.ts", code, ts.ScriptTarget.Latest, true)).filter((l) => NEW_ONLY.test(l.head)).length;
    expect(probe("db.get(`person:${pid}`)")).toBe(1);
    expect(probe('db.get("mbr:" + aid + ":" + pid)')).toBe(1);
    expect(probe("db.smembers(`orgs:${p}`)")).toBe(1);
    expect(probe("// the `person:` row\n/* `mbr:{aid}:{pid}` */ const x = 1;")).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Rule 2132
// ---------------------------------------------------------------------------------------------------------------------

function identifiers(sf: ts.SourceFile, name: string): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  walk(sf, (n) => {
    if (ts.isIdentifier(n) && n.text === name) out.push(n);
  });
  return out;
}
function calls(sf: ts.SourceFile, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  walk(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) out.push(n);
  });
  return out;
}
const hasProp = (e: ts.Expression | undefined, name: string) =>
  !!e && (!ts.isObjectLiteralExpression(e) || e.properties.some((p) => p.name && ts.isIdentifier(p.name) && p.name.text === name) || e.properties.some(ts.isSpreadAssignment));

describe("rule 2132 (scan): the switch is off and nothing in product code makes a p_ person", () => {
  it("MULTI_ORG is false", () => {
    expect(MULTI_ORG).toBe(false);
  });

  it("only src/lib/team.ts and src/lib/membership.ts branch on MULTI_ORG (its definition is in src/lib/multi-org.ts)", () => {
    const users = ALL.filter((f) => identifiers(tree(f), "MULTI_ORG").length > 0);
    expect(users.filter((f) => !["src/lib/multi-org.ts", "src/lib/team.ts", "src/lib/membership.ts"].includes(f))).toEqual([]);
  });

  it("newPersonId is called only by createUser in src/lib/auth.ts, under person: \"p\"", () => {
    const callers = ALL.filter((f) => calls(tree(f), "newPersonId").length > 0);
    expect(callers).toEqual(["src/lib/auth.ts"]);
    const [c] = calls(tree("src/lib/auth.ts"), "newPersonId");
    let p: ts.Node | undefined = c;
    while (p && !ts.isConditionalExpression(p)) p = p.parent;
    expect(p && ts.isConditionalExpression(p) ? p.condition.getText(tree("src/lib/auth.ts")) : "").toBe('opts.person === "p"');
  });

  it("no product call of createUser passes the person option", () => {
    const sites = ALL.flatMap((f) => calls(tree(f), "createUser").map((c) => ({ at: where(tree(f), c), opts: c.arguments[1] })));
    expect(sites.length).toBeGreaterThanOrEqual(2); // signup, Google sign-in
    expect(sites.filter((s) => hasProp(s.opts, "person")).map((s) => s.at)).toEqual([]);
  });

  it("createMember (the only writer that takes a p_ pid) has no product caller, and accept passes no pid", () => {
    const callers = ALL.flatMap((f) => calls(tree(f), "createMember").map((c) => where(tree(f), c)));
    expect(callers).toEqual([]);
    const inserts = calls(tree("src/lib/team.ts"), "insertMember").map((c) => c.arguments[2]?.getText(tree("src/lib/team.ts")));
    expect(inserts.sort()).toEqual(["opts", "{}"]);
  });
});
