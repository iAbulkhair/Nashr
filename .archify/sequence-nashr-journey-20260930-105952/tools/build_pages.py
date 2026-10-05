"""Builds catalog.html (every step as a table) and index.html (links to every diagram)
from the per-chunk steps.json and candidate.json files. Usage: python3 build_pages.py <root> <rev>"""
import json, sys, html
root, REV = sys.argv[1], sys.argv[2]
GH = f"https://github.com/iAbulkhair/Nashr/blob/{REV}/"
cap = lambda t: t[:1].upper() + t[1:]
e = lambda t: html.escape(str(t if t is not None else ''))
plan = json.load(open(root + '/plan.json'))
CSS = """:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--mute:#5f5f5a;--line:#e4e3de;--acc:#0f766e;--chip:#eef6f5}
@media (prefers-color-scheme:dark){:root{--bg:#151514;--card:#1e1e1c;--ink:#ecebe6;--mute:#a3a29b;--line:#34332f;--acc:#5eead4;--chip:#1f2e2c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--acc)}.num{display:inline-block;min-width:26px;padding:0 6px;border-radius:6px;background:var(--chip);color:var(--acc);font-weight:600;font-size:12px;text-align:center}
.lead{color:var(--mute);margin:4px 0 12px;max-width:820px}"""

def srcs(x):
    out = []
    for s in x.get('sources', []):
        end = s.get('end_line') if s.get('end_line') and s['end_line'] > s['line'] else None
        anchor = f"#L{s['line']}" + (f"-L{end}" if end else '')
        label = f"{s['path']}:{s['line']}" + (f"–{end}" if end else '')
        out.append(f'<a href="{e(GH + s["path"] + anchor)}" target="_blank" rel="noopener">{e(label)}</a>')
    return '<br>'.join(out)

def row(n, x):
    br = ''.join(f'<li>{e(b)}</li>' for b in x.get('branches') or [])
    c = x.get('conditions')
    cond = f'<p class="cond"><b>Needs:</b> {e(c)}</p>' if c and str(c).strip().lower() not in ('none', 'none.', '') else ''
    return (f'<tr id="{e(x["id"])}"><td class="n">{n}</td><td><div class="t">{e(x["title"])}</div><div class="who">{e(x["actor"])}</div>'
            f'<div class="surf">{e(x["surface"])}</div></td><td>{e(x["action"])}</td><td>{e(x["ui_response"])}</td>'
            f'<td>{e(x["system_reaction"])}{cond}{("<ul>" + br + "</ul>") if br else ""}</td><td class="src">{srcs(x)}</td></tr>')

HEAD = '<table><thead><tr><th>#</th><th>Step</th><th>The person does</th><th>They see</th><th>The system does</th><th>Code</th></tr></thead><tbody>'
n = 0; sections = []; toc = []; total_msgs = 0; cards = {}
for p in plan:
    k = p['key']; d = json.load(open(f"{root}/{k}/steps.json")); cand = json.load(open(f"{root}/{k}/candidate.json"))
    rows = []
    for x in d['steps']:
        n += 1; rows.append(row(n, x))
    total_msgs += len(cand['messages'])
    sections.append(f'<section id="{e(k)}"><h2><span class="num">{e(k[:2])}</span> {e(p["title"])}<a class="diag" href="{e(k)}/{e(k)}.html">open diagram →</a></h2>{HEAD}{"".join(rows)}</tbody></table></section>')
    toc.append(f'<li><a href="#{e(k)}"><span class="num">{e(k[:2])}</span> {e(p["title"])}</a> <span class="cnt">{len(d["steps"])}</span></li>')
    cards[k] = (f'<a class="card" href="{e(k)}/{e(k)}.html"><span class="num">{e(k[:2])}</span><span class="t">{e(cap(p["title"].split(": ", 1)[-1]))}</span>'
                f'<span class="m">{len(d["steps"])} steps · {len(cand["messages"])} arrows</span></a>')
customer = n
extras = json.load(open(root + '/99-extras/steps.json'))['steps']
founder = [x for x in extras if x.get('actor') == 'founder' or 'golden' in x['id'] or 'founder' in x['id']]
repeats = [x for x in extras if x not in founder]
for title, note, xs, key in [("Also mapped: repeats of steps above", "The same action reached from another screen. Kept so nothing is lost; the diagrams show each once.", repeats, "repeats"),
                             ("Founder console (operator, not the customer)", "What the founder does behind the scenes. Not part of the customer diagrams.", founder, "founder")]:
    rows = []
    for x in xs:
        n += 1; rows.append(row(n, x))
    sections.append(f'<section id="{key}"><h2>{e(title)}</h2><p class="lead">{e(note)}</p>{HEAD}{"".join(rows)}</tbody></table></section>')
    toc.append(f'<li><a href="#{key}">{e(title.split(" (")[0].split(":")[0])}</a> <span class="cnt">{len(xs)}</span></li>')

catalog = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nashr Journey Steps</title>
<style>{CSS}
header,nav,main{{max-width:1400px;margin:auto;padding-left:16px;padding-right:16px}}header{{padding-top:28px}}h1{{margin:0 0 6px;font-size:26px}}
nav ol{{list-style:none;padding:0;margin:8px 0 20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:6px 18px}}nav a{{color:var(--ink);text-decoration:none}}.cnt{{color:var(--mute);font-size:12px}}
main{{padding-bottom:60px}}section{{margin:28px 0}}h2{{font-size:19px;margin:0 0 10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}}a.diag{{font-size:13px;font-weight:500;text-decoration:none;margin-left:auto}}
table{{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);table-layout:fixed}}th,td{{text-align:left;vertical-align:top;padding:9px 10px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}}
th{{font-size:12px;color:var(--mute);font-weight:600;background:var(--bg)}}th:nth-child(1){{width:44px}}th:nth-child(2){{width:15%}}th:nth-child(6){{width:15%}}td.n{{color:var(--mute)}}.t{{font-weight:600}}.who{{font-size:12px;color:var(--acc)}}.surf{{font-size:12px;color:var(--mute)}}
td ul{{margin:6px 0 0;padding-left:18px;color:var(--mute);font-size:13px}}.cond{{margin:6px 0 0;font-size:13px;color:var(--mute)}}td.src{{font-size:12px}}
@media (max-width:900px){{table,thead,tbody,tr,td{{display:block;width:100%}}thead{{display:none}}tr{{border-bottom:1px solid var(--line);padding:6px 0}}td{{border:0;padding:4px 10px}}td.n{{display:none}}
td:nth-child(3)::before{{content:"Does: ";font-weight:600}}td:nth-child(4)::before{{content:"Sees: ";font-weight:600}}td:nth-child(5)::before{{content:"System: ";font-weight:600}}}}</style></head><body>
<header><h1>Nashr user journey: every step</h1><p class="lead">{customer} customer steps plus {len(extras)} founder-console and repeated steps, traced in the code at commit {e(REV[:7])}, from the first visit to daily use. Each row: what the person does, what they see, what the system does, and the exact lines of code. Model calls are paused in this build, so rows say what the person sees then.</p>
<p class="lead"><a href="index.html">← journey index</a></p></header><nav><ol>{"".join(toc)}</ol></nav><main>{"".join(sections)}</main></body></html>'''
open(root + '/catalog.html', 'w').write(catalog)

groups = [("Discover", "01", "02"), ("Join and set up", "03", "05"), ("Create", "06", "07"), ("Review and publish", "08", "10"), ("Every day", "11", "13"), ("Manage any time", "14", "16")]
secs = ''.join(f'<section><h2>{e(g)}</h2><div class="grid">{"".join(v for k, v in cards.items() if a <= k[:2] <= b)}</div></section>' for g, a, b in groups)
index = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nashr User Journey</title>
<style>{CSS}
body{{font-size:15px}}main{{max-width:1100px;margin:auto;padding:32px 16px 60px}}h1{{font-size:28px;margin:0 0 8px}}
.top{{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin:18px 0 8px}}.big,.card{{border:1px solid var(--line);background:var(--card);color:var(--ink);text-decoration:none;border-radius:10px}}
.big{{display:block;padding:18px}}.big b{{display:block;font-size:17px;margin-bottom:4px}}.big span{{color:var(--mute);font-size:14px}}.big:hover,.card:hover{{border-color:var(--acc)}}
h2{{font-size:13px;margin:26px 0 10px;color:var(--mute);font-weight:600;text-transform:uppercase;letter-spacing:.05em}}.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}}
.card{{display:flex;flex-direction:column;gap:4px;padding:14px}}.card .num{{align-self:flex-start}}.t{{font-weight:600}}.m{{color:var(--mute);font-size:13px}}.foot{{margin-top:30px;color:var(--mute);font-size:13px}}</style></head><body><main>
<h1>Nashr user journey</h1>
<p class="lead">Every step a person takes, from the first visit to daily use: what they do, how the product answers, and what the system does behind it. {customer} customer steps in 16 step-by-step diagrams ({total_msgs:,} arrows), traced in the code at commit {e(REV[:7])}.</p>
<div class="top"><a class="big" href="00-overview/00-overview.html"><b>Start here: the journey on one page</b><span>Six stages: what the person does, what the system does, what they see</span></a>
<a class="big" href="catalog.html"><b>Every step as a table</b><span>{n} rows with links to the exact lines of code</span></a></div>
{secs}<p class="foot">Model calls are paused in this build (CLAUDE_PAUSED), so the diagrams show what the person sees while the model is off and what happens when it is on. Diagrams made with Archify.</p></main></body></html>'''
open(root + '/index.html', 'w').write(index)
print(f"catalog rows {n} (customer {customer}, repeats {len(repeats)}, founder {len(founder)}), arrows {total_msgs}")
