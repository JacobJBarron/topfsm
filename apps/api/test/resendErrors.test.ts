/**
 * Resend's refusals, as Settings → Email and a failed send show them: what went wrong and what to
 * change in Resend, instead of Resend's own wording and a status code.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resendProblem, sendWithMailbox } from "../src/lib/notify";

afterEach(() => vi.unstubAllGlobals());

describe("Resend's refusals", () => {
  it("explain a key that's limited to another domain, naming the domain", () => {
    const text = resendProblem(403, "This API key is not authorized to send emails from meadowsexteriors.com");
    expect(text).toMatch(/^This Resend API key can only send from a different domain, not meadowsexteriors\.com\./);
    expect(text).toContain("Sending access for all domains (or for meadowsexteriors.com)");
    expect(resendProblem(403, "This API key is not authorized to send emails from mail.acme.example.")).toContain("not mail.acme.example.");
  });

  it("tell an unverified domain from a personal address", () => {
    expect(resendProblem(403, "The acme.example domain is not verified. Please, add and verify your domain on https://resend.com/domains")).toMatch(/^acme\.example isn't verified in Resend yet\. .*Domains.*Verified/);
    expect(resendProblem(403, "The `acme.example` domain is not verified.")).toMatch(/^acme\.example isn't/);
    expect(resendProblem(403, "The gmail.com domain is not verified. Please, add and verify your domain on https://resend.com/domains")).toBe(
      "Resend can't send from a gmail.com address. Send from an address on your own domain (the one you added in Resend), like office@yourcompany.com.",
    );
    expect(resendProblem(403, "You can only send testing emails to your own email address (ana@example.com).")).toMatch(/no verified domain yet/);
  });

  it("point a wrong, deleted or switched-off key to making a new one", () => {
    for (const [status, message] of [[401, "API key is invalid"], [400, "API key is invalid"], [403, "API key is not active"], [401, "Missing API Key"], [401, ""]] as const) {
      expect(resendProblem(status, message), message).toMatch(/^Resend didn't accept this API key\..*starts with re_/);
    }
    expect(resendProblem(403, "This API key is suspended")).toMatch(/suspended/);
  });

  it("say which sending limit was reached", () => {
    expect(resendProblem(429, "You have exceeded your daily email sending quota.")).toMatch(/daily sending limit \(100 emails on the free plan\)/);
    expect(resendProblem(429, "You have exceeded your monthly email sending quota.")).toMatch(/monthly sending limit \(3,000/);
    expect(resendProblem(429, "Too many requests. Please limit the number of requests per second.")).toBe("Resend got too many emails at once. Try again in a minute.");
    expect(resendProblem(503, "Service unavailable")).toMatch(/^Resend is having trouble/);
  });

  it("say an address that isn't valid in the app's words", () => {
    expect(resendProblem(422, "Invalid `to` field.")).toBe("That email address isn't valid, so Resend didn't send it.");
    expect(resendProblem(422, "The `to` field is invalid.")).toBe("That email address isn't valid, so Resend didn't send it.");
  });

  it("keep Resend's own words for anything else", () => {
    expect(resendProblem(422, "Invalid `scheduled_at` field.")).toBe("Resend refused it (422: Invalid `scheduled_at` field.).");
    expect(resendProblem(400, "")).toBe("Resend refused it (400).");
  });

  it("come back from a send with the status, so callers can tell a bad key from a limit", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ name: "validation_error", message: "This API key is not authorized to send emails from acme.example" }, { status: 403 }));
    const settings = { preset: "resend", kind: "resend" as const, from_email: "office@acme.example" };
    const result = await sendWithMailbox(settings, { api_key: "re_company" }, { to: "ana@example.com", subject: "Hi", text: "Hello" });
    expect(result).toMatchObject({ sent: false, status: 403, reason: expect.stringContaining("can only send from a different domain, not acme.example") });
  });
});
