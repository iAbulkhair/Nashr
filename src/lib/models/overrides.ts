import type { User } from "../auth";
import type { Brand } from "../brand";
import type { TaskType } from "../tasks";
import type { Conversation } from "../conversations";
import { route, type Routed } from "./route";

/**
 * A customer's model picks at call time (spec 2026-10-08-straitly-model-routing, sections 4 and 8; plan Task 6). Three
 * stored fields, all optional and additive (rule 679, expand only), all set and cleared only by `PUT /api/models`:
 *
 * - `Conversation.model`: the chat pick of one conversation, at `conv:{sc(u)}:{id}`. The default thread has no record,
 *   so it holds no pick.
 * - `Brand.model`: the generation pick of one brand, at `brand:{sc(u)}`, used by every batch of that brand.
 * - `User.chinaHostingOk`: the owner's one confirmation that a China-hosted model may be used, on the account
 *   (`user:{u.email}`, the session's account, never a request's).
 *
 * The callers read the records they already read under `sc(u)` and hand the stored values to `route()`, which validates
 * them (routing never reads on its own). Absent and null are both "nothing stored": automatic. A pick `route()` rejects
 * runs the automatic choice, and the customer is told in the reply language (`MODEL_UNAVAILABLE`).
 *
 * Only `chat` and `generate` read a pick. The reviewer, the cross-review, the judge, onboarding, image prompts and the
 * free tools never do (tests/model-override.test.ts).
 */

/** True only when the owner stored the confirmation; anything else is not one. */
export const chinaConfirmed = (u: Pick<User, "chinaHostingOk">): boolean => u.chinaHostingOk === true;

/** A chat turn's model: the conversation's pick when it passes `route()`, else the automatic choice and why. */
export const chatRouteFor = (u: Pick<User, "chinaHostingOk">, conv: Pick<Conversation, "model"> | null | undefined): Routed =>
  route("chat", { stored: conv?.model, confirmedChina: chinaConfirmed(u) });

/** A generation batch's model: the brand's pick when it passes `route()` for this task type, else the automatic choice and why. */
export const generateRouteFor = (u: Pick<User, "chinaHostingOk">, brand: Pick<Brand, "model"> | null | undefined, task: TaskType): Routed =>
  route("generate", { stored: brand?.model, confirmedChina: chinaConfirmed(u), task });

/**
 * What the customer reads when their pick was not used. Chat puts it at the top of the reply (saved with it, so a reload
 * shows it); `POST /api/generate` answers it as `notice`. In the reply language: the request's `x-lang`, else the account's.
 */
export const MODEL_UNAVAILABLE = {
  chat: {
    ar: "النموذج الذي اخترته لهذه المحادثة غير متاح الآن، فاستُخدم الاختيار التلقائي لهذا الرد.",
    en: "The model you chose for this conversation is unavailable right now, so this reply used Automatic.",
  },
  generate: {
    ar: "النموذج الذي اخترته لهذه العلامة غير متاح الآن، فاستُخدم الاختيار التلقائي لهذه الدفعة.",
    en: "The model you chose for this brand is unavailable right now, so this batch used Automatic.",
  },
} as const;

/** The same fact for a model that relays it (the chat tools, MCP `generate_content`): the agent tells the owner in their language. */
export const MODEL_UNAVAILABLE_NOTE = "Note for the owner: the model chosen for this brand is unavailable right now, so this batch used Automatic (the default model). Tell the owner in one short sentence.";
