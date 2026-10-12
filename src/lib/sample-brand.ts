import type { Brand } from "./brand";

/**
 * The brand the founder's skills console tests platform instructions on (agent skills portal, spec 8.2; rule 959). It is
 * clearly fictional: a made-up cafe with no website, no price, no offer, no customer and no result in it, so a test never
 * touches a customer's data and nothing in its output can pass for a real claim. Like the golden set's brands it is not
 * to be reused in marketing.
 */
export const SAMPLE_BRAND: Brand = {
  name: "Sample Café",
  website: "",
  industry: "A small neighbourhood cafe (a fictional sample for testing, not a real business)",
  dialect: "english",
  languages: ["en"],
  city: "Riyadh",
  tone: "warm, simple, friendly",
  products: "Coffee, tea, pastries and light lunches. No prices are stated.",
  audience: "People from the neighbourhood who like a quiet place to read, work or meet a friend",
  offers: "",
  competitors: "",
  banned: "",
  preferred: "",
  channels: ["instagram", "whatsapp"],
  updatedAt: "2026-10-10T00:00:00.000Z",
};
