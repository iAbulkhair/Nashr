"""Merge raw/findings-[A-J].jsonl into findings.jsonl: one item per root cause, duplicates listed as absorbed."""
import json, glob, os, sys
from collections import Counter

base = sys.argv[1]
rows = {}
order = []
for f in sorted(glob.glob(os.path.join(base, "raw", "findings-[A-J].jsonl"))):
    for line in open(f, encoding="utf-8"):
        if line.strip():
            r = json.loads(line)
            rows[r["id"]] = r
            order.append(r["id"])

# root id -> absorbed ids (coordinator dedupe, 2026-10-11)
ABSORB = {
    "F-001": ["A-003"],
    "C-001": ["F-003", "A-013", "D-015", "F-025", "F-010", "A-021", "B-017", "J-010"],
    "I-001": ["A-002"],
    "I-002": ["I-003", "I-009"],
    "I-004": ["A-004", "G-010"],
    "G-007": ["A-001", "E-012"],
    "F-002": ["D-004"],
    "G-003": ["C-003", "A-023", "G-015"],
    "C-002": ["G-006", "D-007"],
    "E-001": ["E-002", "E-003", "E-009", "E-019"],
    "C-005": ["F-006", "F-007", "A-014"],
    "F-004": ["B-002", "F-017"],
    "B-001": ["F-011"],
    "B-003": ["F-009", "D-016"],
    "F-012": ["D-001", "A-006"],
    "J-003": ["A-010"],
    "J-002": ["F-022", "A-020"],
    "E-011": ["A-016", "I-017", "I-010"],
    "H-001": ["H-003"],
    "F-014": ["H-014", "A-022", "H-010"],
    "J-004": ["C-017"],
    "J-015": ["D-022"],
    "B-012": ["J-016", "B-011"],
    "J-006": ["J-011", "J-012", "J-007"],
    "I-006": ["I-007"],
    "I-005": ["I-013", "I-018"],
}
SEV = {"P0": 0, "P1": 1, "P2": 2}
parent = {a: p for p, v in ABSORB.items() for a in v}
missing = [i for i in list(ABSORB) + sorted(parent) if i not in rows]
if missing:
    sys.exit(f"unknown ids: {missing}")

def remap(deps, self_ids):
    return sorted({parent.get(d, d) for d in deps} - set(self_ids))

out = []
for i in order:
    if i in parent:
        continue
    r = dict(rows[i])
    kids = ABSORB.get(i, [])
    deps = set(r.get("depends_on", []))
    if kids:
        r["absorbed"] = kids
        r["severity"] = min([r["severity"]] + [rows[k]["severity"] for k in kids], key=SEV.get)
        owners = {r["owner"]} | {rows[k]["owner"] for k in kids}
        if len(owners) > 1:
            r["owner"] = "both"
        ev = list(r.get("evidence", []))
        for k in kids:
            deps |= set(rows[k].get("depends_on", []))
            for e in rows[k].get("evidence", []):
                if e not in ev:
                    ev.append(e)
        r["evidence"] = ev[:14]
    r["depends_on"] = remap(deps, [i] + kids)
    out.append(r)

out.sort(key=lambda r: (SEV[r["severity"]], r["workstream"], r["id"]))
with open(os.path.join(base, "findings.jsonl"), "w", encoding="utf-8") as fh:
    for r in out:
        fh.write(json.dumps(r, ensure_ascii=False) + "\n")
print(len(rows), "raw ->", len(out), "merged;", dict(Counter(r["severity"] for r in out)), dict(Counter(r["owner"] for r in out)))
for r in out:
    if r["severity"] == "P0":
        print(r["id"], r["owner"], r["title"][:110], r.get("absorbed", ""))
