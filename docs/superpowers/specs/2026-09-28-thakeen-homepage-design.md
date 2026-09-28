# Thakeen homepage: design spec

Date: 2026-09-28 · Status: awaiting founder review · Branch: `claude/nahr-opus-homepage-a8cf3d`

## 1. Goal

Replace the current homepage (`src/app/[lang]/page.tsx`) with an interactive, emotional experience that makes a Gulf business owner feel one thing: the questions that spin in my head every day now have a team that solves them. The visitor must leave remembering the **value** each agent brings, then the agent's **name**, then the **questions** they take off the owner's head.

"Nashr" stays the code name (repo, Redis keys, env vars, docs). The public name is **Thakeen · ذكين** (alternative spelling Zakeen · زكين, founder to choose, see §10). The page never names the underlying AI model.

## 2. Approved line

> **ذكين. الذكي المكين.**
> **أسئلة كثيرة تدور في راسك كل يوم… وذكين يحلها.**

English: *Thakeen. Smart. Steadfast.* / *So many questions spin in your head every day… Thakeen solves them.*

## 3. Concept

References chosen by the founder and what we take from each (structure and mechanics, never their assets or text):

| Reference | What we take |
|---|---|
| becaneparis.com | Real people standing full-body in a row on a clean ground; personality from posture and styling; a figure comes alive on hover. |
| dontlookup.app | A living crowd: figures shift, wander a step, talk in small speech bubbles; wit instead of explanation; the page is playable. |
| benxrun.com | Chapters named by meaning, not departments (we use the owner's questions instead of verbs). |
| thejacketcirclegame.maxmara.com | A "dictionary" of words the visitor picks from, a stepped game with a visible counter (0/5). |

**Story.** At the top, the visitor sees the owner (a standing figure) with a storm of questions spinning above their head, which is "تدور في راسك" made literal. Scrolling, the seven agents step in one by one; each pulls its own questions off the owner's head, and they start spinning calmly above the agent instead. At the end one word stays fixed above the owner: **«موافق.»**

**Hierarchy per agent (founder's rule):** 1) value line, largest; 2) name; 3) rotating questions above the head, flipping continuously, each one showing a different task the agent really does.

**Colour layer.** Each agent owns a colour world (psychology used as a silent visual layer, never as a label). The page repaints in that world during the agent's chapter.

| Agent | Colour | Meaning used for art direction |
|---|---|---|
| Noor | `#f9f871` lemon | attention, optimism |
| Sami | `#ff5da2` rose | warmth, relationship |
| Razan | `#00d9ff` cyan | clarity, trust |
| Faris | `#b517ff` violet | ambition, imagination |
| Dana | pearl (new token, proposal `#efe7f7`) | clarity, honesty |
| Majed | `#2b193d` plum with gold accents | depth, judgement |
| Layan | mint (new token, proposal `#7fe9ff`) | care, renewal |

Colour never carries meaning alone: every state also has text.

## 4. Page structure (top to bottom)

1. **Nav**: wordmark ذكين, language switch, "ابدأ · Start".
2. **Story (sticky scroll)**: hero with the question storm → seven agent chapters → finale «موافق.».
3. **The team lineup**: all eight figures standing in a row (Bécane layout). Hover or focus a figure: it turns to camera, its value line and rotating questions show, and a banter bubble plays (§5.3).
4. **قاموس ذكين (the game)**: §6.
5. **What's true today**: four facts (starts from your website; everything waits for your yes; weekly plan Sunday morning and a brief daily at 08:00; Arabic first, Gulf seasons and channels).
6. **Pricing, FAQ, Footer**: existing components (`Pricing`, `Faq`, `Footer`), restyled to the new tokens in a later pass.

Removed from the homepage (components stay in the codebase for other pages or deletion later): `Agents`, `Highlights`, `Teammate`, `OldWay`, `Runs`, `Deliverables`, `Pillars`, `Industries`, `Integrations`, `Calendar`, `Cta`. Founder confirms in review (§10).

## 5. Copy

All copy lives in a new typed module `src/lib/home.ts` (`{ ar, en }` per string, same pattern as `src/lib/site.ts`), so `tests/content-claims.test.ts` sweeps it.

### 5.1 Hero and finale

| | Arabic | English |
|---|---|---|
| Line 1 | ذكين. الذكي المكين. | Thakeen. Smart. Steadfast. |
| Line 2 | أسئلة كثيرة تدور في راسك كل يوم… وذكين يحلها. | So many questions spin in your head every day… Thakeen solves them. |
| Scroll cue | مرّر | Scroll |
| Finale above owner | موافق. | Approved. |
| Finale line | هم يشتغلون. وأنت توافق. | They do the work. You approve. |
| Finale CTA | ابدأ بموقعك | Start with your website |

### 5.2 Agents (approved)

Each question is tied to a task type that exists in `src/lib/agents.ts` / `TASK_COST` in `src/lib/brand.ts`; the test in §8 enforces it.

**Noor · نور**, value: **محتوى أسبوعك جاهز، بصوت علامتك.** / *Your week of content, ready, in your voice.*

| Question (AR) | English | Task |
|---|---|---|
| وش أنزّل اليوم؟ | What do I post today? | `social` |
| وش أرسل للعملاء بالواتساب؟ | What do I send customers on WhatsApp? | `whatsapp` |
| كيف أرجّع اللي ترك السلة؟ | How do I bring back abandoned carts? | `cart_recovery` |
| رمضان قرّب… وش نقول؟ | Ramadan is close… what do we say? | `weekly_plan` |
| إعلان سناب ولا تيك توك؟ | Snapchat ad or TikTok? | `ads` |
| وش أكتب في قوقل ماب؟ | What do I write on Google Maps? | `gbp` |

**Sami · سامي**, value: **رد جاهز لكل عميل، ومتابعة ما تنسى أحد.** / *A reply for every lead, a follow-up that forgets no one.*

| Question (AR) | English | Task |
|---|---|---|
| كيف أرد على هالعميل؟ | How do I answer this customer? | `sales_script` |
| هذا جاد ولا يسأل وبس؟ | Serious buyer or just asking? | `lead_qualifier` |
| كم مرة أتابعه بدون ما أزعجه؟ | How often can I follow up without annoying them? | `followup_seq` |
| وش أقول لما يقول: غالي؟ | What do I say when they say "too expensive"? | `sales_script` |
| وش أكتب في العرض؟ | What goes in the proposal? | `sales_script` |

**Razan · رزان**, value: **أرقامك واضحة قبل ما تصرف.** / *Your numbers, clear before you spend.*

| Question (AR) | English | Task |
|---|---|---|
| يستاهل الصرف؟ | Is it worth the spend? | `unit_economics` |
| سعري صح؟ | Is my price right? | `pricing_review` |
| كم يكلفني العميل الواحد؟ | What does one customer cost me? | `unit_economics` |
| الكاش يكفي لآخر الشهر؟ | Will cash last to the end of the month? | `cash_forecast` |
| هالخصم يربّح ولا يخسّر؟ | Does this discount make or lose money? | `pricing_review` |

**Faris · فارس**, value: **خطة نمو ٩٠ يوم، وتجارب صغيرة قبل الصرف الكبير.** / *A 90-day growth plan, small tests before big spending.*

| Question (AR) | English | Task |
|---|---|---|
| وين نكبر بعدها؟ | Where do we grow next? | `gtm_plan` |
| نفتح سوق جديد؟ | Do we open a new market? | `gtm_plan` |
| أي قناة تستاهل؟ | Which channel is worth it? | `growth_experiments` |
| وش نجرّب هالأسبوع؟ | What do we test this week? | `growth_experiments` |
| كيف العميل يجيب عميل؟ | How does one customer bring another? | `retention_play` |
| العيد جاي… وش خطتنا؟ | Eid is coming… what's our plan? | `gtm_plan` |

**Dana · دانة**, value: **تقرير أسبوعك من أرقامك، بدون تجميل.** / *Your weekly report, from your numbers, no makeup.*

| Question (AR) | English | Task |
|---|---|---|
| طيب… نفع ولا لا؟ | So… did it work? | `weekly_report` |
| وش صار هالأسبوع؟ | What happened this week? | `weekly_report` |
| أي رقم أراقب؟ | Which number do I watch? | `dashboard_spec` |
| وش أعرض على الشريك؟ | What do I show my partner? | `board_deck` |

**Majed · ماجد**, value: **قرار واضح، في صفحة وحدة.** / *A clear decision, on one page.*

| Question (AR) | English | Task |
|---|---|---|
| وش القرار؟ | What's the call? | `decision_memo` |
| وش أولوياتي هالربع؟ | What are my priorities this quarter? | `okrs` |
| أوظّف ولا أنتظر؟ | Hire now or wait? | `decision_memo` |
| نكمل ولا نوقف؟ | Keep going or stop? | `strategy_review` |
| وش الأهم هالأسبوع؟ | What matters most this week? | `strategy_review` |

**Layan · ليان**, value: **تعرف وش يبي عميلك، وليش يرجع.** / *Know what your customer wants, and why they come back.*

| Question (AR) | English | Task |
|---|---|---|
| ليش ما رجع العميل؟ | Why didn't the customer come back? | `feedback_synthesis` |
| وش يقولون عنا؟ | What are people saying about us? | `feedback_synthesis` |
| وش نطلق بعدها؟ | What do we launch next? | `roadmap` |
| كيف أول تجربة تصير أحلى؟ | How do we make the first experience better? | `onboarding_flow` |
| وش الميزة اللي يطلبونها؟ | Which feature are they asking for? | `prd` |

**You · أنت**, value: **أنت توافق.** / *You approve.* The hero storm uses all 36 agent questions; the finale shows only «موافق.».

### 5.3 Team banter (speech bubbles, lineup and chapters)

Each exchange teaches one real product rule without explaining it.

| Exchange (AR) | English | Rule it teaches |
|---|---|---|
| فارس: «نفتح سوق الكويت؟» · رزان: «نفتحه… بعد ما أزنها.» | Faris: "Open Kuwait?" · Razan: "We will… once I've weighed it." | finance checks growth |
| نور: «لقيت ترند!» · دانة: «كم وصل؟» · نور: «…بدأ أمس.» · دانة: «أجل ما نكتب رقم.» | Noor: "Found a trend!" · Dana: "How big?" · Noor: "…it started yesterday." · Dana: "Then we don't write a number." | no invented numbers |
| ليان: «ثلاث عملاء قالوا نفس الملاحظة.» · نور: «أجل هذا بوست الأسبوع.» | Layan: "Three customers said the same thing." · Noor: "Then that's this week's post." | shared memory across agents |
| سامي: «العميل يسأل عن الخصم.» · ماجد: «هذي ما نحسمها. صاحب الشغل يوافق.» | Sami: "The customer wants a discount." · Majed: "Not ours to decide. The owner approves." | owner approval |

## 6. قاموس ذكين (the game)

Title: **قاموس ذكين** / *The Thakeen Dictionary*. Subtitle: «سبع خطوات، من اسم علامتك لأول نتيجة.» / *Seven steps, from your brand's name to its first result.* A counter shows the step (1/7 … 7/7).

| # | Step | What happens | Interactive? |
|---|---|---|---|
| 1 | براندك · Your brand | Type the brand name, pick a sector (قهوة، مطعم، عيادة، متجر إلكتروني، خدمات). No crawl, no network call. Noor: «حلو الاسم. خلّني أعرفكم.» | yes |
| 2 | كلماتك · Your words | Pick 5 of 12 words (0/5): جريء، دافي، راقي، شعبي، هادي، فاخر، مرح، محلي، سريع، صادق، عائلي، شبابي. Each pick triggers one agent's reaction bubble (e.g. فاخر → رزان: «والسعر يشبهه؟»؛ صادق → دانة: «هذي كلمتي.»). | yes |
| 3 | خطة · Plan | Faris and Majed show a three-line sample week built from the words. Labelled «مثال». | yes |
| 4 | مسودة · Draft | Noor shows a sample post; Sami a sample WhatsApp reply. Pre-written variants selected by the words; no model call. Labelled «مثال». | yes |
| 5 | موافقتك · Your approval | One large button «موافق». Microcopy: «ولا شي ينتشر قبل هالضغطة.» / *Nothing goes out before this tap.* | yes |
| 6 | تحليل · Analysis | Preview card (Dana): what happens next week, from the owner's own numbers. | preview only |
| 7 | قياس · Measurement | Preview card: «نقيس من المصادر اللي تربطها: نتائج إعلانات ميتا وسناب، ومبيعات سلة وشوبيفاي وزد، أو ملف CSV.» | preview only |

Steps 6–7 are previews on purpose: analysis and measurement need real time and real data, and faking them in a demo would break the honesty rule. The game ends with the CTA «جرّبها على موقعك» into the real onboarding (§7.4). Game state is local to the page; nothing is stored or sent.

## 7. Production and technical design

### 7.1 Figures (the people)

- **Recommended: a real photoshoot.** Eight people (seven agents plus the owner), full body on a seamless background. Per person: a still turnaround of 8 angles plus three short loops (idle weight shift, turn to camera, one signature gesture). Styling is modern Gulf, one accent per agent in its colour world. Casting follows the names: Noor, Razan, Dana, Layan women; Sami, Faris, Majed men; the owner neutral. Wardrobe and casting are the founder's call.
- Delivery: transparent video loops, WebM VP9 with alpha plus HEVC with alpha for Safari, at most about 600 KB per loop, with an AVIF poster frame.
- Development uses placeholder figures (flat silhouettes in the agent colours) so the build does not wait for the shoot.
- **Disclosure:** the lineup carries a small, permanent label «وكلاء ذكاء اصطناعي · AI agents», so nobody reads the figures as human staff.
- AI-generated people are the fallback only, not the plan: consistent identity across 24 loops is unreliable and uncanny faces would undo the emotion.

### 7.2 Typography

- Custom-drawn wordmark for ذكين (and Zakeen if chosen).
- One licensed Arabic family with a display cut, plus one Latin editorial serif and one Latin grotesk. Shortlist to specimen: 29LT (29Letters) Arabic display families, TPTQ Arabic families, and Thmanyah's released faces if their licence allows commercial web use. No El Messiri or Cormorant.
- Gate: a specimen page with three pairings, set in the approved copy, is reviewed before any build uses them. Until licences arrive, the build uses the system stack.

### 7.3 Motion and interaction

- **Engine:** GSAP with ScrollTrigger (standard licence, free) for the scroll choreography; DOM and CSS for text; `<video>` for the figures. three.js is not needed for v1; revisit only if the question storm cannot reach the look in DOM.
- **Question storm (hero):** up to 36 questions orbit and flip above the owner's head, overlapping and fast. On scroll, each agent's set peels off and flies to its head.
- **Rotating questions per agent:** one visible at a time, flipping every 2.4 s, staggered across agents so they never flip together; paused on hover or focus.
- **Life:** idle loops play; every 6–10 s one banter exchange from §5.3 plays in bubbles; a figure turns to the cursor on hover.
- **Reduced motion:** no storm, no flipping (the first question shows), no wandering, loops replaced by poster frames; scroll still steps chapter by chapter.

### 7.4 Integration with the app

- Route stays `src/app/[lang]/page.tsx`; new client components under `src/components/home/` (for example `Story.tsx`, `Lineup.tsx`, `Figure.tsx`, `QuestionFlip.tsx`, `Dictionary.tsx`).
- Copy in `src/lib/home.ts`, typed per language.
- The CTA reuses the current hero flow: `/{lang}/app/signup?next=/{lang}/app/start?url=…` (same as `HeroUrl` in `src/components/Landing.tsx`).
- Arabic is the default route; the lineup and all layout mirror in RTL.
- New dependency: `gsap`. Follow the lockfile rule in `CLAUDE.md` (regenerate `package-lock.json` in an empty directory, check the `@rolldown/binding-linux-*` entries).

### 7.5 Budgets

- LCP under 2.5 s on a mid-range phone over 4G; the first paint shows the slogan and poster frames without waiting for video.
- Added JavaScript under 90 KB gzipped; videos lazy-load per chapter; initial transfer under 1.5 MB.
- No network calls from the game.

### 7.6 Accessibility

- Rotating questions sit in an `aria-hidden` layer; each figure exposes value, name and its first question as static text.
- Figures are focusable buttons; the game is fully keyboard-operable with visible focus.
- Contrast meets WCAG AA in every colour world.

## 8. Tests

- `tests/home-copy.test.ts` (new): every agent has a value line, a name and at least four questions in both languages, with equal counts; every question's task exists in `TASK_COST`; the hero storm equals the union of agent questions.
- `tests/content-claims.test.ts` passes over the new copy (no invented numbers, customers or result promises).
- Playwright: the homepage renders the slogan and eight figures in both languages; the game runs steps 1–5 with no `/api/*` request; the CTA lands on signup with the URL carried; reduced motion shows static questions. Update the home markers in `e2e/fixtures/routes.ts`.
- Add the new rules to `docs/system/tests.md`.

## 9. Launch dependencies (outside this page)

1. Claude is paused (`CLAUDE_PAUSED = true` in `src/lib/model.ts`). The CTA leads into onboarding, which refuses while paused; it must be switched back on before launch.
2. A site-wide rename from نشر to ذكين (nav, footer, metadata, emails, other pages) is a separate task. Launching this page alone would show two names.
3. Photoshoot and type licences (§7.1, §7.2).

## 10. Founder decisions still open

1. Spelling: Thakeen · ذكين or Zakeen · زكين.
2. Figures: photoshoot (recommended) or AI-generated; budget and casting.
3. Type: approve the specimen shortlist and licence cost.
4. Ground colour: light pearl ground with plum type (recommended; human photography reads better on light, and the colour worlds wash over it) or a dark plum ground.
5. Confirm the removal of the old homepage sections listed in §4.

## 11. Out of scope

- The "Our story" page (the Dhow Crew concept, النوخذة), which comes after the homepage.
- Restyling Pricing, FAQ and the other pages to the new tokens.
- The site-wide rename (§9.2).
