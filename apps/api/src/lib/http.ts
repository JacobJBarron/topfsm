import type { PostgrestError } from "@supabase/supabase-js";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Json } from "@crewtavo/core";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { reportError } from "./monitoring";

/** Throw this from handlers; the error handler turns it into { error } JSON. */
export class HttpError extends HTTPException {
  constructor(status: ContentfulStatusCode, message: string) {
    super(status, { message });
  }
}

/** Map Postgres/PostgREST errors to a status and a message people can act on. */
export function dbError(error: PostgrestError | { message: string; code?: string }): HttpError {
  const code = error.code ?? "";
  if (code === "42501" || code === "PGRST301") return new HttpError(403, "You don't have permission to do that.");
  if (code === "23505") return new HttpError(409, "That already exists.");
  if (code === "P0002" || code === "PGRST116") return new HttpError(404, error.message || "Not found.");
  if (code === "23503") return new HttpError(400, "Something this refers to no longer exists. Refresh the page and try again.");
  // Our own database functions raise readable messages with 22023.
  if (code === "22023") return new HttpError(400, error.message);
  if (code === "23514") return new HttpError(400, "One of the values isn't allowed. Check the form and try again.");
  if (code === "22P02") return new HttpError(400, "Something you entered doesn't look right. Check the form and try again.");
  console.error("Database error", error);
  reportError(new Error(`Database error${code ? ` ${code}` : ""}: ${error.message}`));
  return new HttpError(500, "Something went wrong. Try again.");
}

/** For jsonb columns: values we built ourselves (presets, GeoJSON) are valid JSON. */
export const asJson = (value: unknown) => value as Exclude<Json, null>;

/** Unwrap a supabase-js result or throw an HttpError. */
export function must<R extends { data: unknown; error: PostgrestError | null }>(result: R, notFound = "Not found."): NonNullable<R["data"]> {
  if (result.error) throw dbError(result.error);
  if (result.data === null || result.data === undefined) throw new HttpError(404, notFound);
  return result.data as NonNullable<R["data"]>;
}

export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "Something went wrong. Try again.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, friendlyIssue(parsed.error.issues[0]!));
  return parsed.data;
}

const FIELD_NAMES: Record<string, string> = {
  client_id: "client", property_id: "property", job_id: "job", quote_id: "quote", request_id: "request", visit_id: "visit",
  to: "recipient", body: "message", due_on: "due date", starts_at: "start time", ends_at: "end time", scheduled_on: "date",
  full_name: "name", display_name: "name", line1: "street address", postal_code: "ZIP code", api_key: "key", amount: "amount",
  config_id: "Configuration ID",
};

/** A validation problem in words a person can act on ("Enter a valid email address."). */
export function friendlyIssue(issue: z.core.$ZodIssue): string {
  // A refine's own words, when it was given some.
  if (issue.code === "custom" && issue.message && issue.message !== "Invalid input") return issue.message;
  // So are a check's, written as a sentence ("A Configuration ID is all digits."). Zod's own never end with a full stop.
  if (/^[A-Z].*[.!?]$/s.test(issue.message ?? "")) return issue.message;
  const key = String(issue.path.at(-1) ?? "");
  const field = FIELD_NAMES[key] ?? key.replace(/_id$/, "").replace(/_/g, " ");
  if (!field || /^\d+$/.test(field)) return "Something in the form isn't right. Check it and try again.";
  const Field = field[0]!.toUpperCase() + field.slice(1);
  const missing = /undefined|required/i.test(issue.message);
  switch (issue.code) {
    case "too_small":
      return "origin" in issue && issue.origin === "string" ? (Number((issue as { minimum?: number }).minimum) <= 1 ? `${Field} is required.` : `${Field} is too short.`) : `${Field} is too low.`;
    case "too_big":
      return "origin" in issue && issue.origin === "string" ? `${Field} is too long.` : `${Field} is too high.`;
    case "invalid_format":
      return "format" in issue && issue.format === "email" ? "Enter a valid email address." : `${Field} doesn't look right.`;
    case "invalid_type":
      return missing ? `${Field} is required.` : `${Field} doesn't look right.`;
    default:
      return `Check the ${field} and try again.`;
  }
}

export const uuid = z.uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

export function param(c: Context<AppEnv>, name: string): string {
  const value = c.req.param(name);
  if (!value || !uuid.safeParse(value).success) throw new HttpError(404, "We couldn't find that. It may have been deleted.");
  return value;
}

/** Public base URL for links in emails and OAuth redirects. */
export function appUrl(c: Context<AppEnv>): string {
  return (c.env.APP_URL ?? new URL(c.req.url).origin).replace(/\/$/, "");
}

export function requireEnv<K extends keyof Env>(env: Env, key: K, feature: string): NonNullable<Env[K]> {
  const value = env[key];
  if (!value) {
    console.warn(`${feature} needs ${String(key)}`);
    throw new HttpError(501, `${feature} isn't turned on yet. Ask whoever set up Crewtavo to add it.`);
  }
  return value as NonNullable<Env[K]>;
}
