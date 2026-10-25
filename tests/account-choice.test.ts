import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ACCOUNT_SETTINGS, accountSettingsUrl } from "@/lib/connectors/account-choice";
import { appDict } from "@/lib/app-i18n";

/**
 * Choosing, and later changing, the account or Page a Composio connection uses (rules 4200-4209,
 * docs/system/tests/4200-account-choice.md).
 */

const read = (f: string) => readFileSync(f, "utf8");
const PANEL = read("src/components/app/IntegrationsPanel.tsx");
const KEYS = ["changeAccounts", "connectHint", "changeTitle", "changeIntro", "changeStep1", "changeStep2", "changeOpen", "changeNote", "metaIgSeparate", "metaOnePage"] as const;

describe("what Composio can force (rule 4200)", () => {
  it("the installed SDK's link() options have no prompt, re-consent or account-chooser switch", () => {
    // If a later @composio/core adds one, this fails: read the new option, then use it in composioConnect and delete the dialog's step 1.
    const types = read("node_modules/@composio/core/dist/customTool.types-CK408sI-.d.mts");
    const from = types.indexOf("declare const CreateConnectedAccountLinkOptionsSchema");
    const to = types.indexOf("type CreateConnectedAccountLinkOptions =");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const schema = types.slice(from, to);
    expect(schema).toContain("callbackUrl");
    expect(schema).toContain("allowMultiple");
    expect(schema).not.toMatch(/prompt|reauth|force|consent|select_account|login_hint/i);
  });

  it("composioConnect still sends only the callback and allowMultiple", () => {
    const src = read("src/lib/connectors/composio.ts");
    const call = src.slice(src.indexOf("c.connectedAccounts.link("), src.indexOf("if (!req.redirectUrl"));
    expect(call).toContain("callbackUrl");
    expect(call).toContain("allowMultiple: true");
    expect(call).not.toMatch(/prompt|reauth|consent/i);
  });
});

describe("the platform settings link (rule 4201)", () => {
  it("is an https page of Meta and of LinkedIn only", () => {
    expect(Object.keys(ACCOUNT_SETTINGS).sort()).toEqual(["linkedin", "meta"]);
    expect(accountSettingsUrl("meta")).toMatch(/^https:\/\/www\.facebook\.com\//);
    expect(accountSettingsUrl("linkedin")).toMatch(/^https:\/\/www\.linkedin\.com\//);
  });
  it("is null for any other provider and for names off the object's prototype", () => {
    for (const p of ["x", "google", "tiktok", "", "constructor", "__proto__", "toString", "hasOwnProperty"]) expect(accountSettingsUrl(p), p).toBeNull();
  });
});

describe("the words (rule 4202)", () => {
  it("every string exists in Arabic and English, and the Arabic is Arabic", () => {
    for (const k of KEYS) {
      expect(appDict.en.integrations[k].length, `en ${k}`).toBeGreaterThan(10);
      expect(appDict.ar.integrations[k], `ar ${k}`).toMatch(/[؀-ۿ]/);
    }
  });
  it("promises no fresh consent from Reconnect alone, and says removing the app stops the current connection", () => {
    expect(appDict.en.integrations.changeNote).toMatch(/stops the current connection/);
    expect(appDict.en.integrations.changeNote).toMatch(/may reuse/);
    expect(appDict.ar.integrations.changeNote).toContain("يوقف الربط الحالي");
    expect(appDict.ar.integrations.changeNote).toContain("قد تعيد");
  });
  it("says Instagram does not follow the Page chosen for a Composio record", () => {
    expect(appDict.en.integrations.metaIgSeparate).toMatch(/whichever Page/);
  });
});

describe("the panel (rules 4203-4205)", () => {
  it("the connected-card action is owner/admin only, Composio records of Meta and LinkedIn only, and reuses the existing start route", () => {
    const btn = PANEL.slice(PANEL.indexOf("{c.meta?.via === \"composio\" && accountSettingsUrl(c.provider)"));
    expect(btn.indexOf("setChangeFor(")).toBeGreaterThan(-1);
    // It sits inside the `manage` block that also holds Disconnect (display only: /start answers 403 to a lower role).
    expect(PANEL.indexOf("{manage && <div className=\"flex shrink-0 flex-col gap-1.5\">")).toBeLessThan(PANEL.indexOf("g.changeAccounts"));
    expect(PANEL).toContain("startOAuth(changeFor,");
    expect(PANEL).not.toContain("/api/connect/${changeFor");
  });
  it("the hint under Connect shows only where a platform picker exists and the owner can connect", () => {
    expect(PANEL).toContain("{canConnect && p!.toolkits && accountSettingsUrl(p!.id) && <p");
  });
  it("the settings link opens in a new tab without a referrer or opener", () => {
    const a = PANEL.slice(PANEL.indexOf("href={accountSettingsUrl(changeFor.id)"));
    expect(a.slice(0, 200)).toContain("rel=\"noopener noreferrer\"");
    expect(a.slice(0, 200)).toContain("target=\"_blank\"");
  });
  it("one Page found: the card says so; two or more and an Instagram login: the Page list says Instagram is separate", () => {
    expect(PANEL).toContain("c.meta.pages ? (c.meta.igId ? g.metaIgSeparate : \"\") : g.metaOnePage");
  });
});

describe("no route or permission changed (rule 4206)", () => {
  it("the start route has the same gate and rate limit as before", () => {
    const start = read("src/app/api/connect/[provider]/start/route.ts");
    expect(start).toContain("forbid(u, p?.secretary ? \"calendar.link\" : \"connectors\")");
    expect(start).toContain("wsKey.connectStartBucket(sc(u))");
  });
});
