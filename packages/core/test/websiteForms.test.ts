import { describe, expect, it } from "vitest";
import { cleanFields, exampleForm, fieldLabel, fieldRole, MAX_VALUE, messageEmail, promoLine, readSubmission, siteAllowed, siteHost, webAddress, type FieldValue } from "../src/websiteForms";

const read = (entries: Array<[string, unknown]>) => {
  const cleaned = cleanFields(entries);
  if (!cleaned.ok) throw new Error(cleaned.error);
  return readSubmission(cleaned.fields);
};
const submission = (entries: Array<[string, unknown]>) => {
  const result = read(entries);
  if (!result.ok) throw new Error(result.error);
  return result.submission;
};

describe("a website form's fields", () => {
  it("are trimmed, with empty ones, files and odd values left out, and repeats kept together", () => {
    const cleaned = cleanFields([
      ["name", "  Jane  "],
      ["empty", "   "],
      ["photo", { name: "photo.jpg", size: 1 }],
      ["services[]", "Mowing"],
      ["services[]", "Edging"],
      ["color", "red"],
      ["color", "blue"],
      ["count", 3],
      ["note", "line one\r\nline two"],
    ]);
    expect(cleaned).toEqual({
      ok: true,
      fields: [["name", "Jane"], ["services[]", ["Mowing", "Edging"]], ["color", ["red", "blue"]], ["count", "3"], ["note", "line one\nline two"]],
    });
  });

  it("refuse more than any real form sends", () => {
    expect(cleanFields([["message", "x".repeat(MAX_VALUE + 1)]])).toEqual({ ok: false, error: expect.stringContaining("too long") });
    expect(cleanFields(Array.from({ length: 61 }, (_, i) => [`f${i}`, "x"] as [string, string]))).toEqual({ ok: false, error: expect.stringContaining("too much") });
  });
});

describe("reading a message", () => {
  it("puts the usual fields on the client, the property and the request, and the rest in answers", () => {
    const s = submission([
      ["Full Name", "Jane Smith"],
      ["E-mail Address", "Jane@Example.com"],
      ["Phone Number", "(540) 555-0101"],
      ["Business", "Smith Farms"],
      ["Street Address", "12 Oak St"],
      ["City", "Roanoke"],
      ["State", "VA"],
      ["Zip Code", "24012"],
      ["How did you hear", "Google"],
      ["services[]", ["Mowing", "Edging"]],
      ["Your Message", "Can you mow on Fridays?"],
    ]);
    expect(s).toMatchObject({
      name: "Jane Smith",
      email: "jane@example.com",
      phone: "(540) 555-0101",
      companyName: "Smith Farms",
      address: { line1: "12 Oak St", city: "Roanoke", region: "VA", postal_code: "24012" },
      message: "Can you mow on Fridays?",
      bot: false,
      answers: { "How did you hear": "Google", "services[]": ["Mowing", "Edging"] },
    });
    expect(Object.keys(s.contact)).toEqual(["Full Name", "E-mail Address", "Phone Number", "Business", "Street Address", "City", "State", "Zip Code"]);
    expect(s.fields).toHaveLength(11);
  });

  it("puts first and last names together", () => {
    expect(submission([["firstName", "Jane"], ["last_name", "Smith"], ["email", "j@x.co"]]).name).toBe("Jane Smith");
  });

  it("takes Formspree's own fields, and never keeps one starting with _ as an answer", () => {
    const s = submission([
      ["_replyto", "jane@example.com"],
      ["_subject", "Quote  request\nplease"],
      ["_next", "https://greenlawn.com/thanks"],
      ["_language", "en"],
      ["g-recaptcha-response", "token"],
      ["message", "Hi"],
    ]);
    expect(s).toMatchObject({ email: "jane@example.com", subject: "Quote request please", next: "https://greenlawn.com/thanks", answers: {} });
    expect(s.fields).toEqual([["message", "Hi"]]);
    expect(submission([["email", "j@x.co"], ["_next", "javascript:alert(1)"]]).next).toBeNull();
  });

  it("tells a bot it worked: _gotcha filled in", () => {
    expect(submission([["_gotcha", "http://spam.example"], ["email", "nope"]]).bot).toBe(true);
  });

  it("needs an email or phone number to answer", () => {
    expect(read([["name", "Jane"], ["message", "Hi"]])).toEqual({ ok: false, error: "Add an email or phone number so we can reach you." });
    expect(read([["email", "jane at example"]])).toEqual({ ok: false, error: "That email address doesn't look right. Check it and try again." });
    expect(read([["phone", "n/a"]])).toEqual({ ok: false, error: "Add an email or phone number so we can reach you." });
  });

  it("keeps an email that isn't whole as an answer when there's a phone number", () => {
    const s = submission([["email", "jane at example"], ["phone", "540 555 0101"]]);
    expect(s.email).toBeNull();
    expect(s.answers).toEqual({ email: "jane at example" });
    expect(s.contact).toEqual({ phone: "540 555 0101" });
  });

  it("uses the first field for each part, and keeps a second one as an answer", () => {
    const s = submission([["email", "jane@example.com"], ["confirm_email", "jane@example.com"], ["Email", "other@example.com"]]);
    expect(s.email).toBe("jane@example.com");
    expect(s.answers).toEqual({ confirm_email: "jane@example.com", Email: "other@example.com" });
  });

  it("keeps a city without a street as an answer", () => {
    const s = submission([["email", "j@x.co"], ["city", "Roanoke"]]);
    expect(s.address).toEqual({});
    expect(s.answers).toEqual({ city: "Roanoke" });
  });

  it("works with the example form as it is", () => {
    const names = [...exampleForm("https://crm.example.com/f/abc123def0").matchAll(/name="([^"]+)"/g)].map((m) => m[1]!);
    expect(names).toEqual(["name", "email", "phone", "address", "message", "_gotcha"]);
    const s = submission(names.filter((n) => n !== "_gotcha").map((n) => [n, n === "email" ? "jane@example.com" : `my ${n}`] as [string, FieldValue]));
    expect(s).toMatchObject({ name: "my name", email: "jane@example.com", phone: null, address: { line1: "my address" }, message: "my message", answers: { phone: "my phone" }, promo: null });
  });

  it("offers a promo code box in the example form only to a business with codes", () => {
    const form = exampleForm("https://crm.example.com/f/abc123def0", { promo: true });
    const names = [...form.matchAll(/name="([^"]+)"/g)].map((m) => m[1]!);
    expect(names).toEqual(["name", "email", "phone", "address", "message", "promo", "_gotcha"]);
    expect(form).toContain(`<label>Promo code <input type="text" name="promo" autocomplete="off"></label>`);
    expect(submission([["email", "jane@example.com"], ["promo", "SPRING15"]]).promo).toBe("SPRING15");
    expect(exampleForm("https://crm.example.com/f/abc123def0", { promo: false })).not.toContain("promo");
  });

  it("reads a promo code in its usual spellings, whatever the case, spaces or dashes", () => {
    for (const name of ["promo", "Promo Code", "promo_code", "PROMOCODE", "coupon", "Coupon-Code", "coupon_code", "Discount Code", "discount-code"]) {
      expect(fieldRole(name)).toBe("promo");
      expect(submission([["email", "j@x.co"], [name, "  spring15 "]]).promo).toBe("spring15");
    }
    expect(fieldRole("discount")).toBeUndefined();
  });

  it("keeps the first promo field, and every one stays an answer so nothing typed is lost", () => {
    const s = submission([["email", "j@x.co"], ["coupon", "FIRST10"], ["promo", "SECOND"], ["message", "Hi"]]);
    expect(s.promo).toBe("FIRST10");
    expect(s.answers).toEqual({ coupon: "FIRST10", promo: "SECOND" });
    expect(submission([["email", "j@x.co"], ["promo", "X".repeat(80)]]).promo).toBe("X".repeat(40));
  });
});

describe("websites", () => {
  it("are kept by their host name", () => {
    expect(siteHost("https://www.GreenLawn.com/contact?x=1")).toBe("greenlawn.com");
    expect(siteHost("greenlawn.com")).toBe("greenlawn.com");
    expect(siteHost("quotes.greenlawn.com.")).toBe("quotes.greenlawn.com");
    expect(siteHost("localhost")).toBeNull();
    expect(siteHost("javascript:alert(1)")).toBeNull();
    expect(siteHost("")).toBeNull();
  });

  it("send messages when none are listed, or from one listed or its subdomains", () => {
    expect(siteAllowed(null, [])).toBe(true);
    expect(siteAllowed("https://www.greenlawn.com", ["greenlawn.com"])).toBe(true);
    expect(siteAllowed("https://quotes.greenlawn.com/form", ["greenlawn.com"])).toBe(true);
    expect(siteAllowed("https://notgreenlawn.com", ["greenlawn.com"])).toBe(false);
    expect(siteAllowed(null, ["greenlawn.com"])).toBe(false);
  });

  it("go to web addresses only", () => {
    expect(webAddress("https://greenlawn.com/thanks")).toBe("https://greenlawn.com/thanks");
    expect(webAddress("/thanks")).toBeNull();
    expect(webAddress("data:text/html,hi")).toBeNull();
  });
});

describe("the email for a message", () => {
  it("says which form, lists the fields as people read them, and links to the request", () => {
    const s = submission([
      ["name", "Jane Smith"],
      ["email", "jane@example.com"],
      ["how_did_you_hear", "Google"],
      ["message", "Line one\nLine two"],
    ]);
    const email = messageEmail({ formName: "Contact form", submission: s, link: "https://crm.example.com/requests/r1" });
    expect(email.subject).toBe("New message from Jane Smith");
    expect(email.text).toBe(
      [
        "New message from your website's Contact form.",
        "Name: Jane Smith\nEmail: jane@example.com\nHow did you hear: Google",
        "Message:\nLine one\nLine two",
        "https://crm.example.com/requests/r1",
        "Reply to this email to answer Jane.",
      ].join("\n\n"),
    );
    expect(messageEmail({ formName: "Quote form", submission: { ...s, subject: "Quote please" }, link: "x" }).subject).toBe("Quote please");
  });

  it("says what became of a promo code, in the office's words", () => {
    const s = submission([["name", "Jane Smith"], ["email", "jane@example.com"], ["Promo Code", "spring15"]]);
    const ready = messageEmail({ formName: "Contact form", submission: s, link: "https://crm.example.com/requests/r1", promo: { code: "SPRING15", problem: null } });
    expect(ready.text).toBe(
      [
        "New message from your website's Contact form.",
        "Name: Jane Smith\nEmail: jane@example.com\nPromo code: spring15",
        "Promo code SPRING15, ready to apply on the quote.",
        "https://crm.example.com/requests/r1",
        "Reply to this email to answer Jane.",
      ].join("\n\n"),
    );
    const refused = messageEmail({ formName: "Contact form", submission: s, link: "x", promo: { code: "OLD10", problem: "That code expired on October 1." } });
    expect(refused.text).toContain("\n\nPromo code OLD10 wasn't applied: that code expired on October 1.\n\nx");
    expect(promoLine(null)).toBeNull();
    expect(messageEmail({ formName: "Contact form", submission: s, link: "x" }).text).not.toContain("Promo code ");
  });

  it("names fields the way people say them", () => {
    expect(fieldLabel("how_did_you_hear")).toBe("How did you hear");
    expect(fieldLabel("firstName")).toBe("First name");
    expect(fieldLabel("services[]")).toBe("Services");
    expect(fieldLabel("ZIP")).toBe("ZIP");
    expect(fieldLabel("Lot size (acres)")).toBe("Lot size (acres)");
  });
});
