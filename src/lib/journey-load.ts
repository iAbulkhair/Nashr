import { getBrand, listLite, type TaskLite } from "./brand";
import { listConnections } from "./connectors/store";
import { getMcpToken } from "./mcp";
import { listGrants } from "./oauth";
import { bannedTerms } from "./brand-rules";
import { computeJourney, type Journey } from "./journey";

/**
 * The journey for one workspace in one round of parallel reads. Kept apart from ./journey, which the browser imports
 * for the level rules: this file reaches the store. Callers that already hold the brand, the light task rows or the
 * connections pass them in instead of reading them twice.
 */
export async function loadJourney(scope: string, email: string, pre: { brand?: { banned?: string } | null; tasks?: TaskLite[]; connections?: unknown[] } = {}): Promise<Journey> {
  const [brand, tasks, connections, token, grants] = await Promise.all([
    "brand" in pre ? pre.brand : getBrand(scope),
    pre.tasks ?? listLite(scope),
    pre.connections ?? listConnections(scope),
    getMcpToken(email),
    listGrants(email),
  ]);
  return computeJourney({ hasBrand: !!brand, bannedWords: bannedTerms(brand?.banned).length, tasks, connections: connections.length, aiLinked: !!token || grants.length > 0, today: new Date().toISOString().slice(0, 10) });
}
