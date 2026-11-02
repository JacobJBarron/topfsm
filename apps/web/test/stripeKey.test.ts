/**
 * The Stripe key on the Apps page: changing it asks for the person's Crewtavo password (sent with
 * the key, the key field staying a password field nobody's browser fills in), a full live secret
 * key is warned about while it's typed but still taken, and once one is connected the Stripe card
 * asks for a restricted key instead.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { KeyCard } from "../src/features/apps/AppDetailPage";
import { isFullSecretKey, STRIPE_NEW_KEY, type AppRow } from "../src/features/apps/catalog";
import { StripePanel } from "../src/features/apps/StripePanel";

vi.mock("../src/lib/session", () => ({
  useSession: () => ({ role: "owner", permissions: [], userId: "u-me", company: { id: "c1", name: "Radford Lawn Care", settings: {} }, config: { features: {} }, refresh: async () => undefined }),
  hasRole: () => true,
  can: () => true,
  isSub: () => false,
}));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: { get: async () => ({}), put: async () => ({}), post: async () => ({}) },
  supabase: () => ({}),
}));

const render = (element: ReactElement) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(MemoryRouter, null, element)));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const STRIPE = { own: true, webhook: true, livemode: true, autopay: true, refunds: true, full_key: false, import: null };
const app = (id: string, extra: Partial<AppRow> = {}) =>
  ({ id, name: id === "stripe" ? "Stripe" : "Anthropic", category: "Payments", auth: "api_key", available: true, redirect_uri: null, status: "connected", account_label: "Radford Lawn Care", ...extra }) as AppRow;

describe("the Stripe key card", () => {
  it("asks for the Crewtavo password, and the key field stays a password field browsers don't fill", () => {
    const html = render(createElement(KeyCard, { app: app("stripe", { stripe: STRIPE }), onSaved: () => undefined }));
    expect(text(html)).toContain("Your Crewtavo password");
    expect(text(html)).toContain("No password yet? Set one under Settings → Profile.");
    expect(html).toMatch(/<input[^>]*type="password"[^>]*autoComplete="current-password"/);
    expect(html).toMatch(/<input[^>]*type="password"[^>]*autoComplete="off"[^>]*aria-label="Key from Stripe"/);
    // Nothing typed yet: Connect waits for the key and the password.
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>.*Connect/);
  });

  it("doesn't ask for a password for the other apps' keys", () => {
    const html = render(createElement(KeyCard, { app: app("anthropic"), onSaved: () => undefined }));
    expect(text(html)).not.toContain("Your Crewtavo password");
    expect(html).not.toContain("current-password");
  });

  it("warns about a full live secret key while it's typed, and only that one", () => {
    expect(isFullSecretKey("sk_live_51Abc")).toBe(true);
    expect(isFullSecretKey("  sk_live_51Abc ")).toBe(true);
    expect(isFullSecretKey("rk_live_51Abc")).toBe(false);
    expect(isFullSecretKey("sk_test_51Abc")).toBe(false);
  });
});

describe("the Stripe card", () => {
  it("asks for a restricted key while a full secret key is connected, without showing any of it", () => {
    const html = render(createElement(StripePanel, { app: app("stripe", { stripe: { ...STRIPE, full_key: true } }), onChanged: () => undefined }));
    expect(text(html)).toContain("This is your full Stripe secret key, which can do anything in your Stripe account, including payouts.");
    expect(text(html)).toContain("then delete the full key in Stripe");
    expect(html).toContain(STRIPE_NEW_KEY.replace(/&/g, "&amp;"));
    expect(text(render(createElement(StripePanel, { app: app("stripe", { stripe: STRIPE }), onChanged: () => undefined })))).not.toContain("full Stripe secret key");
  });
});
