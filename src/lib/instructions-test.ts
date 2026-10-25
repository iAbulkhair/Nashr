import type { User } from "./auth";
import type { Brand } from "./brand";
import { agentForTask, type AgentId } from "./agents";
import { draftCharge } from "./task-costs";
import { modelAllowsTask, modelById } from "./models/catalog";
import { generateRouteFor } from "./models/overrides";
import { DRAFT_TYPES, type TaskType } from "./tasks";

/**
 * What "Test this instruction" costs and which model it runs on (spec 11), in one place for the two callers that must
 * agree to the credit: `POST /api/instructions/test` (which charges it) and the customer page (which prints it on the
 * button the owner confirms). Two items of the type, at the model `generateBatch` would use for this brand and type.
 */
export type TestQuote = {
  /** The routing answer, whole: the route counts a refused pick (`routed.rejected`) for the founder console. */
  routed: ReturnType<typeof generateRouteFor>;
  model: string;
  /** False when the model cannot write this type now (the route answers 503 `model_unavailable`); `cost` is then 0. */
  available: boolean;
  cost: number;
};

export function testQuote(u: Pick<User, "chinaHostingOk">, brand: Pick<Brand, "model"> | null | undefined, type: TaskType): TestQuote {
  const routed = generateRouteFor(u, brand, type);
  const model = routed.model;
  const entry = modelById(model);
  const available = !!entry && (!!entry.auto || !!entry.pick) && modelAllowsTask(entry, type);
  return { routed, model, available, cost: available ? 2 * draftCharge(type, 1, model) : 0 };
}

/** The credits a test of `type` takes, or `null` when the model cannot write it now. */
export function testPrice(u: Pick<User, "chinaHostingOk">, brand: Pick<Brand, "model"> | null | undefined, type: TaskType): number | null {
  const q = testQuote(u, brand, type);
  return q.available ? q.cost : null;
}

/** One thing the owner can test: a type, the agent that owns it and what the button costs. */
export type TestOption = { agent: AgentId; type: TaskType; price: number };

/**
 * The tests the page offers: the types chat's `draft_items` can draft (`DRAFT_TYPES`, which the route also requires),
 * each with its owning agent (computed from the type, as the route does; Reem owns none) and its price. Empty without a
 * brand file, as the route answers 400 `no_brand` then.
 */
export function testOptionsFor(u: Pick<User, "chinaHostingOk">, brand: Pick<Brand, "model"> | null | undefined): TestOption[] {
  if (!brand) return [];
  return DRAFT_TYPES.flatMap((type) => {
    const agent = agentForTask(type).id;
    const price = testPrice(u, brand, type);
    return agent === "reem" || price === null ? [] : [{ agent, type, price }];
  });
}
