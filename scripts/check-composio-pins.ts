// Checks every allowlisted Composio tool against its schema AT THE PINNED toolkit version (rule 2166): each tool exists
// there, every argument name composio-catalog.ts may send is in its input schema, and every argument the schema requires
// is either allowlisted or fixed. Rule 749 pins (TOOLKIT_VERSION in src/lib/connectors/composio.ts) were checked by hand
// with `composio tools info`, which shows the LATEST version only; this reads the pinned one, the version the SDK will
// actually fetch before a platform call. Run by hand before a pin changes and before a provider is added to
// COMPOSIO_PROVIDERS, never at build time and not in `npm run check`: it needs the network and a Composio key.
//
// Usage:  npx --no-install jiti scripts/check-composio-pins.ts [toolkit ...]
// with COMPOSIO_API_KEY already in the environment (`read -rs COMPOSIO_API_KEY; export COMPOSIO_API_KEY`, so the key is
// never typed on a command line that is saved). No toolkit names: every toolkit in the catalog. jiti: see
// scripts/check-models.ts (already in node_modules, `--no-install` never downloads it).
//
// Exit codes: 0 every tool checked holds; 1 at least one tool is missing at its pin or has drifted (each is printed);
// 2 the check could not be made (no key, an unknown toolkit name, a request that failed for another reason).
//
// The key comes from the environment only, goes to the SDK and nowhere else, and is never printed: every message below
// is a toolkit, a slug, argument names or an error class name, never an error text or a body. Reading a tool schema
// executes nothing and connects no account.
import { pathToFileURL } from "node:url";
import { TOOLKITS, type Toolkit } from "../src/lib/connectors/composio-catalog";
import { TOOLKIT_VERSION } from "../src/lib/connectors/composio";

export type ToolSchema = { properties?: Record<string, unknown>; required?: readonly string[] };
/** The tool's input schema at `version`, or null when the tool does not exist there. Throws for any other failure. */
export type FetchSchema = (slug: string, version: string) => Promise<ToolSchema | null>;
export type CheckResult = { code: 0 | 1 | 2; lines: string[] };

/** Pure: the allowlisted names the schema lacks, and the required names that are neither allowlisted nor fixed. */
export function schemaDrift(schema: ToolSchema, args: readonly string[], fixed: Readonly<Record<string, unknown>> = {}): { missing: string[]; requiredNotSent: string[] } {
  const props = new Set(Object.keys(schema.properties ?? {}));
  const sent = new Set([...args, ...Object.keys(fixed)]);
  return {
    missing: args.filter((a) => !props.has(a)),
    requiredNotSent: [...(schema.required ?? [])].filter((r) => !sent.has(r)).sort(),
  };
}

export async function checkPins(env: Record<string, string | undefined>, fetchSchema: FetchSchema, only: readonly string[] = []): Promise<CheckResult> {
  if (!env.COMPOSIO_API_KEY?.trim()) return { code: 2, lines: ["COMPOSIO_API_KEY is not set. Put a Composio key in the environment (it is never printed) and run again."] };
  const unknown = only.filter((t) => !(t in TOOLKITS));
  if (unknown.length) return { code: 2, lines: [`Not a toolkit in composio-catalog.ts: ${unknown.join(", ")}. Nothing was checked.`] };
  const toolkits = (only.length ? only : Object.keys(TOOLKITS)) as Toolkit[];

  const lines: string[] = [];
  let bad = 0, checked = 0;
  for (const t of toolkits) {
    const e = TOOLKITS[t];
    const pin = TOOLKIT_VERSION[t];
    // One toolkit at a time, one tool at a time: a handful of reads, run by hand.
    for (const [slug, args] of Object.entries({ ...e.read, ...e.write })) {
      let schema: ToolSchema | null;
      try {
        schema = await fetchSchema(slug, pin);
      } catch (err) {
        return { code: 2, lines: [...lines, `${t} ${slug}: the schema request failed (${err instanceof Error ? err.name : "error"}). Nothing after it was checked.`] };
      }
      checked++;
      if (!schema) {
        bad++;
        lines.push(`MISSING ${t}@${pin} ${slug}: the tool does not exist at the pinned version`);
        continue;
      }
      const d = schemaDrift(schema, args, e.fixed?.[slug]);
      if (d.missing.length || d.requiredNotSent.length) {
        bad++;
        lines.push(`DRIFT ${t}@${pin} ${slug}:${d.missing.length ? ` not in the schema: ${d.missing.join(", ")};` : ""}${d.requiredNotSent.length ? ` required but never sent: ${d.requiredNotSent.join(", ")}` : ""}`);
      }
    }
  }
  if (bad) return { code: 1, lines: [...lines, `${bad} of ${checked} tools need a look (${toolkits.length} toolkits).`] };
  return { code: 0, lines: [`All ${checked} allowlisted tools hold at their pinned versions (${toolkits.length} toolkits).`] };
}

async function main(): Promise<void> {
  // Built on the first fetch, after checkPins has seen the key: without one the SDK would fall back to the CLI's own
  // stored key (~/.composio), which is a user key, not this project's.
  let sdk: InstanceType<typeof import("@composio/core").Composio> | undefined;
  const fetchSchema: FetchSchema = async (slug, version) => {
    if (!sdk) {
      const { Composio } = await import("@composio/core");
      sdk = new Composio({ apiKey: process.env.COMPOSIO_API_KEY, allowTracking: false });
    }
    try {
      const tool = await sdk.tools.getRawComposioToolBySlug(slug, { version });
      return (tool.inputParameters ?? {}) as ToolSchema;
    } catch (err) {
      if (err instanceof Error && err.name === "ComposioToolNotFoundError") return null;
      throw err;
    }
  };
  const { code, lines } = await checkPins(process.env, fetchSchema, process.argv.slice(2));
  for (const line of lines) (code === 0 ? console.log : console.error)(line);
  process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
