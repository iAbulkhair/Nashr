"""Build dashboard.html from the template, findings.jsonl and the two ledger drafts."""
import json, os, re, sys

base = sys.argv[1]
rd = lambda p: open(os.path.join(base, p), encoding="utf-8").read()

def table_rows(md, first_col_re):
    out = []
    for line in md.splitlines():
        if re.match(r"^\|\s*" + first_col_re, line):
            cells = [c.strip() for c in re.split(r"(?<!\\)\|", line.strip())[1:-1]]
            out.append(cells)
    return out

clean = lambda s: re.sub(r"\*\*|`", "", s or "").strip()

# Founder ledger: sections Open / Done / Obsolete, 11 columns.
k = rd("raw/K-founder-ledger-draft.md")
sections = re.split(r"^### ", k, flags=re.M)
founder = []
for sec in sections:
    name = sec.split("\n", 1)[0].strip().lower()
    if name not in ("open", "done", "obsolete"):
        continue
    for c in table_rows(sec, r"F-\d+"):
        if len(c) < 11:
            continue
        fid, date, source, typ, action, why, state, ev, done, pr, nxt = c[:11]
        st = clean(state).lower()
        st = "partly" if st.startswith("part") else ("obsolete" if name == "obsolete" else ("done" if name == "done" else "open"))
        sev = clean(pr).upper()
        founder.append({
            "id": "T-" + fid.split("-")[1],  # T- so ledger ids never collide with workstream F findings
            "title": clean(action), "date": clean(date), "type": clean(typ), "state": st,
            "severity": sev if sev in ("P0", "P1", "P2") else "", "why": clean(why), "source": clean(source),
            "evidence": [clean(ev)] if clean(ev) else [], "date_done": "" if clean(done) in ("-", "") else clean(done),
            "next_ar": clean(nxt), "owner": "founder",
        })

# Claude ledger: CL rows (6 columns) and worktree rows (4 columns).
j = rd("raw/J-claude-ledger-draft.md")
claude = []
for c in table_rows(j, r"(CL|WT|BR)-\d+"):
    if len(c) == 6:
        cid, item, source, state, nxt, disp = c
    elif len(c) == 4:
        cid, item, state, disp = c; source = ""; nxt = ""
    else:
        continue
    d = clean(disp).lower()
    st = "done" if re.match(r"^(done|merged|built)", clean(state).lower()) else "open"
    sev = "P2" if "archive" in d else "P1"
    claude.append({"id": cid, "title": clean(item), "state": st, "severity": sev, "source": clean(source),
                   "next": clean(nxt) or clean(state), "disposition": clean(disp)})

findings = [json.loads(l) for l in rd("findings.jsonl").splitlines() if l.strip()]
meta = json.loads(rd("raw/dashboard-text.json"))

fo = [f for f in founder if f["state"] in ("open", "partly")]
meta["stats"] = [
    [str(sum(f["severity"] == "P0" for f in findings)), "ملاحظات P0"],
    [str(sum(f["severity"] == "P1" for f in findings)), "ملاحظات P1"],
    [str(len(findings)), "ملاحظة بعد الدمج (من 218)"],
    [f"{len(fo)} / {len(founder)}", "مهامك المفتوحة / الكل"],
    ["77", "commit على main لم تُنشر"],
    ["4", "PR مسودة مفتوحة"],
]
data = {**meta, "founder": founder, "claude": claude, "findings": findings}
html = rd("dashboard.template.html").replace("/*DATA*/null", json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))
open(os.path.join(base, "dashboard.html"), "w", encoding="utf-8").write(html)
print("founder", len(founder), {s: sum(f["state"] == s for f in founder) for s in ("open", "done", "partly", "obsolete")},
      "claude", len(claude), "findings", len(findings), "bytes", len(html))
