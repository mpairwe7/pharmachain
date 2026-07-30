import { describe, expect, test } from "bun:test";
import { emailSchema, inviteSchema, loginPasswordSchema, registerSchema } from "./auth";

const company = {
  name: "Kampala Pharma Ltd",
  type: "SUPPLIER" as const,
  country: "Uganda",
  registrationNumber: "UG-123456",
  address: "12 Industrial Area, Kampala",
  contactPhone: "+256700000000",
};

const admin = { name: "John Mutebi", password: "Passw0rd!" };

const register = (email: string) =>
  registerSchema.safeParse({ company, admin: { ...admin, email } });

describe("registration email (US-101)", () => {
  test("accepts a real work address", () => {
    expect(register("john.mutebi@kampalapharma.co.ug").success).toBe(true);
    expect(register("mutebijohn@gmail.com").success).toBe(true);
  });

  test("rejects a mistyped provider domain and names the intended one", () => {
    // The address is well-formed, so a plain format check passes it and the
    // verification mail is posted into a domain that does not accept mail.
    const result = register("mutebijohn@gmai.com");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("gmail.com");
  });

  test.each([
    "user@gmial.com",
    "user@gmail.co",
    "user@gmail.con",
    "user@yaho.com",
    "user@hotmial.com",
    "user@outlok.com",
    "user@icloud.co",
  ])("rejects %s", (email) => {
    expect(register(email).success).toBe(false);
  });

  test("rejects malformed addresses outright", () => {
    for (const email of [
      "mutebijohn",
      "mutebijohn@",
      "@gmail.com",
      "mutebijohn@gmail",
      "mutebijohn@@gmail.com",
      "mutebi john@gmail.com",
      "mutebijohn@gmail..com",
      ".mutebijohn@gmail.com",
      "mutebijohn@-gmail.com",
      "mutebijohn@gmail-.com",
      "",
    ]) {
      expect(register(email).success).toBe(false);
    }
  });

  test("a country-code domain that merely resembles a typo is fine", () => {
    // yahoo.co is a typo; yahoo.co.uk is a real mail domain.
    expect(register("user@yahoo.co.uk").success).toBe(true);
    expect(register("user@hotmail.co.uk").success).toBe(true);
  });

  test("invites get the same typo guard as registration", () => {
    expect(inviteSchema.safeParse({ email: "clerk@gmai.com", role: "COMPANY_ADMIN" }).success).toBe(
      false,
    );
    expect(
      inviteSchema.safeParse({ email: "clerk@gmail.com", role: "COMPANY_ADMIN" }).success,
    ).toBe(true);
  });

  test("sign-in keeps the format check but not the typo guard", () => {
    // An account that already exists on a typo domain must stay reachable —
    // locking it out of sign-in would strand the user, not help them.
    expect(loginPasswordSchema.safeParse({ email: "user@gmai.com", password: "x" }).success).toBe(
      true,
    );
    expect(loginPasswordSchema.safeParse({ email: "not-an-email", password: "x" }).success).toBe(
      false,
    );
  });

  test("the shared email schema is reusable on its own", () => {
    expect(emailSchema.safeParse("ops@pharmachain.africa").success).toBe(true);
    expect(emailSchema.safeParse(`${"a".repeat(200)}@example.com`).success).toBe(false);
  });
});
