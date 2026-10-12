import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { newMember, newUser, signIn } from "./helpers/session";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { render } from "@/lib/md";
import { splitTitle } from "@/lib/connectors/publish";
import { currencyOf } from "@/lib/zones";
import { taskSpec } from "@/lib/noor";
import { STALLED_AFTER_H, STALLED_MAX, stalledSignups } from "@/lib/admin-stats";
import { MODEL_ERROR_COPY, customerCode, modelErrorCause, modelErrorText, providerFault } from "@/lib/provider-errors";
import { customerModelError, noteProviderFault } from "@/lib/provider-fault-note";
import { APPROVER_DAYS, approverStats } from "@/lib/approver-stats";
import { recordDecisions, type Decision } from "@/lib/decisions";
import { teamView } from "@/lib/team";
import { can } from "@/lib/roles";
import { CHAT_FIRST_MIN_OUT, workspaceLarge } from "@/lib/chat-budget";

/** Rules 1472-1485: the founder's small decided fixes of 2026-10-12 (docs/system/tests/1470-small-decided-fixes.md). Rules 1470-1471 live in tests/partners.test.ts. */

describe("rule 1481: a Markdown table keeps its last column", () => {
  it("with or without the closing pipe, every cell is a cell", () => {
    const closed = render("| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |");
    const open = render("| A | B | C\n|---|---|---\n| 1 | 2 | 3");
    for (const h of [closed, open]) {
      expect(h).toContain("<th>C</th>");
      expect(h).toContain("<td>3</td>");
      expect(h.match(/<td>/g)).toHaveLength(3);
    }
    expect(render("| a | | c |")).toContain("<th></th>");
  });
});

describe("rule 1482: a blog draft's title comes out of its body wherever the H1 sits", () => {
  it("the first H1 is the title and leaves the body; no H1 keeps the item's title", () => {
    expect(splitTitle("Intro line\n# Real title\nBody", "Item")).toEqual({ title: "Real title", rest: "Intro line\nBody" });
    expect(splitTitle("# Top\nBody", "Item")).toEqual({ title: "Top", rest: "Body" });
    expect(splitTitle("No heading\n## Sub", "Item")).toEqual({ title: "Item", rest: "No heading\n## Sub" });
  });
});

describe("rules 1472-1473: task specs name the brand's currency, SAR by default", () => {
  it("currencyOf follows the brand's zone; taskSpec fills the currency", () => {
    expect(currencyOf(null)).toBe("SAR");
    expect(currencyOf({ city: "Dubai" })).toBe("AED");
    expect(currencyOf({ timeZone: "Asia/Kuwait" })).toBe("KWD");
    expect(taskSpec("pricing_review")).toContain("SAR price points");
    expect(taskSpec("pricing_review", { city: "Dubai" })).toContain("AED price points");
    for (const t of ["ads", "pricing_review", "growth_experiments", "retention_play"] as const) expect(taskSpec(t, { city: "Doha" })).not.toContain("{CURRENCY}");
  });
});

describe("rules 1474-1475: the founder console lists sign-ups that never finished onboarding", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  const ago = (h: number) => new Date(now - h * 36e5).toISOString();
  const u = (email: string, h: number, extra: Record<string, unknown> = {}) => ({ email, name: email, phone: "", plan: "trial" as const, createdAt: ago(h), ...extra });
  it("older than a day, not suspended, no brand file; newest first with why they stopped", () => {
    const users = [
      u("fresh@x.test", STALLED_AFTER_H - 1),
      u("unverified@x.test", 30),
      u("verified@x.test", 48, { emailVerifiedAt: ago(47) }),
      u("branded@x.test", 72, { emailVerifiedAt: ago(71) }),
      u("suspended@x.test", 72, { suspended: true }),
    ];
    const r = stalledSignups(users, (e) => e === "branded@x.test", now);
    expect(r.total).toBe(2);
    expect(r.rows.map((x) => [x.email, x.reason])).toEqual([["unverified@x.test", "email_unverified"], ["verified@x.test", "no_brand"]]);
  });
  it("at most STALLED_MAX rows, with the full count", () => {
    const many = Array.from({ length: STALLED_MAX + 5 }, (_, i) => u(`s${i}@x.test`, 25 + i));
    const r = stalledSignups(many, () => false, now);
    expect(r.total).toBe(STALLED_MAX + 5);
    expect(r.rows).toHaveLength(STALLED_MAX);
    expect(r.rows[0].email).toBe("s0@x.test");
  });
  it("the overview carries it and the console shows it", () => {
    expect(readFileSync("src/lib/admin-stats.ts", "utf8")).toContain("stalled: stalledSignups(users,");
    const ov = readFileSync("src/components/admin/Overview.tsx", "utf8");
    expect(ov).toContain("data-stalled");
    expect(ov).toContain("O[u.reason]");
  });
});

describe("rules 1476-1478: provider rate limits and spent balances get a clear message, never the provider's", () => {
  it("classifies the SDK's errors, a media ProviderError and a cause chain; anything else is null", () => {
    expect(providerFault({ status: 429, message: "rate limited" })).toBe("rate_limited");
    expect(providerFault({ status: 500, type: "rate_limit_error" })).toBe("rate_limited");
    expect(providerFault({ status: 529 })).toBe("overloaded");
    expect(providerFault({ error: { type: "error", error: { type: "overloaded_error" } } })).toBe("overloaded");
    expect(providerFault({ status: 402 })).toBe("no_balance");
    expect(providerFault({ status: 400, message: "Your credit balance is too low to access the API" })).toBe("no_balance");
    expect(providerFault({ type: "billing_error" })).toBe("no_balance");
    expect(providerFault({ code: "no_balance" })).toBe("no_balance");
    expect(providerFault(new Error("wrapped", { cause: { status: 429 } }))).toBe("rate_limited");
    for (const e of [new Error("boom"), { status: 400, message: "bad request" }, { status: 500 }, null, "429"]) expect(providerFault(e)).toBeNull();
  });
  it("the customer's code and copy name no provider", () => {
    expect(customerCode("rate_limited")).toBe("model_busy");
    expect(customerCode("overloaded")).toBe("model_busy");
    expect(customerCode("no_balance")).toBe("model_unavailable");
    for (const lang of ["ar", "en"] as const) {
      for (const c of ["model_busy", "model_unavailable"] as const) {
        expect(modelErrorText(lang, c)).toBe(MODEL_ERROR_COPY[lang][c]);
        expect(modelErrorText(lang, c)).toContain(modelErrorCause(lang, c)!);
        expect(MODEL_ERROR_COPY[lang][c]).not.toMatch(/anthropic|claude|straitly|kie|higgsfield|fal|429|402/i);
      }
      expect(modelErrorText(lang, "chat_failed")).toBeNull();
    }
  });
  it("one founder audit row per fault and place an hour; the customer code comes back each time", async () => {
    await db.del("providerfault:rate_limited:generate");
    const rows = async () => (await db.lrange("admin:log", 0, -1)).filter((r) => r.includes('"action":"provider_rate_limited"') && r.includes('"target":"generate"')).length;
    const before = await rows();
    expect(await customerModelError({ status: 429 }, "generate")).toBe("model_busy");
    expect(await customerModelError({ status: 429 }, "generate")).toBe("model_busy");
    await noteProviderFault("rate_limited", "generate");
    expect(await rows()).toBe(before + 1);
    expect(await customerModelError(new Error("other"), "generate")).toBeNull();
  });
  it("chat, generate and onboard use it, and onboard no longer sends the error's own text", () => {
    for (const f of ["src/app/api/chat/route.ts", "src/app/api/generate/route.ts", "src/app/api/onboard/route.ts"]) expect(readFileSync(f, "utf8"), f).toContain("customerModelError(");
    const onboard = readFileSync("src/app/api/onboard/route.ts", "utf8");
    expect(onboard).not.toContain("e.message.slice(0, 160)");
    for (const f of ["src/components/app/ChatPanel.tsx", "src/components/app/GeneratePanel.tsx", "src/components/app/ReportsPanel.tsx"]) expect(readFileSync(f, "utf8"), f).toContain("modelErrorText(lang, j.error)");
  });
});

describe("rules 1479-1480: who approved what, per person on the team", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  const d = (action: Decision["action"], by: Decision["by"], daysAgo = 1): Decision => ({ task: "t", agent: "noor", type: "ads", channel: "x", action, title: "x", at: new Date(now - daysAgo * 864e5).toISOString(), by });
  it("counts per person over the last 30 days; founder, token and system are left out; no `by` is the owner", () => {
    const m = { kind: "member" as const, email: "m@x.test", role: "member" as const };
    const s = approverStats([
      d("approve", m), d("publish", m), d("reject", m), d("edit", m), d("reopen", m),
      d("approve", undefined), d("reject", { kind: "owner", email: "o@x.test" }),
      d("approve", { kind: "founder", email: "o@x.test", imp: "f@x.test" }), d("approve", { kind: "token", email: "o@x.test" }), d("approve", { kind: "system" }),
      d("approve", m, APPROVER_DAYS + 1),
    ], "o@x.test", now);
    expect(s).toEqual({ "m@x.test": { approved: 2, rejected: 1, edited: 1, rate: 67 }, "o@x.test": { approved: 1, rejected: 1, edited: 0, rate: 50 } });
    expect(approverStats([d("edit", m)], "o@x.test", now)["m@x.test"].rate).toBeNull();
  });
  it("the team view carries it for the owner and an admin, across brands, and not for a plain member", async () => {
    const owner = await newUser("appr");
    const admin = await newMember(owner, "admin");
    const plain = await newMember(owner, "member");
    await recordDecisions(owner.email, [{ ...d("approve", { kind: "member", email: plain.email, role: "member" }), at: new Date().toISOString() }]);
    await signIn(owner.email);
    const mine = (await teamView((await currentUser())!))!;
    expect(mine.approvals?.[plain.email]).toMatchObject({ approved: 1, rate: 100 });
    await signIn(admin.email);
    expect((await teamView((await currentUser())!))!.approvals).toBeDefined();
    await signIn(plain.email);
    const u = (await currentUser())!;
    expect(can(u, "team.approvals.view")).toBe(false);
    expect((await teamView(u))!).not.toHaveProperty("approvals");
    expect(readFileSync("src/components/app/TeamPanel.tsx", "utf8")).toContain("data-approvals");
  });
});

describe("rules 1483-1484: a quiet hint when the workspace is large", () => {
  it("history left out, or less than a full answer's room, is large", () => {
    expect(workspaceLarge(4, { messages: [1, 2, 3, 4], maxTokens: CHAT_FIRST_MIN_OUT })).toBe(false);
    expect(workspaceLarge(4, { messages: [3, 4], maxTokens: CHAT_FIRST_MIN_OUT })).toBe(true);
    expect(workspaceLarge(1, { messages: [1], maxTokens: CHAT_FIRST_MIN_OUT - 1 })).toBe(true);
  });
  it("the reply carries `large` (not on the no-answer cliff) and the chat shows the hint", () => {
    const chat = readFileSync("src/lib/chat.ts", "utf8");
    expect(chat).toContain('...(large && ended !== "large" && !outOfTime ? { large: true as const } : {})');
    const panel = readFileSync("src/components/app/ChatPanel.tsx", "utf8");
    expect(panel).toContain('m.role === "assistant" && m.large && <p className="mt-1 text-xs text-foreground-muted" data-workspace-large>');
  });
});

describe("rule 1485: the upstream pins were reviewed and bumped", () => {
  it("both pins point at the reviewed commits", () => {
    const { upstreams } = JSON.parse(readFileSync("docs/upstreams.json", "utf8")) as { upstreams: { repo: string; sha: string }[] };
    expect(upstreams.find((u) => u.repo === "msitarzewski/agency-agents")!.sha).toBe("f99f6aa910a442b0197b768ce0ea7751e35e2060");
    expect(upstreams.find((u) => u.repo === "paperclipai/paperclip")!.sha).toBe("88b7bbb5e248e9dde5aa7671b080f8508ef1865e");
  });
});
