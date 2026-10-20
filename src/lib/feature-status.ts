import { CLAUDE_PAUSED } from "./model";
import { integrationsView, type IntegrationView } from "./integration-status";

/**
 * Rules 2450-2452: what Thakeen has switched on for every customer, shown on the customer's Connections page, so a
 * feature that is not on yet says so before the owner tries it (OpenDots' setup state, docs/OpenDots_Adoption.md). Built
 * from the founder page's own presence checks (`integrationsView`, src/lib/integration-status.ts): on or off only. A
 * customer never sees a variable name, a partial state or a gate's wording; those stay on the founder page.
 */
export type FeatureId = "agents" | "images" | "media" | "email" | "card" | "apps";
export type Feature = { id: FeatureId; on: boolean; name: { ar: string; en: string }; what: { ar: string; en: string } };

/** On only when every required name is present and no code switch keeps it off. */
const ON = (v: IntegrationView | undefined) => !!v && v.status === "on" && v.gates.every((g) => !g.off);

/** Each customer feature and the founder integrations behind it; any one of `any` being on is enough. */
const FEATURES: readonly { id: FeatureId; any: readonly string[]; name: Feature["name"]; what: Feature["what"] }[] = [
  { id: "agents", any: ["anthropic", "straitly"], name: { ar: "الفريق (الدردشة والتوليد)", en: "The team (chat and generation)" }, what: { ar: "نور والمتخصصون يكتبون ويجيبون", en: "Noor and the specialists write and answer" } },
  { id: "images", any: ["fal"], name: { ar: "الصور", en: "Images" }, what: { ar: "صورة لكل منشور بنموذج الصورة الافتراضي، وإلا تظهر بطاقة بديلة بلا كريدت", en: "An image per post with the default image model; otherwise a placeholder card that costs nothing" } },
  { id: "media", any: ["kie", "higgsfield"], name: { ar: "صور ومقاطع أعلى جودة", en: "Higher-quality images and video" }, what: { ar: "نماذج الصور والمقاطع الإضافية", en: "The extra image and video models" } },
  { id: "email", any: ["resend"], name: { ar: "التنبيهات بالبريد", en: "Email notices" }, what: { ar: "الملخص والتذكيرات والدعوات بالبريد", en: "Briefs, reminders and invites by email" } },
  { id: "card", any: ["paymob"], name: { ar: "الدفع بالبطاقة", en: "Card payments" }, what: { ar: "الاشتراك والتجديد بالبطاقة داخل ذكين", en: "Subscribing and renewing by card inside Thakeen" } },
  { id: "apps", any: ["composio"], name: { ar: "ربط لينكدإن وتيك توك والإعلانات", en: "LinkedIn, TikTok and ads connections" }, what: { ar: "المنصات التي تُربط عبر شريكنا للربط", en: "Platforms connected through our connection partner" } },
];

/** Pure over `env` (the process environment by default): booleans only, never a name or a value. */
export function customerFeatures(env: Readonly<Record<string, string | undefined>> = process.env, claudePaused: boolean = CLAUDE_PAUSED): Feature[] {
  const view = new Map(integrationsView(env, claudePaused).map((v) => [v.id, v]));
  return FEATURES.map((f) => ({ id: f.id, name: f.name, what: f.what, on: f.any.some((id) => ON(view.get(id))) }));
}
