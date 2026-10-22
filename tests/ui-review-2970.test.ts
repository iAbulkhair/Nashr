import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Source scans for eight client-side defects from the UI review (rules 2970-2977): a stale shell balance, a `busy` flag that
// a thrown fetch never cleared, a navigation on failure, a URIError on a bad hash, a fake token, a double save and a double
// create. They read the files (like ui-p2-fixes.test.ts), so a revert fails here without a browser.
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const between = (s: string, from: string, to: string) => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from) + from.length));

describe("UI review fixes (rules 2970-2977)", () => {
  it("2970: WorkspaceProvider follows a new `initial` during render, field by field, with no effect", () => {
    const s = src("src/components/app/WorkspaceContext.tsx");
    expect(s).toContain("const [seen, setSeen] = useState(initial)");
    expect(s).toMatch(/if \(seen\.credits !== initial\.credits\) setCredits\(initial\.credits\)/);
    expect(s).toMatch(/if \(seen\.unread !== initial\.unread\) setUnread\(initial\.unread\)/);
    expect(s).toMatch(/if \(seen\.pending !== initial\.pending\) setPending\(initial\.pending\)/);
    expect(s).toContain("setSeen({ credits: initial.credits");
  });

  it("2971: ReportsPanel run() has try/catch/finally and checks res.ok", () => {
    const s = src("src/components/app/ReportsPanel.tsx");
    const fn = between(s, "async function run(type: TaskType)", "const delta =");
    expect(fn).toContain("try {");
    expect(fn).toContain("} catch {");
    expect(fn).toContain("} finally {");
    expect(fn).toContain("setBusy(null)");
    expect(fn).toMatch(/res\.json\(\)\.catch\(\(\) => \(\{\}\)\)/);
    expect(fn).toContain("res.ok && j.ok");
    expect(fn).toContain("toast.danger(t.generate.failed)");
  });

  it("2972: InspoPanel goes to the chat only on an ok answer and shows the failure line otherwise", () => {
    const s = src("src/components/app/InspoPanel.tsx");
    const fn = between(s, "async function use(i: Inspo)", "const Pill");
    expect(fn).toMatch(/if \(!res \|\| !res\.ok\) \{ setBusy\(""\); setRefusal\(t\.generate\.failed\); return; \}/);
    expect(fn.indexOf("!res.ok")).toBeLessThan(fn.indexOf('r.push(href("/chat"))'));
  });

  it("2973: IntegrationsPanel actions clear busy in finally and read replies without throwing", () => {
    const s = src("src/components/app/IntegrationsPanel.tsx");
    for (const name of ["importProducts", "selectPage", "selectOrg", "postAs", "selectAdAccount"]) {
      const fn = between(s, `async function ${name}(`, "\n  }\n");
      expect(fn, name).toContain("try {");
      expect(fn, name).toContain("} finally {");
      expect(fn, name).toContain("setBusy(false)");
      expect(fn, name).not.toMatch(/await fetch\(/);
    }
    const post = between(s, "async function post(", "async function importProducts");
    expect(post).toMatch(/\.catch\(\(\) => null\)/);
    const load = between(s, "async function load()", "useEffect(");
    expect(load).toMatch(/fetch\("\/api\/connect"\)\.catch\(\(\) => null\)/);
    expect(load).toMatch(/\.json\(\)\.catch\(\(\) => null\)/);
    expect(s).not.toContain('await (await fetch("/api/connect")).json()');
  });

  it("2974: HelpCenter decodes the hash inside try/catch", () => {
    const s = src("src/components/HelpCenter.tsx");
    expect(s).toMatch(/try \{ id = decodeURIComponent\(location\.hash\.slice\(1\)\); \} catch/);
    expect(s).not.toMatch(/getElementById\(decodeURIComponent/);
  });

  it("2974: the decode guard really survives a malformed escape", () => {
    expect(() => decodeURIComponent("%E0%A4%A")).toThrow(URIError);
    const safe = (hash: string) => { let id = ""; try { id = decodeURIComponent(hash.slice(1)); } catch { /* malformed */ } return id; };
    expect(safe("#%E0%A4%A")).toBe("");
    expect(safe("#how-to%20start")).toBe("how-to start");
  });

  it("2975: McpPanel gen() checks res.ok, blocks a second click and shows an error", () => {
    const s = src("src/components/app/McpPanel.tsx");
    const fn = between(s, "async function gen()", "async function revoke()");
    expect(fn).toContain("if (busy) return;");
    expect(fn).toContain("setBusy(true)");
    expect(fn).toContain("res?.ok");
    expect(fn).toMatch(/typeof j\.token === "string"/);
    expect(fn).toContain("setErr(");
    expect(fn).toContain("setBusy(false)");
    expect(s).toContain("onClick={gen} disabled={busy}");
    expect(s).toContain('role="alert"');
  });

  it("2976: FilesPanel saves one at a time, clears the conflict on Edit and leaves the open editor alone for a new file", () => {
    const s = src("src/components/app/FilesPanel.tsx");
    const fn = between(s, "async function save(", "async function del(");
    expect(fn).toContain("if (savingRef.current) return;");
    expect(fn).toContain("setSaving(true)");
    expect(fn).toContain("} finally {");
    expect(fn).toContain("setSaving(false)");
    expect(fn).toMatch(/if \(!create\) \{ setConflict\(null\); setEditing\(false\); \}/);
    expect(fn).toMatch(/j\.error === "stale" && !create/);
    expect(s).toMatch(/"\\n", null, true\)/);
    expect(s).toMatch(/setEditing\(true\); setErr\(""\); setConflict\(null\)/);
    expect(s.match(/disabled=\{saving\}/g)?.length).toBe(2);
  });

  it("2977: ChatPanel newConv has a pending guard, survives a failed request, and the first list read has a catch", () => {
    const s = src("src/components/app/ChatPanel.tsx");
    const fn = between(s, "async function newConv(", "async function pick(");
    expect(fn).toContain("if (creatingRef.current) return;");
    expect(fn).toMatch(/\.catch\(\(\) => null\)/);
    expect(fn).toContain("setCreating(false)");
    expect(fn).toContain("j?.ok");
    expect(s).toContain("<button disabled={creating} onClick={() => newConv()}");
    const first = s.slice(s.indexOf('useEffect(() => { void fetch("/api/conversations")'));
    expect(first.slice(0, first.indexOf("[initialConv"))).toContain(".catch(() => {})");
  });
});
