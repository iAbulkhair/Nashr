import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { newUser } from "./helpers/session";
import { sc, type User } from "@/lib/auth";
import { scopeFor } from "@/lib/brands";
import { accountKey, globalKey, scopeParam, storedAccountId, storedPersonId, storedScope, workspaceScope, wsKey, type Scope } from "@/lib/keys";

/**
 * Rules 2030-2033: the Redis key registry (src/lib/keys.ts). Every builder returns the exact bytes of the template it
 * replaced, so no stored record moves; a workspace builder takes only a `Scope`, which a request value cannot be.
 */

const S = "owner@example.com#b2" as Scope;
const D = "owner@example.com" as Scope;
const E = "owner@example.com";

describe("rule 2030: each builder returns the bytes of its old template", () => {
  // [builder output, the template that was written inline before the registry]
  const ws: [string, string][] = [
    [wsKey.brand(S), `brand:${S}`],
    [wsKey.prefs(S), `prefs:${S}`],
    [wsKey.tasks(S), `tasks:${S}`],
    [wsKey.task(S, "t1"), `task:${S}:t1`],
    [wsKey.taskLock(S, "t1"), `tasklock:${S}:t1`],
    [wsKey.pending(S), `pending:${S}`],
    [wsKey.notNow(S), `notnow:${S}`],
    [wsKey.pendingIndex(S), `pendingidx:${S}`],
    [wsKey.taskMonth(S, "2026-10"), `tidx:${S}:2026-10`],
    [wsKey.taskMonths(S), `tidxm:${S}`],
    [wsKey.taskIndexVersion(S), `tidxv:${S}`],
    [wsKey.adCodes(S), `adcodes:${S}`],
    [wsKey.files(S), `files:${S}`],
    [wsKey.file(S, "notes.md"), `file:${S}:notes.md`],
    [wsKey.fileLock(S, "notes.md"), `filelock:${S}:notes.md`],
    [wsKey.onboardPlan(S), `onboardplan:${S}`],
    [wsKey.onboardOk(S), `onboardok:${S}`],
    [wsKey.onboardLock(S), `onboardlock:${S}`],
    [wsKey.onboardGame(S), `onboardgame:${S}`],
    [wsKey.convs(S), `convs:${S}`],
    [wsKey.conv(S, "c1"), `conv:${S}:c1`],
    [wsKey.convLock(S, "c1"), `convlock:${S}:c1`],
    [wsKey.chat(S), `chat:${S}`],
    [wsKey.chat(S, "c1"), `chat:${S}:c1`],
    [wsKey.conns(S), `conns:${S}`],
    [wsKey.conn(S, "meta"), `conn:${S}:meta`],
    [wsKey.gov(S), `gov:${S}`],
    [wsKey.govHistory(S), `govhist:${S}`],
    [wsKey.govLock(S), `govlock:${S}`],
    [wsKey.schedule(S), `schedule:${S}`],
    [wsKey.brief(S), `brief:${S}`],
    [wsKey.decisions(S), `decisions:${S}`],
    [wsKey.feedbackLog(S), `fblog:${S}`],
    [wsKey.siteStats(S), `sitestats:${S}`],
    [wsKey.socialStats(S), `socialstats:${S}`],
    [wsKey.socialPublished(S), `socialpub:${S}`],
    [wsKey.storeSales(S), `storesales:${S}`],
    [wsKey.storeSyncFail(S), `storesyncfail:${S}`],
    [wsKey.perfImport(S), `perfimport:${S}`],
    [wsKey.adSync(S, "google_ads"), `adsync:${S}:google_ads`],
    // Core-file rewrite cards (rule 2306): new keys, written first under the registry.
    [wsKey.fileProposal(S, "ab12"), `fileprop:${S}:ab12`],
    [wsKey.fileProposalDone(S, "ab12"), `fileprop-done:${S}:ab12`],
    [wsKey.fileProposalClaim(S, "ab12"), `fileprop-claim:${S}:ab12`],
    [wsKey.fileProposals(S), `fileprops:${S}`],
    [wsKey.keyCheckBucket(D, "hour"), `keycheck:hour:${E}`],
    [wsKey.connectStartBucket(D), `connectstart:${E}`],
    [wsKey.storeSyncBucket(D), `storesync:${E}`],
    [wsKey.catalogImportBucket(D), `catalogimport:${E}`],
  ];
  const account: [string, string][] = [
    [accountKey.user(E), `user:${E}`],
    [accountKey.brands(E), `brands:${E}`],
    [accountKey.brandsLock(E), `brandslock:${E}`],
    [accountKey.activeBrand(E), `activebrand:${E}`],
    [accountKey.mcpTokenOf(E), `mcptoken-of:${E}`],
    [accountKey.mcpGrants(E), `mcpgrants:${E}`],
    [accountKey.notifications(E), `notifs:${E}`],
    [accountKey.digest(E), `notifydigest:${E}`],
    [accountKey.digestLast(E), `digestlast:${E}`],
    [accountKey.digestLock(E), `digestlock:${E}`],
    [accountKey.digestBucket(E), `digestsave:${E}`],
    [accountKey.referrals(E), `referrals:${E}`],
    [accountKey.referredBy(E), `referredBy:${E}`],
    [accountKey.shared(E), `shared:${E}`],
    [accountKey.shared(E, "x"), `shared:${E}:x`],
    [accountKey.lastSeen(E), `ulast:${E}`],
    [accountKey.weeklyLock(E), `weeklylock:${E}`],
    [accountKey.event(E, "login"), `uev:${E}:login`],
    [accountKey.eventFirst(E, "login"), `ufirst:${E}:login`],
    [accountKey.eventFirst0(E, "login"), `ufirst0:${E}:login`],
    [accountKey.thumbs(E, "reem", "up"), `fb:${E}:reem:up`],
    [accountKey.emailChange(E), `emailchange:${E}`],
    [accountKey.emailChangeTries(E), `emailchange:tries:${E}`],
    [accountKey.googleSub(E), `googlesub:${E}`],
    [accountKey.member(E), `member:${E}`],
    [accountKey.members(E), `members:${E}`],
    [accountKey.invites(E), `invites:${E}`],
    [accountKey.teamLock(E), `lock:team:${E}`],
    [accountKey.login(E), `login:${E}`],
    [accountKey.loginLock(E), `lock:login:${E}`],
    [accountKey.memberLock(E), `lock:member:${E}`],
    [accountKey.usage(E, "2026-10"), `usage:${E}:2026-10`],
    [accountKey.chatTrial(E), `chatm:${E}:trial`],
    // Multi-workspace membership (rules 2110-2139, release M1): the two account builders of the new families.
    [accountKey.membership(storedAccountId(E), storedPersonId("p1")), `mbr:${E}:p1`],
    [accountKey.teamLog(storedAccountId(E)), `teamlog:${E}`],
  ];
  const global: [string, string][] = [
    [globalKey.usersAll(), "users:all"],
    [globalKey.runReceipt("routine:a@b.example:dana_weekly_report:2026-10-18"), "runrec:routine:a@b.example:dana_weekly_report:2026-10-18"],
    [globalKey.cronReport("weekly"), "cronreport:weekly"],
    [globalKey.digests(), "notifydigests"],
    [globalKey.deletedAccounts(), "deleted-accounts"],
    [globalKey.session("abc"), "session:h:abc"],
    [globalKey.sessionLegacy("tok"), "session:tok"],
    [globalKey.mcpToken("tok"), "mcptoken:tok"],
    [globalKey.oauthState("st"), "oauthstate:st"],
    [globalKey.googleAccount("123"), "google:123"],
    [globalKey.invite("i1"), "invite:i1"],
    [globalKey.inviteUse("i1"), "inviteuse:i1"],
    [globalKey.rate("files:x"), "rate:files:x"],
    [globalKey.usageAll("2026-10"), "usage:_all:2026-10"],
    [globalKey.paymobRefundEnded(123456), "paymob:refund_ended:123456"],
    [globalKey.shopifyCompliance(), "shopify:compliance"],
    [globalKey.shopifyRedact(), "shopify:redact"],
    [globalKey.connectionHealth(), "connections:health"],
  ];

  it.each(ws)("workspace %s", (built, old) => expect(built).toBe(old));
  it.each(account)("account %s", (built, old) => expect(built).toBe(old));
  it.each(global)("global %s", (built, old) => expect(built).toBe(old));

  it("the default brand's scope is the bare email, so default-brand keys keep the pre-brands bytes", () => {
    expect(wsKey.tasks(D)).toBe(`tasks:${E}`);
    expect(wsKey.conv(D, "c1")).toBe(`conv:${E}:c1`);
  });

  it("every builder in the registry is covered by the table above", () => {
    const src = readFileSync("tests/key-registry.test.ts", "utf8");
    for (const [group, obj] of [["wsKey", wsKey], ["accountKey", accountKey], ["globalKey", globalKey]] as const) {
      for (const name of Object.keys(obj)) expect(src, `${group}.${name} has no byte-identity row`).toContain(`${group}.${name}(`);
    }
  });
});

describe("rule 2031: sc(u) is the only way a request reaches a workspace builder", () => {
  it("sc(u) is the account email for the default brand and email#brand for an added one", async () => {
    const u = await newUser("keys");
    expect(sc(u)).toBe(u.email);
    expect(sc({ ...u, scope: `${u.email}#b9` } as User)).toBe(`${u.email}#b9`);
    expect(wsKey.brand(sc(u))).toBe(`brand:${u.email}`);
  });

  it("a plain string from a request does not type-check as a scope", () => {
    const fromBody: string = "victim@example.com";
    // @ts-expect-error a request value is a plain string, not a Scope
    wsKey.tasks(fromBody);
    // @ts-expect-error same for builders with an id
    wsKey.conv(fromBody, "c1");
    // Account keys take an address on purpose (sign-in and admin paths); the caller normalizes it.
    expect(accountKey.user(fromBody)).toBe("user:victim@example.com");
  });

  it("src/lib/auth.ts builds the scope from the user record only", () => {
    const src = readFileSync("src/lib/auth.ts", "utf8");
    // Rule 1980: the account part is `acct(u)` (the stored id, or the address of a record from before R1).
    expect(src).toMatch(/export const sc = \(u: User\): Scope => storedScope\(u\.scope \?\? acct\(u\)\);/);
  });
});

describe("rule 2032: workspaceScope matches scopeFor and the stored scope format", () => {
  it.each([["a@b.co", "default", "a@b.co"], ["a@b.co", "b2", "a@b.co#b2"]])("%s / %s", (email, id, want) => {
    expect(workspaceScope(email, id)).toBe(want);
    expect(scopeFor(email, id)).toBe(want);
    expect(storedScope(want)).toBe(want);
  });
});

describe("rule 2033: scopeParam is the phase-1 boundary of lib helpers, never used by routes or pages", () => {
  it("returns the scope unchanged", () => expect(scopeParam("a@b.co#b2")).toBe("a@b.co#b2"));
});
