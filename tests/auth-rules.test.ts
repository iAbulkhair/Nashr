import { describe, expect, it } from "vitest";
import { strongPassword, validEmail } from "@/lib/auth";

describe("validEmail", () => {
  it("accepts ordinary addresses, including plus tags", () => {
    for (const e of ["a@b.com", "ahmad+shop@gmail.com", "info@متجر.sa"]) expect(validEmail(e)).toBe(true);
  });
  // Emails become part of Redis keys: "email#brandId" is a brand scope and ":" separates key parts.
  it("rejects characters that could make two accounts share Redis keys", () => {
    for (const e of ["victim@x.com#abc123", "victim@x.com:conv1", "a b@x.com", "no-at-sign", "a@b"]) expect(validEmail(e)).toBe(false);
  });
  it("rejects absurdly long addresses", () => expect(validEmail("a".repeat(120) + "@x.com")).toBe(false));
});

describe("strongPassword", () => {
  it("needs eight characters with a letter and a digit, in any script", () => {
    expect(strongPassword("abc12345")).toBe(true);
    expect(strongPassword("كلمةسر123")).toBe(true);
    for (const p of ["abcdefgh", "12345678", "a1", ""]) expect(strongPassword(p)).toBe(false);
  });
});
