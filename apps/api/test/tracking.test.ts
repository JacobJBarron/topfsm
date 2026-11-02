/**
 * A campaign email's tracking image and tracked links (routes/public.ts): no sign-in, a random
 * token each. The image is the same whatever the token; a link goes only where the database says
 * this recipient's link goes, never anywhere the request says; a HEAD request counts nothing; and
 * neither reads a company's settings, so both keep working while Marketing is uninstalled.
 * PostgREST is a stand-in answering over fetch. What the database records is in
 * supabase/tests/automated_campaigns_test.sql.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  APP_URL: "https://ops.example.com",
};
const TOKEN = "5f0c2b1e-0000-4000-8000-0000000000aa";

interface Call {
  method: string;
  path: string;
  body: any;
}

/** PostgREST over fetch: `rpc` answers each function (a Response for an error). */
function serve(rpc: Record<string, (body: any) => unknown> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    const text = typeof init?.body === "string" ? init.body : "";
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), path, body: text ? JSON.parse(text) : undefined });
    const fn = rpc[path.replace(/^rpc\//, "")];
    const out = fn ? fn(text ? JSON.parse(text) : undefined) : null;
    return out instanceof Response ? out : Response.json(out);
  });
  return calls;
}

const request = (path: string, method = "GET") => app.request(`/api${path}`, { method, redirect: "manual" }, env);

afterEach(() => vi.unstubAllGlobals());

describe("the tracking image", () => {
  it("records an open and answers with a transparent GIF nobody caches", async () => {
    const calls = serve({ track_campaign_open: () => true });
    const res = await request(`/public/o/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/gif");
    expect(res.headers.get("Cache-Control")).toBe("no-store, private");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(43);
    expect(new TextDecoder().decode(bytes.slice(0, 6))).toBe("GIF89a");
    expect(calls).toEqual([{ method: "POST", path: "rpc/track_campaign_open", body: { p_token: TOKEN } }]);
  });

  it("is the same image for a token nobody has, one that isn't a token, or when the database doesn't answer", async () => {
    serve({ track_campaign_open: () => false });
    const unknown = await request(`/public/o/${TOKEN}`);
    expect([unknown.status, unknown.headers.get("Content-Type")]).toEqual([200, "image/gif"]);
    let calls = serve();
    const junk = await request("/public/o/not-a-token");
    expect([junk.status, junk.headers.get("Content-Type")]).toEqual([200, "image/gif"]);
    expect(calls).toEqual([]);
    serve({ track_campaign_open: () => Response.json({ code: "57014", message: "canceling statement due to statement timeout" }, { status: 500 }) });
    expect((await request(`/public/o/${TOKEN}`)).status).toBe(200);
    calls = serve({ track_campaign_open: () => true });
    const head = await request(`/public/o/${TOKEN}`, "HEAD");
    expect(head.status).toBe(200);
    expect(calls).toEqual([]);
  });
});

describe("a tracked link", () => {
  it("records the click and goes to the link stored for it, telling it nothing of where it came from", async () => {
    const calls = serve({ track_campaign_click: () => "https://acme.example/fall?promo=FALL" });
    const res = await request(`/public/c/${TOKEN}/1?url=https://evil.example`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://acme.example/fall?promo=FALL");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(calls).toEqual([{ method: "POST", path: "rpc/track_campaign_click", body: { p_token: TOKEN, p_n: 1, p_count: true } }]);
  });

  it("goes nowhere for a link the database doesn't have, or one that isn't a web address, and says so on a page", async () => {
    for (const answer of [null, "javascript:alert(1)", "mailto:office@acme.example", ""]) {
      serve({ track_campaign_click: () => answer });
      const res = await request(`/public/c/${TOKEN}/0`);
      const page = await res.text();
      expect([res.status, res.headers.get("Location")], String(answer)).toEqual([404, null]);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(page).toContain("<h1>This link isn't valid anymore</h1>");
      expect(page).not.toContain(String(answer || "javascript"));
    }
  });

  it("says a Client Hub link that has expired since has, in the business's look, instead of sending them to an error", async () => {
    const hub = (exp: number) => `https://ops.example.com/hub/${btoa(JSON.stringify({ c: "co-1", t: "client", id: "cl-1", exp })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.c2ln`;
    const old = hub(Math.floor(Date.now() / 1000) - 86_400);
    const calls = serve({ track_campaign_click: () => old });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/rest\/v1\//, "");
      calls.push({ method: (init?.method ?? "GET").toUpperCase(), path, body: undefined });
      if (path === "rpc/track_campaign_click") return Response.json(old);
      if (path === "companies") return Response.json({ id: "co-1", name: "Acme Lawn", settings: {} });
      return Response.json(null);
    });
    const res = await request(`/public/c/${TOKEN}/0`);
    const page = await res.text();
    expect([res.status, res.headers.get("Location")]).toEqual([410, null]);
    expect(page).toContain("This link has expired");
    expect(page).toContain("Acme Lawn");
    // The click still counts, and a link still in date goes through.
    expect(calls.map((c) => c.path)).toEqual(["rpc/track_campaign_click", "companies"]);
    const fresh = hub(Math.floor(Date.now() / 1000) + 86_400);
    serve({ track_campaign_click: () => fresh });
    const ok = await request(`/public/c/${TOKEN}/0`);
    expect([ok.status, ok.headers.get("Location")]).toEqual([302, fresh]);
  });

  it("doesn't ask the database about a token that isn't one, or a link past the 50 tracked", async () => {
    const calls = serve({ track_campaign_click: () => "https://acme.example" });
    for (const path of [`/public/c/${TOKEN}/50`, `/public/c/${TOKEN}/-1`, `/public/c/${TOKEN}/1.5`, "/public/c/not-a-token/0"]) {
      const res = await request(path);
      expect(res.status, path).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it("counts nothing for a HEAD request, a link checker's, but still says where it goes", async () => {
    const calls = serve({ track_campaign_click: () => "https://acme.example/fall" });
    const res = await request(`/public/c/${TOKEN}/0`, "HEAD");
    expect([res.status, res.headers.get("Location")]).toEqual([302, "https://acme.example/fall"]);
    expect(calls[0]!.body).toEqual({ p_token: TOKEN, p_n: 0, p_count: false });
  });

  it("reads no company's settings, so it works while Marketing is uninstalled", async () => {
    const calls = serve({ track_campaign_click: () => "https://acme.example/fall", track_campaign_open: () => true });
    await request(`/public/c/${TOKEN}/0`);
    await request(`/public/o/${TOKEN}`);
    expect(calls.map((c) => c.path)).toEqual(["rpc/track_campaign_click", "rpc/track_campaign_open"]);
  });

  it("says to try again when the database doesn't answer", async () => {
    serve({ track_campaign_click: () => Response.json({ code: "57014", message: "canceling statement due to statement timeout" }, { status: 500 }) });
    const res = await request(`/public/c/${TOKEN}/0`);
    expect(res.status).toBe(503);
  });
});
