# سجل مهام المؤسس من اليوم الأول (2026-09-17 إلى 2026-10-11)

للمؤسس أبوالخير. هذا سجل كل ما طُلب منك أو انتظر قرارك منذ بداية المشروع، مع حالته ودليله.

- **العدد:** 105 مهمة. 32 منجزة، و56 مفتوحة، و2 منجزة جزئياً، و15 لم تعد لازمة.
- **المصادر:** `docs/Owner_Tasks_AR.md`، وقضايا GitHub بوسم `owner-task` و`founder-decision`، وملفات الذاكرة، وسجل الرحلة، ووثيقة Claude Docs بتاريخ 2026-10-04.
- **ترقيم المهام:** `F-NNN` هنا. في اللوحة التفاعلية صار `T-NNN` حتى لا يختلط بملاحظات مسار العمل F.
- **قاعدة الأسرار:** أسماء متغيرات البيئة فقط، بلا أي قيمة.

## هذا الأسبوع بالترتيب

1. قرار عنوان «عملاء جربوا ذكين» (I-001).
2. كلمة «انشر» لطلب الإصدار main إلى production. يصلح رابط `/p/` المعطّل (F-001).
3. إيقاف nashr-tau.vercel.app وتدوير WAITLIST_ADMIN_KEY (C-001، خطوات #319).
4. تجربة حقيقية لبريد التسجيل واستعادة كلمة المرور على thakeen.com (H-013).
5. نسخ احتياطي Upstash، وحدود صرف عند المزوّدين (F-005).
6. مدة التجربة: 3 أيام أو 7 (I-004).
7. متغيرات بيئة staging حتى يعمل فحص ما قبل الإصدار (F-002).
8. أوراق الشركة: السجل والرقم الضريبي والآيبان (G-002، #47).
9. حجز المحاسب والمحامي (G-003، C-002).
10. إغلاق قضايا `owner-task` المنجزة (قائمة «Stale Owner_Tasks items» أدناه).

## اقتراح لملف مهام المؤسس

نسخة مقترحة من `docs/Owner_Tasks_AR.md` في `docs/reports/2026-10-11-owner-tasks-proposed_AR.md`. لم تُطبّق؛ تُطبّق بعد موافقتك.

---

السجل الكامل أدناه، كما أخرجه مسار العمل K، بجداوله الإنجليزية وعمود الخطوة التالية بالعربية.

### Summary

1. 105 founder tasks found from 2026-09-17 to 2026-10-11: 32 done, 58 open (10 P0, 17 P1, 31 P2), 15 obsolete. Many open tasks are only "say one word" decisions.
2. The live site has a real bug the founder can end in one step: `https://thakeen.com/p/TEST123` answers 307 to `https://0.0.0.0:3000/ar/app/signup` (VERIFIED, curl 2026-10-11). The fix (#313) is on main. It waits on a release PR, and that release first needs the homepage heading decision (F-001).
3. The old Vercel project `nashr-tau.vercel.app` still answers (VERIFIED, 307 from server Vercel, 2026-10-11). It holds the WAITLIST_ADMIN_KEY value that was printed in chat on 2026-09-17 and never recorded as rotated there (#12).
4. No money can come in: there are no company papers (CR, VAT, IBAN; #47), Paymob is built but has no keys and no written answer, and the accountant and lawyer were never booked. No backup and no spend limits are recorded for the live Upstash DB or the providers.
5. `docs/Owner_Tasks_AR.md` (header 2026-10-08) is mostly stale. Section 000 and the P0 block still list Vercel Pro, nashr.ai, MobPay, PAY_LINK_*, QStash, CLAUDE_PAUSED and #243 review. All 23 `owner-task` issues and the `founder-decision` issue #193 are still OPEN, including ones already decided or done.

### Current state (2026-10-11)

| Item | State | Label |
|---|---|---|
| thakeen.com (Hostinger, from `production` 487984f4) | `/` 307 to `/ar`, `/api/health` 200 | VERIFIED (curl -I 2026-10-11) |
| Live `/p/{code}` partner link | 307 to `https://0.0.0.0:3000/ar/app/signup` (broken) | VERIFIED (curl -I 2026-10-11) |
| main vs production | main 3bf67673 (#318), 77 commits ahead; #298 #311 #313 #314 #315 #318 merged, not live | VERIFIED (git, snapshot 01-snapshot.md) |
| staging.thakeen.com | 404 at `/` (hcdn) | VERIFIED (curl -I 2026-10-11) |
| nashr-tau.vercel.app (old Vercel) | 307 to `/ar`, still serving | VERIFIED (curl -I 2026-10-11) |
| thakeen-prototypes.vercel.app | 200 | VERIFIED (curl -I 2026-10-11) |
| thakeen.sa, nashr.ai | no HTTP answer | VERIFIED (curl, no response) |
| Hostinger env names set 2026-10-08 | 11 names: ANTHROPIC_API_KEY, WAITLIST_ADMIN_KEY, CONNECT_SECRET, CRON_SECRET, ADMIN_EMAILS, MAIL_FROM, RESEND_API_KEY, APP_ORIGIN, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, VERCEL_ENV | UNVERIFIED: memory thakeen-hostinger-deploy only; hPanel not readable |
| Not set on live | PAYMOB_*, TURNSTILE_*, SUPPORT_WHATSAPP, WAITLIST_TO, COMPOSIO_*, FAL_KEY, KIE_*, HIGGSFIELD_*, MEDIA_MODELS_ON, BLOB_READ_WRITE_TOKEN, GOOGLE_*, MICROSOFT_*, platform *_CLIENT_ID/SECRET, STRAITLY_API_KEY, LLM_PROVIDER, APP_ENV | UNVERIFIED: inferred from the 11-name list |
| Env names documented | all names above appear in `docs/system/variables.md` | VERIFIED (grep 2026-10-11) |
| CLAUDE_PAUSED | false (`src/lib/model.ts:19`) | VERIFIED |
| Trial length | 3 days (`src/lib/auth.ts:237`), founder decided 7 on 2026-10-05 | VERIFIED code; decision from memory |
| `hello@nashr.ai` in src | 4 occurrences | VERIFIED (grep) |
| GitHub `owner-task` issues | 23 open (#8-#12, #46-#49, #131-#138, #188-#193), none closed | VERIFIED (gh issue list) |
| Open draft PRs needing founder | #316, #317, #319, #320 | VERIFIED (gh pr list) |
| Claude Docs "ذكين — مهامك والتكاملات المطلوبة" (6a53b650…) | read; dated 2026-10-04, rev 6; stale on Vercel Pro, PAY_LINK_*, QStash, MAIL_FROM, thakeen.com | VERIFIED (read tool) |

### Findings (P0 first)

1. **P0 Homepage heading before release (F-001).** `src/lib/home.ts` SCENES_COPY says «عملاء جربوا ذكين» over illustrative scenes (#311, merged 2026-10-10, not live). This conflicts with the CLAUDE.md rule against invented customers. It must be decided before the release PR, or the claim goes live. VERIFIED (leftovers audit; commit cb1748f8).
2. **P0 Release is blocked on the founder's word (F-002).** Six merged PRs are not live, including the `/p/` fix #313. The live bug is VERIFIED today.
3. **P0 Old Vercel project and secret (F-003).** nashr-tau still deploys main with the old env, and the WAITLIST_ADMIN_KEY rotation was never confirmed there (`docs/Owner_Tasks_AR.md:104,430`). VERIFIED (alive); the rotation state is UNVERIFIED.
4. **P0 Mail path unconfirmed (F-004).** The email verification gate (#286, live via #297) fails closed without working mail. Nobody recorded a real signup mail or forgot-password mail on thakeen.com, Resend domain verification, or click tracking off (#283). UNVERIFIED: dashboard.
5. **P0 No backup, no spend limits (F-005, F-006).** No backup or restore record exists for the live Upstash DB (#17). There is no provider limit list (#137). UNVERIFIED: dashboards; absence in repo VERIFIED.
6. **P0 Money chain (F-007 to F-010).** The chain runs: company papers (#47), then the Paymob merchant account and its written answer on recurring/MOTO, then PAYMOB_* keys. The accountant (VAT inclusive, ZATCA, withholding) and the lawyer (PDPL, terms, DPAs, /vs pages) are both unbooked. Nothing can be sold by card until this is done. VERIFIED (`docs/Owner_Tasks_AR.md:130-133,255,372-376`; variables.md section 4a).
7. **P1 Trial 3 vs 7 (F-011).** The code says 3 days and the founder decided 7. The #191 correction message depends on this answer. VERIFIED.
8. **P1 Staging has no env (F-012).** staging.thakeen.com answers 404 and the release checklist (flows section 51/52.1) cannot run. VERIFIED (404).
9. **P1 Integrations dormant for lack of keys (F-013 to F-018).** Turnstile, support WhatsApp, platform apps, Google/Microsoft calendar apps, Composio and media keys are not on live. The Owner_Tasks platform table still lists `nashr-tau.vercel.app` callbacks (`docs/Owner_Tasks_AR.md:258-287`). STALE doc, keys UNVERIFIED.
10. **P2 Issue hygiene.** All 23 owner-task issues are open. #193 (decided 2026-09-29/10-01), #49 (email verification done via #286), #11 (MAIL_FROM set 2026-10-08) and #8 (domain is thakeen.com, not nashr.ai) can be closed with evidence. VERIFIED (gh).

### Do this week (max 10, dependency order)

1. F-001: decide the homepage heading wording (keep it with an «أمثلة توضيحية» label, or change it).
2. F-002: say "go" for the release PR main to production; Claude opens it as a draft. This fixes the live `/p/` bug.
3. F-003: retire Vercel per #319. Rotate WAITLIST_ADMIN_KEY and any value printed in chat, disconnect or delete nashr-tau, remove the Deployment Check, set APP_ENV in hPanel and then delete VERCEL_ENV.
4. F-004: on thakeen.com, sign up with a new address and run forgot-password. Confirm both mails arrive. In Resend, confirm the domain is verified and click tracking is off.
5. F-005: turn on Upstash backup/persistence for the live DB and record the region.
6. F-006: set a monthly limit and alert on Anthropic, Upstash, Resend and Hostinger (and Straitly). Write the numbers, not keys, in Owner_Tasks.
7. F-011: answer "3" or "7" for the trial length (one word). It unblocks the correction message F-025.
8. F-012: set the staging env in hPanel: separate Upstash KV_REST_API_URL/KV_REST_API_TOKEN, new CRON_SECRET and CONNECT_SECRET, APP_ORIGIN, STAGING_ACCESS_KEY. Rebuild and say "done".
9. F-007: start the company papers (CR, VAT, IBAN), or decide the date. This unblocks Paymob (F-009) and Meta business verification.
10. F-008 + F-010: send the accountant the question list and book the lawyer (one message each).

### Ledger

Types: key/env, dashboard, decision, money, legal/company, live test, content, external contact.
P = priority. Date done = "-" when open.

#### Open

| id | date asked | source | type | exact action | why / blocks | state | evidence | done | P | next step (Arabic) |
|---|---|---|---|---|---|---|---|---|---|---|
| F-001 | 2026-10-10 | leftovers audit homepage-heading; PR #311 | decision | Re-confirm or change the heading «عملاء جربوا ذكين» over illustrative scenes | Release PR; no-invented-customers rule | open | src/lib/home.ts SCENES_COPY; commit cb1748f8; #311 merged 2026-10-10 (VERIFIED) | - | P0 | اكتب كلمة: «نبقيه مع وسم أمثلة توضيحية» أو «غيّره إلى: كيف يشتغل أصحاب المشاريع مع ذكين» |
| F-002 | 2026-10-10 | leftovers release-pr; journey 10-10 | decision | Approve opening and merging a release PR main to production | 6 merged PRs not live; live /p/ bug | open | curl thakeen.com/p/TEST123 307 to 0.0.0.0:3000 (VERIFIED 2026-10-11); origin/production 487984f4 | - | P0 | بعد F-001 قل «افتح PR الإصدار»، وراجع الفحوص، وادمجه بنفسك |
| F-003 | 2026-09-17 | Owner_Tasks:104,430 (#12); PR #319 body | dashboard | Rotate WAITLIST_ADMIN_KEY and anything printed in chat; disconnect/delete Vercel project nashr; remove Deployment Check; hPanel APP_ENV then remove VERCEL_ENV; check BLOB_READ_WRITE_TOKEN | Old project still serves main with old secrets and runs vercel.json crons | open | nashr-tau.vercel.app 307 server Vercel (VERIFIED 2026-10-11); rotation UNVERIFIED | - | P0 | افتح لوحة Vercel واتبع خطوات PR #319 بالترتيب، ثم اكتب «تم» |
| F-004 | 2026-09-18 | #11; PR #283, #286 | live test | Real signup and forgot-password on thakeen.com; Resend domain verified; click tracking off; HTML check in Gmail/Outlook/iOS | Verification gate fails closed without mail | open | #286 live via #297 (VERIFIED); mail arrival UNVERIFIED | - | P0 | سجّل ببريد جديد على thakeen.com، واطلب نسيت كلمة المرور، وتأكد من وصول الرسالتين، ثم أطفئ تتبّع النقرات في Resend |
| F-005 | 2026-10-03 | Owner_Tasks:22,57; issue #17 | dashboard | Enable daily backup/persistence on the live Upstash DB; record region | All customer data in one DB with no restore | open | no backup/restore doc in repo (VERIFIED absence); dashboard UNVERIFIED | - | P0 | من لوحة Upstash فعّل النسخ الاحتياطي اليومي لقاعدة الإنتاج، واكتب المنطقة هنا |
| F-006 | 2026-09-22 | #137; Owner_Tasks:113,160-167 | money | Monthly spend limit + low-balance alert on every provider | A runaway loop or abuse drains money | open | all boxes [ ] at Owner_Tasks:160-166 (VERIFIED); consoles UNVERIFIED | - | P0 | ضع حداً شهرياً وتنبيهاً في Anthropic وUpstash وResend وStraitly، واكتب الأرقام فقط |
| F-007 | 2026-09-22 | #47; Owner_Tasks:130-133 | legal/company | Obtain CR, VAT number, business IBAN | Blocks Paymob, Meta verification, .sa domain, invoices | open | Owner_Tasks:130-133 all «?» (VERIFIED) | - | P0 | حدّد موعد استخراج السجل التجاري والرقم الضريبي والآيبان، أو اكتب «ننتظر حتى تاريخ كذا» |
| F-008 | 2026-09-22 | #48; Owner_Tasks:255,407; CFO memo | external contact | Send accountant: VAT shown or inclusive (PRICES_INCLUDE_VAT), registration threshold, ZATCA, withholding on foreign SaaS, Gulf tax | Price page legality; payouts | open | Owner_Tasks:255,407 unticked (VERIFIED) | - | P0 | أرسل قائمة الأسئلة في Owner_Tasks للمحاسب وانقل أجوبته هنا |
| F-009 | 2026-10-08 | PR #279 body; memory 2026-10-08 | money | Open Paymob KSA merchant; get written answer on recurring/MOTO; set PAYMOB_* test keys; give webhook URL; run test-card plan, pack, renewal, refund | No card payments possible | open | #279 merged gated off; variables.md section 4a (VERIFIED); keys UNVERIFIED | - | P0 | بعد الأوراق افتح حساب تاجر Paymob، واطلب ردهم المكتوب عن الاشتراكات، وضع مفاتيح الاختبار في hPanel |
| F-010 | 2026-09-22 | #48, #132; Owner_Tasks:365-376; PR #240 | external contact | Saudi lawyer: privacy, terms (incl. legal.ts new sentence), PDPL transfer, DPAs dates, /vs pages, affiliate terms | Legal exposure at first sale | open | tests/content-claims.test.ts DPA_RECORDED empty (leftovers, VERIFIED there) | - | P0 | احجز موعد محامٍ، وأنا أجهّز ملف المراجعة |
| F-011 | 2026-10-05 | PRD decisions memory; Owner_Tasks:354 | decision | Confirm trial length 3 or 7 days | Code says 3; decks/drafts say 7; blocks F-025 | open | src/lib/auth.ts:237 `3 * 864e5` (VERIFIED) | - | P1 | اكتب رقماً واحداً: 3 أو 7 |
| F-012 | 2026-10-08 | PR #282 body; staging memory | key/env | hPanel staging env: separate Upstash KV_REST_API_URL/TOKEN, CRON_SECRET, CONNECT_SECRET, APP_ORIGIN, STAGING_ACCESS_KEY, capped Anthropic key, mail | No rehearsal before release; #298 checklist | open | staging.thakeen.com 404 (VERIFIED 2026-10-11) | - | P1 | أنشئ قاعدة Upstash ثانية للتجربة وضع المتغيرات في موقع staging فقط، ثم أعد البناء واكتب «تم» |
| F-013 | 2026-10-01 | PR #233; Owner_Tasks:37 | key/env | Create Cloudflare Turnstile site; set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY | Signup has no bot check | open | variables.md (fails open) VERIFIED; hPanel UNVERIFIED | - | P1 | أنشئ موقع Turnstile في Cloudflare وضع المفتاحين في hPanel |
| F-014 | 2026-09-22 | #138, #134; PR #239 | key/env | Business WhatsApp number in SUPPORT_WHATSAPP; WAITLIST_TO on Hostinger | Personal number shown; leads may be lost; packs sale | open | variables.md:47-48,61-63 (VERIFIED); hPanel UNVERIFIED | - | P1 | اختر رقم واتساب أعمال وبريد استقبال، وضعهما في hPanel |
| F-015 | 2026-09-22 | #10; Owner_Tasks:258-288; Docs 6a53b650 | dashboard | Developer apps + reviews: Meta (business verification), X, Shopify dev store, Salla, Zid, Google, LinkedIn, TikTok, Snap; callbacks on thakeen.com | Connect buttons hidden on live | partly | applications started 2026-10-08 (journey; UNVERIFIED); Owner_Tasks table still nashr-tau (STALE) | - | P1 | ابدأ بـ Meta وX وسلة، واستخدم روابط callback على thakeen.com لا nashr-tau |
| F-016 | 2026-10-05 | PR #314 body; Reem memory | dashboard | Google Cloud app (calendar read-only, redirect /api/connect/gcal/callback) + Microsoft Entra app (/api/connect/mscal/callback); set GOOGLE_CLIENT_ID/SECRET, MICROSOFT_CLIENT_ID/SECRET; apply for sensitive-scope verification early | Reem B3 cannot link calendars | open | #314 merged not live (VERIFIED) | - | P1 | سجّل تطبيق Google وتطبيق Microsoft وقدّم على تحقق Google الآن لأنه يأخذ أسابيع |
| F-017 | 2026-10-05 | Owner_Tasks:291-308; PR #272/#281 | key/env | COMPOSIO_API_KEY, COMPOSIO_PROVIDERS, COMPOSIO_AUTH_* on staging then live; Node bump on Hostinger; approve orphan account cleanup | Social results and ad reads dormant | open | composio memory; variables.md section 5a (VERIFIED names) | - | P1 | ضع مفاتيح Composio في staging أولاً وارفع نسخة Node في Hostinger |
| F-018 | 2026-09-22 | #135; Owner_Tasks:194-231 | key/env | FAL_KEY, KIE_API_KEY, KIE_WEBHOOK_HMAC_KEY, HIGGSFIELD_API_KEY_ID/SECRET, MEDIA_MODELS_ON + provider spend cap | Images are placeholders | open | src/lib/media/start.ts placeholder path (leftovers, VERIFIED there) | - | P1 | بعد قرار التخزين (F-019) ضع مفاتيح الصور والفيديو وحداً للصرف |
| F-019 | 2026-10-10 | PR #320 spec section 9 | dashboard | Fill the hPanel facts checklist (disk, paths, limits) | Media storage build after Vercel Blob retires | open | #320 draft CLEAN (VERIFIED) | - | P1 | افتح hPanel واملأ قائمة الحقائق في القسم 9 من مواصفة #320 |
| F-020 | 2026-10-10 | leftovers drafts-order | decision | Order of drafts #316, #317, #319, #320 for the next release | Rule 772: ready once | open | gh pr list 4 drafts (VERIFIED) | - | P1 | رتّب الأربعة: أي واحد يدخل الإصدار القادم وأيها ينتظر |
| F-021 | 2026-10-10 | PR #316 body | decision | Answer 7 items: COMPOSIO_AUTH_GOOGLEDOCS/GOOGLESHEETS, response shapes, platform lock, judge vs veto wording, golden stamp gap, untargeted test charge, later PDF refs | #316 cannot be marked ready | open | #316 draft DIRTY (VERIFIED) | - | P1 | أجب السبعة بكلمة لكل واحد في تعليق على #316 |
| F-022 | 2026-09-22 | #132; Owner_Tasks:371 | decision | Record where Upstash, Hostinger and model hosts run | Privacy/PRD/site copy must match | open | docs/PRD.md in-Kingdom claims (leftovers) | - | P1 | اكتب أماكن الاستضافة الثلاثة، وأنا أعدّل النصوص لتطابقها |
| F-023 | 2026-10-10 | journey 10-10; model report v8 | decision | Yes/no to next golden round (~$5-6), Chinese models in or out, Haiku vs Sonnet after baseline rerun | Model routing default-off | open | golden never run on new assignment (leftovers golden-set) | - | P1 | قل «نعم للجولة» أو «لا»، و«الصينية داخل/خارج» |
| F-024 | 2026-09-18 | #136, #188; Owner_Tasks:310-336 | live test | Section و on live: iPhone Safari 4 checks, Telegram, Claude MCP, team 4 steps, admin console, Noor refuses unapproved publish, two-device password, MCP connected apps, test.example search | Never checked on the new live DB | open | all [ ] (VERIFIED) | - | P1 | خصص ساعة واحدة وجرّب قائمة القسم «و» على thakeen.com بالترتيب |
| F-025 | 2026-09-29 | #191; Owner_Tasks:352-354,400 | content | Correction message to everyone told 149/399/799 or 7-day trial; standing rule; first-100 price-lock text | Trust; old claims in drafts | open | GTM_Teardown stale lines (leftovers) | - | P1 | بعد F-011 أعطني قائمة من وصلتهم الرسالة القديمة، وأنا أكتب التصحيح |
| F-026 | 2026-10-05 | PRD decisions memory | external contact | Offer 20 founding seats by personal WhatsApp; log each no with a one-word reason | First revenue | open | PRD v3.2 draft (VERIFIED file) | - | P1 | بعد تفعيل الدفع جهّز قائمة الـ150 وابدأ بالمحادثات الشخصية |
| F-027 | 2026-10-09 | journey 10-09 | dashboard | Change the password-like text seen in a screenshot, if it is real | Possible credential exposure | open | UNVERIFIED: no record of the outcome | - | P1 | إن كان النص كلمة مرور حقيقية غيّرها اليوم واكتب «تم» |
| F-028 | 2026-09-28 | Owner_Tasks:76; PR #280 | content | Logo SVG + 1024 PNG + maskable + favicon | Store/platform listings; PWA icon is a letter | open | no logo file in repo (memory; leftovers app-icon) | - | P2 | أرسل الشعار SVG وPNG بمقاس 1024 |
| F-029 | 2026-10-01 | official-name memory | legal/company | Thmanyah font files + written licence copy | Font cannot ship without it | open | UNVERIFIED: no copy in repo | - | P2 | أرسل ملفات الخط ونسخة الإذن المكتوب |
| F-030 | 2026-10-10 | leftovers ci-hygiene | dashboard | Turn on branch protection on main | Direct pushes possible | open | leftovers (VERIFIED there) | - | P2 | من إعدادات GitHub فعّل حماية فرع main |
| F-031 | 2026-10-10 | leftovers code-todos-03 | decision | Yearly billing: build it or remove the line | Price page offers what cannot be bought | open | src/lib/i18n.ts:402 (leftovers) | - | P2 | قل «احذف السطر» أو «نبني السنوي» |
| F-032 | 2026-09-22 | #133; Owner_Tasks:442 | external contact | Two native reviewers for Emirati/Kuwaiti examples | Dialect quality | open | unticked (VERIFIED) | - | P2 | رشّح مراجعَين من الإمارات والكويت |
| F-033 | 2026-09-22 | #97; Owner_Tasks:443 | dashboard | Uptime/error monitoring account (now for Hostinger) | Outages unseen | open | unticked (VERIFIED) | - | P2 | اختر أداة مراقبة مجانية وأنا أجهّز الإعداد |
| F-034 | 2026-09-29 | PR #222; Owner_Tasks:378-382,425-427 | decision | Media Q1 trial video, Q4 cinematic price, Q5 img-text; ranking-article score; 3 onboardings/day | Pricing details | open | unticked (VERIFIED) | - | P2 | أجب بعد أسبوع من صرف حقيقي على الصور |
| F-035 | 2026-10-01 | PR #236; Owner_Tasks:363-367 | money | Payout procedure: phone-verify partner IBAN, VAT/withholding, monthly transfers | First affiliate payout | open | unticked (VERIFIED) | - | P2 | لا تحوّل لأي شريك قبل جواب المحاسب |
| F-036 | 2026-09-17 | #190; Owner_Tasks:340,344,383 | decision | Helena Q3-5, Enrich screens, نجرفان site: do or cancel | Old research | open | «الموعد: ؟» (VERIFIED) | - | P2 | اكتب «أُلغي» أو «أكمل» لكل واحد |
| F-037 | 2026-09-22 | #189; Owner_Tasks:347,352 | content | One real testimonial / customer story with written consent | Social proof without invention | open | none exists (VERIFIED absence) | - | P2 | بعد أول عميل اطلب شهادة بموافقة مكتوبة |
| F-038 | 2026-10-10 | issue #33 | decision | Freeze new agents until the Salla loop works? | Scope | open | #33 open (leftovers) | - | P2 | أجب نعم أو لا |
| F-039 | 2026-10-10 | issue #87 | decision | Keep or drop hooks/plugins (GateGuard etc.) | Agent tooling noise | open | #87 open | - | P2 | اختر ما يبقى من الأدوات |
| F-040 | 2026-09-29 | competitor study memory | legal/company | Trademark clearance for ذكين vs thek.ai | Name clash risk | open | UNVERIFIED: no record | - | P2 | اطلب بحث علامة من وكيل ملكية فكرية |
| F-041 | 2026-10-10 | tests/0905-298-followups | content | Wording for premium-model hold | #298 copy | open | leftovers mem-b-36 | - | P2 | اختر الصيغة العربية والإنجليزية |
| F-042 | 2026-10-10 | PRD v3.2 on main | decision | Review PRD v3.2 draft | Decisions not recorded | open | docs/PRD-Thakeen.md:4 «مسودة للمراجعة» | - | P2 | اقرأ PRD 3.2 وقل «معتمد» أو عدّل |
| F-043 | 2026-09-29 | official-name memory | dashboard | Delete or keep thakeen-prototypes Vercel project + Blob store | Public leftover | open | 200 (VERIFIED 2026-10-11) | - | P2 | قل «احذفه» أو «أبقه» |
| F-044 | 2026-10-09 | PR #298 body | decision | Straitly: fund or drop; LLM_PROVIDER only on explicit yes | Gateway default-off | open | variables.md LLM_PROVIDER rows (VERIFIED) | - | P2 | قرر بعد جولة golden: نكمل Straitly أو نوقفه |
| F-045 | 2026-10-05 | chat-sonnet memory; PRD:200 | dashboard | Read console chat cost on 2026-10-19 | Real cost per message | open | date not reached | - | P2 | في 19 أكتوبر افتح لوحة المؤسس واقرأ عمود تكلفة المحادثة |
| F-046 | 2026-10-10 | PR #318 body | dashboard | One week after live: compare Anthropic Console vs founder console; two-API-keys question | Metering accuracy | open | #318 not live (VERIFIED) | - | P2 | بعد أسبوع من الإصدار قارن اللوحتين |
| F-047 | 2026-10-05 | Reem memory | live test | iPhone ICS subscribe, Arabic card text, repeat control, Calendly/Cal.com | Reem live quality | open | «Founder still to confirm» (memory) | - | P2 | اشترك في التقويم من آيفونك وصوّر ما تراه |
| F-048 | 2026-10-07 | journey 10-07 | legal/company | Submit nic.sa letter for thakeen.sa (needs CR number) | .sa domain | open | thakeen.sa no answer (VERIFIED); submission UNVERIFIED | - | P2 | بعد السجل التجاري أرسل خطاب nic.sa |
| F-049 | 2026-09-17 | journey 09-17 | external contact | MCP connector listing via Anthropic partner form | Distribution | open | UNVERIFIED: no record | - | P2 | قرر هل نقدّم الآن أو بعد الإطلاق |
| F-050 | 2026-09-17 | journey 09-17 | content | Deck team slide bios | Investor deck | open | UNVERIFIED: no record | - | P2 | أرسل نبذة قصيرة لكل عضو أو اكتب «أُلغي» |
| F-051 | 2026-10-03 | Owner_Tasks:30; gh | dashboard | Close decided/done issues (#193, #49, #11, #8) and triage the rest | 23 owner-task issues all open | open | gh issue list (VERIFIED) | - | P2 | قل «أغلقها» وأنا أكتب سبب الإغلاق والدليل في كل واحدة |
| F-052 | 2026-10-09 | PR #305 body | decision | Switch agent scope from shadow to enforce after 2 weeks | Scope enforcement | open | date ~2026-10-23 not reached | - | P2 | بعد أسبوعين قل «فعّل» |
| F-053 | 2026-09-29 | Owner_Tasks ح3:408 | decision | GCC prices (SAR/AED/KWD) and provider currency support | Gulf sales | open | unticked (VERIFIED) | - | P2 | قرر هل نبيع خارج السعودية الآن أم لاحقاً |
| F-054 | 2026-10-01 | PR #232, #260 bodies | decision | Brand-switch notice link; stores spec open questions | Small UX/spec gaps | open | UNVERIFIED: answers not found | - | P2 | راجع أسئلة #232 و#260 وأجب أو اكتب «لاحقاً» |
| F-055 | 2026-10-01 | journey 10-01; Owner_Tasks:24-27 | decision | Say «كمّل» to refresh the archify diagram; in-app page | Internal diagram | partly | diagram merged (#253), page undone | - | P2 | قل «كمّل» أو «أُلغي» |
| F-056 | 2026-10-02 | CFO budget memory | money | Decide 166k SAR budget + 60k cash before launch | Runway | open | UNVERIFIED: no decision recorded | - | P2 | راجع ملف الميزانية وحدد المبلغ المتاح |
| F-057 | 2026-10-08 | variables.md:21,64 | key/env | Remove VERCEL_ENV on Hostinger and PAY_LINK_AGENCY on Vercel | Stale config | open | variables.md lines (VERIFIED) | - | P2 | احذفهما مع خطوات F-003 |
| F-058 | 2026-10-11 | this study | decision | Approve the proposed Owner_Tasks rewrite (docs/reports/2026-10-11-owner-tasks-proposed_AR.md) | Owner_Tasks is stale | open | this file | - | P2 | اقرأ المقترح وقل «طبّقه» |

#### Done

| id | date asked | source | type | exact action | why / blocks | state | evidence | done | P | next step (Arabic) |
|---|---|---|---|---|---|---|---|---|---|---|
| F-059 | 2026-09-17 | Owner_Tasks و | live test | Create founder account on production | Admin access | done | Owner_Tasks [x] (VERIFIED) | 2026-09-18 | - | لا شيء |
| F-060 | 2026-09-17 | journey 09-18 | key/env | Add RESEND_API_KEY | Mail | done | journey 09-18; on Hostinger 10-08 (UNVERIFIED hPanel) | 2026-09-18 | - | لا شيء |
| F-061 | 2026-09-17 | journey 09-18 | key/env | Add WAITLIST_TO (Vercel) | Leads | done (old Vercel only) | journey 09-18; not in Hostinger list, see F-014 | 2026-09-18 | - | انظر F-014 |
| F-062 | 2026-09-18 | Owner_Tasks ح2 | dashboard | Enable Vercel Deployment Check | Safe deploys | done; to be removed by F-003 | Owner_Tasks [x] | 2026-09-18 | - | انظر F-003 |
| F-063 | 2026-09-18 | Owner_Tasks ح | decision | Navigation + priorities | Build order | done | [x] | 2026-09-18 | - | لا شيء |
| F-064 | 2026-09-18 | Owner_Tasks ط | decision | Approve golden set | Quality bar | done | [x] | 2026-09-18 | - | لا شيء |
| F-065 | 2026-09-17 | Owner_Tasks:339 | content | Paste Helena replies Q1-2 | Research | done | [x] | 2026-09 | - | لا شيء |
| F-066 | 2026-09-17 | Owner_Tasks:343 | live test | Enrich signup | Research | done | [x] | 2026-09-18 | - | لا شيء |
| F-067 | 2026-09-27 | Owner_Tasks ح2 | decision | Sonnet price | Pricing | done | [x] | 2026-09-27 | - | لا شيء |
| F-068 | 2026-09-28 | official-name memory | decision | Name Thakeen · ذكين | Brand | done | memory; rename in #213 | 2026-09-28 | - | لا شيء |
| F-069 | 2026-09-28 | official-name memory; Docs 6a53b650 | decision | Approve homepage prototype D; merge re-skin #250 | Brand | done | #250 merged 2026-10-04 (VERIFIED gh) | 2026-10-04 | - | لا شيء |
| F-070 | 2026-09-29 | media memory; Owner_Tasks:377 | decision | Add kie.ai + Higgsfield; video now | Media | done | #222 merged | 2026-09-29 | - | لا شيء |
| F-071 | 2026-09-29 | pricing memory | decision | First-100 offer = 12-month price lock | GTM | done (site text open, F-025) | memory | 2026-09-29 | - | انظر F-025 |
| F-072 | 2026-09-30 | official-name memory | decision | Reem as 8th agent | Product | done | #213 | 2026-09-30 | - | لا شيء |
| F-073 | 2026-09-22 | #193 | decision | Affiliate 15% / discounts decisions | Partners | done (issue still open) | memory 2026-10-01; #236 merged 2026-10-01 | 2026-10-01 | - | انظر F-051 |
| F-074 | 2026-10-01 | affiliates memory | decision | Manual credit top-ups + chat caps | Launch money | done | memory; #235 | 2026-10-01 | - | لا شيء |
| F-075 | 2026-10-03 | Owner_Tasks:19-20 | decision | Approve/merge Reem A1 #243, A2 #247, #251 | Reem | done | #243 merged 2026-10-03 (VERIFIED gh); #251 2026-10-05 | 2026-10-05 | - | لا شيء |
| F-076 | 2026-10-05 | Reem memory | decision | B1 #255, B2a #262, B3 spec/decisions (gmail with declaration), secret-in-URL | Reem | done | #255/#256/#258 merged 2026-10-05 (VERIFIED gh) | 2026-10-05 | - | لا شيء |
| F-077 | 2026-10-03 | Owner_Tasks:18,23-24; Docs 6a53b650 | decision | Chat on Sonnet 5.5 $0.14 (#252); BYOK; budget update | Cost | done | #252 merged 2026-10-05 (VERIFIED gh) | 2026-10-05 | - | لا شيء |
| F-078 | 2026-10-05 | PRD memory | decision | PRD v3.1 decisions (segment, perks, refund, 6,000 SAR stop) | Strategy | done | #265 merged 2026-10-05 (VERIFIED gh) | 2026-10-05 | - | لا شيء |
| F-079 | 2026-10-03 | Owner_Tasks:17 | decision | Unpause Claude | Launch | done | src/lib/model.ts:19 false (VERIFIED) | 2026-10 (UNVERIFIED day) | - | لا شيء |
| F-080 | 2026-09-22 | #8, #11; Docs 6a53b650 | dashboard | Buy thakeen.com; set APP_ORIGIN, MAIL_FROM | Domain, mail | done | thakeen.com live (VERIFIED); env UNVERIFIED hPanel | 2026-10-08 | - | لا شيء |
| F-081 | 2026-10-07 | Hostinger memory | dashboard | Hostinger: connect GitHub, 11 env vars, 9 crons | Live hosting | done | /api/health 200 (VERIFIED); crons per memory | 2026-10-08 | - | لا شيء |
| F-082 | 2026-10-08 | journey 10-08 | money | Top up Anthropic credits | Model calls | done | journey | 2026-10-08 | - | لا شيء |
| F-083 | 2026-10-08 | journey; supastarter memory | decision | Choose Paymob KSA; buy supastarter Solo | Billing | done | #279 merged (VERIFIED gh) | 2026-10-08 | - | لا شيء |
| F-084 | 2026-10-08 | staging memory | decision | Approve release PRs #297, #309, #312; ruleset on production | Releases | done | #309/#312 merged 2026-10-09 (VERIFIED gh) | 2026-10-09 | - | لا شيء |
| F-085 | 2026-10-09 | CI memory | money | Fix GitHub Actions budget | CI | done | journey 10-09 | 2026-10-09 | - | لا شيء |
| F-086 | 2026-10-09 | admin shell memory | decision | Brand caps 1/1/2/5/agency-set | Part B | done | memory | 2026-10-09 | - | لا شيء |
| F-087 | 2026-10-09 | Straitly memory | money | Straitly wallet $10 + $40; pick pricing option A | Spike, golden | done | memory; rule 902 | 2026-10-10 | - | لا شيء |
| F-088 | 2026-10-10 | gh | decision | Merge #298, #311, #313, #314, #318 to main | Features | done | merged 2026-10-10 (VERIFIED gh) | 2026-10-10 | - | انظر F-002 |
| F-089 | 2026-10-10 | skills portal / retire-Vercel memory | decision | Skills portal answers; retire Vercel and media storage decisions | #316, #319, #320 | done | memory | 2026-10-10 | - | لا شيء |
| F-090 | 2026-10-05 | journey 10-05; composio memory | key/env | COMPOSIO_API_KEY in Vercel Preview; login condition met | Composio test | done (Preview only) | memory | 2026-10-08 | - | انظر F-017 |

#### Obsolete

| id | date asked | source | type | exact action | why obsolete | state | evidence | done | P | next step (Arabic) |
|---|---|---|---|---|---|---|---|---|---|---|
| F-091 | 2026-09-22 | #8; Owner_Tasks:105,142-154,360 | dashboard | Buy nashr.ai | thakeen.com chosen | obsolete | nashr.ai no answer; hello@nashr.ai still in 4 src strings (VERIFIED) | - | - | أغلق #8، وأنا أستبدل العنوان القديم |
| F-092 | 2026-10-03 | Owner_Tasks:22,40,57; Docs 6a53b650 | money | Upgrade Vercel Pro | Hosting moved to Hostinger | obsolete | live server hcdn (VERIFIED) | - | - | احذف البند |
| F-093 | 2026-09-30 | Owner_Tasks:38; ح3; Docs 6a53b650 | key/env | Four PAY_LINK_* links | Superseded by Paymob | obsolete | variables.md:64 | - | - | احذف البند |
| F-094 | 2026-10-02 | Owner_Tasks:16,111,234-247,359 (#9) | external contact | MobPay meeting; Moyasar/Tap choice | Paymob chosen 10-08 | obsolete | #279 | - | - | احذف البند |
| F-095 | 2026-09-30 | taskuary memory; Docs 6a53b650 | key/env | QStash schedule + signing keys | Hostinger crons replace it | obsolete | 9 hPanel crons (memory) | - | - | احذف البند |
| F-096 | 2026-09-29 | Owner_Tasks:231,379 (Q2) | decision | Vercel plan cron frequency | Hostinger crons | obsolete | same | - | - | احذف البند |
| F-097 | 2026-09-20 | #46; Owner_Tasks:90,100,317 | live test | Weekly-plan discount check before 2026-09-28 | Deadline passed; old DB | obsolete | live DB is new (memory) | - | - | أغلق #46 |
| F-098 | 2026-09-30 | Owner_Tasks ح, ح3 | external contact | Agency contracts before 10-01; tell pre-10-01 partner applicants | Old Vercel DB; no customers (founder 10-09) | obsolete | memory | - | - | احذف البند |
| F-099 | 2026-09-18 | Owner_Tasks ب | live test | Two mail tests on nashr-tau | Replaced by F-004 on thakeen.com | obsolete | - | - | - | انظر F-004 |
| F-100 | 2026-10-04 | Docs 6a53b650 | dashboard | Mark Upstash Redis vars sensitive in Vercel | Vercel retiring (F-003) | obsolete | #319 | - | - | يُغطّى بحذف مشروع Vercel |
| F-101 | 2026-09-22 | #192; Owner_Tasks:159 | dashboard | Vercel deployment protection | Vercel retiring | obsolete | #319 | - | - | أغلق #192 بعد F-003 |
| F-102 | 2026-09-28 | journey 09-28 | decision | Homepage handoff 6 decisions | Superseded by prototype D | obsolete | #250 | - | - | لا شيء |
| F-103 | 2026-09-27 | Owner_Tasks:258,271-287 | dashboard | Register platform apps on nashr-tau callbacks | Domain now thakeen.com | obsolete | STALE table | - | - | استخدم thakeen.com في F-015 |
| F-104 | 2026-10-03 | Owner_Tasks:33 | decision | "CLAUDE_PAUSED = true" launch-blocker line | Already false | obsolete | src/lib/model.ts:19 | - | - | احذف السطر |
| F-105 | 2026-09-20 | journey 09-20 | dashboard | Check weekly inbox on Sunday (one-off) | Routine, no record | obsolete | UNVERIFIED | - | - | لا شيء |

### Stale Owner_Tasks items to close (with evidence)

| Owner_Tasks line | Item | Close because | Evidence |
|---|---|---|---|
| 3 | Header "آخر تحديث: 2026-10-08" | Three days of merges and decisions missing | gh: #298 #311 #313 #314 #318 merged 2026-10-10 |
| 16, 58, 111, 234-247, 359 | MobPay meeting, Moyasar/Tap | Paymob KSA chosen | #279 merged 2026-10-08 |
| 17, 33, 53 | CLAUDE_PAUSED unpause / "=true" | Already false | src/lib/model.ts:19 |
| 18 | Chat Sonnet 5.5 local commit | Merged | #252 merged 2026-10-05 |
| 19, 20 | Review #243; A2 paused | Merged | #243 2026-10-03; #247; #251 2026-10-05 |
| 21 | Reem B plans | B1/B2a live; B2b/B3 merged via #314 | gh; Reem memory |
| 22, 57 | P0 list: Vercel Pro, thakeen.com, MAIL_FROM | Hostinger; domain + MAIL_FROM set 10-08 | thakeen.com 200 server hcdn; memory |
| 23, 24 | BYOK answer; 100-client budget update | Done 10-05 | CFO memory v2 |
| 25 | Move homepage D to product | Merged | #250 2026-10-04 |
| 26-28 | Diagram | Diagram merged (#253); in-app page still open (F-055) | gh |
| 34 | No domain | Done | thakeen.com |
| 35 | MAIL_FROM missing | Set 10-08 (keep F-004 verification) | memory |
| 38, PAY_LINK lines | PAY_LINK_* | Superseded by Paymob | variables.md:64 |
| 40 | Vercel Pro | Obsolete | Hostinger |
| 90, 100, 317 | #46 weekly-plan check | Deadline passed, old DB | memory |
| 105, 142-154, 287, 360 | nashr.ai domain, MAIL_FROM on mail.nashr.ai | thakeen.com chosen | curl |
| 159 | #192 Vercel protection | Vercel retiring | #319 |
| 184-186 | Resend on nashr.ai, MAIL_FROM via vercel env add | Done on Hostinger | memory |
| 231, 379 | Q2 Vercel cron frequency; cron every 15 min | Hostinger crons | memory |
| 258-287 | Platform table with nashr-tau callbacks | Must use thakeen.com | STALE |
| 319 | test.example search on Vercel DB | Live DB is new; repeat on live only | memory |
| ح3 | agency contracts before 10-01 | Date passed; no customers | founder 2026-10-09 |
| ح3 | PAY_LINK new links | Paymob | #279 |
| ح | #193 sub-items | Decided | #236 merged 2026-10-01 |
| 122 | #49 email verification | Done | #286 live via #297 |

### What could not be verified

- hPanel env names and values on live and staging (no access). The 11-name list is from memory only.
- Resend dashboard: domain verification and click tracking.
- Upstash backup, persistence and region.
- Provider spend limits: Anthropic, Upstash, Resend, Straitly, fal, kie, Higgsfield.
- Vercel dashboard: whether WAITLIST_ADMIN_KEY was rotated, whether the Deployment Check is on, and BLOB_READ_WRITE_TOKEN.
- Whether a Paymob merchant account exists, and whether Paymob gave its written answer.
- Company papers, the accountant and the lawyer: no record beyond «?».
- Platform developer applications started 2026-10-08 (Meta ads_read, TikTok, Snap, LinkedIn Ads, Google Business Profile): their review status.
- Submission of the nic.sa letter for thakeen.sa.
- The outcome of the password-like text seen in a screenshot on 2026-10-09.
- The exact day CLAUDE_PAUSED was set to false.
- Thmanyah font licence copy.
- The Claude Docs doc 6a53b650 was read. It is dated 2026-10-04, and its Vercel-era items are now obsolete (F-092, F-093, F-095, F-100).
