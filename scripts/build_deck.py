"""Build Nashr seed pitch deck (16:9) with python-pptx."""
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
from pptx.util import Emu, Inches, Pt

OUT = "docs/Nashr_Pitch_Deck.pptx"
OASIS = RGBColor(0x0F, 0x3D, 0x3A)
DEEP = RGBColor(0x0A, 0x2B, 0x29)
SALT = RGBColor(0xF6, 0xF4, 0xEE)
SAFF = RGBColor(0xF2, 0xB3, 0x3D)
SADU = RGBColor(0xD9, 0x50, 0x3F)
INK = RGBColor(0x10, 0x14, 0x18)
MIST = RGBColor(0xE9, 0xF0, 0xEC)
DIM = RGBColor(0xA9, 0xBF, 0xB8)
GREY = RGBColor(0x55, 0x5B, 0x60)

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
W, Hh = prs.slide_width, prs.slide_height
BLANK = prs.slide_layouts[6]


def bg(slide, color):
    f = slide.background.fill
    f.solid()
    f.fore_color.rgb = color


def rect(slide, x, y, w, h, color, shape=MSO_SHAPE.RECTANGLE):
    s = slide.shapes.add_shape(shape, x, y, w, h)
    s.fill.solid()
    s.fill.fore_color.rgb = color
    s.line.fill.background()
    return s


def sadu(slide, y=None):
    """Signature woven stripe."""
    y = Hh - Inches(0.18) if y is None else y
    seq = [(SADU, 0.28), (INK, 0.08), (SALT, 0.14), (INK, 0.08), (SAFF, 0.28), (INK, 0.08), (SALT, 0.14), (INK, 0.08)]
    x = 0
    while x < W:
        for c, w in seq:
            rect(slide, Emu(x), y, Inches(w), Inches(0.18), c)
            x += Inches(w)
            if x >= W:
                break


def text(slide, x, y, w, h, s, size=18, color=INK, bold=False, align=PP_ALIGN.LEFT, font="Avenir Next"):
    tb = slide.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    lines = s if isinstance(s, list) else [s]
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        run = p.add_run()
        run.text = line
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = color
        run.font.name = font
        p.space_after = Pt(6)
    return tb


def bullets(slide, x, y, w, h, items, size=16, color=INK):
    tb = slide.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    for i, it in enumerate(items):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        r = p.add_run()
        r.text = "•  " + it
        r.font.size = Pt(size)
        r.font.color.rgb = color
        r.font.name = "Avenir Next"
        p.space_after = Pt(8)
    return tb


def slide_dark(title, eyebrow=None, n=None):
    s = prs.slides.add_slide(BLANK)
    bg(s, DEEP)
    if eyebrow:
        text(s, Inches(0.8), Inches(0.5), Inches(8), Inches(0.4), eyebrow.upper(), 11, SAFF, True)
    text(s, Inches(0.8), Inches(0.85), Inches(11.5), Inches(1.2), title, 34, MIST, True)
    if n:
        text(s, W - Inches(1.6), Hh - Inches(0.6), Inches(1), Inches(0.3), f"{n:02d}", 10, DIM, align=PP_ALIGN.RIGHT)
    sadu(s)
    return s


def slide_light(title, eyebrow=None, n=None):
    s = prs.slides.add_slide(BLANK)
    bg(s, SALT)
    if eyebrow:
        text(s, Inches(0.8), Inches(0.5), Inches(8), Inches(0.4), eyebrow.upper(), 11, SADU, True)
    text(s, Inches(0.8), Inches(0.85), Inches(11.5), Inches(1.2), title, 34, OASIS, True)
    if n:
        text(s, W - Inches(1.6), Hh - Inches(0.6), Inches(1), Inches(0.3), f"{n:02d}", 10, GREY, align=PP_ALIGN.RIGHT)
    sadu(s)
    return s


def stat(slide, x, y, num, label, dark=True):
    text(slide, x, y, Inches(2.9), Inches(0.9), num, 40, SAFF if dark else OASIS, True)
    text(slide, x, y + Inches(0.85), Inches(2.9), Inches(0.8), label, 13, DIM if dark else GREY)


def table(slide, x, y, w, rows, col_w=None, size=12, dark=False):
    nrows, ncols = len(rows), len(rows[0])
    shp = slide.shapes.add_table(nrows, ncols, x, y, w, Inches(0.4) * nrows)
    t = shp.table
    if col_w:
        for j, cw in enumerate(col_w):
            t.columns[j].width = cw
    for i, row in enumerate(rows):
        for j, val in enumerate(row):
            cell = t.cell(i, j)
            p = cell.text_frame.paragraphs[0]
            run = p.add_run()
            run.text = str(val)
            run.font.size = Pt(size)
            run.font.name = "Avenir Next"
            run.font.bold = i == 0
            run.font.color.rgb = MIST if (i == 0 or dark) else INK
            cell.fill.solid()
            cell.fill.fore_color.rgb = OASIS if i == 0 else (DEEP if dark else (SALT if i % 2 else RGBColor(0xEB, 0xE7, 0xDC)))
    return shp


# 1 Cover
s = prs.slides.add_slide(BLANK)
bg(s, DEEP)
text(s, Inches(0.8), Inches(1.6), Inches(6), Inches(1), "نشر  ·  Nashr", 22, SAFF, True)
text(s, Inches(0.8), Inches(2.3), Inches(11), Inches(2.4), ["While you sleep,", "Noor markets."], 60, MIST, True)
text(s, Inches(0.8), Inches(4.7), Inches(10), Inches(1), "The autonomous AI marketing agent for Gulf businesses — Arabic-first, WhatsApp-native, hosted in-Kingdom.", 18, DIM)
text(s, Inches(0.8), Inches(6.2), Inches(10), Inches(0.5), "Seed round  ·  September 2026  ·  Riyadh", 12, DIM)
sadu(s)

# 2 Problem
s = slide_light("Every Gulf business needs daily marketing in two languages across six channels. Almost none have a marketer.", "Problem", 2)
bullets(s, Inches(0.8), Inches(2.6), Inches(6.2), Inches(4), [
    "40k+ Salla and Zid stores, 100k+ SMEs on Snap/TikTok ads — most run by the owner, at night.",
    "Freelancers and agencies charge SAR 2–6k/month for inconsistent Arabic content and zero accountability.",
    "Ads are tuned by gut. Seasons (Ramadan, National Day, White Friday) arrive unplanned.",
    "Leads land on WhatsApp and go cold. No one follows up.",
    "Global AI tools are English-first, non-agentic, and blind to Gulf channels, payments, and calendar.",
], 16)
rect(s, Inches(7.6), Inches(2.6), Inches(4.9), Inches(3.6), OASIS, MSO_SHAPE.ROUNDED_RECTANGLE)
text(s, Inches(7.9), Inches(2.8), Inches(4.4), Inches(0.5), "What a merchant told us", 12, SAFF, True)
text(s, Inches(7.9), Inches(3.3), Inches(4.4), Inches(2.8), "“I spend SAR 25k a month on Snap and I have no idea if it works. I post when I remember. Ramadan came and I had nothing ready.”", 18, MIST)
text(s, Inches(7.9), Inches(5.6), Inches(4.4), Inches(0.5), "— Perfume store, Riyadh, SAR 1.8M GMV", 11, DIM)

# 3 Solution
s = slide_dark("Noor: an AI agent that plans, creates, publishes, tunes ads, and reports — you only approve.", "Solution", 3)
cols = [
    ("Connect", "Salla · Zid · Shopify · Snap · TikTok · Meta · Google · WhatsApp — one-click OAuth."),
    ("Learn", "Brand voice file: dialect, tone, banned words, competitors. Improves with every edit."),
    ("Plan", "Weekly plan from your real numbers and the Gulf calendar, 4 weeks ahead of every season."),
    ("Execute", "Posts, articles, WhatsApp flows, ad budget moves — inside guardrails you set."),
    ("Report", "08:00 WhatsApp brief: revenue, ROAS, what she did, what needs a yes."),
]
for i, (h, b) in enumerate(cols):
    x = Inches(0.8 + i * 2.45)
    rect(s, x, Inches(2.6), Inches(2.25), Inches(3.4), OASIS, MSO_SHAPE.ROUNDED_RECTANGLE)
    text(s, x + Inches(0.2), Inches(2.75), Inches(1.9), Inches(0.5), h, 18, SAFF, True)
    text(s, x + Inches(0.2), Inches(3.3), Inches(1.9), Inches(2.6), b, 12, MIST)

# 4 Product (overnight log)
s = slide_light("A night with Noor", "Product", 4)
rows = [
    ("Time", "Action", "Agent"),
    ("23:40", "Snap campaign ROAS fell to 1.8 → cut 30%, moved budget to TikTok", "Sultan · Ads"),
    ("01:15", "Wrote 1,800-word Arabic article on a keyword competitors miss", "Faisal · SEO/GEO"),
    ("02:50", "12 posts for next week in light Saudi dialect + 3 UGC scripts", "Lama · Social"),
    ("04:30", "Competitor changed 6 prices → comparison added to brief", "Noor"),
    ("06:00", "Abandoned-cart WhatsApp to 214 customers (expected 8–12% conversion)", "Reem · WhatsApp"),
    ("08:00", "Morning brief sent: 4 approvals pending, revenue SAR 18,420 (+11%)", "Noor"),
]
table(s, Inches(0.8), Inches(2.5), Inches(11.7), rows, [Inches(1.1), Inches(8.2), Inches(2.4)], 13)
text(s, Inches(0.8), Inches(5.9), Inches(11), Inches(0.6), "Default: everything waits for approval. Trust builds → delegate by type. Acceptance rate reaches 95% by week 8.", 13, GREY)

# 5 Why now
s = slide_dark("Why now", "Timing", 5)
stat(s, Inches(0.8), Inches(2.5), "90%+", "of Saudi internet users on Snapchat; TikTok Shop live in KSA")
stat(s, Inches(3.9), Inches(2.5), "40k+", "Salla/Zid merchants — an app-store distribution channel that didn't exist 4 years ago")
stat(s, Inches(7.0), Inches(2.5), "PDPL", "In-Kingdom data rules now enforced — global tools can't comply cheaply")
stat(s, Inches(10.1), Inches(2.5), "$39→", "Agentic marketing proven in the US (Enrich Labs, 1,400+ businesses in 18 months)")
text(s, Inches(0.8), Inches(4.9), Inches(11.5), Inches(1.5), "Frontier models now write Gulf Arabic well enough to ship with a human QA loop. WhatsApp Business API is open. Agent frameworks are mature. The window to own “the marketer for Salla stores” is 12–18 months.", 16, MIST)

# 6 Market
s = slide_light("Market", "Size", 6)
stat(s, Inches(0.8), Inches(2.4), "SAR 9B", "GCC digital ad spend 2026 (SAM proxy: SMB share ~35%)", dark=False)
stat(s, Inches(4.2), Inches(2.4), "1.2M", "SMEs in KSA (Monsha'at); ~300k actively advertising online", dark=False)
stat(s, Inches(7.6), Inches(2.4), "SAR 1.4B", "Serviceable: 300k SMBs × SAR 4.8k/yr blended ARPA", dark=False)
text(s, Inches(0.8), Inches(4.6), Inches(11.5), Inches(1.6), ["Beachhead: KSA e-commerce (Salla, Zid, Shopify) → real estate, legal, startups, clinics, restaurants, agencies.", "Expansion: UAE and Kuwait in year 2 (same channels, same calendar, AED/KWD billing)."], 15, GREY)

# 7 Business model
s = slide_dark("Subscription + credits. Cheaper than one hire, faster than an agency.", "Business model", 7)
rows = [
    ("Plan", "SAR / month", "Credits", "For", "Gross margin"),
    ("Starter", "149", "200", "Solo sellers, creators", "~69%"),
    ("Pro", "399", "700", "Founders, stores, clinics", "~75%"),
    ("Agency", "799", "2,000 (roll over)", "Agencies, multi-branch", "~72%"),
    ("Enterprise", "custom (~4,500)", "custom", "Groups, real-estate developers", "~79%"),
]
table(s, Inches(0.8), Inches(2.5), Inches(11.7), rows, [Inches(1.6), Inches(2.0), Inches(2.2), Inches(3.9), Inches(2.0)], 13, dark=True)
text(s, Inches(0.8), Inches(5.0), Inches(11.5), Inches(1.4), ["Credits meter real model + media cost (post = 1, article = 2, WhatsApp campaign = 3, video = 12–24). Top-ups and extra seats/brands add ~12% revenue.", "7-day trial, no card. Annual = 2 months free. Billing via Tap/Moyasar (mada, Apple Pay, STC Pay)."], 13, DIM)

# 8 Moat
s = slide_light("Why a US player can't just localize", "Moat", 8)
rows = [
    ("", "Enrich Labs (Helena)", "Nashr (Noor)"),
    ("Language", "English", "Arabic, dialect-aware (Saudi / Emirati / Kuwaiti) + English"),
    ("Ads", "Meta, Google, TikTok", "Snapchat first, TikTok, Meta, Google, X"),
    ("Owned channel", "Email (Klaviyo)", "WhatsApp Business API (+SMS, email)"),
    ("Commerce", "Shopify, Woo", "Salla, Zid, Shopify, Woo — app-store distribution"),
    ("Calendar", "US retail", "Hijri + national days + White Friday + DSF"),
    ("Data", "US hosting", "KSA region, PDPL-compliant"),
    ("Payments", "Stripe", "Tap / Moyasar, mada, Tabby/Tamara awareness"),
]
table(s, Inches(0.8), Inches(2.4), Inches(11.7), rows, [Inches(2.0), Inches(3.5), Inches(6.2)], 12)

# 9 GTM
s = slide_dark("Go-to-market: distribution we don't have to buy", "GTM", 9)
bullets(s, Inches(0.8), Inches(2.5), Inches(5.8), Inches(4), [
    "Salla + Zid app stores — “Noor for Salla”, 30 days free for installs.",
    "Founder-led Arabic content: free tools (hook generator, Ramadan planner, Snap audit), weekly threads, YouTube teardowns.",
    "Agency white-label: 25% rev-share; agencies bring 5–10 brands each.",
    "Partnerships: Tap/Moyasar merchant base, Monsha'at programs, Snap KSA partner team, TikTok Shop MENA.",
    "Paid: Snap + Meta to merchants; LinkedIn to real-estate and agencies.",
], 15, MIST)
rect(s, Inches(7.2), Inches(2.5), Inches(5.3), Inches(3.8), OASIS, MSO_SHAPE.ROUNDED_RECTANGLE)
text(s, Inches(7.5), Inches(2.7), Inches(4.8), Inches(0.4), "Launch sequence", 12, SAFF, True)
bullets(s, Inches(7.5), Inches(3.2), Inches(4.8), Inches(3), [
    "Now: waitlist live (nashr site, AR/EN)",
    "Weeks 4–8: 20 design partners",
    "Week 10: Salla app-store beta",
    "November: public launch before White Friday",
    "Month 6: 300 paying brands",
], 13, MIST)

# 10 Traction plan
s = slide_light("Traction plan and targets", "Milestones", 10)
rows = [
    ("", "Month 3", "Month 6", "Month 12", "Month 24"),
    ("Paying brands", "80", "220", "970", "4,800"),
    ("MRR (SAR)", "33k", "97k", "436k", "2.2M"),
    ("Acceptance rate", "80%", "88%", "93%", "95%"),
    ("Gross margin", "70%", "72%", "74%", "74%"),
    ("Team", "4", "8", "12", "17"),
]
table(s, Inches(0.8), Inches(2.5), Inches(11.7), rows, [Inches(2.5)] + [Inches(2.3)] * 4, 14)
text(s, Inches(0.8), Inches(5.3), Inches(11.5), Inches(1), "Leading indicator we watch weekly: approved actions per brand per week. Lagging: net revenue retention ≥ 100%.", 13, GREY)

# 11 Competition
s = slide_dark("Competition", "Landscape", 11)
rows = [
    ("", "Agentic (does the work)", "Gulf-native", "Ads + WhatsApp + content in one"),
    ("Nashr", "✓", "✓", "✓"),
    ("Enrich Labs / Helena", "✓", "✗", "partial (email, not WhatsApp)"),
    ("Jasper, Copy.ai", "✗ (writes only)", "✗", "✗"),
    ("Hootsuite, Predis", "✗ (schedules only)", "✗", "✗"),
    ("Local agencies", "✓ (humans)", "✓", "✓ at 10× the price"),
    ("Salla/Zid built-in tools", "✗", "✓", "✗"),
]
table(s, Inches(0.8), Inches(2.4), Inches(11.7), rows, [Inches(3.0), Inches(2.9), Inches(2.4), Inches(3.4)], 13, dark=True)

# 12 Financials
s = slide_light("Financials (base case, SAR)", "Model", 12)
rows = [
    ("", "Year 1", "Year 2", "Year 3"),
    ("Revenue", "1.9M", "15.1M", "43.2M"),
    ("Gross margin", "74%", "74%", "74%"),
    ("EBITDA", "(2.1M)", "3.4M", "18.8M"),
    ("Ending paying brands", "970", "4,830", "10,690"),
    ("Ending headcount", "12", "17", "30"),
]
table(s, Inches(0.8), Inches(2.5), Inches(7.2), rows, [Inches(2.7), Inches(1.5), Inches(1.5), Inches(1.5)], 14)
rect(s, Inches(8.6), Inches(2.5), Inches(3.9), Inches(3.6), OASIS, MSO_SHAPE.ROUNDED_RECTANGLE)
text(s, Inches(8.9), Inches(2.7), Inches(3.4), Inches(0.4), "Unit economics (blended)", 12, SAFF, True)
bullets(s, Inches(8.9), Inches(3.2), Inches(3.4), Inches(3), ["ARPA SAR 452/mo", "Gross profit / brand SAR 336", "CAC SAR 650", "Payback 1.9 months", "LTV:CAC 12.9×  (25-month life)"], 13, MIST)
text(s, Inches(0.8), Inches(5.4), Inches(7.5), Inches(1), "Full 36-month model with live assumptions: Nashr_Financial_Model.xlsx. Figures above are indicative outputs of the base case; verify in the workbook.", 11, GREY)

# 13 Team
s = slide_dark("Team", "People", 13)
for i, (name, role, note) in enumerate([
    ("Founder / CEO", "Product, GTM, Gulf market", "Replace with founder bio: prior exits, Saudi e-commerce and marketing background."),
    ("Founding engineer", "Agents, connectors, infra", "Hiring: TypeScript + LLM tooling; Salla/Zid API experience a plus."),
    ("AI / Arabic lead", "Dialect quality, evals", "Hiring: NLP + native Gulf Arabic; builds the 300-item golden set."),
    ("Growth / partnerships", "Salla, Zid, agencies", "Hiring: ex-Salla/Zid partner team or agency founder."),
]):
    x = Inches(0.8 + i * 3.05)
    rect(s, x, Inches(2.5), Inches(2.85), Inches(3.6), OASIS, MSO_SHAPE.ROUNDED_RECTANGLE)
    text(s, x + Inches(0.2), Inches(2.7), Inches(2.5), Inches(0.5), name, 16, SAFF, True)
    text(s, x + Inches(0.2), Inches(3.2), Inches(2.5), Inches(0.5), role, 12, MIST, True)
    text(s, x + Inches(0.2), Inches(3.8), Inches(2.5), Inches(2.2), note, 11, DIM)
text(s, Inches(0.8), Inches(6.3), Inches(11.5), Inches(0.5), "Advisors to recruit: a Salla/Zid executive, a Snap KSA partner lead, a PDPL/legal advisor.", 12, DIM)

# 14 Ask
s = slide_light("The ask", "Raise", 14)
text(s, Inches(0.8), Inches(2.3), Inches(6), Inches(1.2), "SAR 6M seed (~USD 1.6M)", 40, OASIS, True)
text(s, Inches(0.8), Inches(3.3), Inches(6), Inches(0.6), "Funds the team to cash-flow positive (~month 20): 1,000 paying brands and SAR 430k MRR by month 12", 16, GREY)
rows = [
    ("Use of funds", "Share"),
    ("Engineering + AI (6 hires)", "55%"),
    ("Growth, partnerships, content", "25%"),
    ("Arabic QA + customer success", "12%"),
    ("Legal, compliance, KSA hosting", "8%"),
]
table(s, Inches(7.4), Inches(2.4), Inches(5.1), rows, [Inches(3.6), Inches(1.5)], 13)
bullets(s, Inches(0.8), Inches(4.3), Inches(6.2), Inches(2), [
    "Milestones unlocked: Salla + Zid app-store listings, WhatsApp + Snap approvals, 20 design partners → 220 paying by month 6, 970 by month 12.",
    "Series A trigger: SAR 1M MRR (~month 18), NRR ≥ 105%, UAE live.",
], 14)
text(s, Inches(0.8), Inches(6.4), Inches(11), Inches(0.5), "hello@nashr.ai  ·  nashr.ai", 12, GREY)

prs.save(OUT)
print("saved", OUT, len(prs.slides), "slides")
