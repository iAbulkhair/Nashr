# supastarter → Thakeen: UI/UX benchmark and adoption plan

Date: 2026-10-10 · Branch: `claude/supastarter-uiux-report-fca589` · Repo HEAD audited: `1fb56b90`
Type: recommendations only. No product code was changed for this report.
Companion to `docs/superpowers/specs/2026-10-08-supastarter-adoption-design.md`, which covers feature adoption (email, CSRF, confirm dialog, llms.txt). This report covers the interface.

---

## الملخص التنفيذي (للمؤسس أبوالخير)

**الخلاصة في سطر:** ذكين أقوى من supastarter في الهوية والعربية والاتجاه من اليمين لليسار، وأضعف منه بكثير في «الطبقة الوسطى» من المنتج: مكوّنات موحّدة، رسائل نجاح وخطأ، الإعدادات، الفوترة، ولوحة المؤسس. نأخذ من supastarter هيكله وانضباطه، لا شكله.

**ما يتقنه supastarter ونأخذه:**
1. **مكتبة مكوّنات واحدة** (29 مكوّناً: زر بحالة تحميل مدمجة، حقل مربوط برسالة الخطأ، نافذة حوار، قائمة منزلقة، إشعار عائم، جدول، تبويبات، هيكل تحميل…). عندنا أنماط CSS فقط، و77 زراً و52 حقلاً و57 بطاقة مكتوبة يدوياً خارجها.
2. **ألوان دلالية كاملة** (نجاح، تحذير، خطر، حدود، نص خافت) مع **وضع داكن** ومفتاح «النظام / فاتح / داكن». عندنا لون «خطر» فقط، والأحمر يُستعمل زينةً في 130 موضعاً، ولا وضع داكن.
3. **إعدادات في مكان واحد**، كل إعداد في بطاقة لها زر حفظ خاص لا يعمل إلا إذا تغيّر الحقل وصار صحيحاً. عندنا الإعدادات مبعثرة على 8 صفحات من قائمة منبثقة فيها أكثر من 10 عناصر.
4. **فوترة واضحة**: الباقة الحالية مُعلَّمة، تاريخ نهاية التجربة، بوابة اشتراك. عندنا لا علامة للباقة الحالية، والأسعار بالأحمر، وصفحة العودة من Paymob تقول «حدّث الصفحة»، ولا فواتير للعميل (ولا فاتورة ZATCA).
5. **لوحة إدارة**: بحث وترقيم صفحات محفوظان في الرابط، حظر بسبب ومدة، ورسائل «جارٍ… تمّ / فشل» في إشعار واحد.
6. **تسجيل دخول متكامل**: رابط سحري، مفتاح مرور (passkey)، شارة «آخر طريقة استخدمتها»، رمز تحقّق يُرسل تلقائياً، وقائمة شروط كلمة المرور الحيّة.
7. **مركز إشعارات** في الشريط العلوي مع عدّاد، وتفضيلات لكل نوع ولكل قناة.

**أخطاء حقيقية وجدناها أثناء التدقيق (تُصلَح قبل أي تحسين شكلي):**
- **لوحة المؤسس:** زر «إلغاء» في نوافذ السبب **لا يلغي**؛ يطبّق تغيير الباقة والمقاعد والرصيد والاسترداد بسبب فارغ (`src/components/admin/Users.tsx:66` و8 مواضع أخرى). و«إلغاء» في تمديد التجربة **يضيف 7 أيام** (`:377`).
- **حذف الحساب يطلب كلمة المرور في نافذة متصفّح مكشوفة** (`src/components/app/ProfilePanel.tsx:178`)، وإعادة تعيين كلمة مرور مستخدم تُظهر كلمة المرور المؤقتة في نافذة متصفّح (`Users.tsx:51`).
- **المحادثة:** الانتقال من محادثة لأخرى في الشريط الجانبي قد يُبقي المحادثة القديمة، فتذهب الرسالة التالية إليها (`ChatPanel` بلا `key`، والحالة `conv` لا تتجدّد: `ChatPanel.tsx:484` و`:499`). ثبت بقراءة الكود؛ يحتاج اختباراً حيّاً.
- **خط الصفحة الرئيسية خاطئ:** نصها يظهر بخط النظام لا بخط IBM Plex Sans Arabic (`src/app/[lang]/home.module.css:5-7`)، مع أن المتصفح يحمّل 6 ملفات Plex لا تُستعمل هناك.
- **مخطط التقارير غير مقروء:** خطّان من ثلاثة بلون الليلكي والليموني على أبيض، تباين قرابة 1.1:1 (`ReportsPanel.tsx:90`).
- **كل شاشات التطبيق ولوحة المؤسس تحمل نفس عنوان الصفحة** (0 من 40 صفحة)، فلا يميّز قارئ الشاشة ولا تبويب المتصفح بينها.

**ما لا نأخذه:** الواجهة الداكنة فقط، والتصميم من اليسار لليمين (supastarter لا يدعم RTL: لا `dir`، وقرابة 142 خاصية فيزيائية يسار/يمين، وخطوط لاتينية فقط)، والشهادات المخترعة وأرقام الإثبات المتضاربة، وتسجيل الدخول بـ GitHub، والصفحات الطويلة جداً، والشكل الرمادي العام الذي يمحو هويتنا (الحبر البنفسجي والليموني وخط «ثمانية»).

**خطة التنفيذ (6 مراحل، كل مرحلة طلب دمج مسوّدة واحد، دفعة واحدة بعد نجاح الفحص المحلي):**
- **المرحلة 0 (يوم):** الأخطاء أعلاه + عناوين الصفحات + رابط «تخطَّ إلى المحتوى» + إلغاء تباعد الحروف في العربية + تقليل الخطوط المحمّلة مسبقاً.
- **المرحلة 1 (3-4 أيام):** الألوان الدلالية الجديدة (إضافة فقط، لا حذف) + مكوّنات الأساس: حقل بعنوان ظاهر، إشعار عائم، نافذة حوار بإدخال، زر بحالة تحميل، مفتاح تبديل واحد، شارات.
- **المرحلة 2 (أسبوع):** هيكل التطبيق: حالات التحميل والخطأ داخل الإطار، شريط جانبي بـ `<nav>`، مركز إشعارات، محادثة بارتفاع ثابت على الجوال.
- **المرحلة 3 (أسبوع):** صفحة الإعدادات الموحّدة + الفوترة (الباقة الحالية، حالة الدفع، السجل).
- **المرحلة 4 (أسبوع):** لوحة المؤسس: جدول بيانات، لوحة جانبية للمستخدم، سبب إلزامي، سجل تدقيق مقروء.
- **المرحلة 5 (أسبوعان):** الوضع الداكن، بعد استبدال قرابة 400 لون شفّاف بالرموز الدلالية، ومعرض واجهات حيّة في الصفحة الرئيسية.

**توصيتي:** ابدأ بالمرحلة 0 هذا الأسبوع لأنها أخطاء أمان ومال حقيقية، ثم المرحلة 1 لأن كل ما بعدها يُبنى عليها. الوضع الداكن آخر شيء؛ قيمته لعميلنا (صاحب متجر خليجي على الجوال نهاراً) أقل من الفوترة والإعدادات.

---

## 1. Scope, method, limits

**Studied (supastarter):**
- Marketing site supastarter.dev: home, pricing section, FAQ, docs (Fumadocs), changelog (8 pages, 2023-09 → 2026-10), blog, showcase, comparison pages, legal.
- Template demo: demo.supastarter.dev (marketing), app-demo.supastarter.dev (`/login`, `/signup`, `/forgot-password`), demo-docs.
- Licensed source at `~/projects/supastarter`: `tooling/tailwind/theme.css` (113 lines), `packages/ui/components` (29 primitives), `apps/saas/modules/*` (admin, ai, auth, i18n, onboarding, organizations, payments, settings, shared). Patterns are described here; no supastarter code is copied into this repository. Re-implement ideas, never paste code (license).

**Studied (Thakeen):** marketing site, `/{lang}/app` workspace, `/{lang}/admin` console, onboarding, chat, tasks, billing, settings, components, `src/app/tokens.css`, `src/app/globals.css`, `docs/Design_System.md`. Run locally with `APP_ENV=test` and the in-memory store; test accounts created on localhost only.

**Screenshots:** 57 captures at 1440×900 and 375×812 (mobile emulation), AR and EN, light and dark preference. They live in the published Artifact and locally in `coverage/uiux-shots/` (gitignored, not committed). File names are cited as `[shot: name]`. Prefix `ss-` is supastarter, `th-` is Thakeen; suffix `-d` desktop, `-m` mobile.

**Limits:**
- supastarter's logged-in app was not captured: the demo has no guest login and creating an account on a third-party demo is out of bounds. Its app shell, settings and admin are described from the licensed source, the docs, and the marketing dashboard mockup (`ss-demo-mkt-full-d`).
- Thakeen has no dark mode, so the "dark" captures show the light theme. That is itself a finding.
- The Next.js dev indicator ("N" badge, "Compiling") shows bottom-left in Thakeen captures; it is dev-only.
- Chat replies were not generated (no model key locally), so busy and streaming states are described from code.
- Performance notes are static (code reading), not field measurements.

**Inputs:** six parallel audits whose full notes sit in the shared notes folder (`uiux/A`–`F`). This report merges, de-duplicates and ranks them. Every Thakeen claim carries a `file:line` from HEAD `1fb56b90`.

---

## 2. Scorecard

Score 1–5 (5 = mature SaaS standard). "Gap" is what Thakeen should close; it is not "be like supastarter".

| Area | supastarter | Thakeen | Gap | Priority |
|---|---|---|---|---|
| Brand identity, art direction | 3 (generic olive / sand) | **5** (ink, lemon, scribble, Thmanyah) | none, protect it | — |
| Arabic and RTL | 1 (no `dir`, ~142 physical classes) | **4** (logical props, glyph and letter-spacing bugs) | small | P0/P1 |
| Design tokens | 4 (full semantic set, light + dark) | 2.5 (3 layers; no success/warning/border/muted-fg; no dark) | medium | P1 |
| Component primitives | 4.5 (29 in `packages/ui`) | 2 (CSS classes; one good dialog) | **large** | P0/P1 |
| Loading / empty / error / toast | 3 (toast, skeletons; no route boundaries) | 1.5 (0 `loading.tsx`, 0 skeleton, 44 native dialogs) | **large** | P0 |
| App shell and navigation | 4 (collapsible rail, mobile sheet, bell) | 2.5 (no `<nav>`, no `aria-current`, 10+ item menu) | medium | P1 |
| Chat | 3.5 (streaming markdown, sessions) | 2.5 (no stream, one-line input, stale-thread bug) | medium | P0/P1 |
| Settings | 4 (one area, per-card save, sessions, passkeys) | 1.5 (8 scattered routes) | **large** | P1 |
| Billing | 4 (current plan, portal, trial end) | 2 (no current marker, red prices, no receipts) | large | P1 |
| Admin console | 3.5 (URL search and paging, ban with reason; no impersonation banner) | 2 (client filter, Cancel bug, inline detail) | large | P0/P1 |
| Auth | 4.5 (magic link, passkey, last-used, OTP auto-submit) | 3 (good password rules; placeholder-only labels) | medium | P0/P1 |
| Onboarding | 3.5 (multi-step form, progress) | 3.5 (playful 7 steps, nothing persists) | small | P2 |
| Marketing site | 4 (coded mockups, freshness, sticky nav) | 3.5 (strong art; no hero CTA; font bug) | small | P1 |
| Docs, changelog, help | 4.5 | 2 (updates page only) | medium | P2 |
| Accessibility | 3 | 2.5 (good contrast, focus ring, reduced motion; titles, labels, live regions, traps missing) | medium | P0/P1 |
| Performance (static) | 3.5 | 2.5 (11 font preloads, 192 client Scribbles, 106 KB dictionary per page) | medium | P1 |
| Dates, numbers, plurals | 3 | 2 (UTC, 56–61 raw ISO slices, wrong Arabic plural, mixed digits) | medium | P1 |

---

## 3. Bugs found during the audit (fix before any redesign)

These are defects, not design gaps. They form Phase 0.

| # | Bug | Evidence | Fix | Effort | Priority |
|---|---|---|---|---|---|
| B-1 | Admin reason prompts never cancel: Cancel applies plan, seats, chat, deal, credits, top-up, void, refund or member removal with an empty reason | `src/components/admin/Users.tsx:66, 80, 100, 166, 177, 205, 229, 256, 323` (`prompt(O.reason, "") ?? ""`) | Treat `null` as abort (one guard each); later a FormDialog with a required reason (Phase 4) | S | **P0** |
| B-2 | Cancel on "extend trial" adds 7 days | `Users.tsx:377` (`Number(prompt(...)) \|\| 7`) | Abort on `null`; validate 1–30 | S | **P0** |
| B-3 | Account deletion asks for the password in a plain-text native prompt | `src/components/app/ProfilePanel.tsx:178` | Dialog with `PasswordField` (masked), consequences list, typed email | S–M | **P0** |
| B-4 | Admin password reset shows the temporary password in `window.prompt` | `Users.tsx:51` | Copy-once reveal panel inside a dialog, cleared on close | S | **P0** |
| B-5 | Switching conversation in the sidebar likely keeps the old thread; the next message goes to the old `conv` | `src/app/[lang]/app/chat/page.tsx:86` renders `ChatPanel` with no `key`; `ChatPanel.tsx:484` keeps `conv` in state; the effect at `:499` resets only `agent` | `key={conv ?? agent}` on `ChatPanel`; `newConv` calls `router.replace`. Runtime-verify first | S | **P0** |
| B-6 | All 31 app and 9 admin pages share one `<title>`; the Next route announcer reads the same title on every screen (WCAG 2.4.2) | 0 `generateMetadata` under `src/app/[lang]/app/**` except `/mcp`, 0 under `admin/**` | `generateMetadata` per page from the dictionaries: «الشاشة · ذكين» | S | **P0** |
| B-7 | Home body text renders in the system font, while 6 preloaded Plex files go unused | `src/app/[lang]/home.module.css:5-7`; collapsed scale `:9-13` | Use `var(--font-body)`; fix the scale | S | **P0** |
| B-8 | Reports chart: two of three series near-invisible (lilac and lemon on white, ~1.1:1); admin Overview draws signups in lemon and approvals in red | `ReportsPanel.tsx:90`; `src/components/admin/Overview.tsx:8` | Chart tokens from ink + agent fills, each ≥ 3:1 on paper | S | **P0** |
| B-9 | Paymob "turn off auto-renew" and "remove card" run with no confirmation | `PaymobBilling.tsx:113, 117` | `useConfirm` destructive variant | S | P0 |
| B-10 | BrandForm save failure is silent; success navigates to chat | `BrandForm.tsx:46-50` | Error message on non-OK; stay on page with a toast | S | P0 |
| B-11 | Integrations shows raw error codes in `alert()` and in the URL flash | `IntegrationsPanel.tsx:42, 77, 84, 94, 104, 113` | i18n error map + toast | S | P0 |
| B-12 | Profile shows "…" forever if its fetch fails | `ProfilePanel.tsx:79-80` (`.catch(() => {})`) | Error state with retry | S | P1 |
| B-13 | Wrong Arabic plural "بعد 2 أيام" in the trial banner, plus dead code | `TrialBanner.tsx:17-18` (HomeSide `:26-27` already does it right) | Shared `plural(lang, n, forms)` on `Intl.PluralRules` | S | P1 |
| B-14 | `hello@nashr.ai` (code-name domain) on public billing and i18n | `billing/page.tsx:124`, `TopupCard.tsx:47`, `src/lib/i18n.ts:284, 436` | Thakeen support address from config | S | P1 |
| B-15 | `rtl:space-x-reverse` breaks Tailwind v4's logical spacing stack | `Sidebar.tsx:105` | Drop the reverse; v4 `space-x` is already logical | S | P1 |
| B-16 | Admin invoice note still says "Once Moyasar or Tap is wired" | `src/components/admin/shared.tsx:77` | Copy fix | S | P2 |

---

## 4. Area by area

Each block: **supastarter pattern** → **Thakeen today** → **gap** → **fix** → effort · impact · priority.
Effort: S ≤ half a day, M 1–3 days, L > 3 days. Impact: H/M/L for customers and the founder.

### 4.1 Foundations: tokens, colour semantics, theming

**supastarter pattern.** One theme file defines a complete two-layer semantic set: `background/foreground`, `card`, `popover`, `primary`, `secondary`, `muted` + `muted-foreground`, `accent`, `destructive`, `success`, `warning`, `border`, `input`, `ring`, plus one brand accent ("touch", an oklch moss green used only for state and emphasis), each with a `-foreground` pair, mapped to utilities through `@theme`. A light block and a `.dark` block. All radii derive from one `--radius`. Status badges and alerts use tints (`bg-X/10 text-X`). Gaps on their side: no shadow, spacing or motion tokens, no reduced-motion handling. Theme switch: System / Light / Dark segmented control on auth pages and in the user menu. [shot: `ss-app-login-d`, `ss-app-login-dark-d`, `ss-demo-mkt-dark-d`]

**Thakeen today.** `src/app/tokens.css` (130 lines) already has a good three-layer shape: primitives (ink `#2b193d`, muted `#5d4a70`, paper, ground `#f7f3f9`, lilac `#efe7f7`, lemon `#f9f871`, gold, danger `#cc0000`, nine agent colours), semantics (`--color-background`, `-surface`, `-foreground`, `-primary*`, `-accent*`, `-inverse-*`, `-ring`), component tokens (`--button-*`, `--input-*`, `--card-*`), plus motion durations and an easing (ahead of supastarter). Contrast of the base pair is strong (ink on paper 16:1, muted 7.8:1). Missing: `success`, `warning`, `info`, `border` / `border-input`, `muted-foreground`, `popover`, `overlay`, chart series, any dark values.
Components bypass the semantic layer with ~400 opacity utilities (`text-ink/70` ×130, `border-ink/10` ×58, `border-ink/15` ×42 …). `text-danger` is used 130 times, many decorative (agent names `ChatPanel.tsx:711`, prices `billing/page.tsx:116, 134`, `TopupCard.tsx:64`), a leftover of reskin commit `31989d1c`. Lemon appears on light grounds ~30 times against the "lemon only on ink" rule (`TrialBanner.tsx:15`, `Inbox.tsx:293-296`, `StartLaunch.tsx:96, 103`, `CalendarPanel.tsx:106, 121`). Zero `dark:` classes, no `color-scheme`. [shot: `th-home-ar-dark-d`, `th-login-ar-dark-d` render identical to light]

**Gap.** Semantic coverage and discipline, not palette. Thakeen's palette is better; its plumbing is thinner.

**Fix.** Full proposal in §5. Expand tokens.css (add, rename nothing), add lint rules for decorative `text-danger` and lemon on light, codemod opacity utilities to semantic utilities, then add dark values.
Effort M (tokens) + L (codemod + dark) · Impact H · **P1** (dark mode P2).

### 4.2 Typography and Arabic reading

**supastarter pattern.** One family per surface with a custom weight scale (350/450/525/600), `tracking-tight`, `text-balance` headings, `text-pretty` body, opacity steps for grey text. [shot: `ss-home-d`, `ss-demo-mkt-full-d`]

**Thakeen today.** Thmanyah Serif Display, IBM Plex Sans Arabic 400/500/600, Plex Mono (`src/app/[lang]/layout.tsx:13-23`).
- Leading: blog prose 1.8 (`globals.css:148-157`); elsewhere Tailwind default; titles at 1.2/1.25 (37 `.page-title`, 17 `leading-tight`); 526 `text-xs` at 12px/1.33.
- Letter-spacing on Arabic: 37 `tracking-wide`, `.eyebrow` adds 0.2em on 16 Arabic labels, often with `uppercase`. It breaks the joined script.
- **Faux bold**: Plex is loaded only at 400–600, but `.s-btn` asks for 800 (30 uses) and links, `strong` and ~31 `font-bold` ask for 700, so browsers synthesise bold.
- Home uses its own px scale with `--t-xs` = `--t-s` = 16px and `!important` overrides (`home.module.css:9-13, 799, 818, 822`) and the wrong font (B-7).
- Five H1 scales across marketing pages; four container widths.
- Mixed digit systems: Arabic-Indic in `Steps.tsx:19`, `SceneTrack.tsx:73`, `DictionaryStart.tsx:217`; Western elsewhere.
[shot: `th-home-ar-full-d`, `th-pricing-ar-full-d`]

**Fix.**
- `:lang(ar)`: body leading 1.7, titles 1.4, `letter-spacing: 0` and no `text-transform` globally; 13px floor for `text-xs`.
- Load Plex 700 (and cap body at 700) or map heavy weights to Thmanyah; never request 800 from Plex.
- One 7-step scale as tokens used by `.page-title`, a new `.page-hero-title` (one marketing H1), `.section-title`, `.page-sub`.
- Western digits everywhere (drop `-u-nu-arab`), matching prices and the brand.
- Do **not** adopt supastarter's 350 weight or `tracking-tight`: Plex Arabic loses stroke contrast at light weights on Android and negative tracking collides joined letters.
Effort S–M · Impact M–H · **P0** (letter-spacing, faux bold), **P1** (scale).

### 4.3 Component primitives

**supastarter pattern.** `packages/ui/components` holds 29 primitives built on Base UI (migrated from Radix 2026-07-31), shadcn-style with variant classes and a class merger: accordion, alert-dialog, alert, avatar, badge, button, card, chart, color-mode-toggle, dialog, dropdown-menu, form, input-otp, input, label, locale-switch, logo, popover, progress, select, sheet, skeleton, spinner, switch, table, tabs, textarea, toast, tooltip. Strongest ideas:
- **Button with a built-in `loading` state**: spinner replaces the leading icon and the button disables, so no form writes its own busy logic (their gap: no `aria-busy`).
- **Form field ARIA wiring**: label, description and message ids wired to the control automatically, `aria-invalid` on error.
- **Toast manager callable from anywhere** with a promise helper (loading → success or error in one call), stacked and swipeable, per-type icons.
- **Global confirm provider** called imperatively.
- Missing on their side: data table, empty state, breadcrumb, checkbox, radio, date picker, command palette.

**Thakeen today.** CSS component classes in `globals.css:331-382` (`.btn*`, `.card*`, `.input`, `.badge*`, `.page-title`, `.page-sub`) plus a few React components: `ConfirmDialog`/`useConfirm` (native `<dialog>`, good), `PasswordField`, `PasswordRules`, `ReadOnlyNote`, `Icon`, `AgentAvatar`, `Scribble`. Counts:
- 283 buttons, 77 ad-hoc (60 distinct class strings); ≥12 raw ink pills bypass `.btn` (BrandsPanel `:64, :85`, billing `:122-137`, `PaymobBilling.tsx:71`).
- 126 inputs, 52 ad-hoc (17 styles), many with `border-ink/15` (1.1–1.35:1, below 3:1); `.input` is 14px, which zooms iOS on focus.
- 57 ad-hoc cards with 52 class sets; radii disagree (`.card` 0.375rem vs `rounded-xl` ×38).
- Switch copied 5× (`GovernancePanel.tsx:16`, `WorkingDaysPanel.tsx:74`, `TasksPanel.tsx:46`, `ChatAllowanceCard.tsx:111`, `SeriesPanel.tsx:37`).
- 15 tables with 8 class sets; `fill()` defined 8×; 9 clipboard implementations; 5 overlay implementations, only ConfirmDialog correct.
- 0 Skeleton, 0 Spinner, 0 Toast provider (33 components hold their own `msg`/`err`), 0 Tabs, 0 Tooltip (59 `title=`), 0 DataTable, 0 FormField.

**Gap.** Large. This is the root cause of most other gaps.

**Fix.** Build `src/components/ui/` (Thakeen's own code, on our tokens, native `<dialog>` where possible, no new UI dependency required). Full list in §6. Migrate worst files first: IntegrationsPanel, Inbox, BrandsPanel, admin Users.
Effort L (spread over Phases 1–4) · Impact H · **P0** for Field / Toast / FormDialog / loading Button, **P1** for the rest.

### 4.4 App shell and navigation

**supastarter pattern.** Server-side data fetch before first paint; layouts redirect in order (onboarding → organisation → plan). `NavBar` (595 lines): a collapsible sidebar that stays fully usable when collapsed (tooltips on icons, flyout submenus, an edge toggle); expandable submenus; a mobile slide-in sheet (2026-05-05); org switcher showing the plan; user menu with the theme toggle; notification centre with unread badge in the header (`NotificationCenter`, 197 lines; 2026-05-06). Their weakness: the collapsed state is read from a cookie after mount, so the rail flashes expanded. [shot: `ss-demo-mkt-full-d` dashboard wireframe]

**Thakeen today.** `src/app/[lang]/app/layout.tsx` stacks Sidebar, impersonation strip (`:67-73`), TrialBanner (`:74`), InstallHint (`:75`), `<main>`, LimitModal (`:78`). Sidebar (`Sidebar.tsx`, 203 lines):
- The rail is an `<aside>`/`<div>` with no `<nav>`; no `aria-current` anywhere; conversation rows never highlight because `active()` skips hrefs with `?` (`:59`). No skip link in any layout.
- User menu `role="menu"` with no arrow keys, outside-click or focus return; 10+ ungrouped items (`:152-178`). Team appears twice (`:140`, `:166`). "Updates" leaves the app (`:147`).
- Desktop has no bell; mobile bell has a red badge (`:184-191`).
- Three fetches on every path change (`:42-49`); `/api/conversations` fetched in 5 places; credits shown in 3 places and only the chat pill updates.
- Mobile drawer: no dialog role, trap, scroll lock or Escape; close button labelled "Menu" (`:192-200`). Same in `AdminNav.tsx:75-83`.
- Sidebar "+" is ~19×16px (below the 24px minimum of WCAG 2.5.8).
- Up to four stacked strips at 375px.
[shot: `th-app-ar-d`, `th-app-ar-m`, `th-app-en-d`, `th-chat-ar-m`]

**Fix.**
1. Skip link «تخطَّ إلى المحتوى» to `#main` in root, app and admin layouts; `<nav aria-label>` in Arabic; `aria-current="page"` with query-aware matching (S, **P0**).
2. Rail groups: Work (Approvals, Chat, To-do, Calendar) · Brand (Files, Reports, Connections, Activity) · one "Settings" entry (§4.7). Remove Team from the rail; Updates moves under Help (S–M, P1).
3. Collapsible rail that stays usable collapsed (tooltips, flyouts), state read on the server from a cookie so it never flashes (M, P2).
4. Bell with unread count in the desktop rail opening a popover notification centre (M, P1).
5. One `WorkspaceContext` (credits, unread, pending, recent conversations) fed by the layout and updated by chat events; one fetch per navigation (M, P1).
6. Drawers on the new `Sheet` primitive (S once Sheet exists, P1).
7. Banner priority: impersonation > billing problem > trial > install hint; one at a time below md (S, P1).
Impact H.

### 4.5 Chat (Noor and the specialists)

**supastarter pattern.** AI chat module: multiple sessions with history, streaming markdown rendered incrementally (Streamdown), suggestion cards in the empty state, plain-prose assistant replies, tinted user bubble. Their gaps: no Stop button, no `aria-live`, no IME-composition check on Enter. Structural reference only.

**Thakeen today.** `ChatPanel.tsx` (792 lines) with KPI side panel `HomeSide.tsx`. [shot: `th-chat-ar-d`, `th-chat-ar-m`]
- B-5 stale thread on switch.
- Side panel `hidden xl:block` (`chat/page.tsx:85-87`): invisible below 1280px with no replacement.
- Mobile: no fixed-height pane because below lg the document scrolls; the composer scrolls away and auto-scroll (`:498`) does nothing; auto-scroll also fires when the user has scrolled up.
- No `role="log"`/`aria-live` on messages or busy steps (`:690-746`).
- SSE sends `status` steps then one full message: no token streaming; no Stop; 40 × 5 s silent poll on network drop (`:623-639`).
- Composer is a one-line `<input>` (`:748-753`): no Shift+Enter, attachments, copy/retry; send icon not mirrored in RTL (`Icons.tsx:20`); assistant bubble has no `dir="auto"` (`:712`).
- Agent picker `role="tablist"` without tabpanel or arrow keys; specialists popover `role="listbox"` with buttons inside (`:670-688`).
- ItemCard duplicates the Inbox approval card and the character limits disagree (`ChatPanel.tsx:28` has `meta: 63206`, `Inbox.tsx:73` does not). Approve is `btn-xs` (~24px).
- Thumbs not persisted across reload (`:642-648`).

**Fix.**
1. B-5 (S, P0).
2. `role="log" aria-live="polite"` on the list, a hidden status «يكتب… / وصل الرد», `aria-busy` on send (S, **P0**).
3. Chat route below lg: full-height flex column, list `overflow-y-auto`, sticky composer with `env(safe-area-inset-bottom)`; scroll only when near the bottom (M, P1).
4. Autosize textarea (Enter sends, Shift+Enter newline, ignore Enter while IME is composing), Stop via `AbortController`, copy and retry per assistant message, hover timestamps, day separators (M, P1).
5. Agent picker as buttons with `aria-pressed` + a real menu button for specialists (S, P1).
6. `render()` emits `dir="auto"` per block; `dir="auto"` on free-text inputs (92 of 123 lack it) (S, P1).
7. Token streaming over the existing SSE (M–L, P2; server work).
8. Extract `ApprovalCard` + one `CHANNEL_LIMITS` in `src/lib` for chat and Inbox (M, P1).
9. KPI side panel becomes a collapsible "Today" sheet below xl (S–M, P2).
Impact H.

### 4.6 Workspace screens: approvals, calendar, reports, files, connections, notifications

**supastarter pattern.** Dashboard chart cards (2026-01-26); table primitive; row-shaped skeletons; notification centre with lazy list, "99+" cap, per-type icons and per-type × per-channel preferences (2026-03-30); URL-held search and paging.

**Thakeen today.** [shot: `th-app-ar-full-d`, `th-calendar-ar-d`, `th-reports-ar-d`, `th-files-ar-d`, `th-integrations-ar-d`, `th-tasks-ar-d`, `th-tasks-ar-m`]
- **Approvals inbox** (`Inbox.tsx`, 521 lines): fake Chat/Feed tabs with a static "new" badge (`:276-279`); filter pills without `aria-pressed` (`:283-287`); `alert()` on publish failure (`:165`); day labels in UTC (`:217`); glyph buttons "▾ ▴ ⧉ ↗ ✓" (`:442-444, :476`); no pagination.
- **Calendar** (`CalendarPanel.tsx`): "today" in UTC (`:24-42`); week view `min-w-[860px]` scrolls sideways at 375px (`:85`); Arabic month grid forced `dir="ltr"` (`:116`); "‹ ›" not mirrored while keyboard arrows are (`:47-48, :78-80`); global single-key shortcuts re-bound every render (`:43-54`); empty cell links to the inbox instead of "create for this day" (`:104`).
- **Reports**: B-8; chart has no data-table alternative; range pills lack `aria-current` (`:106`).
- **Files**: raw `<pre>` preview (`:122`); no unsaved-changes guard (`:120`); unlabeled new-file input (`:96-97`).
- **Connections** (`IntegrationsPanel.tsx`, least migrated): first paint shows "no connections" then pops in (`:44-48`); B-11; disconnect without confirm (`:55-58`); two modals with `bg-black/40`, no dialog role, Escape, trap, and a "✕" close with no name (`:249, :271`).
- **Notifications** (`NotificationsPanel.tsx`, 37 lines): marks everything read 1.5 s after mount (`:13`); unread is `bg-lemon/5` only (`:23`); raw UTC timestamps (`:25`).
- **Routines** show raw outcome strings ("Ran: ok:3").
- **To-do** (`TodoPanel.tsx`) handles empty, all-clear, done, deleted and undo well: the reference screen for states.

**Fix.**
- Connections: rebuild on primitives, skeleton, confirm on disconnect, i18n errors, Dialog (M, P1; alerts P0 via B-11).
- Notifications: per-item read on open plus "mark all read", unread dot + bold + text label, group by day with `<Time>` (S, P1).
- Calendar: agenda list below md, drop forced `dir`, mirrored chevron icons, focus-scoped shortcuts, empty cell opens chat for that date (M, P1).
- Inbox: real tabs or none; `aria-pressed`; Icons for glyphs; toast instead of alert; pagination at 50 (M, P1).
- Files: rendered markdown preview via `render()`; dirty guard (S–M, P2).
Impact H (Connections, Notifications), M (others).

### 4.7 Settings and account security

**supastarter pattern.** One settings area with a menu (`SettingsMenu`): General (avatar with crop dialog and signed upload, name, email, language saved to the user, delete account), Security (set vs change password with shared rules, passkeys with rename, 2FA, active sessions with readable labels, connected accounts), Notifications (per type × channel), Billing; organisation settings (logo, members with role descriptions inside the select, invitations, billing, owner-only delete). **Each setting is its own card with its own Save button, disabled until the field is valid and changed.** Their gaps: some inputs lack labels, 2FA has no backup codes, revoking a session has no confirmation.

**Thakeen today.** No settings area: Profile, Notifications, Tasks, Generate, Billing, Brand file, Brands, Members, MCP, Help from the popover (`Sidebar.tsx:165-170`); Governance and Integrations in the rail. [shot: `th-profile-ar-full-d`, `th-profile-ar-m`, `th-team-ar-d`]
- `ProfilePanel.tsx` (335 lines): 9 cards in one column mixing credit usage, subscription, email prefs, account, social, business, SEO, password, logout, delete (`:193-333`). Brand fields also edited in `BrandForm.tsx:87-93` (two save paths). One top-of-page message banner for all forms (`:196`), so password and delete errors appear off-screen; success and error look identical (lilac). One "Save changes" for five cards (`:303`).
- Password change lacks live `PasswordRules` (`:306-316`); no session list or "sign out other devices" (`:319`); no 2FA; email immutable (`:273`).
- B-3 delete via prompt; no consequences, subscription warning or export.
- Team (`TeamPanel.tsx`) is the best panel: seats progressbar with ARIA, `useConfirm`, alert/status messages, copy-link fallback. Gaps: role change applies on select without confirm (`:106-109`), no resend invite.
- BrandsPanel: rename via `prompt()` (`:86`), archive without confirm (`:87`), raw styles (`:63-85`), no empty state.
- BrandForm: ~11 placeholder-only fields (`:62-93`), B-10, chips without `aria-pressed` (`:106`), raw English channel ids in Arabic.

**Fix.** `/{lang}/app/settings/*` with a `SettingsLayout` (secondary nav: start-side column on desktop, list on mobile) and per-setting cards with their own Save:
- **Account** (name, phone, language, email prefs) · **Security** (password with live rules, sessions list, sign out others by rotating the session version, 2FA later with backup codes) · **Notifications** (per type × channel: in-app, email; WhatsApp later) · **Brand** (one labelled brand form) · **Brands** · **Members** (Team as is) · **Billing** · **Connections** · **Governance** · **Danger zone** (export, then delete in a dialog).
- Old routes redirect (308) for one release, then go.
- Moving notification preferences is a **read-both, write-new expand** step (§7).
Effort L · Impact H · **P1**.

### 4.8 Billing

**supastarter pattern.** Billing settings show the current plan and trial end (2026-10-09), a "Manage subscription" button with a loading state that opens the provider portal, past-due users routed to billing; checkout and portal follow the UI locale; a `choose-plan` page and a `checkout-return` route; pricing grid with a recommended highlight (container queries in the template; CSS subgrid on their own site). [shot: `ss-demo-mkt-full-d` pricing with Monthly/Yearly tabs]

**Thakeen today.** `src/app/[lang]/app/billing/page.tsx` (143 lines). [shot: `th-billing-ar-full-d`, `th-billing-ar-m`]
- Credits, seats and dates repeated in the summary (`:82-87`), PlanIncludesCard (`:31-58`) and ChatAllowanceCard; plans come last, below the fold on mobile.
- No current-plan marker; no recommended tier; credits lines and top-up prices in `text-danger` (`:116, :134`, `TopupCard.tsx:64`); raw ink-pill pay buttons (`:122-137`, `PaymobBilling.tsx:71`); features cut to 4 with no "see all".
- Paymob return: "If your payment went through … Refresh this page" (`:89-91`), no polling, no result state.
- B-9 auto-renew off and remove card without confirm.
- No customer invoices, receipts or payment history; no ZATCA e-invoice.
- LimitModal is a div dialog without trap or focus restore (`LimitModal.tsx:92`); its routing copy is good.
- Pricing page (marketing): highlighted Pro shows 3 of 5 bullets as «(قريباً)»; VAT exclusion only in the sub-heading (`src/lib/i18n.ts:252-255, 404-407`); credits table without `<thead>`/`<caption>` (`Pricing.tsx:71-82`). [shot: `th-pricing-ar-d`, `th-pricing-ar-m`]

**Fix.**
1. `PlanCard` with Current and Recommended badges, ink prices, «+ ضريبة القيمة المضافة» under each price, `Button`, full feature list behind "See all" (M, P1).
2. One summary block (plan, renews/ends, credits meter, seats meter) at the top; plans next; add-ons (top-up, partner code, offer) after (S, P1).
3. Paymob return polls a billing-status endpoint and shows success / pending / failed with a next step (M, P1).
4. Billing → History table from Paymob callbacks with a receipt view; plan the ZATCA simplified tax invoice (VAT number, QR, sequence). New stored records, expand only (L; P1 history, P2 ZATCA after legal review).
5. Paid tiers list only what works today; "coming soon" items move to a separate row (S, **P0** for honesty).
6. LimitModal on the `Dialog` primitive (S, P1).
Impact H.

### 4.9 Founder console (admin)

**supastarter pattern.** Users and organisations lists with search and paging held in the URL; edit dialogs; ban/unban with internal reason and expiry (2026-08-04); impersonate and ban through promise toasts (loading → success/error). Their gaps: **no impersonation banner and no "stop impersonating" UI**, empty state hard-coded "No results.".

**Thakeen today.** Own shell (`admin/layout.tsx:17-27`, `AdminNav.tsx`, 9 sections). [shot: `th-admin-ar-d`, `th-admin-users-ar-d`, `th-admin-ar-m`]
- B-1, B-2, B-4, B-6.
- Users table (`Users.tsx`, 512 lines): client-side substring search (`:304`) with an unlabeled raw input (`:311`); no pagination, sort or filters; 13 columns (`:326-366`); `text-left` in RTL (`:328`, also `Quality.tsx:26`); plan changed by an inline select showing raw ids and firing on change (`:338-340`).
- User detail renders inline below the whole table (`:369-508`); brand file as raw `JSON.stringify` (`:474`).
- Impersonation: one click, no confirm or reason (`:376`). Thakeen does have a customer-side banner (ahead of supastarter), but it scrolls away and the email is not isolated (`app/layout.tsx:67-72`).
- English in the Arabic console: SUSPENDED (`:334`), action results (`:50-56`), Log headers (`Log.tsx:19`), MediaReport (`Billing.tsx:11-27`).
- Audit log hides the actor column although the type has it (`Log.tsx:11`); before/after as raw JSON.
- KPI tiles without deltas; B-8 chart.
- Six admin components live in `components/app/` (LeadsPanel, PartnersPanel, WishlistPanel, PaymentsPanel, GoldenPanel, EntitlementsTable).

**Fix.**
1. Phase 0 guards (B-1/2/4).
2. `DataTable` with server-side filters (plan, suspended, unverified, trial ≤ 24h, credits < 10, inactive 14 d), sort, pagination, URL-held query, sticky header (L, P1).
3. User detail in a `Sheet` (inline-end) with tabs Overview · Billing · Usage · Activity · Brand; brand as fields, not JSON (M, P1).
4. FormDialog with a **required** reason for every money or access change; impersonation dialog with reason and duration (15/60/120), sticky banner with countdown, `<bdi>`, and a Stop button (S–M, P1).
5. Audit log: actor column, field-level diff chips, filters, link to the user (S, P1).
6. All strings into admin dictionaries; `text-start`; a unit test scanning `src/components/admin/**` for Latin JSX text (S, P1).
7. Move the six admin panels to `components/admin/` (S, P2).
Impact H for the founder.

### 4.10 Auth

**supastarter pattern.** Centred `max-w-md` card; Password | Magic link tabs; show/hide eye; "Forgot password?" beside the field; Google, GitHub and passkey sign-in; **"Last used" badge** on the last method (2026-08-18); a translated map of ~25 auth error codes; success messages that replace the form; signup with a live password checklist; OTP input with autofill and auto-submit; theme toggle and language select in the top bar; correct `autocomplete`. [shot: `ss-app-login-d`, `ss-app-login-m`, `ss-app-signup-d`, `ss-app-signup-m`, `ss-app-forgot-d`]

**Thakeen today.** Email + password only; Turnstile on signup and forgot. [shot: `th-login-ar-d`, `th-login-ar-m`, `th-login-en-d`, `th-signup-ar-d`, `th-signup-ar-m`]
- Placeholder-only fields: login email has no label, `aria-label` or `autoComplete` (`AuthForm.tsx:130-131`); signup `:77-82`; forgot uses the page title as `aria-label` (`:184`).
- Submit buttons show no busy text (`:133`); JoinForm does (`JoinForm.tsx:138`), the model to follow.
- Errors not linked to inputs (`aria-invalid` used once or twice in the codebase); three error styles.
- Signup: two steps with no "1 of 2"; trial note below the button (`:91`); legal text 12px (`:95`).
- Forgot and verify success boxes are `bg-ground` on a `bg-ground` page, nearly invisible (`:178`, `VerifyForm.tsx:201`).
- Reset token not checked on load (`:201-243`); verify does not auto-submit at 6 digits; no help link on auth pages (WCAG 3.2.6).
- Good already: PasswordField with `aria-pressed` toggle at the inline end; PasswordRules with sr-only text and live status; OTP `inputMode="numeric"` + `one-time-code`; tokens in the URL fragment.

**Fix.**
1. `Field` everywhere (visible label, hint, error, `aria-describedby`, `aria-invalid`), `autoComplete="username"`/`current-password`/`new-password`, 16px inputs on mobile (M, **P0** for login, P1 rest).
2. Loading `Button` on every submit (S, P1).
3. Translated auth error map (AR/EN), success replaces the form (S, P1).
4. Status boxes on the `Callout` primitive with icon and `role="status"` (S, P1).
5. Verify auto-submit + spam hint; reset token pre-check; Help/WhatsApp link in the auth header (S, P1).
6. Email-code ("magic link") login as an alternative: Gulf SMB owners forget passwords (M, P2).
7. "Last used" badge once there are two methods (S, P2).
8. Google sign-in: product decision first (P2, OAuth review).
Impact H (first impression, conversion).

### 4.11 Onboarding

**supastarter pattern.** Multi-step form with a steps array, per-step validation and translations, a progress indicator; org creation and avatar upload. Plain and functional.

**Thakeen today.** `/app/start` is a 7-step «قاموس ذكين» game (`DictionaryStart.tsx`, `StartLaunch.tsx`): steps 3–6 show samples; the build happens at step 7. [shot: `th-start-ar-d`, `th-start-ar-m`]
- Nothing persists: a refresh loses every answer.
- Next disabled with no stated reason (`:240`); step names sr-only on mobile so sighted users see bare numbers (`:218`); Arabic-Indic digits on the rail (`:217`).
- StartLaunch notes lemon on paper (`:96, :103`), busy label "…" (`:111, :124`).

**Gap.** Small. Thakeen's onboarding has more personality than supastarter's; it needs robustness.

**Fix.** sessionStorage per step (S, P1); reason text next to the disabled button (S, P1); short step names visible on mobile (S, P2); consider merging sample steps 3–6 into two (M, P2, test with real users first).
Impact M.

### 4.12 Marketing home and pricing

**supastarter pattern.** [shot: `ss-home-d`, `ss-home-full-d`, `ss-home-m`, `ss-home-full-m`, `ss-demo-mkt-d`, `ss-demo-mkt-full-d`, `ss-demo-mkt-m`]
- Sticky nav that blurs on scroll; centred hero with a "New: …" pill linking to the changelog; a buyer-specific H1; four check bullets; price inside the primary CTA; secondary "See demo".
- **Feature explorer**: tabs whose panels are coded HTML mockups (file tree, sign-in card, members list, language switcher, API panel), not screenshots; each tab links to its docs page; below `lg` tabs become stacked cards. The template demo's hero is also an HTML dashboard mock, not an image.
- Copy framed against the failure of the alternative.
- Layered trust: named avatars, live product showcase, quotes with source links, founder faces, "Last updated 1 day ago" chip on the pricing card.
- Weak: very long page, proof numbers disagree (1503 vs "thousands" vs 1200+), dark only, no refund statement, stale legal dates (2022/2023). The template's testimonials are invented placeholders (labelled as replaceable on the demo).

**Thakeen today.** Strong art direction (scribble, lineup with `aria-pressed` and a polite live announcer, MotionToggle, reduced-motion and forced-colours handling). [shot: `th-home-ar-d`, `th-home-ar-full-d`, `th-home-ar-m`, `th-home-ar-full-m`, `th-home-en-d`]
- B-7 font.
- No hero CTA or URL field; the only CTA is in the nav; no FinalCta at the end of home (`home/Cover.tsx`).
- Dead code: `home/Dictionary.tsx`, `home/StartForm.tsx` and their CSS (`home.module.css:80-111, :289+`).
- Nav: dropdown trigger is a navigating `<Link>` with `aria-haspopup` (`Nav.tsx:26`); hover-only open, no Escape (`:31`); English `aria-label="Main"` on Arabic (`:61`); mobile menu is a `<details>` with a 36px trigger that never closes and full-reload `<a>` links (`:79-93`).
- ~9 infinite home animations keep running off-screen.
- Five H1 scales; 404 and error pages strand the user without nav (`not-found.tsx`, `error.tsx:30` links only to `/ar`). [shot: `th-404-ar-d`]

**Fix.**
1. Hero primary CTA «ابدأ مجاناً» + optional URL field pre-filling `/app/signup?url=`; FinalCta at the end (S, P1). Do **not** put the price in the CTA; show «3 أيام مجاناً، بدون بطاقة» under it.
2. **Coded mockup explorer** (the one big idea worth taking): tabs per agent (Noor plans, Sami writes, Dana reports, Reem schedules) whose panels are live Arabic/English HTML mockups built from our own primitives: an approval card, a calendar week, a report chart, a chat turn. Crisp, translatable, mirrored, cheap to keep current, and it replaces sections rather than adding them (M–L, P1).
3. Freshness chip on pricing («آخر تحديث: …» → `/updates`) and a «جديد» pill in the hero, both generated from the updates feed, never hand-typed (S, P2).
4. Nav as a client disclosure (44px, `aria-expanded`, closes on Escape / outside click / route change, `Link`), Arabic labels, blur on scroll (M, P1).
5. Pause off-screen animations with an IntersectionObserver (S, P2).
6. One `.page-hero-title` and one container rule (S–M, P1).
7. 404/error with nav, footer and a language-correct home link (S, P1).
8. Delete dead files (S, P2).
Impact H (acquisition).

### 4.13 Docs, changelog, help

**supastarter pattern.** [shot: `ss-docs-d`, `ss-docs-m`, `ss-changelog-d`] Fumadocs three-column docs with ⌘K search, file-titled code blocks, "Copy as Markdown" / "Copy Prompt", `.md` twins, `llms.txt`. Changelog: roadmap block, dated entries grouped New / Improved / Fixed / Security, filter, pagination.

**Thakeen today.** `/updates` page and HelpCenter (`components/HelpCenter.tsx`): "Talk to us" card renders dead when WhatsApp is unset (`:55`); English placeholder and `aria-label` on the Arabic email field (`:64`); fetch without `.catch` leaves the UI stuck (`:20`). `llms.txt` exists.

**Fix.** Arabic-first help centre organised by job («ربط إنستغرام»، «اعتماد منشور»، «شحن الرصيد») with search; updates written for owners (what changed for you), typed New / Improved / Fixed, the same feed powering the freshness chip; fix HelpCenter states. Developer docs affordances (Copy Prompt, `.md` twins) are not for our buyer.
Effort M · Impact M · **P2**.

### 4.14 States and feedback: loading, empty, error, dialogs, toasts

**supastarter pattern.** Skeleton and Spinner primitives with row-shaped skeletons; loading button; promise toast; global confirm. Note: supastarter itself has **no `loading.tsx` / `error.tsx`** either; a failed server prefetch shows the framework error page. Here Thakeen should go further than the benchmark.

**Thakeen today.**
- **0 `loading.tsx`**; force-dynamic app pages await 5–11 Redis calls with no feedback (chat `chat/page.tsx:65, :80`).
- Only `[lang]/error.tsx`, above the app layout, so any app error **drops the sidebar**; it uses loud marketing scribble and links Home to `/ar` (`error.tsx:30`). No `app/error.tsx` or `admin/error.tsx`.
- **44 native dialogs**: `prompt()` ×35 (Users ×30, PaymentsPanel `:134`, PartnersPanel `:274`, BrandsPanel `:86`, ProfilePanel `:178`), `confirm()` ×3 (Users `:157, :228, :250`), `alert()` ×6 (Inbox `:165`, Integrations ×5). They ignore language and direction and cannot mask a password or require a field.
- No toast system; feedback is per-component `msg`/`err`, often far from the action; success and error share lilac.
- 0 `scroll-padding`, so focus can hide under the sticky nav and bottom toasts (WCAG 2.4.11).
- Empty states mostly plain text; the design system's "scribble on empty states" rule is unmet.

**Fix.**
- `app/error.tsx` and `admin/error.tsx` inside their shells, quiet style, language from the pathname, Retry (S, **P0**).
- `app/loading.tsx` (shell skeleton) + route skeletons for chat, inbox, billing, reports, admin; Suspense around layout data (M, P1).
- `ToastProvider` (polite live region, inline-end bottom in RTL, success / error / info, promise helper) (M, **P0**).
- `FormDialog` / `PromptDialog` beside ConfirmDialog; migrate all 44 calls (M, P0 for B-3/B-4/B-11, P1 rest).
- `html { scroll-padding-block: 72px 88px }` (S, P1).
- `EmptyState` with a scribble figure and one action; `ErrorState` with retry (S–M, P1).
Impact H.

### 4.15 Accessibility (WCAG 2.2 AA) and RTL

**supastarter pattern.** Base UI primitives give focus management, roving tabindex and labelled controls. RTL: none. No `dir` attribute anywhere, ~142 physical spacing/position classes, latin-only fonts, chevrons not mirrored, emails hard-coded `lang="en"`; the only RTL claim is marketing copy on a Nuxt page. Their a11y gaps: no skip link, icon buttons without labels, clickable `div` cards.

**Thakeen today.** Strengths: `<html lang dir>` per locale (`[lang]/layout.tsx:59`); global 2px `:focus-visible` ring (`globals.css:142`); scribble controls 44–52px with forced-colours handling; reduced motion and a motion pause button; logical classes nearly everywhere (ms/me 43, text-start/end 78, physical ml/mr 0); strong base contrast; ConfirmDialog with `<bdi>`.
Gaps:
- B-6 titles; no skip link (§4.4).
- Placeholder-only labels across auth, BrandForm, Contact, Help, Affiliate, ToolForm, Files, admin search (1.3.1, 3.3.2); errors not bound (3.3.1).
- Live regions missing in chat and ToolForm output (`ToolForm.tsx:41`) (4.1.3).
- Four of five overlays without trap / Escape / focus return; closes named "✕" or "menu" (4.1.2, 2.1.2, 2.4.3).
- Roles declared without keyboard behaviour (Sidebar `:152-178`, ChatPanel `:670-688`).
- Targets: LangToggle sm ~20px tall (`LangToggle.tsx:31`), sidebar "+" ~19×16, `btn-xs` (~24px) on primary actions 128–139 times (2.5.8).
- Input borders `border-ink/15` at 1.1–1.35:1 (1.4.11).
- The ink focus ring is invisible on 117 `bg-ink` surfaces (2.4.7).
- RTL glyph bugs: send icon, "‹ ›", "▾", `← كل الأدوات` (`tools/[tool]/page.tsx:32`), `InspoPanel.tsx:75` "→", date ranges in SiteStats/SocialStats; forced `dir="ltr"` on the calendar month grid and on mixed Arabic values (`affiliates/page.tsx:43`); `text-left` in admin; English runs missing `lang="en"`.
- `PRODUCT.md:131` says there is no formal WCAG target.

**Fix.** Write **WCAG 2.2 AA** as the target in `docs/Design_System.md`. Most fixes ride on primitives (Field, Dialog, Sheet, Menu, Tabs, Switch). One `Icon` prop `mirror` for directional icons. Two-tone focus ring (paper inner, ink outer) or a lemon outline inside `.bg-ink`. Primary actions ≥ 44px; every target ≥ 24px. Input border at ink 55%. A CI check banning physical direction classes (`ml-`, `pl-`, `left-`, `text-left` …) in `src/`. An axe check on 10 key routes in the e2e suite (runs only when the PR is marked ready, per the CI rules).
Effort M (spread) · Impact H · **P0** (titles, skip link, login labels, chat live region, dialog traps), P1 rest.

### 4.16 Performance (static review)

**supastarter pattern.** Server prefetch before paint; lazy notification list; their weakness is a mobile-detection hook that shifts layout and a cookie-read sidebar that flashes.

**Thakeen today.**
- ~11 font preloads on every route, including 243.7 KB of Thmanyah weights and 6 Plex files the home page never paints (`[lang]/layout.tsx:13-23`, B-7).
- `<Scribble>` is a client component at ~192 call sites; each measures layout (`getComputedStyle` + ResizeObserver) and re-renders; the server draws with `rtl:false`, so Arabic art **flips at hydration**.
- The whole `appDict[lang]` (~106 KB Arabic source) is passed as props 101 times and lands in the RSC payload of every app page.
- 0 `loading.tsx` (§4.14); 45 `router.refresh()` calls used as state sync; ~9 infinite home animations off-screen.

**Fix.** `preload: false` on Mono and non-critical Thmanyah weights, per-locale subsets (S, **P0**); pass `rtl` from `lang` on the server, make static scribbles server-rendered and keep client measurement only for resizable hosts with one shared ResizeObserver (M, P1); pass dictionary slices per component (M, P1); `WorkspaceContext` to cut refreshes (§4.4).
Impact M–H (LCP, INP on mid-range Android).

### 4.17 Dates, numbers, plurals

**supastarter pattern.** Typed message keys with default-locale fallback; locale prefix on marketing and a cookie locale in the app saved to the user; localized mail subjects; checkout in the UI locale.

**Thakeen today.** `dateFormat()` (`src/lib/dates.ts:21`) is fixed to `timeZone: "UTC"` and used in 4 components; 56–61 raw `.slice(0,10|16)` display slices in ~29 files; calendar "today" and inbox day labels wrong between 21:00 and 24:00 Riyadh time; two plural implementations that disagree; trial length "3 days" hard-coded (`ProfilePanel.tsx:187`, `app-i18n.ts:77`).

**Fix.** `<Time value style relative>` and `<Money>` on `Intl.DateTimeFormat` / `Intl.NumberFormat` with the brand timezone (default `Asia/Riyadh`), Western digits, optional Hijri second line; `plural(lang, n, forms)`; a lint rule against display slicing; trial length from one constant.
Effort S–M · Impact M · **P1**.

---

## 5. Design-token proposal

Principles: keep Thakeen's palette and three layers; **expand only** (no renames in the first release, the expand/contract rule applied to the CSS contract); every new semantic token gets a light and a dark value from day one even while dark stays off.

### 5.1 New semantic tokens (light values from existing primitives)

| Token | Light | Dark (proposed) | Replaces |
|---|---|---|---|
| `--color-foreground-muted` | muted `#5d4a70` | `#c9bcd6` | `text-ink/70` ×130, `text-ink/80` ×26 |
| `--color-foreground-subtle` | ink @ 55% | lilac @ 55% | `text-ink/50`, placeholders |
| `--color-border` | ink @ 18% | lilac @ 16% | `border-ink/10`, `/15`, `/5` on cards and dividers |
| `--color-border-input` | ink @ 55% (≥ 3:1) | lilac @ 50% | `border-ink/15` on inputs (fixes 1.1–1.35:1) |
| `--color-border-strong` | ink | lilac | `border-[1.5px] border-ink` |
| `--color-surface-muted` | ground `#f7f3f9` | `#231531` | `bg-ground` boxes, `bg-ink/5` |
| `--color-popover` | paper | `#2a1b3a` | menus, popovers |
| `--color-overlay` | ink @ 45% | black @ 60% | `bg-black/40` (Integrations) |
| `--color-success` / `-foreground` / `-tint` | new primitive `#1f7a4d` / paper / success @ 10% | `#5fd39a` / ink / @ 16% | positive states (none today) |
| `--color-warning` / `-foreground` / `-tint` | new primitive `#8a5a00` / paper / `#fff4d6` | `#ffcf66` / ink / @ 16% | lemon-on-paper notices |
| `--color-info` / `-tint` | ink / lilac | lilac / `#3a2850` | ReadOnlyNote, info callouts |
| `--color-danger` (keep) / `-tint` | `#cc0000` / @ 8% | `#ff6b6b` / @ 16% | errors only |
| `--color-text-accent` | ink, bold weight | lilac | **decorative `text-danger`** (agent names, labels, icons, prices) |
| `--color-notice-bg` / `-border` | lilac / ink @ 30% | `#2a1b3a` / lilac @ 30% | `bg-lemon/10`, `border-lemon/40` on light |
| `--color-ring-inverse` | lemon | lemon | focus ring on `bg-ink` surfaces |
| `--chart-1..5` | ink, agent-sami, agent-dana, agent-faris, muted (each ≥ 3:1 on paper) | lilac and agent tints | Reports and Overview series (B-8) |
| `--radius-card` | one value (e.g. `0.75rem`) | same | `.card` 0.375rem vs `rounded-xl` drift |
| `--leading-body` / `--leading-title` | 1.5 / 1.25 EN; 1.7 / 1.4 under `:lang(ar)` | same | Tailwind defaults |
| `--text-xs-min` | 13px under `:lang(ar)` | same | 526 `text-xs` at 12px |
| `--hit-min` / `--hit-floor` | 44px / 24px | same | `btn-xs` on primary actions, tiny toggles |

Rules to add to `docs/Design_System.md`:
- Danger is for errors and destructive actions only. Prices and labels use `text-accent` or ink.
- Lemon only as a fill on ink or as the `btn-accent` CTA on inverse surfaces; notices on light use `notice-*`.
- Status is never colour-only: dot + text label, or icon + text.
- Every chart series ≥ 3:1 against its surface.
- No letter-spacing or uppercase on Arabic; no font weight that is not loaded.

### 5.2 Dark mode (Phase 5, after the codemod)

- Ground deep aubergine (`#1a1024`), surface `#231531`, foreground lilac `#efe7f7`; primary flips to lilac with ink text; lemon stays the CTA (it was designed to sit on ink, so it works better on dark than on light).
- System / Light / Dark segmented control in Settings → Account and in the user menu, stored per user (new optional field: expand step), `prefers-color-scheme` as default; `color-scheme` declared per theme.
- Declare `color-scheme: light` **now** (Phase 0) so browsers in dark mode stop tinting form controls.

### 5.3 What not to take from supastarter's tokens

Their olive / sand palette and "touch" accent, the 350 body weight and `tracking-tight` (bad for Arabic joining), and the opacity-only grey system (opacity greys are exactly what makes our dark mode expensive today). Do take what they lack and we already have: motion tokens and reduced-motion handling.

---

## 6. Component inventory: build, replace, keep

`src/components/ui/` (new, Thakeen code on our tokens). "Replaces" lists the duplicates it retires.

| Component | Action | Replaces / uses | Phase | Effort |
|---|---|---|---|---|
| `Button` (primary, secondary, accent, danger, ghost; sm/md/lg; `loading` with spinner + `aria-busy`) | Build on `.btn` | 77 ad-hoc buttons, ≥12 raw ink pills, "…" busy labels | 1 | M |
| `Field` (label, hint, error, required, auto-wired `aria-describedby` / `aria-invalid`) + `Input`, `Textarea`, `Select` (16px on mobile, `dir="auto"` on free text) | Build | 52 ad-hoc inputs, placeholder-as-label everywhere | 1 | M |
| `Switch` | Build | 5 copies | 1 | S |
| `Badge` (neutral, success, warning, danger, info, accent; tint style) | Extend `.badge` | 18 ad-hoc pills, SUSPENDED chip, role chips | 1 | S |
| `Callout` / `Alert` (info, success, warning, danger) | Build | ReadOnlyNote styles, `bg-agent-sami/20` boxes, invisible `bg-ground` status boxes | 1 | S |
| `Toast` + `ToastProvider` (promise helper, polite live region) | Build | 33 local `msg`/`err`, `.journey-toast`, TodoPanel bar | 1 | M |
| `Dialog`, `FormDialog`, `PromptDialog` | Build on ConfirmDialog's `<dialog>` | 44 native dialogs, LimitModal, 2 Integrations modals | 1 | M |
| `ConfirmDialog` / `useConfirm` | **Keep**, move to `ui/`, add loading on confirm | — | 1 | S |
| `PasswordField`, `PasswordRules` | **Keep**; add Rules to password change | — | 1/3 | S |
| `Time`, `Money`, `plural` | Build | 56–61 raw slices, UTC `dateFormat`, 2 plural copies | 1 | S–M |
| `SkipLink` | Build | none today | 0 | S |
| `Sheet` (inline-end side panel, mobile bottom) | Build | Sidebar drawer, AdminNav drawer, admin user detail | 2 | M |
| `Menu` (roving focus, outside click, focus return) | Build | Sidebar `role="menu"`, chat specialists popover | 2 | M |
| `Tabs` (roving, tabpanel) | Build | Inbox fake tabs, admin detail | 2 | S–M |
| `Skeleton`, `Spinner` | Build | "…", "Loading…" | 2 | S |
| `EmptyState`, `ErrorState` | Build (scribble figure) | plain-text empties | 2 | S |
| `PageHeader` (title, sub, actions) | Build | 29 `.page-title` + ad-hoc subs | 2 | S |
| `NotificationCenter` (bell, popover, unread, 99+) | Build | NotificationsPanel auto-read | 2 | M |
| `Icon` `mirror` prop | Extend | unmirrored send, chevrons, arrows; glyph buttons | 2 | S |
| `Avatar` (initials, image) | Build | Sidebar `avatar()`, TeamPanel initials | 2 | S |
| `CopyButton` | Build | 9 clipboard implementations | 2 | S |
| `ApprovalCard` + `CHANNEL_LIMITS` | Extract | ItemCard + Inbox card, two limit tables | 2 | M |
| `SettingsLayout`, `SettingsCard` (per-card save, disabled until valid and changed) | Build | 8 scattered routes, one-save Profile | 3 | M |
| `PlanCard`, `UsageMeter` (`role="progressbar"`) | Build | billing cards, credit bars | 3 | M |
| `DataTable` (server sort/filter/paginate, URL state, sticky header, row actions, empty, loading) + `Pagination` | Build | 15 tables / 8 styles, admin Users | 4 | L |
| `Tooltip` | Build | 59 `title=` | 4 | S |
| `StatTile` (value, delta, period) | Build | admin KPI tiles, conversation stats | 4 | S |
| `ThemeToggle` (System / Light / Dark) | Build | — | 5 | S |
| `MockupExplorer` (marketing, coded agent mockups) | Build from app primitives | static illustrations | 5 | M–L |
| `Scribble` | **Keep**, make server-rendered by default | 192 client instances | 2 | M |
| `Wordmark`, `LangToggle` (raise sm size), `AgentAvatar`, `Turnstile` | **Keep** | — | — | — |

Helpers to centralise: `fill()` (8 copies) into one i18n helper; one SSE parser for chat (2 today).

Dependency stance: no UI library is required. If headless primitives are wanted later, Base UI is what supastarter moved to; adding it is a dependency change that must follow the lockfile and `min-release-age` rules in CLAUDE.md, and its components would still need RTL review.

---

## 7. Phased rollout

Rules applied:
- **CI minutes:** each phase is built on a branch with no PR, proven locally (`npm run check`, `npx next build`), pushed once, opened as a **draft** PR, marked ready once. No fix-up pushes.
- **Expand / contract:** UI-only changes have no stored-shape impact. Three items touch stored shapes and follow two releases: theme preference (new optional user field), notification preferences moving under Settings (read old + new, write new; contract later), billing history records (new keys, expand only). Old settings routes redirect for one release, then are removed in a contract release.
- **Tests:** every rule touched gets a test in `tests/` and a coverage note in `docs/system/tests/NNNN-slug.md` (check the next free rule number at the time of work).
- **Docs:** route and permission changes update `docs/system/architecture.md`, `flows.md`, `permissions.md` in the same commit.
- **No production without the founder's release PR.** Phases land on `main` (staging); the founder releases to `production`.

| Phase | Content | Size | Gate |
|---|---|---|---|
| **0 · Bugs and quick wins** (1–2 days) | B-1…B-11; titles on all 40 pages; skip link + `<nav>` + `aria-current`; `color-scheme: light`; `app/error.tsx` + `admin/error.tsx`; chat `role="log"` + key fix; Arabic letter-spacing off; Plex 700 or weight cap; font preload trim; "coming soon" out of paid-tier bullets; `hello@nashr.ai` replaced; mobile nav trigger 44px; Arabic `aria-label`s; `text-left` → `text-start`; mirrored arrows; Western digits | ~25 files, S each | unit tests for admin abort guards, chat key and titles; one draft PR |
| **1 · Tokens + core primitives** (3–4 days) | Semantic tokens §5.1 (expand only); `Button`, `Field` family, `Switch`, `Badge`, `Callout`, `Toast`, `Dialog`/`FormDialog`, `Time`/`Money`/`plural`; migrate auth forms, BrandForm, BrandsPanel, Profile delete, Integrations; lint rules (decorative `text-danger`, lemon on light, display slicing, physical direction classes) as warnings | M–L | visual check AR/EN at 375 and 1440 locally; one draft PR |
| **2 · Shell, chat, states** (1 week) | Rail regroup, `WorkspaceContext`, `Sheet`, `Menu`, `Tabs`, `Skeleton`, `EmptyState`, `PageHeader`, `NotificationCenter`; `loading.tsx` set; chat mobile pane, textarea composer, Stop, copy/retry; `ApprovalCard`; calendar agenda + RTL; reports chart tokens; server-rendered Scribble; dictionary slices | L | axe on 10 routes in e2e (ready-only) |
| **3 · Settings + billing** (1 week) | `SettingsLayout` and routes; Security (live rules, sessions, sign out others); notification preferences (expand); Danger zone; `PlanCard`, summary block, Paymob return polling, history table (expand) | L | redirects for old routes; expand release named in the PR |
| **4 · Founder console** (1 week) | `DataTable` + server filters + URL state; user `Sheet` with tabs; required-reason FormDialog; impersonation dialog + sticky banner with Stop; audit log actor/diff/filters; admin i18n scan test; admin panels moved to `components/admin/` | L | founder walkthrough on staging |
| **5 · Dark mode + marketing** (2 weeks) | Codemod ~400 opacity utilities to semantic utilities; dark values; `ThemeToggle` + user field (expand); `MockupExplorer`; freshness chip from the updates feed; hero CTA | L | a later contract release removes old settings routes and old preference reads |

---

## 8. What NOT to copy (Arabic-first Gulf SMB product)

1. **Dark-only marketing site.** Our buyer reads on a phone in daylight; light first, dark as an option.
2. **LTR-only markup and components.** supastarter has no `dir`, ~142 physical classes, latin-only fonts, unmirrored chevrons, emails fixed to `lang="en"`. Do not import their components or class patterns; re-implement on logical properties.
3. **The generic neutral SaaS look** (olive/zinc greys, thin line icons, light 350 weights, `tracking-tight`). It would erase the ink-and-lemon scribble identity that is Thakeen's main visual asset.
4. **Developer-buyer copy and trust devices**: "for your coding agent", GitHub sign-in, file-tree mockups, Copy Prompt buttons, `.md` twins as a customer feature.
5. **Price inside the hero CTA and one-time "lifetime" framing.** We sell monthly SAR plans with VAT; the trial («3 أيام مجاناً، بدون بطاقة») is the hook.
6. **Invented testimonials, avatar walls and proof numbers.** CLAUDE.md forbids invented customers, logos, testimonials and numbers; supastarter's template ships invented quotes and its own site's numbers disagree (1503 vs "thousands" vs 1200+). Copy only the honest pattern: label placeholders as placeholders, and show nothing until it is real.
7. **Very long single-page marketing** (9 tabs + 17 cards + ~40 testimonials). Keep our page short; the explorer replaces sections.
8. **Floating FAQ widget** bottom-right: in RTL it collides with the WhatsApp entry point Gulf customers expect; use the help centre and WhatsApp.
9. **Provider-hosted billing portal as the only billing UI.** Paymob has no equivalent and ZATCA invoices must be ours; build history and receipts in-app.
10. **Organisation-first IA** (create an organisation before anything). Our unit is the brand; teams and multi-brand are secondary and already modelled.
11. **Uppercase eyebrows and letter-spaced labels.** Arabic has no case; letter-spacing breaks joining.
12. **Language select tucked in a corner, English as default.** Language is a first-class header toggle; Arabic is the default.
13. **Emoji-headed comparison pages** (⚖️ 🔍 ✅/❌). They read as low-trust in formal Gulf business Arabic.
14. **Imperative global `confirm()` without a loading state, session revoke without confirmation, 2FA without backup codes.** Their gaps; build ours complete.
15. **Stale legal pages and docs drift.** Their Terms are dated 2022; ours must carry a real date and stay current.

---

## 9. Appendix

### 9.1 Screenshot index (Artifact and `coverage/uiux-shots/`)

supastarter: `ss-home-d`, `ss-home-full-d`, `ss-home-dark-d`, `ss-home-m`, `ss-home-full-m`, `ss-docs-d`, `ss-docs-m`, `ss-changelog-d`, `ss-demo-mkt-d` (cookie banner visible), `ss-demo-mkt-full-d`, `ss-demo-mkt-dark-d`, `ss-demo-mkt-m`, `ss-app-login-d`, `ss-app-login-dark-d`, `ss-app-login-m`, `ss-app-signup-d`, `ss-app-signup-m`, `ss-app-forgot-d`, `ss-app-404-d` (redirects to login).

Thakeen: `th-home-ar-d`, `th-home-ar-full-d`, `th-home-ar-dark-d`, `th-home-ar-m`, `th-home-ar-full-m`, `th-home-en-d`, `th-pricing-ar-d`, `th-pricing-ar-full-d`, `th-pricing-ar-m`, `th-login-ar-d`, `th-login-ar-dark-d`, `th-login-ar-m`, `th-login-en-d`, `th-signup-ar-d`, `th-signup-ar-m`, `th-404-ar-d`, `th-app-ar-d`, `th-app-ar-full-d`, `th-app-en-d`, `th-app-ar-m`, `th-chat-ar-d`, `th-chat-ar-m`, `th-tasks-ar-d`, `th-tasks-ar-m`, `th-calendar-ar-d`, `th-files-ar-d`, `th-reports-ar-d`, `th-integrations-ar-d`, `th-billing-ar-full-d`, `th-billing-ar-m`, `th-profile-ar-full-d`, `th-profile-ar-m`, `th-team-ar-d`, `th-admin-ar-d`, `th-admin-users-ar-d`, `th-admin-ar-m`, `th-start-ar-d`, `th-start-ar-m`.

### 9.2 Sources

- supastarter: https://supastarter.dev/, https://supastarter.dev/faq, https://supastarter.dev/docs/nextjs, https://supastarter.dev/docs/nextjs/customization/styling, https://supastarter.dev/docs/nextjs/internationalization, https://supastarter.dev/docs/nextjs/authentication/superadmin, https://supastarter.dev/changelog, https://demo.supastarter.dev/, https://app-demo.supastarter.dev/login, https://app-demo.supastarter.dev/signup. Licensed source at `~/projects/supastarter` (patterns only).
- Thakeen: this repository at `1fb56b90`; `docs/Design_System.md`; `docs/Admin_Console_Benchmark.md` §7, §9; `PRODUCT.md`; `docs/superpowers/specs/2026-10-08-supastarter-adoption-design.md`.
- Detailed audit notes (not committed): shared notes folder `uiux/` files A (supastarter source, 1246 lines, with a ranked top 25), B (supastarter web), C (marketing + auth), D (app shell + chat), E (settings, billing, admin, primitives), F (accessibility, RTL, performance).

### 9.3 Follow-ups outside UI scope (noticed, not fixed)

- Trial length must be one number across signup, profile, pricing and emails (3 days in code; earlier notes mention a 3 vs 7 mismatch elsewhere).
- `PRODUCT.md` drift: Readex Pro and the Sadu palette are still named (`PRODUCT.md:112, 116`) although `Design_System.md` removed them; the Design_System "Status (2026-09-17)" section is stale.
- Re-check the customers page against the no-invented-customers rule before adding any trust section.
