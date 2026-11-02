/**
 * The server itself (server.ts), started as an instance starts it and sent real requests over a
 * socket: the app and the gateway see each request's connection, so visitors count by the address
 * the web server in front gives (lib/visitor.ts), not "unknown" for everyone.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// server.ts starts listening as it loads; keep hold of the listener to close it afterwards.
const started = vi.hoisted(() => ({ listener: undefined as http.Server | undefined }));
vi.mock("@hono/node-server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@hono/node-server")>();
  return { ...real, serve: (...args: Parameters<typeof real.serve>) => (started.listener = real.serve(...args) as http.Server) };
});

/** What the server asked Auth, REST and Storage (fetch is stubbed): rate limit keys say who it counted. */
const calls: Array<{ url: string; key?: string; forwardedFor: string | null }> = [];
let port = 0;
// A built web app: its page and one fingerprinted asset.
const web = mkdtempSync(join(tmpdir(), "crewtavo-web-"));
mkdirSync(join(web, "assets"));
writeFileSync(join(web, "index.html"), "<!doctype html><title>Crewtavo</title>");
writeFileSync(join(web, "assets/app-1a2b.js"), "export {};");

beforeAll(async () => {
  port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address() as AddressInfo;
      probe.close(() => resolve(free));
    });
  });
  // An instance with Docker (stack mode), and nothing else set that would change the rule.
  for (const [name, value] of Object.entries({ PORT: String(port), JWT_SECRET: "x".repeat(64), CREWTAVO_PLATFORM: "compose", CREWTAVO_SCHEDULER: "off", CREWTAVO_STATIC_DIR: web })) vi.stubEnv(name, value);
  for (const name of ["RAILWAY_PROJECT_ID", "RAILWAY_PUBLIC_DOMAIN", "CREWTAVO_VISITOR_IP", "SUPABASE_AUTH_URL", "SUPABASE_REST_URL", "SUPABASE_STORAGE_URL", "CREWTAVO_SENTRY_DSN", "APP_URL"]) vi.stubEnv(name, "");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(input), key: body?.p_key, forwardedFor: new Headers(init?.headers).get("x-forwarded-for") });
    // Every limit is used up, so a request stops right after it's counted.
    return String(input).endsWith("/rest/v1/rpc/rate_limit_hit") ? Response.json(false) : Response.json({});
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await import("../src/server");
  const listener = started.listener!;
  if (!listener.listening) await new Promise((resolve) => listener.once("listening", resolve));
});

afterAll(async () => {
  await new Promise((resolve) => started.listener?.close(resolve));
  rmSync(web, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A request from this machine, as the web server in front (or a visitor here) sends it. */
function send(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: init.headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

/** The headers a page or file comes back with. */
function headersOf(path: string) {
  return new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      res.resume();
      resolve(res.headers);
    }).on("error", reject);
  });
}

const forged = { "X-Real-IP": "198.51.100.2" };
// Caddy on this machine adds the visitor's address at the end of X-Forwarded-For.
const behindCaddy = { ...forged, "X-Forwarded-For": "198.51.100.1, 203.0.113.9" };

describe("the server", () => {
  it("hands the app each request's connection, so visitors count by the address the web server gives", async () => {
    const promoKey = async (headers: Record<string, string>) => {
      calls.length = 0;
      const status = await send("/api/public/forms/acme/quote/promo", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ code: "SPRING" }) });
      expect(status).toBe(429);
      return calls.find((c) => c.url.endsWith("/rpc/rate_limit_hit"))?.key;
    };
    expect(await promoKey(behindCaddy)).toBe("promo:203.0.113.9");
    // Nothing in front: the connection's own address.
    expect(await promoKey({})).toBe("promo:127.0.0.1");
  });

  it("tells Auth that same address through the gateway", async () => {
    calls.length = 0;
    expect(await send("/auth/v1/user", { headers: behindCaddy })).toBe(200);
    expect(calls).toEqual([{ url: "http://auth:9999/user", key: undefined, forwardedFor: "203.0.113.9" }]);
  });

  it("keeps the app's pages out of other sites' frames, except booking forms", async () => {
    for (const path of ["/", "/apps/stripe"]) {
      const headers = await headersOf(path);
      expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
      expect(headers["content-security-policy"]).toBe("frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
    }
    // A booking form on the business's own website (features/booking/embed.ts).
    const form = await headersOf("/book/acme/quote?embed=1");
    expect(form["content-type"]).toContain("text/html");
    expect(form["x-frame-options"]).toBeUndefined();
    expect(form["content-security-policy"]).toBeUndefined();
    // Files that aren't pages keep their own headers.
    const asset = await headersOf("/assets/app-1a2b.js");
    expect(asset["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset["content-security-policy"]).toBeUndefined();
  });
});
