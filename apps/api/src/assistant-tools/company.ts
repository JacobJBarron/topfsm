/**
 * The company's details and the settings on Settings → Company, changed the way that screen changes
 * them (apps/web/src/features/settings/CompanySettings.tsx). The database lets an assistant change
 * these and nothing else about the company (the assistant_areas migration).
 */
import { isTimeZoneName, taxPercent, taxRateFromPercent } from "@crewtavo/core";
import { z } from "zod";
import { geocodeAddress } from "../services/external";
import { changed, companyArg, one, tool, type ToolContext } from "./tool";

type Settings = Record<string, any>;

async function current(ctx: ToolContext) {
  return one(ctx.db.from("companies").select("name, phone, email, website, address, timezone, settings").eq("id", ctx.companyId).maybeSingle(), "The company");
}

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM.");

export const companyTools = {
  get_company_settings: tool({
    description:
      "The company's details (name, contact, shop address, time zone) and its settings: payment terms, sales tax, how long quotes are valid, the workday and the brand color. client_tips: whether clients can add a tip for the crew when they pay an invoice online in the Client Hub, or from an autopay receipt.",
    input: z.object({ ...companyArg }),
    run: async (ctx) => {
      const c = await current(ctx);
      const s = (c.settings ?? {}) as Settings;
      return {
        name: c.name,
        phone: c.phone,
        email: c.email,
        website: c.website,
        address: c.address,
        timezone: c.timezone,
        payment_terms_days: s.payment_terms_days ?? 30,
        sales_tax_percent: taxPercent(s.default_tax_rate ?? 0),
        quote_valid_days: s.quote_valid_days ?? 30,
        working_hours: { start: s.working_hours?.start ?? "07:00", end: s.working_hours?.end ?? "18:00" },
        brand_color: s.branding?.color ?? "#0f2a35",
        client_tips: s.hub_tips === true,
      };
    },
  }),
  update_company_settings: tool({
    description:
      "Change the company's details or settings. Send only what changes. A new shop address is found on the map for route planning. Read them first with get_company_settings.",
    input: z.object({
      name: z.string().trim().min(1).max(120).optional(),
      phone: z.string().trim().max(40).nullable().optional(),
      email: z.email().nullable().optional(),
      website: z.string().trim().max(200).nullable().optional(),
      address: z.object({ line1: z.string().trim().max(200), city: z.string().trim().max(100), region: z.string().trim().max(100), postal_code: z.string().trim().max(20) }).optional(),
      timezone: z.string().refine(isTimeZoneName, "Use a time zone name like America/New_York.").optional(),
      payment_terms_days: z.number().int().min(0).max(365).optional().describe("Days until an invoice is due."),
      sales_tax_percent: z.number().min(0).lt(100).optional().describe("Default sales tax, as a percent: 8.875 for 8.875%."),
      quote_valid_days: z.number().int().min(1).max(365).optional(),
      working_hours: z.object({ start: time, end: time }).optional(),
      brand_color: z.string().regex(/^#[0-9a-f]{6}$/i, "Use a hex color like #3b7d23.").optional(),
      client_tips: z
        .boolean()
        .optional()
        .describe(
          "Let clients add a tip for the crew when they pay an invoice online in the Client Hub, or from the receipt after an automatic charge. Off hides every tip choice and no tip is charged. This is not about tips or hints shown to the team.",
        ),
      ...companyArg,
    }),
    area: "company",
    run: async (ctx, a) => {
      const c = await current(ctx);
      const previous = (c.settings ?? {}) as Settings;
      if (a.working_hours && a.working_hours.end <= a.working_hours.start) throw new Error("The workday has to end after it starts.");
      const website = a.website?.trim() ? (/^https?:\/\//.test(a.website) ? a.website.trim() : `https://${a.website.trim()}`) : a.website === undefined ? undefined : null;

      // The shop is where routes start: find it again when its address changes.
      let depot = previous.depot ?? null;
      let located: boolean | null = null;
      const oldAddress = (c.address ?? {}) as Record<string, string>;
      if (a.address?.line1 && (a.address.line1 !== oldAddress.line1 || a.address.city !== oldAddress.city || !depot)) {
        const hit = await geocodeAddress([a.address.line1, a.address.city, a.address.region, a.address.postal_code].filter(Boolean).join(", "), ctx.env.GOOGLE_MAPS_SERVER_KEY).catch(() => null);
        located = Boolean(hit);
        depot = hit ? { lat: hit.lat, lng: hit.lng } : null;
      }
      const settings: Settings = {
        ...previous,
        ...(a.payment_terms_days !== undefined && { payment_terms_days: a.payment_terms_days }),
        ...(a.sales_tax_percent !== undefined && { default_tax_rate: taxRateFromPercent(a.sales_tax_percent) }),
        ...(a.quote_valid_days !== undefined && { quote_valid_days: a.quote_valid_days }),
        ...(a.working_hours && { working_hours: a.working_hours }),
        ...(a.brand_color && { branding: { ...(previous.branding ?? {}), color: a.brand_color } }),
        ...(a.client_tips !== undefined && { hub_tips: a.client_tips }),
        depot,
      };
      const patch = {
        ...(a.name !== undefined && { name: a.name }),
        ...(a.phone !== undefined && { phone: a.phone?.trim() || null }),
        ...(a.email !== undefined && { email: a.email || null }),
        ...(website !== undefined && { website }),
        ...(a.address && { address: a.address }),
        ...(a.timezone && { timezone: a.timezone }),
        settings,
      };
      await changed(ctx.db.from("companies").update(patch as never).eq("id", ctx.companyId).select("id"), "The company");
      return {
        saved: true,
        ...(located === false && { note: "Saved, but the shop address wasn't found on the map; route planning will start from the first stop." }),
      };
    },
  }),
};
