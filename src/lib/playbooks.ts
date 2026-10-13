/** Industry playbooks injected into Noor's system prompt. Matched on brand.industry (AR or EN label). */
export type Playbook = { id: string; match: RegExp; text: string };

export const PLAYBOOKS: Playbook[] = [
  {
    id: "ecommerce",
    match: /متجر|تجارة|e-?commerce|salla|zid|shopify|store/i,
    text: `E-COMMERCE PLAYBOOK
- Funnel: Snap/TikTok for reach (video-first, first 2 seconds = product in use), Instagram for trust (UGC, reviews), WhatsApp for conversion (cart recovery within 1h, 24h, 72h).
- Every post needs one product, one benefit, one CTA ("اطلب الآن", "الرابط في البايو", "راسلنا واتساب").
- Use social proof numbers only if in the brand file; otherwise "آلاف العملاء" style claims are banned.
- Mention free shipping threshold, COD availability, Tabby/Tamara installments when relevant — they are common at KSA checkouts.
- Abandoned cart message: name → product image reference → scarcity (stock/offer end) → one-tap link → opt-out line.
- Ad copy: headline = benefit + offer; primary text = objection handling (shipping, returns, authenticity); 3 hooks to test.`,
  },
  {
    id: "real_estate",
    match: /عقار|real ?estate|developer|مطور|property/i,
    text: `REAL ESTATE PLAYBOOK
- Compliance: every ad/post must leave a slot "[رقم رخصة فال / REGA license no.]" and "[رقم الإعلان]" placeholders. No guaranteed-return claims. No "investment advice" phrasing.
- Lead flow: Snap/Meta lead ad or landing → WhatsApp qualification within 5 minutes (budget, location, purpose: سكن/استثمار, timeline) → site visit booking.
- Content pillars: project progress (weekly construction update), neighborhood lifestyle, payment plans (Sakani, bank financing, installments), virtual tour, buyer FAQ.
- Launch sequence: teaser (2 wks) → registration of interest → launch event → early-bird units → progress updates.
- Tone: trustworthy, precise numbers (area m², price from, delivery date) as placeholders unless provided.`,
  },
  {
    id: "legal",
    match: /قانون|محام|law|legal|attorney/i,
    text: `LAW FIRM PLAYBOOK
- Content must be educational, never case-specific advice. End each piece with "هذا المحتوى للتوعية ولا يُعد استشارة قانونية" / "This is general information, not legal advice."
- Avoid guaranteeing outcomes, comparative superiority ("أفضل مكتب"), or client names without consent.
- Formats that work: "ماذا تفعل إذا…" explainers, new regulation breakdowns (Saudi Companies Law, Labor Law, PDPL), contract red-flags carousels, LinkedIn thought-leadership in formal MSA, short Q&A reels.
- CTA: book a consultation (WhatsApp/Calendly), download a checklist. Lead magnets: NDA checklist, employment contract checklist.
- Dialect: formal MSA for all legal content, even if brand dialect is Saudi; light dialect allowed only in hooks.`,
  },
  {
    id: "startup",
    match: /ناشئ|startup|saas|tech|تقنية/i,
    text: `STARTUP PLAYBOOK
- Channels: LinkedIn (founder voice, build-in-public, hiring), X (product updates, industry takes), Instagram for consumer apps only.
- Weekly cadence: 1 founder story, 1 product update/changelog, 1 customer proof, 1 insight/opinion, 1 hiring or culture post.
- Launch sequence: waitlist → beta cohort → public launch on Product Hunt/local communities (Monsha'at, Misk, Flat6Labs networks) → case studies.
- Growth experiments: every ad batch = 3 hooks × 2 audiences, SAR 50–100/day per cell (or the same in the brand's currency), kill at <1% CTR.
- Tone: confident, specific numbers, no buzzwords ("ثورة", "الأول من نوعه") unless proven.`,
  },
  {
    id: "clinic",
    match: /عياد|تجميل|clinic|aesthetic|dental|أسنان|health|صح/i,
    text: `CLINIC / AESTHETICS PLAYBOOK
- Saudi MOH advertising rules: no before/after with guaranteed results, no price-only bait, no "best/most successful", no patient testimonials implying outcomes; doctors named must carry license placeholder "[رقم الترخيص]".
- Content: procedure explainers, doctor Q&A, safety/hygiene, seasonal skin tips (summer sun, Ramadan fasting and treatments), FAQ on downtime and cost ranges as placeholders.
- Booking: WhatsApp booking link in every post; GBP posts weekly; Snapchat suits aesthetics audiences in KSA.
- Tone: caring, medical accuracy, female-audience-appropriate imagery references.`,
  },
  {
    id: "restaurant",
    match: /مطعم|كافي|restaurant|cafe|café|food|hospitality|ضياف/i,
    text: `RESTAURANT / CAFÉ PLAYBOOK
- Post timing: 11:30 (lunch), 17:00 (dinner planning), 21:30 (late night). Fridays after Jumu'ah are peak family time.
- Formats: menu item close-up video (Snap/TikTok), behind-the-counter, limited-time item, delivery partner offers (HungerStation, Jahez, Keeta), GBP offers with "Order" CTA.
- Reviews: reply templates for Google reviews (thank + specific detail + invite back), Arabic and English.
- Ramadan: Iftar sets, Suhoor hours, family boxes, pre-order via WhatsApp.
- Always include location/branch, hours, delivery radius as placeholders if not in brand file.`,
  },
  {
    id: "agency",
    match: /وكالة|agency|marketing/i,
    text: `AGENCY PLAYBOOK
- Content: client results (with permission placeholder), process transparency, trend explainers for Gulf platforms, team culture, pricing-adjacent education ("كم تكلفة إعلانات سناب؟").
- LinkedIn + X for B2B; Instagram as portfolio.
- CTA: free audit, discovery call. Lead magnet: platform benchmark PDF for KSA.`,
  },
  {
    id: "professional",
    match: /خدمات|محاسب|استشار|تعليم|professional|accounting|consult|education|training/i,
    text: `PROFESSIONAL SERVICES PLAYBOOK
- Authority content: regulation updates (ZATCA e-invoicing, VAT, Saudization), checklists, "mistakes we see" posts, client FAQ.
- LinkedIn primary, GBP weekly, WhatsApp for lead follow-up within 1 business hour.
- Tone: formal MSA, precise, no guarantees. CTA: book a consultation.`,
  },
];

export function pickPlaybook(industry: string): Playbook | null {
  return PLAYBOOKS.find((p) => p.match.test(industry)) ?? null;
}
