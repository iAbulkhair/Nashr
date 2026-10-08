import type { L, HomeAgentId } from "./home";

/**
 * The homepage's "how teams use Thakeen" slides: illustrative personas, NOT customer reviews. Each is a kind of owner
 * (a role, no name, no company) and says, in their own voice, what they would want from one agent, a tip, or a
 * suggestion. The section is badged as illustrative (`STORIES.badge`), and nothing here may be read as a real customer:
 * no personal or business names, no figures, no time saved, no result promised (CLAUDE.md: no invented customers,
 * testimonials, numbers or results). Every line describes something the agent does today (see `AGENT_CAST` and
 * `src/lib/agents.ts`); `tests/stories.test.ts` pins the shape and the bans.
 */

export type StoryKind = "like" | "tip" | "ask" | "take";

export type Look = {
  hair: "short" | "long" | "bun" | "curly" | "bald" | "cap";
  /** Headwear drawn over the hair: a shayla or a ghutra with its agal. */
  wear?: "shayla" | "ghutra";
  beard?: "stubble" | "full";
  glasses?: boolean;
};

export type Story = { id: string; role: L; who: HomeAgentId; kind: StoryKind; say: L; look: Look };

export const STORIES: { h: L; sub: L; badge: L; kind: Record<StoryKind, L>; prev: L; next: L; slide: L; of: L } = {
  h: { ar: "كيف يستخدمون ذكين.", en: "How teams use Thakeen." },
  sub: {
    ar: "وجوه رسمناها لأنواع أصحاب الأعمال اللي نخدمهم، وكل واحد يقول وش يبي من وكيله.",
    en: "Faces we drew for the kinds of owners we serve, each saying what they want from their agent.",
  },
  badge: { ar: "سيناريوهات توضيحية، مو آراء عملاء حقيقيين", en: "Illustrative scenarios, not real customer reviews" },
  kind: {
    like: { ar: "اللي يعجبني", en: "What I like" },
    tip: { ar: "نصيحة", en: "Tip" },
    ask: { ar: "اقتراح", en: "Suggestion" },
    take: { ar: "رأيي", en: "My take" },
  },
  prev: { ar: "السابق", en: "Previous" },
  next: { ar: "التالي", en: "Next" },
  slide: { ar: "شريحة", en: "Slide" },
  of: { ar: "من", en: "of" },
};

export const STORIES_LIST: Story[] = [
  {
    id: "cafe", who: "noor", kind: "like",
    role: { ar: "صاحب كوفي", en: "Café owner" },
    say: { ar: "نور تكتب لي أسبوع المحتوى بصوت الكوفي، وأنا بس أقرأ وأوافق.", en: "Noor writes my week of content in the café's voice. I read it and approve." },
    look: { hair: "short", wear: "ghutra", beard: "full" },
  },
  {
    id: "boutique", who: "noor", kind: "tip",
    role: { ar: "صاحبة بوتيك أونلاين", en: "Online boutique owner" },
    say: { ar: "ابدأ بإدخال رابط متجرك: كل ما عرفت نور منتجاتك أكثر، طلعت منشوراتها أقرب لك.", en: "Start by giving your store link. The better Noor knows your products, the closer her posts get." },
    look: { hair: "long", wear: "shayla" },
  },
  {
    id: "salon", who: "sami", kind: "like",
    role: { ar: "صالون تجميل", en: "Beauty salon" },
    say: { ar: "سامي يجهّز لي رد لكل عميلة تسأل، وأعدّله لو بغيت قبل ما يروح.", en: "Sami drafts a reply for every client who asks, and I edit it before it goes." },
    look: { hair: "bun", glasses: true },
  },
  {
    id: "dental", who: "sami", kind: "ask",
    role: { ar: "عيادة أسنان", en: "Dental clinic" },
    say: { ar: "أبغى سامي يفرّق لي بين اللي يحجز فعلًا واللي يسأل عن السعر وبس.", en: "I want Sami to tell me who will really book and who is only asking about the price." },
    look: { hair: "short", glasses: true },
  },
  {
    id: "freelance", who: "dana", kind: "like",
    role: { ar: "مصمم مستقل", en: "Freelance designer" },
    say: { ar: "تقرير دانة يطلع من أرقامي أنا، ما فيه تجميل. أقرأه أول شي يوم الأحد.", en: "Dana's report comes from my own numbers, no makeup. It's the first thing I read on Sunday." },
    look: { hair: "curly", beard: "stubble" },
  },
  {
    id: "agency", who: "dana", kind: "tip",
    role: { ar: "وكالة صغيرة", en: "Small agency" },
    say: { ar: "اربط حساباتك قبل أول تقرير. التقرير يبني على اللي يشوفه فعلًا، مو على التخمين.", en: "Connect your accounts before the first report. It builds on what it actually sees, not guesses." },
    look: { hair: "long", glasses: true },
  },
  {
    id: "shop", who: "razan", kind: "like",
    role: { ar: "متجر إلكتروني", en: "Online store" },
    say: { ar: "قبل ما أصرف على إعلان، رزان تحسبها لي وتقول لي يستاهل ولا لا.", en: "Before I spend on an ad, Razan runs the maths and tells me if it's worth it." },
    look: { hair: "short", wear: "ghutra" },
  },
  {
    id: "bakery", who: "razan", kind: "ask",
    role: { ar: "مخبز منزلي", en: "Home bakery" },
    say: { ar: "أبغى أعرف بوضوح كم يكلفني العميل الواحد، وهل سعري يغطي تعبي.", en: "I want to see plainly what one customer costs me, and whether my price covers my effort." },
    look: { hair: "bun", wear: "shayla" },
  },
  {
    id: "coach", who: "faris", kind: "like",
    role: { ar: "مدرّب أعمال", en: "Business coach" },
    say: { ar: "فارس يعطيني خطة ٩٠ يوم وتجارب صغيرة. ما أحس إني أراهن بكل الميزانية.", en: "Faris gives me a 90-day plan with small tests, so I'm not betting the whole budget at once." },
    look: { hair: "short", beard: "full", glasses: true },
  },
  {
    id: "startup", who: "faris", kind: "tip",
    role: { ar: "مؤسس شركة ناشئة", en: "Startup founder" },
    say: { ar: "جرّب فكرة واحدة بميزانية صغيرة أول، ولما تنجح اطلب من فارس يوسّعها.", en: "Test one idea on a small budget first. When it works, ask Faris to widen it." },
    look: { hair: "cap", beard: "stubble" },
  },
  {
    id: "restaurant", who: "majed", kind: "like",
    role: { ar: "مطعم عائلي", en: "Family restaurant" },
    say: { ar: "ماجد يعطيني القرار في صفحة وحدة. ما أحتاج أقرأ عشر رسائل.", en: "Majed gives me the decision on one page. I don't have to read ten messages." },
    look: { hair: "short", wear: "ghutra", beard: "full" },
  },
  {
    id: "realestate", who: "majed", kind: "take",
    role: { ar: "مكتب عقارات", en: "Real-estate office" },
    say: { ar: "أحب إن آخر كلمة لي: ما ينتشر شي بدون موافقتي، حتى لو الفريق كله متفق.", en: "I like that the last word is mine: nothing goes out without my approval, even when the whole team agrees." },
    look: { hair: "bald", beard: "stubble", glasses: true },
  },
  {
    id: "gym", who: "layan", kind: "like",
    role: { ar: "نادي رياضي نسائي", en: "Women's gym" },
    say: { ar: "ليان تساعدني أفهم وش تبي المشتركات وليش ترجع وحدة وتروح وحدة.", en: "Layan helps me understand what members want, and why some come back and some leave." },
    look: { hair: "long", wear: "shayla", glasses: true },
  },
  {
    id: "kids", who: "layan", kind: "tip",
    role: { ar: "متجر ألعاب أطفال", en: "Kids' toy shop" },
    say: { ar: "اسأل ليان عن عميلك قبل ما تكتب أي إعلان. الإعلان يصير أوضح لما تعرف لمن تتكلم.", en: "Ask Layan about your customer before you write any ad. It gets clearer when you know who you're talking to." },
    look: { hair: "curly" },
  },
  {
    id: "tutor", who: "reem", kind: "like",
    role: { ar: "معلمة خصوصية", en: "Private tutor" },
    say: { ar: "ريم تجمع مهامي ومواعيدي ومتابعاتي في قائمة وحدة، وأقدر أضيف عليها بنفسي.", en: "Reem keeps my to-dos, dates and follow-ups in one list, and I can add to it myself." },
    look: { hair: "bun", wear: "shayla" },
  },
  {
    id: "photographer", who: "reem", kind: "take",
    role: { ar: "مصوّرة مناسبات", en: "Event photographer" },
    say: { ar: "أنا ما أحب أنسى متابعة عميل. القائمة الواضحة تهدّيني.", en: "I hate forgetting to follow up with a client. A clear list calms me down." },
    look: { hair: "long" },
  },
  {
    id: "florist", who: "noor", kind: "ask",
    role: { ar: "محل ورود", en: "Flower shop" },
    say: { ar: "قبل المناسبات أبغى نور تقترح لي وش أقول، وأنا أختار.", en: "Before the big occasions I want Noor to suggest what to say, and I choose." },
    look: { hair: "short", glasses: true },
  },
  {
    id: "mechanic", who: "sami", kind: "tip",
    role: { ar: "ورشة سيارات", en: "Car workshop" },
    say: { ar: "اكتب لسامي أسئلة عملائك الشائعة. يرد بنفس الكلام اللي تقوله أنت.", en: "Give Sami your customers' usual questions. He answers in the way you would." },
    look: { hair: "cap", beard: "full" },
  },
  {
    id: "consultant", who: "dana", kind: "take",
    role: { ar: "مستشارة تسويق", en: "Marketing consultant" },
    say: { ar: "أفضّل تقريرًا صريحًا على تقرير جميل. دانة تقول اللي صار.", en: "I'd take a frank report over a pretty one. Dana says what happened." },
    look: { hair: "bun", glasses: true },
  },
  {
    id: "wholesale", who: "razan", kind: "tip",
    role: { ar: "تاجر جملة", en: "Wholesale trader" },
    say: { ar: "راجع سعرك مع رزان قبل الموسم، مو بعده.", en: "Review your price with Razan before the season, not after." },
    look: { hair: "short", wear: "ghutra", beard: "stubble" },
  },
  {
    id: "event", who: "faris", kind: "ask",
    role: { ar: "منظّم فعاليات", en: "Event organiser" },
    say: { ar: "أبغى من فارس خطة تتوزع على أسابيع، مو حملة وحدة كبيرة.", en: "I want a plan from Faris that spreads over weeks, not one big campaign." },
    look: { hair: "curly", beard: "full", glasses: true },
  },
  {
    id: "pharmacy", who: "majed", kind: "tip",
    role: { ar: "صيدلية حي", en: "Neighbourhood pharmacy" },
    say: { ar: "لما تتردد بين خيارين، اطلب من ماجد يلخصها لك في صفحة وتقرر.", en: "When you're torn between two options, ask Majed to boil them down to one page, then decide." },
    look: { hair: "short", glasses: true },
  },
  {
    id: "bookshop", who: "layan", kind: "take",
    role: { ar: "مكتبة مستقلة", en: "Independent bookshop" },
    say: { ar: "أحس إن ليان تسمع عميلي أكثر مني، وهذا يفيدني.", en: "I feel Layan listens to my customer better than I do, and that helps me." },
    look: { hair: "long", glasses: true },
  },
  {
    id: "travel", who: "reem", kind: "ask",
    role: { ar: "مكتب سفر", en: "Travel desk" },
    say: { ar: "أبغى كل متابعاتي مرتبة في مكان واحد، وأشوف وش بقي لي اليوم.", en: "I want all my follow-ups in one place so I can see what's left for today." },
    look: { hair: "short", beard: "stubble" },
  },
];

/** Four faces a slide. */
export const PER_SLIDE = 4;
