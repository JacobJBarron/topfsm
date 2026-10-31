/** Clients, requests, notes, the schedule, guides and equipment: looking things up, logging requests and notes. */
import { z } from "zod";
import { companyArg, friendly, rows, tool } from "./tool";

export const recordTools = {
  search_clients: tool({
    description: "Find clients by name, company, email or phone (query 1–100 characters; limit 1–25, default 10). For a whole list, use list_clients.",
    input: z.object({ query: z.string().min(1).max(100), limit: z.number().int().min(1).max(25).default(10), ...companyArg }),
    run: (ctx, a) => {
      const term = a.query.replace(/[%,()*]/g, " ").trim();
      return rows(
        ctx.db
          .from("clients")
          .select("id, display_name, company_name, email, phone, status, tags")
          .eq("company_id", ctx.companyId)
          .or(["display_name", "company_name", "email", "phone"].map((col) => `${col}.ilike.%${term}%`).join(","))
          .limit(a.limit),
      );
    },
  }),
  get_client: tool({
    description: "A client's details, contacts, properties (with access codes if your role sees them), and recent requests, quotes and jobs.",
    input: z.object({ client_id: z.uuid(), ...companyArg }),
    run: async (ctx, a) => {
      const [client, contacts, properties, requests, quotes, jobs] = await Promise.all([
        rows(ctx.db.from("clients").select("id, display_name, company_name, email, phone, status, tags, notes, lead_source, billing_address, marketing_opt_out, review_opt_out, sms_opt_out_at, custom_fields").eq("id", a.client_id).eq("company_id", ctx.companyId)),
        rows(ctx.db.from("client_contacts").select("id, name, email, phone, role, is_primary, notify_email, notify_sms").eq("client_id", a.client_id)),
        rows(ctx.db.from("properties").select("id, label, line1, line2, city, region, postal_code, lat, lng, lot_size_sqft, notes, tags, access:property_access(gate_code, lockbox_code, alarm_code, instructions)").eq("client_id", a.client_id)),
        rows(ctx.db.from("requests").select("id, number, title, status, created_at").eq("client_id", a.client_id).order("created_at", { ascending: false }).limit(5)),
        rows(ctx.db.from("quotes").select("id, number, title, status, total, sent_at").eq("client_id", a.client_id).order("created_at", { ascending: false }).limit(5)),
        rows(ctx.db.from("jobs").select("id, number, title, status, kind").eq("client_id", a.client_id).order("created_at", { ascending: false }).limit(5)),
      ]);
      if (!client.length) throw new Error("Client not found");
      const { custom_fields, ...details } = client[0];
      return { client: { ...details, source_id: ((custom_fields ?? {}) as { source_id?: string }).source_id ?? null }, contacts, properties, requests, quotes, jobs };
    },
  }),
  list_requests: tool({
    description: "Incoming work requests, newest first.",
    input: z.object({
      status: z.enum(["new", "assessment_scheduled", "assessment_complete", "quoted", "converted", "archived"]).optional(),
      limit: z.number().int().min(1).max(50).default(20),
      ...companyArg,
    }),
    run: (ctx, a) => {
      let q = ctx.db.from("requests").select("id, number, title, status, source, created_at, client:clients(id, display_name)").eq("company_id", ctx.companyId);
      if (a.status) q = q.eq("status", a.status);
      return rows(q.order("created_at", { ascending: false }).limit(a.limit));
    },
  }),
  create_request: tool({
    description: "Log a new work request for an existing client (find them with search_clients first).",
    input: z.object({ client_id: z.uuid(), title: z.string().min(3).max(200), details: z.string().max(4000).optional(), ...companyArg }),
    area: "records",
    run: async (ctx, a) => {
      const { data, error } = await ctx.db
        .from("requests")
        .insert({ company_id: ctx.companyId, client_id: a.client_id, title: a.title, details: a.details, source: "assistant" })
        .select("id, number, title, status")
        .single();
      if (error) throw new Error(friendly(error.message));
      return data;
    },
  }),
  add_note: tool({
    description: "Add an internal note to a client's record.",
    input: z.object({ client_id: z.uuid(), text: z.string().min(1).max(4000), ...companyArg }),
    area: "records",
    run: async (ctx, a) => {
      const { data, error } = await ctx.db
        .from("messages")
        .insert({ company_id: ctx.companyId, client_id: a.client_id, channel: "note", direction: "internal", body: a.text })
        .select("id, created_at")
        .single();
      if (error) throw new Error(friendly(error.message));
      return data;
    },
  }),
  search_sops: tool({
    description: "Search the company's guides (standard operating procedures, SOPs). Returns titles and matching excerpts; read one in full with get_guide.",
    input: z.object({ query: z.string().min(2).max(200), ...companyArg }),
    run: async (ctx, a) => {
      // Asked with GET like the other lookups: an instance's gateway takes only reads from an
      // assistant that can't change things (lib/assistants.ts).
      const { data, error } = await ctx.db.rpc("search_sops", { p_company: ctx.companyId, p_query: a.query, p_limit: 5 }, { get: true });
      if (error) throw new Error(friendly(error.message));
      return (data ?? []).map((s: { id: string; title: string; category: string; snippet: string }) => ({ id: s.id, title: s.title, category: s.category, excerpt: s.snippet }));
    },
  }),
  equipment_maintenance: tool({
    description: "Maintenance on the company's equipment (trucks, mowers, machines): what's overdue or coming due, with hours or miles left. Set include_ok for every schedule.",
    input: z.object({ include_ok: z.boolean().default(false), ...companyArg }),
    run: async (ctx, a) => {
      let q = ctx.db
        .from("equipment_due")
        .select("equipment_id, equipment_name, name, state, next_due_on, days_left, next_due_meter, meter_left, meter, meter_reading, last_done_on")
        .eq("company_id", ctx.companyId)
        .eq("equipment_status", "active");
      if (!a.include_ok) q = q.neq("state", "ok");
      const found = await rows(q.order("next_due_on", { nullsFirst: false }).limit(200));
      const order: Record<string, number> = { overdue: 0, due_soon: 1, ok: 2 };
      return found.sort((x, y) => order[String(x.state)] - order[String(y.state)]);
    },
  }),
};
