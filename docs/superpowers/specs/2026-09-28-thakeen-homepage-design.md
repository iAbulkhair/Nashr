# Thakeen homepage: design spec

Date: 2026-09-28 · Status: approved by the founder on 2026-09-28 (decisions in §10) · Branch: `claude/nahr-opus-homepage-a8cf3d`

## 1. Goal

Replace the current homepage (`src/app/[lang]/page.tsx`) with an interactive, emotional experience that makes a Gulf business owner feel one thing: the questions that spin in my head every day now have a team that solves them. The visitor must leave remembering the **value** each agent brings, then the agent's **name**, then the **questions** they take off the owner's head.

"Nashr" stays the code name (repo, Redis keys, env vars, docs). The public name is **Thakeen · ذكين** (decided 2026-09-28; Zakeen was dropped). The page never names the underlying AI model.

## 2. Approved line

> **ذكين. الذكي المكين.**
> **أسئلة كثيرة تدور في راسك كل يوم… وذكين يحلها.**

English: *Thakeen. Smart. Steadfast.* / *So many questions spin in your head every day… Thakeen solves them.*

## 3. Concept

References chosen by the founder and what we take from each (structure and mechanics, never their assets or text):

| Reference | What we take |
|---|---|
| becaneparis.com | Figures standing full-body in a row on a clean light ground; personality from posture and styling; a figure comes alive on hover. We draw them instead of photographing them. |
| dontlookup.app | A living crowd of hand-drawn characters: figures shift, wander a step, talk in small speech bubbles; wit instead of explanation; the page is playable. |
| benxrun.com | Chapters named by meaning, not departments (we use the owner's questions instead of verbs). |
| thejacketcirclegame.maxmara.com | A "dictionary" of words the visitor picks from, a stepped game with a visible counter (0/5). |

**Story.** At the top, the visitor sees the owner (a standing figure) with a storm of questions spinning above their head, which is "تدور في راسك" made literal. Scrolling, the agents (seven at approval, eight with Reem) step in one by one; each pulls its own questions off the owner's head, and they start spinning calmly above the agent instead. At the end one word stays fixed above the owner: **«موافق.»**

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
| Reem | soft coral `#ffa38a` (DRAFT, pending founder approval; changed on 2026-09-30 from amber `#f4b942`, which was nearly the site's accent `#F2B33D`, the CTA and focus colour) | DRAFT: a placeholder for the founder to choose (order, reliability) |

Colour never carries meaning alone: every state also has text.

**Ground:** light pearl (proposal `#f7f3f9`) with plum `#2b193d` for ink and type; each agent's colour washes over the ground during its chapter.

## 4. Page structure (top to bottom)

1. **Nav**: wordmark ذكين, language switch, "ابدأ · Start".
2. **Story (sticky scroll)**: hero with the question storm → one chapter per agent (eight with Reem) → finale «موافق.».
3. **The team lineup**: all figures standing in a row (Bécane layout): eight at approval, nine with Reem. Hover or focus a figure: it turns to camera, its value line and rotating questions show, and a banter bubble plays (§5.3).
4. **قاموس ذكين (the game)**: §6.
5. **What's true today**: four facts (starts from your website; everything waits for your yes; weekly plan Sunday morning and a brief daily at 08:00; Arabic first, Gulf seasons and channels).
6. **Pricing, FAQ, Footer**: existing components (`Pricing`, `Faq`, `Footer`), restyled to the new tokens in a later pass.

Removed from the homepage (components stay in the codebase for other pages or deletion later): `Agents`, `Highlights`, `Teammate`, `OldWay`, `Runs`, `Deliverables`, `Pillars`, `Industries`, `Integrations`, `Calendar`, `Cta`. Confirmed by the founder on 2026-09-28. Components no other page imports are deleted in the build; the rest stay.

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

Each question is tied to a task type that exists in `src/lib/agents.ts` / `TASK_COST` in `src/lib/brand.ts`, or, for an agent that owns no task type (Reem), to the free feature it runs; the test in §8 enforces it.

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

**Reem · ريم** (DRAFT, added 2026-09-29, pending the founder's approval), value: **مهامك ومواعيدك ومتابعاتك، في قائمة وحدة.** / *Your to-dos, dates and follow-ups, in one list.*

Reem is the secretary (`src/lib/secretary.ts`): she keeps the owner's own list (to-dos, follow-ups, what the owner owes and is owed) with dates in the brand's local time, read back for confirmation; free, no credits; she never closes an item herself. Today's and overdue items show on My to-dos (`/app/todo`) and in the 08:00 morning brief, with in-app alerts for overdue items. Not available yet, so never promised here: reminders on WhatsApp or Telegram, and an alert at the due time itself. She owns no task type, so each question is backed by the `todo` feature instead of a task.

| Question (AR) | English | Backed by |
|---|---|---|
| وش عليّ اليوم؟ | What's on me today? | feature `todo` |
| مين ما رد علي للحين؟ | Who still hasn't got back to me? | feature `todo` |
| وش المتأخر عندي؟ | What's overdue? | feature `todo` |
| متى أكلم المورّد؟ | When do I call the supplier? | feature `todo` |
| كيف ما أنسى أتابع العميل؟ | How do I not forget to follow up with the customer? | feature `todo` |

Drawing (DRAFT): a woman in an abaya and shayla holding a small spiral planner at chest height, one of its three checkbox lines ticked, the other hand holding a pencil on the next line; no glasses (Razan) and no clipboard (Dana). Turned to face you, only her head turns: the planner and the pencil keep their side, so the tick never reads backwards. Order: after Layan, before the owner. She adds no banter exchange; pressed in the lineup, she says her value line. Claim line for prototypes only, when she takes a question: «سجّلتها عندي.» / *Noted.*

**You · أنت**, value: **أنت توافق.** / *You approve.* The hero storm uses every agent question (36 at approval, 41 with Reem); the finale shows only «موافق.».

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

### 7.1 Figures (illustrated characters)

- **Style (decided 2026-09-28): hand-drawn cartoon, doodle / illustration.** Eight characters (seven agents plus the owner) at approval, nine with Reem, full body, standing. Art direction: one confident ink line in plum on the light ground, flat fills in each agent's colour, no gradients or 3D, faces drawn with a few strokes (eyes, brows) so expression carries the personality. Adult and editorial rather than childish: think New Yorker or Max Mara sketch energy, with the liveliness of Don't Look Up.
- Styling is modern Gulf, drawn not caricatured. Characters follow the names: Noor, Razan, Dana, Layan and Reem women; Sami, Faris, Majed men; the owner neutral. Each has one signature prop that says its job at a glance, for example Noor's phone on a small ring light, Razan's reading glasses and pocket calculator, Faris's scarf mid-stride, Dana's pearl and clipboard, Majed's bisht, Layan's headphones, Sami's phone to his ear, Reem's spiral planner and pencil (draft).
- **Delivery:** layered SVG per character with named groups for head, eyes, brows, arms, prop and body, so the code can animate them (blink, glance at the cursor, turn, gesture). Poses per character: stand, turn to camera, one signature gesture, and talking (for the banter). Optional later: Rive files if we want richer animation.
- **Who draws:** a commissioned illustrator, briefed from this spec. Style frames first (two characters), approved by the founder, then the full cast.
- Development uses simple placeholder doodles in the same line style so the build does not wait for the final art.
- **Disclosure:** the lineup carries a small, permanent label «وكلاء ذكاء اصطناعي · AI agents».

### 7.2 Typography

- Custom-drawn wordmark for ذكين (and Zakeen if chosen).
- One licensed Arabic family with a display cut, plus one Latin editorial serif and one Latin grotesk. Shortlist to specimen: 29LT (29Letters) Arabic display families, TPTQ Arabic families, and Thmanyah's released faces if their licence allows commercial web use. No El Messiri or Cormorant.
- Gate: a specimen page with three pairings, set in the approved copy, is reviewed before any build uses them. Until licences arrive, the build uses the system stack.

### 7.3 Motion and interaction

- **Engine:** GSAP with ScrollTrigger (standard licence, free) for the scroll choreography; DOM and CSS for text; inline SVG for the characters, animated by GSAP (blink, glance, breathing, gesture). three.js is not needed for v1.
- **Question storm (hero):** every agent question (41 with Reem) orbits and flip above the owner's head, overlapping and fast. On scroll, each agent's set peels off and flies to its head.
- **Rotating questions per agent:** one visible at a time, flipping every 2.4 s, staggered across agents so they never flip together; paused on hover or focus.
- **Life:** characters breathe and blink; every 6–10 s one banter exchange from §5.3 plays in bubbles; eyes follow the cursor; a character turns to camera on hover.
- **Reduced motion:** no storm, no flipping (the first question shows), no wandering or breathing, static poses; scroll still steps chapter by chapter.

### 7.4 Integration with the app

- Route stays `src/app/[lang]/page.tsx`; new client components under `src/components/home/` (for example `Story.tsx`, `Lineup.tsx`, `Figure.tsx`, `QuestionFlip.tsx`, `Dictionary.tsx`).
- Copy in `src/lib/home.ts`, typed per language.
- The CTA reuses the current hero flow: `/{lang}/app/signup?next=/{lang}/app/start?url=…` (same as `HeroUrl` in `src/components/Landing.tsx`).
- Arabic is the default route; the lineup and all layout mirror in RTL.
- New dependency: `gsap`. Follow the lockfile rule in `CLAUDE.md` (regenerate `package-lock.json` in an empty directory, check the `@rolldown/binding-linux-*` entries).

### 7.5 Budgets

- LCP under 2.5 s on a mid-range phone over 4G; the first paint shows the slogan and the owner character.
- Added JavaScript under 90 KB gzipped; all the characters together under 250 KB of SVG; initial transfer under 1 MB.
- No network calls from the game.

### 7.6 Accessibility

- Rotating questions sit in an `aria-hidden` layer; each figure exposes value, name and its first question as static text.
- Figures are focusable buttons; the game is fully keyboard-operable with visible focus.
- Contrast meets WCAG AA in every colour world.

## 8. Tests

- `tests/home-copy.test.ts` (new): every agent has a value line, a name and at least four questions in both languages, with equal counts; every question's task exists in `TASK_COST` and belongs to that agent, or its feature is one that agent's capability runs; the hero storm equals the union of agent questions.
- `tests/content-claims.test.ts` passes over the new copy (no invented numbers, customers or result promises).
- Playwright: the homepage renders the slogan and every figure (nine with Reem) in both languages; the game runs steps 1–5 with no `/api/*` request; the CTA lands on signup with the URL carried; reduced motion shows static questions. Update the home markers in `e2e/fixtures/routes.ts`.
- Add the new rules to `docs/system/tests.md`.

## 9. Launch dependencies (outside this page)

1. Claude is paused (`CLAUDE_PAUSED = true` in `src/lib/model.ts`). The CTA leads into onboarding, which refuses while paused; it must be switched back on before launch.
2. A site-wide rename from نشر to ذكين (nav, footer, metadata, emails, other pages) is a separate task. Launching this page alone would show two names.
3. Final illustrations and type licences (§7.1, §7.2).

## 10. Founder decisions

Decided on 2026-09-28:
1. Name: **Thakeen · ذكين**.
2. Characters: **hand-drawn cartoon, doodle / illustration** (§7.1), not photography.
3. Ground: **light**.
4. Old homepage sections: **removed** (§4).

Still open:
1. Type: approve the specimen shortlist and licence cost (§7.2).
2. Illustrator: who draws, and budget; style frames approved before the full cast.
3. Reem (added 2026-09-29, on the page as a DRAFT): her colour (soft coral `#ffa38a`, a placeholder, §3), her drawing (§5.2, §7.1), her value line and her five questions (§5.2) all await the founder's approval.

Build decisions (2026-09-28), recorded as built:
1. CTA contract: `StartForm` submits to `/{lang}/app/signup?url=…`, the existing UrlStart path. Since PR #216 that lands on `/{lang}/app/start?url=…`, where the owner confirms the site before any crawl. §7.4's `signup?next=/{lang}/app/start?url=…` is not used.
2. Banter bubbles: a figure speaks when pressed (Enter, Space or click), not on hover or focus (ruling R8). Hover and focus turn the figure to face you and hold its question.
3. Banter cadence: the next exchange starts at the later of 8000 ms after the previous one's start and 2200 ms after its last line (ruling R12).
4. Motion toggle: one page-level pause button for WCAG 2.2.2, shown on the story's stage and in the lineup. Both are the same switch, and it stops the storm, the scroll cue, the story's flip and all of the lineup's motion (ruling R13, extended to the whole page in the final review).
5. Game samples: steps 3–4 build their samples from the sector, the brand and the first word's tone only. Variants driven by all five words wait for founder-approved copy.

## 11. Out of scope

- The "Our story" page (the Dhow Crew concept, النوخذة), which comes after the homepage.
- Restyling Pricing, FAQ and the other pages to the new tokens.
- The site-wide rename (§9.2).
