/**
 * Reem B3, proof that the linked calendar belongs to the brand (spec 2026-10-05-secretary-reem-b3-calendar-read-design.md
 * §4). Rule 613 pins the pure part: the brand host, the one-way subdomain rule, free mail never matching, Google's
 * `hd` claim and Microsoft's tenant plus verified domains.
 */
import { describe, expect, it } from "vitest";
import {
  CAL_DECLARATION_V,
  FREE_MAIL,
  MS_CONSUMER_TENANT,
  brandHost,
  decodeIdToken,
  domainMatches,
  googleAccount,
  microsoftDomain,
  proofOf,
} from "@/lib/secretary-cal-proof";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("rule 613: proof of the brand's calendar", () => {
  it("brandHost normalises messy websites", () => {
    expect(brandHost("HTTP://WWW.Shop.MyStore.sa:8080/ar?x=1")).toBe("shop.mystore.sa");
    expect(brandHost("mystore.sa")).toBe("mystore.sa");
    for (const bad of ["", "not a url", "https://192.168.1.1", "http://localhost", undefined]) expect(brandHost(bad)).toBeNull();
    expect(brandHost("http://[::1]/x")).toBeNull();
    expect(brandHost("ftp://mystore.sa")).toBeNull();
  });
  it("the subdomain rule works one way only", () => {
    expect(domainMatches("mystore.sa", "shop.mystore.sa")).toBe(true);
    expect(domainMatches("mystore.sa", "mystore.sa")).toBe(true);
    expect(domainMatches("shop.mystore.sa", "mystore.sa")).toBe(false);
    expect(domainMatches("store.sa", "mystore.sa")).toBe(false);
    expect(domainMatches(null, "mystore.sa")).toBe(false);
    expect(domainMatches("mystore.sa", null)).toBe(false);
  });
  it("free mail never matches", () => {
    expect(domainMatches("gmail.com", "gmail.com")).toBe(false);
    expect(domainMatches("gmail.com", "shop.gmail.com")).toBe(false);
    for (const d of ["gmail.com", "googlemail.com", "outlook.sa", "hotmail.co.uk", "yahoo.com.sa", "proton.me", "icloud.com"]) expect(FREE_MAIL.has(d)).toBe(true);
    expect(FREE_MAIL.size).toBe(20);
  });
  it("Google: hd match is domain, Gmail is not, unverified email never", () => {
    expect(proofOf(googleAccount({ email: "a@mystore.sa", email_verified: true, hd: "mystore.sa" }).domain, "https://mystore.sa")).toBe("domain");
    expect(proofOf(googleAccount({ email: "a@gmail.com", email_verified: true }).domain, "https://mystore.sa")).toBeNull();
    expect(googleAccount({ email: "a@mystore.sa", email_verified: false, hd: "mystore.sa" }).domain).toBeNull();
    expect(googleAccount({ email: "a@mystore.sa", email_verified: "true", hd: "mystore.sa" }).domain).toBeNull();
    expect(googleAccount({ email_verified: true, hd: "MyStore.sa" })).toEqual({ account: "", domain: "mystore.sa" });
    expect(googleAccount({ email: "a@mystore.sa", email_verified: true, hd: "mystore.sa" }).account).toBe("a@mystore.sa");
  });
  it("Microsoft: work tenant with verified UPN domain, consumer tenant never", () => {
    expect(microsoftDomain("t-1", "a@mystore.sa", ["mystore.sa"])).toBe("mystore.sa");
    expect(microsoftDomain("t-1", "A@MyStore.SA", ["MYSTORE.sa"])).toBe("mystore.sa");
    expect(microsoftDomain("t-1", "a@mystore.sa", ["other.sa"])).toBeNull();
    expect(microsoftDomain(MS_CONSUMER_TENANT, "a@mystore.sa", ["mystore.sa"])).toBeNull();
    expect(microsoftDomain(undefined, "a@mystore.sa", ["mystore.sa"])).toBeNull();
    expect(microsoftDomain("", "a@mystore.sa", ["mystore.sa"])).toBeNull();
    expect(microsoftDomain("t-1", "no-at-sign", ["mystore.sa"])).toBeNull();
  });
  it("decodeIdToken reads the payload and never throws", () => {
    expect(decodeIdToken(`h.${b64({ hd: "x.sa", email_verified: true })}.s`)).toEqual({ hd: "x.sa", email_verified: true });
    for (const bad of [undefined, "", "a.b", "a.b.c.d", "h.@@@.s", `h.${Buffer.from("nope").toString("base64url")}.s`, `h.${b64([1])}.s`, `h.${b64("x")}.s`])
      expect(decodeIdToken(bad)).toBeNull();
  });
  it("the declaration text version is 1 and the consumer tenant is Microsoft's", () => {
    expect(CAL_DECLARATION_V).toBe(1);
    expect(MS_CONSUMER_TENANT).toBe("9188040d-6c67-4c5b-b112-36a304b66dad");
    expect(proofOf(null, "https://mystore.sa")).toBeNull();
  });
});
