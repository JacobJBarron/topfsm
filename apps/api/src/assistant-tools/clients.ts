/**
 * Clients, their properties and contacts, and importing them from another system. Saved the way
 * the Clients screens save them (apps/web/src/features/clients), and imported with the same rules
 * as Clients → Import (packages/core/src/clientImport.ts).
 */
import { CLIENT_STATUSES, planImport, recordsToClients, type ExistingClient } from "@crewtavo/core";
import { z } from "zod";
import { geocodeLater, geocodeProperty } from "../services/properties";
import { changed, companyArg, friendly, one, rows, tool, type ToolContext } from "./tool";

const text = (max: number) => z.string().trim().max(max);
const optional = (max: number) => text(max).nullable().optional();
const address = z.object({ line1: text(200).min(1), city: optional(100), region: optional(100), postal_code: optional(20) });

const clientFields = {
  name: text(200).min(1).optional().describe("The client's name as it shows in Crewtavo: a person or a business."),
  company_name: optional(200),
  email: z.email().nullable().optional(),
  phone: optional(40),
  status: z.enum(CLIENT_STATUSES).optional().describe("lead, active, or archived (an inactive or former client)."),
  tags: z.array(text(40).min(1)).max(20).optional(),
  lead_source: optional(80),
  notes: optional(4000),
  billing_address: address.nullable().optional(),
  marketing_opt_out: z.boolean().optional().describe("True: no marketing emails or texts, and no review requests."),
  review_opt_out: z.boolean().optional().describe("True: don't ask them for reviews."),
};

const propertyFields = {
  label: optional(80).describe('"Main house", "Lot B"...'),
  line1: text(200).min(1).optional(),
  line2: optional(100),
  city: optional(100),
  region: optional(100).describe("State."),
  postal_code: optional(20),
  notes: optional(2000),
  lot_size_sqft: z.number().min(0).max(1e9).nullable().optional(),
  tags: z.array(text(40).min(1)).max(20).optional(),
  access: z
    .object({ gate_code: optional(80), lockbox_code: optional(80), alarm_code: optional(80), instructions: optional(1000) })
    .optional()
    .describe("Gate, lockbox and alarm codes and access instructions. Office and up only."),
};

/** A client's row from the fields given; undefined fields are left as they are. */
function clientRow(a: z.infer<z.ZodObject<typeof clientFields>>) {
  return {
    ...(a.name !== undefined && { display_name: a.name }),
    ...(a.company_name !== undefined && { company_name: a.company_name || null }),
    ...(a.email !== undefined && { email: a.email?.toLowerCase() || null }),
    ...(a.phone !== undefined && { phone: a.phone || null }),
    ...(a.status !== undefined && { status: a.status }),
    ...(a.tags !== undefined && { tags: a.tags }),
    ...(a.lead_source !== undefined && { lead_source: a.lead_source || null }),
    ...(a.notes !== undefined && { notes: a.notes || null }),
    ...(a.billing_address !== undefined && { billing_address: (a.billing_address ?? {}) as never }),
    ...(a.marketing_opt_out !== undefined && { marketing_opt_out: a.marketing_opt_out }),
    ...(a.review_opt_out !== undefined && { review_opt_out: a.review_opt_out }),
  };
}

/** Every client in the company, for matching an import (in pages, like the import screen). */
async function existingClients(ctx: ToolContext): Promise<ExistingClient[]> {
  const all: ExistingClient[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await rows(ctx.db.from("clients").select("id, email, display_name, status, custom_fields").eq("company_id", ctx.companyId).order("created_at").range(from, from + 999));
    all.push(...page.map((c) => ({ id: c.id, display_name: c.display_name, email: c.email, status: c.status, source_id: ((c.custom_fields ?? {}) as { source_id?: string }).source_id ?? null })));
    if (page.length < 1000) return all;
  }
}

async function streetsOf(ctx: ToolContext, ids: readonly string[]) {
  const streets = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += 200) {
    for (const p of await rows(ctx.db.from("properties").select("client_id, line1").in("client_id", ids.slice(i, i + 200)))) streets.set(p.client_id, [...(streets.get(p.client_id) ?? []), p.line1]);
  }
  return streets;
}

const importRecord = z.object({
  source_id: optional(100).describe("The client's ID in the old system. Matched first, so running the same import again adds nothing twice."),
  name: optional(200),
  first_name: optional(100),
  last_name: optional(100),
  company_name: optional(200),
  email: optional(200),
  phone: optional(40),
  status: optional(40).describe("active, inactive/former/archived, or lead. New clients without one come in active."),
  tags: z.array(text(40)).max(20).optional(),
  lead_source: optional(80),
  notes: optional(4000),
  billing_address: z.object({ line1: text(200), city: optional(100), region: optional(100), postal_code: optional(20) }).nullable().optional(),
  properties: z
    .array(z.object({ label: optional(80), line1: text(200).min(1), line2: optional(100), city: optional(100), region: optional(100), postal_code: optional(20), notes: optional(2000) }))
    .max(50)
    .optional(),
});

export const clientTools = {
  list_clients: tool({
    description:
      "Every client, a page at a time (limit up to 200, then offset by next_offset until it's null), with status, tags, old-system ID and properties. Filter by status (default all, archived included), a tag, text in the name, company, email or phone, or updated_since. Use it to reconcile a whole list; search_clients finds one person.",
    input: z.object({
      status: z.enum(["all", ...CLIENT_STATUSES]).default("all"),
      tag: text(40).optional(),
      text: text(100).optional(),
      updated_since: z.iso.datetime({ offset: true }).optional(),
      limit: z.number().int().min(1).max(200).default(100),
      offset: z.number().int().min(0).default(0),
      ...companyArg,
    }),
    run: async (ctx, a) => {
      let q = ctx.db
        .from("clients")
        .select("id, display_name, company_name, email, phone, status, tags, lead_source, custom_fields, updated_at, properties(id, label, line1, city, region, postal_code)", { count: "exact" })
        .eq("company_id", ctx.companyId);
      if (a.status !== "all") q = q.eq("status", a.status);
      if (a.tag) q = q.contains("tags", [a.tag]);
      if (a.updated_since) q = q.gte("updated_at", a.updated_since);
      if (a.text) {
        const term = a.text.replace(/[%,()*]/g, " ").trim();
        q = q.or(["display_name", "company_name", "email", "phone"].map((col) => `${col}.ilike.%${term}%`).join(","));
      }
      const { data, error, count } = await q.order("display_name").range(a.offset, a.offset + a.limit - 1);
      if (error) throw new Error(friendly(error.message));
      const clients = (data ?? []).map(({ custom_fields, ...c }) => ({ ...c, source_id: ((custom_fields ?? {}) as { source_id?: string }).source_id ?? null }));
      const next = a.offset + clients.length;
      return { total: count ?? clients.length, clients, next_offset: count !== null && next < count ? next : null };
    },
  }),
  create_client: tool({
    description: "Add a client, with an optional first property. New clients are leads unless you give a status. Check search_clients first so they aren't added twice.",
    input: z.object({
      ...clientFields,
      name: text(200).min(1),
      source_id: optional(100).describe("Their ID in an old system, if any."),
      property: z.object({ ...propertyFields, line1: text(200).min(1) }).optional(),
      ...companyArg,
    }),
    area: "clients",
    run: async (ctx, a) => {
      const client = await one(
        ctx.db
          .from("clients")
          .insert({ company_id: ctx.companyId, ...clientRow(a), display_name: a.name, ...(a.source_id && { custom_fields: { source_id: a.source_id } as never }) })
          .select("id, display_name, status")
          .single(),
        "The client",
      );
      const property = a.property ? await savePropertyRow(ctx, { ...a.property, client_id: client.id }) : null;
      return { client, property };
    },
  }),
  update_client: tool({
    description: "Change a client's details or status. Send only what changes.",
    input: z.object({ client_id: z.uuid(), ...clientFields, ...companyArg }),
    area: "clients",
    run: async (ctx, { client_id, company_id: _, ...a }) => {
      const patch = clientRow(a);
      if (!Object.keys(patch).length) throw new Error("Nothing to change: send at least one field.");
      await changed(ctx.db.from("clients").update(patch).eq("id", client_id).eq("company_id", ctx.companyId).select("id"), "That client");
      return { saved: true };
    },
  }),
  set_client_status: tool({
    description: "Make many clients active, archived (inactive) or leads at once, up to 500.",
    input: z.object({ client_ids: z.array(z.uuid()).min(1).max(500), status: z.enum(CLIENT_STATUSES), ...companyArg }),
    area: "clients",
    run: async (ctx, a) => {
      let done = 0;
      for (let i = 0; i < a.client_ids.length; i += 200) {
        done += (await rows(ctx.db.from("clients").update({ status: a.status }).in("id", a.client_ids.slice(i, i + 200)).eq("company_id", ctx.companyId).select("id"))).length;
      }
      return { changed: done, not_found: a.client_ids.length - done };
    },
  }),
  delete_client: tool({
    description: "Delete a client with their properties and contacts. A client with invoices or payments can't be deleted: archive them with set_client_status instead.",
    input: z.object({ client_id: z.uuid(), ...companyArg }),
    area: "clients",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("clients").delete().eq("id", a.client_id).eq("company_id", ctx.companyId).select("id"), "That client");
      return { deleted: true };
    },
  }),
  save_property: tool({
    description: "Add a property to a client (client_id and line1), or change one (property_id). A new address is found on the map for routes and weather.",
    input: z.object({ property_id: z.uuid().optional(), client_id: z.uuid().optional(), ...propertyFields, ...companyArg }),
    area: "clients",
    run: (ctx, a) => savePropertyRow(ctx, a),
  }),
  delete_property: tool({
    description: "Delete a property. Jobs, visits, quotes and requests there keep going, without the address.",
    input: z.object({ property_id: z.uuid(), ...companyArg }),
    area: "clients",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("properties").delete().eq("id", a.property_id).eq("company_id", ctx.companyId).select("id"), "That property");
      return { deleted: true };
    },
  }),
  save_contact: tool({
    description: "Add another contact to a client (client_id and name), or change one (contact_id): a spouse, a property manager, accounts payable. Making one primary makes the others not.",
    input: z.object({
      contact_id: z.uuid().optional(),
      client_id: z.uuid().optional(),
      name: text(200).min(1).optional(),
      email: z.email().nullable().optional(),
      phone: optional(40),
      role: optional(80),
      is_primary: z.boolean().optional(),
      notify_email: z.boolean().optional().describe("Gets the client's emails (quotes, invoices, reminders)."),
      notify_sms: z.boolean().optional(),
      ...companyArg,
    }),
    area: "clients",
    run: async (ctx, { contact_id, client_id, company_id: _, ...a }) => {
      const row = {
        ...(a.name !== undefined && { name: a.name }),
        ...(a.email !== undefined && { email: a.email?.toLowerCase() || null }),
        ...(a.phone !== undefined && { phone: a.phone || null }),
        ...(a.role !== undefined && { role: a.role || null }),
        ...(a.is_primary !== undefined && { is_primary: a.is_primary }),
        ...(a.notify_email !== undefined && { notify_email: a.notify_email }),
        ...(a.notify_sms !== undefined && { notify_sms: a.notify_sms }),
      };
      const owner = contact_id
        ? (await one(ctx.db.from("client_contacts").select("client_id").eq("id", contact_id).eq("company_id", ctx.companyId).maybeSingle(), "That contact")).client_id
        : client_id;
      if (!owner) throw new Error("Give the client_id for a new contact, or the contact_id to change one.");
      if (!contact_id && !a.name) throw new Error("A new contact needs a name.");
      if (a.is_primary) {
        const { error } = await ctx.db.from("client_contacts").update({ is_primary: false }).eq("client_id", owner).neq("id", contact_id ?? "00000000-0000-0000-0000-000000000000");
        if (error) throw new Error(friendly(error.message));
      }
      if (contact_id) {
        await changed(ctx.db.from("client_contacts").update(row).eq("id", contact_id).select("id"), "That contact");
        return { contact_id, saved: true };
      }
      const made = await one(ctx.db.from("client_contacts").insert({ company_id: ctx.companyId, client_id: owner, name: a.name!, ...row }).select("id").single(), "The contact");
      return { contact_id: made.id, saved: true };
    },
  }),
  delete_contact: tool({
    description: "Remove one of a client's contacts.",
    input: z.object({ contact_id: z.uuid(), ...companyArg }),
    area: "clients",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("client_contacts").delete().eq("id", a.contact_id).eq("company_id", ctx.companyId).select("id"), "That contact");
      return { deleted: true };
    },
  }),
  import_clients: tool({
    description:
      "Bring clients and their properties in from another system or a spreadsheet, up to 2,000 at once. Run it with mode \"preview\" first: it says which clients are new, which are already here (found by source_id, then email, then name), whose status changes, and which properties get added, without changing anything. Then run the same clients with mode \"commit\". Rows for the same client (same source_id or email) are combined. Running it again adds nothing twice.",
    input: z.object({ mode: z.enum(["preview", "commit"]), clients: z.array(importRecord).min(1).max(2000), ...companyArg }),
    area: "clients",
    run: async (ctx, a) => {
      const { clients, skipped } = recordsToClients(a.clients);
      const existing = await existingClients(ctx);
      const found = [...new Set(planImport(clients, existing, new Map()).decisions.flatMap((d) => (d.client_id ? [d.client_id] : [])))];
      const plan = planImport(clients, existing, await streetsOf(ctx, found));
      const summary = (extra: (key: string) => object = () => ({})) =>
        plan.decisions.map((d) => ({
          name: d.display_name,
          action: d.action === "create" ? "new client" : `already here (by ${d.matched_by})`,
          client_id: d.client_id,
          ...(d.status_change ? { status: `${d.status_change.from} → ${d.status_change.to}` } : d.action === "create" ? { status: d.status } : {}),
          add_properties: d.add_properties.map((p) => [p.line1, p.city].filter(Boolean).join(", ")),
          ...(d.kept_properties ? { properties_already_here: d.kept_properties } : {}),
          ...extra(d.key),
        }));
      if (a.mode === "preview") return { mode: "preview", totals: plan.totals, skipped, clients: summary() };

      const byKey = new Map(clients.map((c) => [c.key, c]));
      const ids = new Map<string, string>();
      for (const d of plan.decisions) ids.set(d.key, d.client_id ?? crypto.randomUUID());
      const fresh = plan.decisions.filter((d) => d.action === "create");
      for (let i = 0; i < fresh.length; i += 200) {
        const { error } = await ctx.db.from("clients").insert(
          fresh.slice(i, i + 200).map((d) => {
            const c = byKey.get(d.key)!;
            return {
              id: ids.get(d.key)!, company_id: ctx.companyId, display_name: c.display_name, company_name: c.company_name, email: c.email, phone: c.phone,
              lead_source: c.lead_source, tags: c.tags, notes: c.notes, billing_address: (c.billing ?? {}) as never, status: d.status ?? "active",
              custom_fields: (c.source_id ? { source_id: c.source_id } : {}) as never,
            };
          }),
        );
        if (error) throw new Error(`${friendly(error.message)} Nothing after the first ${i} new clients was added; run the import again to finish it.`);
      }
      for (const status of CLIENT_STATUSES) {
        const changing = plan.decisions.filter((d) => d.status_change?.to === status).map((d) => d.client_id!);
        for (let i = 0; i < changing.length; i += 200) {
          const { error } = await ctx.db.from("clients").update({ status }).in("id", changing.slice(i, i + 200));
          if (error) throw new Error(friendly(error.message));
        }
      }
      const properties = plan.decisions.flatMap((d) =>
        d.add_properties.map((p) => ({ key: d.key, row: { company_id: ctx.companyId, client_id: ids.get(d.key)!, label: p.label, line1: p.line1, line2: p.line2, city: p.city, region: p.region, postal_code: p.postal_code, notes: p.notes ?? null } })),
      );
      const propertyIds = new Map<string, string[]>();
      for (let i = 0; i < properties.length; i += 200) {
        const chunk = properties.slice(i, i + 200);
        const made = await rows(ctx.db.from("properties").insert(chunk.map((p) => p.row)).select("id"));
        made.forEach((p, j) => propertyIds.set(chunk[j].key, [...(propertyIds.get(chunk[j].key) ?? []), p.id]));
      }
      geocodeLater(ctx.db, ctx.env, ctx.companyId, [...propertyIds.values()].flat());
      return {
        mode: "commit",
        totals: plan.totals,
        skipped,
        clients: summary((key) => ({ client_id: ids.get(key), property_ids: propertyIds.get(key) ?? [] })),
        note: "New properties are being found on the map in the background.",
      };
    },
  }),
};

/** Adds or changes a property, its access codes (office only), and finds a new address on the map. */
async function savePropertyRow(ctx: ToolContext, a: { property_id?: string; client_id?: string } & z.infer<z.ZodObject<typeof propertyFields>>) {
  const fields = {
    ...(a.label !== undefined && { label: a.label || null }),
    ...(a.line1 !== undefined && { line1: a.line1 }),
    ...(a.line2 !== undefined && { line2: a.line2 || null }),
    ...(a.city !== undefined && { city: a.city || null }),
    ...(a.region !== undefined && { region: a.region || null }),
    ...(a.postal_code !== undefined && { postal_code: a.postal_code || null }),
    ...(a.notes !== undefined && { notes: a.notes || null }),
    ...(a.lot_size_sqft !== undefined && { lot_size_sqft: a.lot_size_sqft }),
    ...(a.tags !== undefined && { tags: a.tags }),
  };
  const moved = ["line1", "line2", "city", "region", "postal_code"].some((k) => k in fields);
  let id = a.property_id;
  if (id) {
    // A new address needs a new map location.
    await changed(ctx.db.from("properties").update({ ...fields, ...(moved && { lat: null, lng: null }) }).eq("id", id).eq("company_id", ctx.companyId).select("id"), "That property");
  } else {
    if (!a.client_id || !a.line1) throw new Error("A new property needs the client_id and a street address (line1).");
    id = (await one(ctx.db.from("properties").insert({ company_id: ctx.companyId, client_id: a.client_id, ...fields, line1: a.line1 }).select("id").single(), "The property")).id;
  }
  if (a.access) {
    const codes = {
      ...(a.access.gate_code !== undefined && { gate_code: a.access.gate_code || null }),
      ...(a.access.lockbox_code !== undefined && { lockbox_code: a.access.lockbox_code || null }),
      ...(a.access.alarm_code !== undefined && { alarm_code: a.access.alarm_code || null }),
      ...(a.access.instructions !== undefined && { instructions: a.access.instructions || null }),
    };
    const { error } = await ctx.db.from("property_access").upsert({ company_id: ctx.companyId, property_id: id, ...codes });
    if (error) throw new Error(friendly(error.message));
  }
  const located = moved || !a.property_id ? await geocodeProperty(ctx.db, ctx.env, ctx.companyId, id).catch(() => null) : null;
  return { property_id: id, saved: true, ...(moved || !a.property_id ? { on_map: Boolean(located) } : {}) };
}
