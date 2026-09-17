---
target: app home (chat page)
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
target_identity: "file:/Users/ihejazy/projects/nashr/src/app/[lang]/app/chat/page.tsx"
target_fingerprint: "sha256:6e430da9cf820290a837df7fd17bf0e5f03a9c72440924f5e498127f7d5e641c"
target_path: /Users/ihejazy/projects/nashr/src/app/[lang]/app/chat/page.tsx
timestamp: 2026-09-17T20-14-35Z
slug: src-app-lang-app-chat-page-tsx
closed: true
---
Method: dual-agent (A: design review sub-agent · B: detector/browser sub-agent)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Credits shown in three places with three formats; working-status lines are 14px at 50% ink with a 6px dot |
| 2 | Match System / Real World | 3 | Warm dialectal Arabic; but "البداية", "# الرئيسية" and "الخلاصة" are three mental models for one product |
| 3 | User Control and Freedom | 2 | Approve is one click with no undo; 👎 uses window.prompt; conversation delete has no confirm; mobile drawers have no close button or Escape |
| 4 | Consistency and Standards | 2 | Two hamburgers on one mobile screen; English "NEW" badges inside Arabic UI; chat card has 3 actions, feed card has 8 |
| 5 | Error Prevention | 2 | No warning before approving an item over the channel limit; switching agent mid-stream orphans the in-flight reply |
| 6 | Recognition Rather Than Recall | 2 | Thread is always "البداية"; agent blurbs only as tooltips; "شغّل الآن" links to /tasks instead of running |
| 7 | Flexibility and Efficiency | 1 | No keyboard agent switching, no Cmd+K, no approve-all for a 10-post batch |
| 8 | Aesthetic and Minimalist Design | 2 | 65 interactive elements on the desktop home; 21 sidebar text nodes ≤10px; HireBlock repeats the trial banner CTA |
| 9 | Error Recovery | 2 | Network failure renders "⚠︎ network" as a bubble signed by Noor; approve failure is silent |
| 10 | Help and Documentation | 3 | WhatsApp contact, Help, suggestion chips, "أول خطوة" line; but the tip is buried in a sales block |
| **Total** | | **21/40** | **Acceptable (52%)** |

## Design Specificity Verdict

**Mixed: authored vocabulary inside an interchangeable frame.** The seven named agents with Arabic initials, the kunya greeting in the morning brief with days to National Day, the trial promise ("40 منشوراً بلهجتك… لا تُنشر بدونك"), the palette and the "ن" monogram on the limit modal are genuinely Nashr. The composition is a Slack/Enrich template: dark rail with # channels, DM rows with fake green presence dots, "+ New" per person, NEW badges. The Sadu weave, the design system's stated signature, is absent from the app shell. Noor has the same visual weight as Layan, so the front door is not a door.

**Deterministic scan** (static): 0 findings across the 7 target files (verified the scanner works on a control sample; it cannot see Tailwind arbitrary sizes like `text-[10px]`, which the browser pass catches). **Browser detector** (overlay injected on 3 pages): `/ar/app/chat` 26 findings (24 undersized-ui-text at 10px/9px: sidebar section headers, 7 agent roles, 7 "+ جديد", "NEW" at 9px, "trial · 40 كريدت", the three right-panel tile labels; 1 tiny-text on the task status line); `/en/app/chat` 25 (same set); `/ar/app` 39 (the same 21 sidebar hits, 1 low-contrast: "ملخص نور" #d9503f on #f6f4ee = 3.7:1, 7 text-overflow on feed card subtitles clipped by 23–54px, 10 undersized character counters). No console errors. No false positives; the overflow hits are on intentional `.clip` spans, which is a judgment call rather than a bug. The two assessments agree on sub-12px text (A ranked it P1 before seeing B). B added the contrast failure on the brief label that A did not measure.

**Visual overlays**: injection succeeded in the detector's own tab, which was closed after the run, so no overlay is left open for you.

## Overall Impression

Honest, bilingual, functionally rich, and the item cards are the best thing on the screen. But the home is an org chart plus a chat log with two sales asks bracketing it, and the page auto-scrolls the trust copy off-screen on load. The single biggest opportunity: make the home about what the team made and what needs the owner's approval, with Noor as the one visible door.

## What's Working

1. **In-chat item cards with live character counts** ("109 / 280" in mono next to the platform icon) embody "publish-ready" better than any headline.
2. **The morning brief voice** (kunya greeting, days to National Day, one next step) is the product's personality in four lines.
3. **Trial copy** states the concrete promise and the trust rule in one sentence, in the feminine imperative that matches Noor.

## Priority Issues

- **[P0] Home auto-scrolls the promise off-screen and double-scrolls.** `ChatPanel` sizes itself to `100vh-3rem` while the layout adds the banner, and `scrollIntoView` on mount scrolls the document 88px (desktop) / ~200px (mobile). Why: the sentence that explains "nothing publishes without you" disappears in the first second. Fix: message list is the only scroller (`scrollTop = scrollHeight` on the container), panel `min-h-0 flex-1` in an `h-dvh` column with a banner slot. Command: `/impeccable layout`.
- **[P0] Three ways to pick an agent, none clear.** Seven equal pills above the composer, seven DM rows with "+ جديد", and a duplicate conversation column. Pill accessible names are the blurbs, not the names. Why: Noor is the front door per PRODUCT.md; a 5-minute owner should not choose from an org chart. Fix: Noor as the only visible pill plus one "+ اسأل متخصصاً" disclosure (or `@` mention); drop the in-panel history column on desktop; `aria-label={name}`. Command: `/impeccable distill`.
- **[P1] The approval-first product has no approval surface on the home.** Pending items are a badge "9" in three places; approve has no undo, no next step, silent failure. Fix: a "بانتظارك (9)" strip above the composer with the first card inline and "راجع الكل"; 4-second undo toast; "انسخ إلى Instagram" as next action; inline error on failure. Command: `/impeccable clarify`.
- **[P1] Sub-12px grey text carries the operating information** (21 sidebar nodes ≤10px, tile labels, task status, counters; brief label at 3.7:1 contrast). Arabic at 10px loses dots and diacritics. Fix: 12px floor for anything read, 13px for Arabic body, full ink for numbers, fix `text-sadu` on salt to a darker sadu or ink. Command: `/impeccable typeset`.
- **[P2] Two sales blocks on one screen, no Nashr signature in the shell.** TrialBanner and HireBlock both push /billing; the Sadu weave appears nowhere in the app. Fix: one activation surface (banner with days left and credits used), keep only the "أول خطوة" line under the composer, add `sadu-thin` under the brand header and as feed day dividers. Command: `/impeccable bolder`.
- **[P3] Mixed-language artifacts in Arabic UI**: "NEW", Latin channel names, "MCP", "trial" as plan name, ISO dates, "قبل 0 ساعة", "بعد 2 يوم". Fix: localise badges and plan names, `Intl` dates, Arabic plural rules. Command: `/impeccable polish`.

## Persona Red Flags

**Alex (power user)**: 29 sidebar controls precede the composer in tab order; no shortcut to focus it, no Cmd+K, no keyboard agent switch; conversation "✕" is invisible on focus (`opacity-0 group-hover`). Leaves after the second message.

**Jordan (first-timer)**: first screen shows "# الرئيسية", "الخلاصة NEW", "PRD", "OKRs", "اقتصاديات الوحدة", "MCP"; no pill says what to type; does not know a message costs a credit.

**Sam (accessibility, keyboard and screen reader)**: agent tabs announce the blurb instead of the name; vote buttons are 11px emoji; LimitModal has no focus trap or Escape; the brief label fails 4.5:1.

**Umm Sara (Salla owner, 5 minutes, Arabic-only, phone)**: message list is 308px tall at 375px width; pill row takes 3 lines at 26px (below touch minimum); two hamburgers; the drawer needs its own scroll to reach credits; "شغّل الآن" runs nothing; approvals are a tab away. Her five minutes end in the drawer.

## Minor Observations

- Permanent fake green presence dots (`bg-green-400`, a raw colour outside the palette) contradict "honest by construction".
- Arabic suggestions for Noor are 5, English 4 (parity break).
- Feminine imperative for Noor but masculine for Majed's chips; HireBlock title addresses the owner as male ("وظّف") while the button addresses Noor ("وظّفي").
- `window.prompt` for the 👎 reason; `dangerouslySetInnerHTML` renders model output (escaped, but the surface trusts it).
- Mobile header shows "40" with no unit; `dir="ltr"` on "40 كريدت" flips word order in RTL.
- "NEW" badges have no expiry.
- Chat card and feed card are two components for one object.
- Emoji as icons render differently across OSes; "▦" for integrations is a box-drawing glyph.

## Questions to Consider

1. If Noor is the face, why does the home open on a chat log rather than on what she made overnight and what she needs approved before noon? What if the composer were the last thing, not the first?
2. The brief already knows "اليوم الوطني بعد 5 أيام". Why is the Gulf calendar invisible on the home while a Slack-style channel list is the first thing on the side? What if a season strip replaced the channel list?
3. Would a Salla owner ever choose between seven specialists, or describe a problem and expect the team to route it? Is the agent picker a feature or an admission that routing was not built?
