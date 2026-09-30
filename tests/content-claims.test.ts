import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LEGAL } from "@/lib/legal";
import { HELP } from "@/lib/help";
import { MEDIA_MODELS, TRIAL_VIDEO_MODELS, mediaModel, type MediaKind } from "@/lib/media-catalog";

/**
 * The published comparison page names six real competitors and stakes its credibility on the rubric being checkable:
 * "we publish the full rubric… email us to correct any number". Four of its eight totals did not match the weights it
 * publishes three lines above, and the rank column contradicted its own scores in seven of eight rows — with the
 * vendor's own row being one of the arithmetically correct ones. This recomputes it.
 */
const RUBRIC = "content/blog/best-ai-marketing-agents-gulf-2026.md";
/** Exec, Arabic, Channels, Compliance, Control, Price — the weights the article itself publishes. */
const WEIGHTS = [0.25, 0.2, 0.2, 0.1, 0.15, 0.1];

type Row = { rank: string; tool: string; scores: number[]; total: number };

function rubricRows(): Row[] {
  const rows: Row[] = [];
  for (const line of readFileSync(RUBRIC, "utf8").split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length !== 9) continue;
    const scores = cells.slice(2, 8).map(Number);
    const total = Number(cells[8].replace(/\*/g, ""));
    if (scores.some((n) => !Number.isFinite(n)) || !Number.isFinite(total)) continue;
    rows.push({ rank: cells[0], tool: cells[1], scores, total });
  }
  return rows;
}

describe("the published competitor rubric is arithmetically true", () => {
  it("finds both language tables, so an empty result cannot pass by accident", () => {
    expect(rubricRows().length).toBe(16);
  });

  it("every published total equals weight x score", () => {
    const wrong = rubricRows()
      .map((r) => ({ tool: r.tool, published: r.total, computed: Math.round(r.scores.reduce((s, v, i) => s + v * WEIGHTS[i], 0) * 100) / 100 }))
      .filter((r) => Math.abs(r.published - r.computed) > 0.005);
    expect(wrong, `rows whose total does not match the published weights: ${JSON.stringify(wrong)}`).toEqual([]);
  });

  it("the rank column does not contradict the scores", () => {
    // Rows carrying a number are the ranked products; the agency row is a reference and is marked with a dash.
    for (const table of [rubricRows().slice(0, 8), rubricRows().slice(8)]) {
      const ranked = table.filter((r) => /^\d+$/.test(r.rank));
      expect(ranked.length).toBeGreaterThan(0);
      const byRank = [...ranked].sort((a, b) => Number(a.rank) - Number(b.rank)).map((r) => r.total);
      const byScore = [...ranked].map((r) => r.total).sort((a, b) => b - a);
      expect(byRank, "the # column must be ordered by the published score").toEqual(byScore);
    }
  });
});

describe("no blog post asserts an invented number or promises a result", () => {
  const BANNED = [
    { re: /Savings\s*[≈~]\s*SAR/i, why: "a quantified savings promise" },
    { re: /الوفر:\s*~?\s*[\d,]+\s*ريال/, why: "a quantified savings promise (Arabic)" },
    { re: /Agencies charge SAR [\d,]+[–-][\d,]+/i, why: "an unsourced competitor price range" },
    { re: /better than a (new )?agency writer/i, why: "a comparative performance guarantee" },
    { re: /أفضل من كاتب جديد في الوكالة/, why: "a comparative performance guarantee (Arabic)" },
  ];

  it("checks every post, so the sweep cannot be empty", () => {
    const posts = readdirSync("content/blog").filter((f) => f.endsWith(".md"));
    expect(posts.length).toBeGreaterThan(10);
  });

  it("finds none of the claims CLAUDE.md forbids", () => {
    // CLAUDE.md: "No invented customers, logos, testimonials, numbers or results promises anywhere in the product or
    // the site." The product enforces this against its own model output (the reviewer pass and the judge's honesty
    // dimension); the marketing has to hold to it too.
    const hits: string[] = [];
    for (const file of readdirSync("content/blog").filter((f) => f.endsWith(".md"))) {
      const text = readFileSync(join("content/blog", file), "utf8");
      for (const { re, why } of BANNED) if (re.test(text)) hits.push(`${file}: ${why}`);
    }
    expect(hits).toEqual([]);
  });
});

/**
 * The same rule, applied to every place the site and the product speak: the landing page, pricing, plan cards, the
 * in-app strings, industry and comparison pages, help, legal pages and lifecycle emails. Each pattern below is a claim
 * that was published and was not true: an invented result, an invented audience, a channel that is not built, a
 * billing behaviour the code does not have. The list is deliberately narrow, so a hit is a real regression, not noise.
 */
describe("no site or product copy asserts an invented result or an unbuilt feature as live", () => {
  const ROOTS = ["src/app", "src/components", "src/lib", "content/blog"];
  const COPY = /\.(tsx?|md)$/;

  function copyFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return copyFiles(p);
      return COPY.test(e.name) ? [p] : [];
    });
  }

  const CLAIMS = [
    // Invented results and audiences from the old homepage log and highlights.
    { re: /18,420/, why: "an invented revenue figure" },
    { re: /214 (عميل|customers)/, why: "an invented audience count" },
    { re: /(expected|متوقع) ?\d+\s*[–-]\s*\d+\s*% ?(conversion|تحويل)/i, why: "an expected-conversion promise" },
    { re: /\(\+\d+%\)/, why: "an invented growth figure" },
    { re: /(Acceptance reaches|نسبة القبول تصل) \d+%/, why: "an invented acceptance rate" },
    { re: /(About|عادةً) 20 (edits|تعديلاً)/, why: "an invented learning curve" },
    { re: /(90%\+|\+90%)/, why: "an unsourced market statistic" },
    { re: /(40k\+|ألف متجر على سلة وزد)/, why: "an unsourced market statistic" },
    { re: /(25 hours every week|استرجع 25 ساعة)/, why: "a time-saved promise" },
    { re: /(SAR 8,000\+|8,000\+ ريال)/, why: "an unsourced agency price" },
    // Always-on and overnight work: generation runs when asked, plus a weekly plan and a daily brief.
    { re: /(while you sleep|works overnight|sleeps\. Noor doesn't|وأنت نايم|ينام\. نور لا|(?<![\d/])24\/7(?![\d/])|before you wake up|قبل ما تصحى|One Noor\. Always on|دائماً شغالة|تعمل بالليل|overnight log|سجل نور الليلة|changed overnight|ما تغيّر الليلة)/i, why: "an always-on promise" },
    // Channels and behaviours that are not built.
    { re: /(brief on WhatsApp|WhatsApp brief|alerts on WhatsApp|ملخص الصباح على واتساب|ملخصك على واتساب|ملخص واتساب|تنبيهات الاعتماد على واتساب)/i, why: "a WhatsApp brief that is not built" },
    { re: /(email you within 48 hours|سنراسلك خلال 48 ساعة|(reply during|activated within) business hours|(نرد|يُفعَّل حسابك) خلال ساعات العمل)/i, why: "a response-time promise nothing implements" },
    { re: /(\d+ concurrent tasks|\d+ (مهام|مهمة) متزامنة)/i, why: "a concurrency limit that does not exist" },
    { re: /\b(rolls|rolling) over\b/i, why: "credits reset monthly; they do not roll over" },
    { re: /(?<!لا )[يت]ترحّ?ل/, why: "credits reset monthly; they do not roll over (Arabic)" },
    { re: /Data hosted inside Saudi Arabia(?! \(coming soon\))/, why: "Saudi hosting is not built" },
    { re: /استضافة البيانات داخل السعودية(?! \(قريباً\))/, why: "Saudi hosting is not built (Arabic)" },
    { re: /(White-label (client )?reports|تقارير بعلامتك للعملاء|تقارير بشعارك)(?! \((coming soon|قريباً)\))/i, why: "white-label reports are not built" },
    { re: /Auto ad optimization within your guardrails(?! \(coming soon\))/, why: "ad optimization is not built" },
    { re: /ضبط الإعلانات تلقائياً ضمن حدودك(?! \(قريباً\))/, why: "ad optimization is not built (Arabic)" },
    // Follow-ups of 27 Sep: the free-tool pages, the inspiration cards, the chat prompt and the prompts injected into
    // every generation, which customers read or which the model repeats as fact.
    { re: /(every day — automatically|كل يوم — تلقائياً)/i, why: "a daily automatic-generation promise; only the Sunday plan is automatic" },
    { re: /no auto-publishing/i, why: "implies a paid plan publishes automatically; none does" },
    { re: /(Highest reply rate|orders cluster \d|lift Maps ranking|1\.4 إلى 3\.2 ROAS)/, why: "an unsourced result claim on an inspiration card" },
    { re: /(Biggest KSA sale season|top channel for aesthetics|Tamara[^.]*(lift conversion|raise order value))/, why: "an unsourced superlative injected into generation prompts" },
    // Pricing phase 1 (rule 248): the retired prices, allowances and brand limits. Prices now render from
    // src/lib/pricing.ts and TASK_COST; a typed copy of an old one is a regression, wherever it appears.
    { re: /(SAR ?(149|399|799)\b|\b(149|399|799) ?(SAR|ريال)|\b149[–-]799\b|"(149|399|799)", l: "(SAR|ريال))/, why: "a retired plan price (149 / 399 / 799)" },
    { re: /(Starter|Pro|Agency|البداية|الاحتراف|الوكالة) (149|399|799)\b/, why: "a retired plan price next to a tier name" },
    { re: /(\b200 credits|\b200 كريدت|2,000 credits|2,000 كريدت|"2,000", l: "(credits|كريدت)|(Starter|ستارتر) 200\b)/, why: "a retired allowance (Starter 200, Agency 2,000)" },
    { re: /(5 included|5 brands included|5 مشمولة|5 علامات مشمولة|runs 5 brands|تدير 5 علامات|for 5 brands|لـ 5 علامات)/, why: "a brand limit; brands are unlimited on every plan" },
    { re: /(Extra brand SAR 99|علامة إضافية (بـ )?99)/, why: "a paid extra brand; an added brand costs its setup credits only" },
    { re: /(Unlimited brands \(coming soon\)|علامات بلا حد \(قريباً\))/, why: "unlimited brands are live on every plan" },
    { re: /(Upgrade to Agency for 5 brands|لخطة الوكالة لـ 5 علامات)/, why: "a brand-limit upsell" },
    { re: /(ten thousand credits|عشرة آلاف كريدت|بعشرة آلاف كريدت)/i, why: "the retired Enterprise allowance" },
    { re: /(limits by plan|بحدود حسب الخطة)/i, why: "brands have no plan limit" },
    { re: /plans differ only in monthly credits and number of brands/, why: "plans differ in credits and seats; brands are unlimited (the chat prompt repeats this to owners)" },
    { re: /(\bplan\b[^.()]{0,60}\(1 credit\)|خطة[^.()]{0,60}\(1 كريدت\))/i, why: "the weekly plan costs TASK_COST.weekly_plan, not 1" },
  ];

  const files = ROOTS.flatMap(copyFiles);

  it("walks the copy tree, so the sweep cannot be empty", () => {
    expect(files).toContain("src/lib/i18n.ts");
    expect(files).toContain("src/lib/app-i18n.ts");
    expect(files.length).toBeGreaterThan(100);
  });

  it("the pricing bans catch the copy they retired, so a pattern cannot pass by matching nothing (rule 248)", () => {
    const RETIRED = [
      `{ name: "Starter", price: "149", period: "SAR / month", credits: "200 credits / month"`,
      `"فريق كامل من 149 ريالاً شهرياً"`,
      `us: "SAR 149–799" }`,
      `proof: [{ n: "799", l: "ريال/شهر لـ 5 علامات" }`,
      `{ n: "2,000", l: "credits a month, reset monthly" }`,
      `a: "Monthly credits by plan: Starter 149, Pro 399, Agency 799 SAR."`,
      `features: ["Multi-brand (5 included)", "Extra brand SAR 99 (coming soon)"]`,
      `"علامات متعددة (5 مشمولة)", "علامة إضافية 99 ريال (قريباً)"`,
      `"Unlimited brands (coming soon)"`,
      `"علامات بلا حد (قريباً)"`,
      "`You've reached your plan's limit of ${j.limit}. Upgrade to Agency for 5 brands.`",
      `d: "The enterprise plan carries ten thousand credits a month"`,
      `d: "ملف علامة وصندوق اعتماد مستقل لكل علامة، بحدود حسب الخطة."`,
      `plans differ only in monthly credits and number of brands, and the trial is 3 days`,
      `weeklyDesc: "Every Sunday 06:00 KSA — a 7-day plan lands in your inbox (1 credit)."`,
      `a: { ar: "خطة أسبوعية كل أحد 06:00 (1 كريدت) وملخص صباحي" }`,
      `| Items per month | — | what your plan's credits buy (Starter 200, Pro 700) |`,
    ];
    const missed = RETIRED.filter((line) => !CLAIMS.some(({ re }) => re.test(line)));
    expect(missed).toEqual([]);
    // And the copy that replaced them is not caught.
    const CURRENT = [`us: "from SAR 299" }`, `"(2 credits)"`, `"1,500 credits / month, reset monthly"`, `"Unlimited brands, 1 seat"`, `"7 seats including the owner"`];
    expect(CURRENT.filter((line) => CLAIMS.some(({ re }) => re.test(line)))).toEqual([]);
  });

  it("finds none of the claims that were removed", () => {
    const hits: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const { re, why } of CLAIMS) if (re.test(line)) hits.push(`${file}:${i + 1}: ${why}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

/**
 * Images and video now go to three media providers (docs/superpowers/specs/2026-09-29-media-providers-design.md, R6 and
 * Q3). Higgsfield's terms let it train on inputs and outputs and kie.ai's let it use content to improve its service, so
 * the privacy policy names both, says so, and says the media is AI-generated. It claims a data-processing agreement only
 * for a provider whose acceptance date is recorded in docs/Owner_Tasks_AR.md: add the provider here in the same commit
 * that adds it to the legal text. None is recorded today, so the phrase must not appear at all.
 */
describe("media processors are disclosed honestly", () => {
  const DPA_RECORDED: string[] = [];
  const PROCESSORS = ["Anthropic", "Vercel", "Upstash", "Resend", "fal.ai", "kie.ai", "Higgsfield"];
  const DPA = /data[- ]processing agreement|اتفاقيات? معالجة/i;
  const LANGS = ["ar", "en"] as const;
  // A full stop followed by a space ends a sentence; the one inside "fal.ai" or "kie.ai" does not.
  const sentences = (text: string) => text.split(/(?<=[.!?؟])\s+/);
  const privacy = (lang: "ar" | "en") => LEGAL[lang].privacy.sections.flatMap((s) => s.p).join(" ");
  const answer = (en: string) => {
    const item = HELP.flatMap((t) => t.items).find((i) => i.q.en === en);
    if (!item) throw new Error(`no help answer for "${en}"`);
    return item.a;
  };

  it("names every media processor and the media storage in both languages", () => {
    for (const lang of LANGS) {
      for (const name of ["fal.ai", "kie.ai", "Higgsfield", "Vercel Blob"]) expect(privacy(lang), `${lang}: ${name}`).toContain(name);
    }
  });

  it("discloses the providers' rights over content and that the media is AI-generated", () => {
    expect(privacy("en")).toContain("Higgsfield's terms allow it to use inputs and outputs to improve its models");
    expect(privacy("en")).toContain("kie.ai's terms allow it to use content to operate and improve its service");
    expect(privacy("en")).toContain("Images and videos made by the team are AI-generated.");
    expect(privacy("ar")).toContain("تسمح شروط Higgsfield لها باستخدام المدخلات والمخرجات لتحسين نماذجها");
    expect(privacy("ar")).toContain("وتسمح شروط kie.ai لها باستخدام المحتوى لتشغيل خدمتها وتحسينها");
    expect(privacy("ar")).toContain("الصور والفيديو التي يولّدها الفريق مصنوعة بالذكاء الاصطناعي.");
    // The old text named fal.ai as the image provider, which is no longer the whole list.
    for (const lang of LANGS) expect(privacy(lang)).not.toMatch(/fal\.ai للصور|fal\.ai for images/);
  });

  it("claims a data-processing agreement only for providers whose acceptance is recorded", () => {
    // Checked on the clause that follows the phrase ("... under data-processing agreements with X and Y."), not on the
    // whole sentence: the sentence that carries it also lists every processor, recorded or not.
    const texts = LANGS.flatMap((lang) => [
      privacy(lang),
      LEGAL[lang].terms.sections.flatMap((s) => s.p).join(" "),
      ...HELP.flatMap((t) => t.items.map((i) => i.a[lang])),
    ]);
    const claims = texts.flatMap(sentences).filter((s) => DPA.test(s));
    if (!DPA_RECORDED.length) expect(claims, "no agreement is recorded in docs/Owner_Tasks_AR.md").toEqual([]);
    for (const s of claims) {
      const clause = s.slice(s.search(DPA));
      const named = PROCESSORS.filter((p) => clause.includes(p));
      expect(named.filter((p) => !DPA_RECORDED.includes(p)), s).toEqual([]);
    }
  });

  it("the help cost answer prices images and video as the catalogue does", () => {
    const range = (kind: MediaKind) => {
      const c = MEDIA_MODELS.filter((m) => m.kind === kind).map((m) => m.credits);
      const lo = Math.min(...c), hi = Math.max(...c);
      return lo === hi ? `${lo}` : `${lo}-${hi}`;
    };
    const a = answer("What does each task cost?");
    expect(a.en).toContain(`image ${range("image")}`);
    expect(a.en).toContain(`video ${range("video")}`);
    expect(a.ar).toContain(`صورة ${range("image")}`);
    expect(a.ar).toContain(`فيديو ${range("video")}`);
  });

  it("the help video answer names the trial clip styles, every price, and that video is not published", () => {
    const a = answer("Video?");
    for (const lang of LANGS) {
      for (const id of TRIAL_VIDEO_MODELS) expect(a[lang], `${lang}: ${id}`).toContain(mediaModel(id).label[lang].split(" · ")[0]);
      for (const n of new Set(MEDIA_MODELS.filter((m) => m.kind === "video").map((m) => m.credits))) expect(a[lang]).toContain(String(n));
    }
    expect(a.en).toContain("Publishing video from Nashr is not available yet");
    expect(a.ar).toContain("نشر الفيديو من نشر غير متاح بعد");
  });

  it("the help answers on training and deletion stay true for media", () => {
    const trained = answer("Are models trained on my data?");
    for (const lang of LANGS) expect(trained[lang], lang).toContain("Higgsfield");
    expect(trained.en).not.toMatch(/^No\b/);
    expect(trained.ar).not.toMatch(/^لا\./);
    const deletion = answer("How do I delete my account?");
    for (const lang of LANGS) expect(deletion[lang], lang).toContain("Vercel Blob");
    expect(deletion.en).toContain("None of these is removed by this step");
    expect(deletion.ar).toContain("ولا يُحذف أي منها بهذه الخطوة");
  });

  it("no help, legal or in-app string claims Arabic lettering inside images works", () => {
    // No provider documents Arabic lettering (spec A27, R4). Every mention must sit in a sentence that says it is not
    // supported. A sentence ends at a full stop, a question mark, a line end or the end of the string literal.
    const FILES = [
      "src/lib/legal.ts", "src/lib/help.ts", "src/lib/app-i18n.ts", "src/lib/media-catalog.ts",
      ...readdirSync("src/components/app").filter((f) => f.endsWith(".tsx")).map((f) => join("src/components/app", f)),
    ];
    const MENTION = [/arabic (text|lettering|letters|headlines?)/gi, /(ال)?(كتابة|حروف|نصوص?|عناوين|عنوان) ?(ال)?عربي(ة)?/g];
    const NOT_SUPPORTED = /not supported|غير مدعوم/;
    const mentions: string[] = [];
    const bad: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, "utf8");
      for (const re of MENTION) for (const m of text.matchAll(re)) {
        const i = m.index ?? 0;
        const start = Math.max(...[". ", "\n", "\"", "؟"].map((b) => text.lastIndexOf(b, i))) + 1;
        const end = text.slice(i).search(/\.(\s|"|$)|[\n"؟]/);
        const sentence = text.slice(start, end < 0 ? text.length : i + end);
        mentions.push(`${file}: ${sentence}`);
        if (!NOT_SUPPORTED.test(sentence)) bad.push(`${file}: ${sentence}`);
      }
    }
    // The catalogue hint for the English headline image and the help answer on images, in both languages.
    expect(mentions.length, mentions.join("\n")).toBeGreaterThanOrEqual(4);
    expect(bad).toEqual([]);
  });
});
