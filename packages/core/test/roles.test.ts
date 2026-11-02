import { describe, expect, it } from "vitest";
import { isPlaceholderEmail } from "../src/email";
import { adminLevel, canMakeResetLink, EVERYONE, isStaff, LEVEL_PERMISSIONS, LEVEL_SUMMARY, memberPermissions, ROLE_LABELS, ROLES, STAFF, WITH_SUBS } from "../src/roles";
import { isSubLogin, signInLinkMessages, smsLink, subAccessText, subLoginEmail, subLoginMark } from "../src/subs";

describe("the Subcontractor level", () => {
  it("is a level of its own, outside the team", () => {
    expect(ROLES).toContain("subcontractor");
    expect(STAFF).toEqual(ROLES.filter((r) => r !== "subcontractor"));
    // "Everyone" means the team: a route or rule written with it stays closed to subs.
    expect(EVERYONE).toEqual(STAFF);
    expect(WITH_SUBS).toEqual(ROLES);
    expect(isStaff("field_crew")).toBe(true);
    expect(isStaff("subcontractor")).toBe(false);
    expect(isStaff("nobody")).toBe(false);
  });

  it("has a name, a summary and no areas, even with a custom role's list", () => {
    expect(ROLE_LABELS.subcontractor).toBe("Subcontractor");
    expect(LEVEL_SUMMARY.subcontractor).toMatch(/their own jobs/i);
    expect(LEVEL_PERMISSIONS.subcontractor).toEqual([]);
    expect(memberPermissions("subcontractor", ["subs", "schedule"])).toEqual([]);
  });

  it("never gets a password reset link, and never makes one", () => {
    for (const r of ROLES) {
      expect(canMakeResetLink(r, "subcontractor"), r).toBe(false);
      expect(canMakeResetLink("subcontractor", r), r).toBe(false);
    }
  });
});

describe("admin-level access", () => {
  it("is an owner, or an admin with the apps, settings or team area", () => {
    expect(ROLES.filter((r) => adminLevel(r))).toEqual(["owner", "admin"]);
    expect(adminLevel("admin", ["invoices", "team"])).toBe(true);
    expect(adminLevel("admin", ["settings"])).toBe(true);
    expect(adminLevel("admin", ["invoices", "reports"])).toBe(false);
    expect(adminLevel("admin", [])).toBe(false);
    // Office can have Settings, but never reaches the Stripe key, the email or the team.
    expect(adminLevel("office", ["settings"])).toBe(false);
    expect(adminLevel("nobody")).toBe(false);
  });
});

describe("a sub's sign-in", () => {
  it("gets an address nothing emails when the office has none", () => {
    const email = subLoginEmail("D1070000-0000-0000-0000-0000000000C3");
    expect(email).toBe("sub-d1070000-0000-0000-0000-0000000000c3@subs.invalid");
    expect(isPlaceholderEmail(email)).toBe(true);
    expect(isPlaceholderEmail(" X@Subs.INVALID ")).toBe(true);
    expect(isPlaceholderEmail("al@apex.test")).toBe(false);
    expect(isPlaceholderEmail("al@invalid.com")).toBe(false);
    expect(isPlaceholderEmail(null)).toBe(false);
  });

  it("writes the text and email that send the link", () => {
    const m = signInLinkMessages({ companyName: "Oscar Roofing", subName: "Apex Roofing LLC", contactName: "Al Apex", link: "https://ops.test/?token_hash=t&type=magiclink" });
    expect(m.subject).toBe("Your sign-in for Oscar Roofing");
    expect(m.sms).toBe("Oscar Roofing: here's your link to sign in and see your jobs with us. It works once, within a day: https://ops.test/?token_hash=t&type=magiclink");
    expect(m.text).toMatch(/^Hi Al,\n\nHere's your link to sign in to Oscar Roofing on Crewtavo/);
    expect(m.text).toContain("\n\nhttps://ops.test/?token_hash=t&type=magiclink\n\nIt works once, within a day.");
    // An iPhone's Home Screen app keeps its own sign-in, which the link can't reach.
    expect(m.text).not.toMatch(/Home Screen/);
  });

  it("opens the office's own Messages app with the text filled in", () => {
    expect(smsLink("+1 (540) 555-0101", "Hi & welcome: https://x.test/?a=1&b=2")).toBe("sms:+15405550101?&body=Hi%20%26%20welcome%3A%20https%3A%2F%2Fx.test%2F%3Fa%3D1%26b%3D2");
  });

  it("says where it stands", () => {
    expect(subAccessText({ state: "none" })).toBe("Can't sign in");
    expect(subAccessText({ state: "invited", last_sign_in_at: null })).toBe("Hasn't signed in yet");
    expect(subAccessText({ state: "active", last_sign_in_at: "2026-10-12T15:00:00Z" }, "America/New_York")).toBe("Signed in Oct 12");
    expect(subAccessText({ state: "active", last_sign_in_at: null, shared: true })).toBe("Own sign-in");
    expect(subAccessText({ state: "none", shared: true })).toBe("Can't sign in");
  });

  it("knows an account made as a sub's sign-in, and for which sub", () => {
    const meta = { provider: "email", crewtavo_sub: subLoginMark("CO-1", "SUB-1") };
    expect(meta.crewtavo_sub).toBe("co-1:sub-1");
    expect(isSubLogin(meta)).toBe(true);
    expect(isSubLogin(meta, "co-1", "sub-1")).toBe(true);
    expect(isSubLogin(meta, "co-1", "sub-2")).toBe(false);
    expect(isSubLogin(meta, "co-2", "sub-1")).toBe(false);
    expect(isSubLogin({ provider: "email" })).toBe(false);
    expect(isSubLogin(null)).toBe(false);
    expect(isSubLogin({ crewtavo_sub: 7 })).toBe(false);
  });
});
