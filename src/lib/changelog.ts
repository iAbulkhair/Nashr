import type { Lang } from "./i18n";
import { CHAT_ALLOWANCE as M, ONBOARD_EXTRA_BRAND_COST, PLAN_PRICE_SAR as P, chatOverflowHold, formatCount as fc } from "./pricing";
import { TASK_COST } from "./tasks";

/**
 * The public "Updates & wishlist" page (/{lang}/updates): what shipped, and what owners can vote on next.
 *
 * Import-free apart from types, src/lib/pricing.ts and src/lib/tasks.ts (both import-free, so they drag nothing else
 * along) on purpose: client components read the labels and statuses from here, and anything this file imported would be
 * dragged into their bundles. The prices and task costs in the pricing entries come from those tables (rule 248). The Redis side (votes, suggestions, promoted items, status
 * overrides) lives in src/lib/wishlist.ts.
 *
 * Every changelog entry is a change merged into main (the PR or commit is named next to it) and is dated with the
 * merge date. Every wishlist item comes from a row marked «أمنية: نعم» in docs/Competitor_Features_AR.md. Nothing here
 * names a competitor, and seeded wishes start with no votes: the only numbers on the page are real votes.
 */

export type Bi = { ar: string; en: string };
export type ChangeTag = "new" | "improved" | "fixed";
export type ChangeEntry = { date: string; tag: ChangeTag; title: Bi; desc: Bi };

export type WishStatus = "planned" | "in_progress" | "shipped";
export const WISH_STATUSES: readonly WishStatus[] = ["planned", "in_progress", "shipped"];
export const isWishStatus = (v: unknown): v is WishStatus => typeof v === "string" && (WISH_STATUSES as readonly string[]).includes(v);

export type WishArea = "agents" | "onboarding" | "content" | "channels" | "commerce" | "ads" | "reports" | "team" | "billing" | "integrations" | "app";
export type SeedWish = { id: string; area: WishArea; title: Bi };

/** Newest first. Dates are merge dates on main. */
export const CHANGELOG: readonly ChangeEntry[] = [
  // Reem phase 3 A2 (repeating to-dos and the deletion of their closed copies). Dated 2026-10-03; when it merges later, set
  // the date to its merge date on main. A1's entry below stays.
  { date: "2026-10-03", tag: "new", title: { ar: "المهام المتكررة في «مهامي»", en: "Repeating to-dos on My to-dos" }, desc: { ar: "صارت المهمة تتكرر: كل يوم أو يوم عمل أو أسبوع أو شهر أو سنة، بالتقويم الميلادي أو الهجري. تضبطها من «مهامي» أو تطلبها من ريم في الدردشة. وحين تنجز نسخة تُفتح النسخة التالية وحدها في موعدها التالي، وتقدر أن تتخطى نسخة واحدة أو توقف التكرار من الصفحة. النسخ المنجزة من مهمة متكررة تُحذف بعد مدة من إنجازها، بعد تنبيه في التطبيق وبالبريد، وتقدر أن تحتفظ بسجل المهمة أو تنزّله ملف CSV من صفحة سجلها. تضبط ريم التكرار حين تطلب منها، لكن التخطي والإيقاف وإنهاء التكرار لك وحدك.", en: "A to-do can now repeat: every day, working day, week, month or year, on the Gregorian or the Hijri calendar. Set it on My to-dos or ask Reem in chat. When you close one copy, the next opens by itself on the next date, and you can skip one copy or stop the repeat from the page. Closed copies of a repeating to-do are deleted some time after they close, after a warning in the app and by email, and you can keep a to-do's history or download it as a CSV from its history page. Reem sets a repeat when you ask her to, but skipping, stopping and ending a repeat are yours alone." } },
  // Reem phase 3 A1 (work calendar and away contacts). Dated 2026-10-03; when it merges later, set the date to its merge
  // date on main.
  { date: "2026-10-03", tag: "new", title: { ar: "ريم تعرف أيام العمل ومن هو غائب", en: "Reem knows your working days and who is away" }, desc: { ar: "لا تقترح ريم متابعة أحد من خارج الفريق في عطلة نهاية الأسبوع والعيدين والإجازات الرسمية لبلد علامتك، وفي رمضان لا تقترحها إلا في ساعات المتابعة: من 10:00 إلى 15:00 ما لم تغيّرها، ويظهر تحت المهمة سبب انتظارها. لوحة «أيام العمل» في «مهامي» يغيّر فيها المالك أو المشرف عطلة نهاية الأسبوع وساعات رمضان ويوم العيد والإجازات، ولوحة «الغائبون» يسجّل فيها أي عضو من هو غائب حتى يوم معيّن. وإن أخبرت ريم في الدردشة أن أحداً مسافر، تقترحه في بطاقة لا يُحفظ شيء منها حتى تضغط «احفظ». مهامك أنت وتذكيراتك لا تتوقف.", en: "Reem does not suggest following up with anyone outside the team on the weekend, at Eid or on your brand's country's official holidays, and in Ramadan only within the chasing hours, 10:00 to 15:00 unless you change them; the item says why it waits. On My to-dos, the Working days panel lets the owner or an admin change the weekend, the Ramadan hours, the Eid day and the holidays, and the Away panel lets any member note who is away until a day. Tell Reem in chat that someone is travelling and she proposes it on a card; nothing is saved until you press Save. Your own to-dos and reminders keep running." } },
  // pricing phase 2
  { date: "2026-10-01", tag: "new", title: { ar: "رصيد رسائل المحادثة الشهري", en: "Monthly chat messages" }, desc: { ar: `كل خطة تشمل الآن رسائل محادثة مع الفريق: البداية ${fc(M.starter)} والاحتراف ${fc(M.pro)} والأعمال ${fc(M.business)} شهرياً، تتجدد أول كل شهر (بتوقيت UTC)، و${fc(M.trial)} للتجربة كلها، والرسالة التي تعذّر ردها لا تُحسب. عند نفادها تتوقف الدردشة حتى أول الشهر (وفي التجربة حتى اختيار خطة)، إلا إن اختار المالك المتابعة بالكريدت من صفحة الاشتراك: كل رسالة إضافية تُحسب بكلفتها الفعلية، ${chatOverflowHold()} كريدت كحد أقصى، وتحتاج ${chatOverflowHold()} كريدت على الأقل في الرصيد. والمحتوى والصور التي تطلبها في الدردشة تُخصم كريدتها كما كانت.`, en: `Every plan now includes chat messages with the team: Starter ${fc(M.starter)}, Pro ${fc(M.pro)} and Business ${fc(M.business)} a month, renewed on the 1st (UTC), and ${fc(M.trial)} for the whole trial; a message that fails is not counted. When they run out, chat pauses until the 1st (on the trial, until a plan is chosen), unless the owner chooses to continue on credits on the Subscription page: each extra message is charged its real cost, at most ${chatOverflowHold()} credits, and needs at least ${chatOverflowHold()} credits in the balance. Content and images you ask for in chat are charged as before.` } },
  // agent-team step 3b, part O item 5
  { date: "2026-09-30", tag: "new", title: { ar: "تشغيل تلقائي اختياري للتسليمات", en: "Opt-in auto-run for handoffs" }, desc: { ar: "مفتاح جديد في الحوكمة، متوقف افتراضياً. إن فعّلته، وهو يحتاج حداً شهرياً لوكيل واحد على الأقل ممن يسلّمهم ماجد العمل وتأكيدك، قد يبدأ ذكين بنفسه بنداً واحداً في اليوم من تسليم اقترحه ماجد عليك خلال آخر 7 أيام، ويُخصم ضمن الحد الشهري لوكيل البند وضمن الحد الأسبوعي. ما يُكتب ينتظر موافقتك دائماً ويصلك تنبيه في كل مرة، ولا يبدأ تلقائياً ما طلبه عضو أو تطبيق متصل.", en: "A new Governance switch, off by default. If you turn it on, which needs a monthly cap on at least one agent Majed hands work to and your confirmation, Thakeen may start one item a day of a handoff Majed proposed to you in the last 7 days, charged under that item's agent cap and within the weekly cap. What it writes always waits for your approval and you are told each time; handoffs a member or a connected app asked for never start on their own." } },
  // agent-team step 3b, part O
  { date: "2026-09-30", tag: "new", title: { ar: "ماجد يقود الفريق بتسليمات", en: "Majed leads the team with handoffs" }, desc: { ar: "حين يحتاج هدفك عمل وكيل آخر، يقترح ماجد في الدردشة تسليماً من بند إلى ثلاثة: لكل بند الوكيل الذي سيكتبه وطلب ماجد وتكلفته. لا يُنفَّذ شيء ولا يُخصم كريدت حتى تضغط «نفّذ» (إلا إن فعّلت تشغيل ماجد التلقائي في الحوكمة)، ولك أن ترفض أي بند. ما يُكتب يصل إلى صندوق الموافقة وعليه علامة «من تسليم ماجد».", en: "When your goal needs another agent's work, Majed proposes a handoff of one to three items in chat: each with the agent who will write it, his brief and its cost. Nothing runs and no credits are charged until you press Run (unless you turn on Majed's auto-run in Governance), and you can decline any item. The work lands in the approval inbox marked \"from Majed's handoff\"." } },
  // agent-team step 3b, part R
  { date: "2026-09-30", tag: "new", title: { ar: "الوكلاء يراجعون عمل بعضهم", en: "Agents review one another" }, desc: { ar: "رزان تراجع الأرقام في خطط النمو والعروض والمذكرات الاستراتيجية، وماجد يراجع الاستراتيجية في مراجعات التسعير وخطط الدخول للسوق. ملاحظات فقط تظهر على بطاقة العنصر، والعنصر الذي عليه ملاحظة ينتظر قرارك حتى مع الاعتماد التلقائي. بلا كريدت، ويمكن إيقافها من الحوكمة.", en: "Razan checks the numbers in growth plans, decks and strategy memos, and Majed checks the strategy in pricing reviews and go-to-market plans. Notes only, shown on the item's card, and an item with a note waits for your decision even under auto-approve. No credits; you can switch it off in Governance." } },
  // Pricing phase 1 (docs/superpowers/plans/2026-09-29-pricing.md). Dated 2026-09-30; if #228 merges later, set the date
  // to its merge date on main.
  // #228
  { date: "2026-09-30", tag: "new", title: { ar: "خطط وأسعار جديدة، وعلامات بلا حد", en: "New plans and prices, and unlimited brands" }, desc: { ar: `البداية ${P.starter} والاحتراف ${P.pro} والأعمال ${P.business} ريال شهرياً غير شاملة الضريبة، والوكالات بعقد. العلامات بلا حد في كل الخطط: إعداد علامتك الأولى مجاني، وإعداد كل علامة إضافية من رابطها ${ONBOARD_EXTRA_BRAND_COST} كريدت، وخطة الأحد تعمل تلقائياً لعلامتك الأولى وتفعّلها للعلامات المضافة من «المهام». وارتفعت كلفة ثلاث مهام: خطة الأسبوع ${TASK_COST.weekly_plan} كريدت، والتقرير الأسبوعي ${TASK_COST.weekly_report}، وسلسلة المتابعة ${TASK_COST.followup_seq}.`, en: `Starter ${P.starter}, Pro ${P.pro} and Business ${P.business} SAR a month, excluding VAT, and Agency by contract. Unlimited brands on every plan: your first brand's setup is free, setting up each added brand from its URL is ${ONBOARD_EXTRA_BRAND_COST} credits, and the Sunday plan runs on its own for your first brand while added brands switch it on in Tasks. Three tasks now cost more: the weekly plan ${TASK_COST.weekly_plan} credits, the weekly report ${TASK_COST.weekly_report} and the follow-up cadence ${TASK_COST.followup_seq}.` } },
  // agent-team step 3, part L
  { date: "2026-09-29", tag: "new", title: { ar: "سجل نشاط لكل وكيل", en: "An activity log for every agent" }, desc: { ar: "صفحة «النشاط» تعرض ما فعله كل وكيل في علامتك: الدفعات، وتقييم الحَكَم، والقرارات، والنشر، والصور والفيديو، والمهام الدورية، وتغييرات الحوكمة، مع من قام بها ومتى. صفِّ حسب الوكيل أو الحدث، ونزّل السجل ملف CSV.", en: "The Activity page shows what each agent did in your brand: batches, judging, decisions, publishing, images and videos, routines and governance changes, with who did it and when. Filter by agent or event, and download the log as a CSV file." } },
  // agent-team step 3, part H
  { date: "2026-09-29", tag: "new", title: { ar: "سجل تغييرات الحوكمة مع الاسترجاع", en: "Governance change history with restore" }, desc: { ar: "صفحة الحوكمة تعرض آخر تغييرات إعداداتها: متى، ومن غيّرها، وما الذي تغيّر. واسترجع الإعدادات كما كانت قبل أي تغيير، ويُسجَّل الاسترجاع تغييراً جديداً.", en: "The Governance page lists the latest changes to its settings: when, who made each, and what changed. Restore the settings as they were before any change; the restore is recorded as a new change." } },
  // #217
  { date: "2026-09-29", tag: "new", title: { ar: "مهام دورية لمزيد من الوكلاء", en: "Recurring routines for more agents" }, desc: { ar: "فعّل ما تريد منها: تقرير دانة الأسبوعي، ورسائل نور لاسترجاع السلات المتروكة، وتوقع رزان النقدي الشهري، ومراجعة ماجد الشهرية.", en: "Turn on the ones you want: Dana's weekly report, Noor's cart-recovery messages, Razan's monthly cash forecast and Majed's monthly review." } },
  { date: "2026-09-29", tag: "new", title: { ar: "سقف كريدت شهري لكل وكيل", en: "A monthly credit cap per agent" }, desc: { ar: "حدّد من صفحة الحوكمة كم يصرف كل وكيل في الشهر، ويصلك تنبيه عند 80%.", en: "Set in Governance how much each agent may spend a month, with a notice at 80%." } },
  { date: "2026-09-29", tag: "improved", title: { ar: "الوكلاء يتعلمون من قراراتك", en: "Agents learn from your decisions" }, desc: { ar: "كل وكيل يرى اعتماداتك وتعديلاتك وملاحظاتك الأخيرة على عمله قبل أن يكتب الدفعة التالية، ويمكنك إيقاف ذلك من الحوكمة.", en: "Each agent sees your recent approvals, edits and notes on its own work before it drafts the next batch. You can switch this off in Governance." } },
  // #216
  { date: "2026-09-29", tag: "fixed", title: { ar: "الرابط المشارك لا يبني مساحتك وحده", en: "A shared link no longer sets up your workspace" }, desc: { ar: "إذا فتحت رابط تسجيل يحمل عنوان موقع، تؤكد الموقع بنفسك أولاً قبل أن يُبنى ملف علامتك.", en: "When a signup link carries a site address, you confirm the site yourself before your brand file is built." } },
  // #214
  { date: "2026-09-29", tag: "improved", title: { ar: "مراجع لكل وكيل، وهدفك في كل مهمة", en: "A reviewer for every agent, and your goal in every task" }, desc: { ar: "مسودات كل وكيل يراجعها مراجع يعرف دوره، وهدفك من التهيئة يصل إلى كل الوكلاء.", en: "Each agent's drafts are checked by a reviewer that knows its role, and the goal you set at onboarding reaches every agent." } },
  // #206
  { date: "2026-09-28", tag: "new", title: { ar: "حارس كلمات العلامة", en: "Brand word guard" }, desc: { ar: "الكلمات التي تمنعها في ملف علامتك تمنع اعتماد ونشر أي مسودة تحتويها، والمحرر ينبّهك وأنت تكتب.", en: "Words you ban in your brand file now block approving and publishing any draft that contains them, and the editor flags them as you type." } },
  { date: "2026-09-28", tag: "new", title: { ar: "رحلة الإطلاق في صفحة البداية", en: "A launch journey on the start page" }, desc: { ar: "سبع محطات تتقدم فيها من ملف العلامة إلى أول نشر، مقروءة من حالة مساحتك.", en: "Seven milestones from your brand file to your first publish, read from the state of your workspace." } },
  // #203
  { date: "2026-09-28", tag: "new", title: { ar: "النشر على فيسبوك وإنستقرام", en: "Publish to Facebook and Instagram" }, desc: { ar: "انشر المنشورات المعتمدة على صفحتك في فيسبوك وحساب إنستقرام الاحترافي المربوط بها.", en: "Publish approved posts to your Facebook Page and the Instagram business account linked to it." } },
  // #205
  { date: "2026-09-28", tag: "new", title: { ar: "ربط متجر زد", en: "Zid store connection" }, desc: { ar: "اربط متجرك في زد لاستيراد المنتجات، وقراءة الطلبات والسلات المتروكة في التقارير.", en: "Connect your Zid store to import products and read orders and abandoned carts in Reports." } },
  // #200, #201
  { date: "2026-09-28", tag: "new", title: { ar: "مبيعات متجرك في التقارير", en: "Your store's sales in Reports" }, desc: { ar: "طلبات سلة وشوبيفاي وسلاتهما المتروكة تظهر كمجاميع في التقارير وفي ذاكرة نور.", en: "Orders and abandoned carts from Salla and Shopify show as totals in Reports and in Noor's memory." } },
  // #202
  { date: "2026-09-28", tag: "new", title: { ar: "استرجاع السلات من سلاتك الحقيقية", en: "Cart recovery from your real abandoned carts" }, desc: { ar: "مسودات رسائل الاسترجاع تُبنى على السلات المتروكة الفعلية في متجرك.", en: "Cart-recovery drafts are built on the abandoned carts actually in your store." } },
  // #211
  { date: "2026-09-28", tag: "new", title: { ar: "نتائج إعلانات Meta وسناب شات", en: "Results from Meta Ads and Snapchat Ads" }, desc: { ar: "اربط حسابك الإعلاني لتقرأ التقارير نتائج حملاتك.", en: "Connect your ad account and Reports reads your campaign results." } },
  // #208
  { date: "2026-09-28", tag: "new", title: { ar: "استيراد نتائج الحملات من ملف CSV", en: "Import campaign results from a CSV file" }, desc: { ar: "صدّر النتائج من منصة الإعلانات وارفعها، لتبني نور اقتراحاتها التالية عليها.", en: "Export results from your ad platform and upload them, so Noor builds her next suggestions on them." } },
  // #212
  { date: "2026-09-28", tag: "new", title: { ar: "رموز الإعلانات", en: "Ad codes" }, desc: { ar: "كل مسودة إعلان أو منشور تحمل رمزاً قصيراً. ضعه في اسم الإعلان لترى أداء إعلاناتك منّا مقارنة ببقية إعلاناتك.", en: "Every ad or social draft carries a short code. Put it in the ad's name to see how those ads did against your other ads." } },
  // #209
  { date: "2026-09-28", tag: "fixed", title: { ar: "تنبيه المبيعات في التقارير", en: "Sales notice in Reports" }, desc: { ar: "التقارير لم تعد تقول إن مبيعاتك غير مقروءة حين يكون متجرك متزامناً.", en: "Reports no longer say your sales are not read when your store is synced." } },
  // #199
  { date: "2026-09-27", tag: "new", title: { ar: "استيراد منتجات سلة", en: "Import products from Salla" }, desc: { ar: "اربط متجرك في سلة لاستيراد منتجاتك، مع اسم المتجر الذي رُبط.", en: "Connect your Salla store to import your products, and see which store is connected." } },
  // #197
  { date: "2026-09-27", tag: "improved", title: { ar: "ربط أكثر أماناً للمنصات", en: "Safer platform connections" }, desc: { ar: "خطوات ربط حساباتك على المنصات أصبحت محمية من الطلبات المزوّرة.", en: "The steps that connect your platform accounts are now protected against forged requests." } },
  // #2
  { date: "2026-09-21", tag: "fixed", title: { ar: "رسالة استعادة كلمة المرور", en: "Password reset message" }, desc: { ar: "إذا تعذّر إرسال بريد الاستعادة، تخبرك الصفحة بذلك بدل أن تعدك برابط لن يصل.", en: "If the reset email cannot be sent, the page tells you instead of promising a link that will not arrive." } },
  // e1445d6
  { date: "2026-09-18", tag: "improved", title: { ar: "تغيير كلمة المرور يخرج بقية الأجهزة", en: "Changing your password signs out other devices" }, desc: { ar: "وصارت التطبيقات المتصلة بحسابك تظهر في صفحة MCP ويمكنك إلغاؤها.", en: "Apps connected to your account are also listed on the MCP page, where you can revoke them." } },
  // 7835949
  { date: "2026-09-18", tag: "improved", title: { ar: "اعتماد ورفض فوري", en: "Instant approve and reject" }, desc: { ar: "صندوق الموافقات يستجيب لحظة الضغط دون إعادة تحميل الصفحة.", en: "The approvals inbox responds the moment you tap, without reloading the page." } },
];

/**
 * Seeded wishes, in the order of the source table. Ids are stable: votes are stored under them.
 * Promoted suggestions are added by the founder console and stored in Redis (wishlist.ts).
 */
export const SEED_WISHES: readonly SeedWish[] = [
  { id: "custom-agent", area: "agents", title: { ar: "ابنِ وكيلاً مخصصاً لعملك", en: "Build your own custom agent" } },
  { id: "secretary-agent", area: "agents", title: { ar: "وكيل سكرتير يتابع مهامك ويذكّرك بها", en: "A secretary agent that tracks your to-dos and follows up" } },
  { id: "timed-reminders", area: "agents", title: { ar: "تذكيرات في وقتها على واتساب أو تيليجرام", en: "Reminders on time, by WhatsApp or Telegram" } },
  { id: "calendar-sync", area: "integrations", title: { ar: "مزامنة مع تقويم Google أو Outlook", en: "Sync with Google or Outlook Calendar" } },
  { id: "free-check", area: "onboarding", title: { ar: "تقييم مجاني لتسويقك قبل التسجيل", en: "A free marketing check before you sign up" } },
  { id: "store-link-start", area: "onboarding", title: { ar: "ابدأ برابط متجرك في سلة أو زد", en: "Start from your Salla or Zid store link" } },
  { id: "product-images", area: "content", title: { ar: "صور منتجات وتصاميم", en: "Product images and designs" } },
  { id: "background-removal", area: "content", title: { ar: "إزالة الخلفية ودمج الصور", en: "Background removal and image blending" } },
  { id: "short-video", area: "content", title: { ar: "فيديو قصير بأسلوب صنّاع المحتوى", en: "Short creator-style videos" } },
  { id: "dialect-voice-ads", area: "content", title: { ar: "إعلانات صوتية باللهجة", en: "Voice ads in local dialects" } },
  { id: "landing-pages", area: "content", title: { ar: "صفحات هبوط", en: "Landing pages" } },
  { id: "bulk-product-copy", area: "commerce", title: { ar: "أوصاف منتجات بالجملة لسلة وزد", en: "Bulk product descriptions for Salla and Zid" } },
  { id: "post-to-ad", area: "ads", title: { ar: "تحويل منشور إلى إعلان", en: "Turn a post into an ad" } },
  { id: "publish-linkedin", area: "channels", title: { ar: "النشر على LinkedIn", en: "Publish to LinkedIn" } },
  { id: "publish-tiktok", area: "channels", title: { ar: "النشر على تيك توك", en: "Publish to TikTok" } },
  { id: "publish-snapchat", area: "channels", title: { ar: "النشر على سناب شات", en: "Publish to Snapchat" } },
  { id: "whatsapp-send", area: "channels", title: { ar: "إرسال رسائل واتساب", en: "Send WhatsApp messages" } },
  { id: "salla-app", area: "commerce", title: { ar: "تطبيق ذكين في متجر تطبيقات سلة", en: "Thakeen in the Salla App Store" } },
  { id: "zid-app", area: "commerce", title: { ar: "تطبيق ذكين في سوق تطبيقات زد", en: "Thakeen in the Zid App Market" } },
  { id: "meta-campaigns", area: "ads", title: { ar: "إطلاق حملات Meta", en: "Launch Meta ad campaigns" } },
  { id: "more-campaigns", area: "ads", title: { ar: "إطلاق حملات تيك توك وسناب شات وجوجل", en: "Launch TikTok, Snapchat and Google campaigns" } },
  { id: "budget-limits", area: "ads", title: { ar: "ضبط ميزانية الإعلانات ضمن حدود تضعها", en: "Ad budgets kept within limits you set" } },
  { id: "ad-waste-audit", area: "ads", title: { ar: "تدقيق أسبوعي لهدر الإعلانات", en: "A weekly ad waste audit" } },
  { id: "ga4-search-console", area: "reports", title: { ar: "قراءة Google Analytics وSearch Console", en: "Read Google Analytics and Search Console" } },
  { id: "competitor-watch", area: "reports", title: { ar: "رصد المنافسين باستمرار", en: "Ongoing competitor monitoring" } },
  { id: "ai-search-visibility", area: "reports", title: { ar: "تتبع ظهورك في إجابات مساعدات الذكاء الاصطناعي", en: "Track how you show up in AI assistant answers" } },
  { id: "team-seats", area: "team", title: { ar: "مقاعد وأدوار للفريق", en: "Team seats and roles" } },
  { id: "client-branded-reports", area: "team", title: { ar: "تقارير بعلامة عميلك", en: "Reports under your client's brand" } },
  { id: "shared-workspace", area: "team", title: { ar: "مساحة عمل مشتركة للفريق", en: "A shared workspace for your team" } },
  { id: "credit-top-up", area: "billing", title: { ar: "شحن رصيد كريدت إضافي", en: "Top up extra credits" } },
  { id: "claude-directory", area: "integrations", title: { ar: "ذكين في دليل موصّلات Claude", en: "Thakeen in the Claude connector directory" } },
  { id: "chatgpt-app", area: "integrations", title: { ar: "تطبيق ذكين في دليل تطبيقات ChatGPT", en: "A Thakeen app in the ChatGPT app directory" } },
  { id: "chat-control", area: "integrations", title: { ar: "كلّم وكلاءك من واتساب أو تيليجرام", en: "Talk to your agents from WhatsApp or Telegram" } },
  { id: "mobile-app", area: "app", title: { ar: "تطبيق جوال", en: "A mobile app" } },
];

export const SEED_WISH_IDS: ReadonlySet<string> = new Set(SEED_WISHES.map((w) => w.id));

/** Suggestion text limits: short enough to read in a list, long enough for one idea. */
export const SUGGESTION_MIN = 5;
export const SUGGESTION_MAX = 280;
export const TITLE_MAX = 120;

type Copy = {
  eyebrow: string; title: string; sub: string; tabNew: string; tabWish: string;
  newTitle: string; newSub: string; wishTitle: string; wishSub: string;
  tags: Record<ChangeTag, string>; statuses: Record<WishStatus, string>; areas: Record<WishArea, string>;
  vote: string; voted: string; votesLabel: string; signIn: string; signInNote: string; failed: string; slowDown: string;
  suggestTitle: string; suggestSub: string; suggestPlaceholder: string; suggestSend: string; suggestSent: string; suggestPrivate: string; suggestSlowDown: string; signInSuggest: string; tooShort: string; tooLong: string;
  empty: string;
};

export const UPDATES: Record<Lang, Copy> = {
  ar: {
    eyebrow: "التحديثات والأمنيات", title: "ما أطلقناه، وما نبنيه بعده", sub: "سجل بما وصل إلى المنتج فعلاً، وقائمة أمنيات تصوّت عليها لتحدد ما نبنيه أولاً.",
    tabNew: "ما الجديد", tabWish: "قائمة الأمنيات",
    newTitle: "ما الجديد", newSub: "كل بند هنا وصل إلى المنتج في التاريخ المذكور.",
    wishTitle: "قائمة الأمنيات", wishSub: "صوّت لما تريده أولاً. صوت واحد لكل حساب في كل أمنية، ويمكنك سحبه.",
    tags: { new: "جديد", improved: "تحسين", fixed: "إصلاح" },
    statuses: { planned: "مخطط", in_progress: "قيد العمل", shipped: "أُطلق" },
    areas: { agents: "الوكلاء", onboarding: "البداية", content: "المحتوى", channels: "القنوات", commerce: "التجارة", ads: "الإعلانات", reports: "التقارير", team: "الفرق", billing: "الفوترة", integrations: "التكاملات", app: "التطبيق" },
    vote: "صوّت", voted: "صوّتَّ", votesLabel: "صوت", signIn: "سجّل الدخول للتصويت", signInNote: "التصويت واقتراح الأمنيات لأصحاب الحسابات.", failed: "تعذّر حفظ صوتك. حاول مرة أخرى.", slowDown: "أصوات كثيرة في وقت قصير. حاول بعد قليل.",
    suggestTitle: "اقترح أمنية", suggestSub: "فكرة واحدة في سطر أو سطرين.", suggestPlaceholder: "مثال: جدولة المنشورات حسب أوقات الصلاة", suggestSend: "أرسل الاقتراح", suggestSent: "وصلنا اقتراحك. نراجعه قبل أن يظهر في القائمة.", suggestPrivate: "الاقتراحات لا تُنشر مباشرة: نراجعها ونضيف ما يناسب إلى القائمة.", suggestSlowDown: "وصلت إلى حد الاقتراحات اليومي. عد غداً.", signInSuggest: "سجّل الدخول لتقترح", tooShort: "اكتب فكرتك بكلمات أكثر قليلاً.", tooLong: "الاقتراح أطول من المسموح.",
    empty: "لا شيء هنا بعد.",
  },
  en: {
    eyebrow: "Updates & wishlist", title: "What we shipped, and what we build next", sub: "A log of what actually reached the product, and a wishlist you vote on to decide what we build first.",
    tabNew: "What's new", tabWish: "Wishlist",
    newTitle: "What's new", newSub: "Every entry here reached the product on the date shown.",
    wishTitle: "Wishlist", wishSub: "Vote for what you want first. One vote per account per wish, and you can take it back.",
    tags: { new: "New", improved: "Improved", fixed: "Fixed" },
    statuses: { planned: "Planned", in_progress: "In progress", shipped: "Shipped" },
    areas: { agents: "Agents", onboarding: "Getting started", content: "Content", channels: "Channels", commerce: "Commerce", ads: "Ads", reports: "Reports", team: "Teams", billing: "Billing", integrations: "Integrations", app: "App" },
    vote: "Vote", voted: "Voted", votesLabel: "votes", signIn: "Sign in to vote", signInNote: "Voting and suggesting wishes are for account holders.", failed: "Could not save your vote. Please try again.", slowDown: "Too many votes in a short time. Try again shortly.",
    suggestTitle: "Suggest a wish", suggestSub: "One idea in a line or two.", suggestPlaceholder: "For example: schedule posts around prayer times", suggestSend: "Send suggestion", suggestSent: "Thanks, we got it. We review suggestions before they appear in the list.", suggestPrivate: "Suggestions are not published directly: we review them and add what fits to the list.", suggestSlowDown: "You reached today's limit for suggestions. Come back tomorrow.", signInSuggest: "Sign in to suggest", tooShort: "Write your idea in a few more words.", tooLong: "The suggestion is longer than allowed.",
    empty: "Nothing here yet.",
  },
};
