/**
 * Estimate templates (document_templates: how estimates and invoices look on paper) and the contract
 * sections they print (contract_sections), changed the way Settings → Estimate template and Settings
 * → Contract terms change them. The business's own letterhead pictures are cut from its stationery in
 * Crewtavo itself; an assistant can only choose between them and Crewtavo's.
 */
import { CONTRACT_LIMITS, FILL_INS, HEADER_STYLES, markdownToGuide, TEMPLATE_LIMITS, templateSettings, type HeaderStyle } from "@crewtavo/core";
import { z } from "zod";
import { changed, companyArg, one, rows, tool, type ToolContext } from "./tool";

const sectionIds = z.array(z.uuid()).max(TEMPLATE_LIMITS.sections);

/** Every id is one of the business's contract sections, so nothing silently drops off the paper. */
async function checkSections(ctx: ToolContext, ids: string[]) {
  if (!ids.length) return;
  const found = await rows(ctx.db.from("contract_sections").select("id").eq("company_id", ctx.companyId).in("id", ids));
  if (found.length < new Set(ids).size) throw new Error("One of the contract sections isn't here. Find them with list_contract_sections.");
}

export const templateTools = {
  list_document_templates: tool({
    description:
      "The estimate templates: how estimates and invoices look on paper (letterhead, color, lettering, license and insurer lines, terms, the contract sections printed on every estimate and every invoice, signature lines, footer). The default prints unless a quote names another. None saved means documents print with the defaults shown.",
    input: z.object({ ...companyArg }),
    run: async (ctx) => {
      const templates = await rows(ctx.db.from("document_templates").select("id, name, is_default, settings").eq("company_id", ctx.companyId).order("name"));
      return {
        templates: templates.map((t) => ({ id: t.id, name: t.name, is_default: t.is_default, settings: templateSettings(t.settings) })),
        ...(!templates.length && { defaults: templateSettings({}) }),
      };
    },
  }),
  save_document_template: tool({
    description:
      "Make an estimate template (no template_id) or change one (with template_id; send only what changes). The first one becomes the default. sections and invoice_sections are contract section ids (list_contract_sections), in the order they print; they replace the list. color null uses the company's brand color.",
    input: z.object({
      template_id: z.uuid().optional(),
      name: z.string().trim().min(1).max(TEMPLATE_LIMITS.name).optional().describe("Default \"Standard\" for a new one."),
      make_default: z.boolean().optional().describe("Print with this one unless a quote names another."),
      letterhead: z.enum(["built_in", "custom"]).optional().describe("custom prints the business's own letterhead pictures, uploaded in Crewtavo; without them Crewtavo's still prints."),
      header: z.enum(HEADER_STYLES.map((h) => h.id) as [HeaderStyle, ...HeaderStyle[]]).optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/i, "Use a hex color like #1f4e79.").nullable().optional(),
      font: z.enum(["modern", "classic"]).optional().describe("modern is sans serif, classic a serif."),
      tagline: z.string().max(TEMPLATE_LIMITS.tagline).optional().describe('Under the business name, like "Roofing · Siding · Gutters".'),
      license: z.string().max(TEMPLATE_LIMITS.license).optional(),
      insurer: z.string().max(TEMPLATE_LIMITS.insurer).optional(),
      show_license: z.boolean().optional(),
      show_insurer: z.boolean().optional(),
      terms: z.string().max(TEMPLATE_LIMITS.terms).optional().describe("Printed above the signatures. Line breaks are kept."),
      sections: sectionIds.optional().describe("Contract sections on every estimate."),
      invoice_sections: sectionIds.optional().describe("Contract sections on every invoice."),
      customer_signs: z.boolean().optional(),
      customer_label: z.string().max(TEMPLATE_LIMITS.label).optional(),
      company_signs: z.boolean().optional(),
      company_label: z.string().max(TEMPLATE_LIMITS.label).optional().describe('Under the company\'s signature line; empty is "<business> representative".'),
      sign_dates: z.boolean().optional(),
      footer: z.string().max(TEMPLATE_LIMITS.footer).optional(),
      page_numbers: z.boolean().optional(),
      ...companyArg,
    }),
    area: "templates",
    run: async (ctx, { template_id, name, make_default, company_id: _, ...changes }) => {
      await checkSections(ctx, [...(changes.sections ?? []), ...(changes.invoice_sections ?? [])]);
      const existing = await rows(ctx.db.from("document_templates").select("id, settings, is_default").eq("company_id", ctx.companyId));
      const row = template_id ? existing.find((t) => t.id === template_id) : null;
      if (template_id && !row) throw new Error("That template isn't here. Find it with list_document_templates.");
      const settings = templateSettings({ ...templateSettings(row?.settings), ...changes });
      const makeDefault = make_default === true || !existing.length;
      // Only one default: the old one steps down first (a unique index holds it).
      if (makeDefault && !row?.is_default) {
        const { error } = await ctx.db.from("document_templates").update({ is_default: false }).eq("company_id", ctx.companyId).eq("is_default", true);
        if (error) throw new Error(error.message);
      }
      const fields = { settings: settings as never, ...(name && { name }), ...(makeDefault && { is_default: true }) };
      if (row) {
        await changed(ctx.db.from("document_templates").update(fields).eq("id", row.id).eq("company_id", ctx.companyId).select("id"), "That template");
        return { template_id: row.id, saved: true };
      }
      const made = await one(ctx.db.from("document_templates").insert({ name: "Standard", ...fields, company_id: ctx.companyId }).select("id, is_default").single(), "The template");
      return { template_id: made.id, is_default: made.is_default };
    },
  }),
  delete_document_template: tool({
    description: "Delete an estimate template. Quotes that named it print with the default; signed ones keep the template they were signed with.",
    input: z.object({ template_id: z.uuid(), ...companyArg }),
    area: "templates",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("document_templates").delete().eq("id", a.template_id).eq("company_id", ctx.companyId).select("id"), "That template");
      return { deleted: true };
    },
  }),
  list_contract_sections: tool({
    description:
      "The business's contract wording, a section at a time (payment, changes, warranty, right to cancel...), in the order they print, with each body as HTML. place is signatures (above them) or terms (on the pages after). fill_ins are the {tokens} a body can use.",
    input: z.object({ ...companyArg }),
    run: async (ctx) => ({
      sections: await rows(ctx.db.from("contract_sections").select("id, title, body, place, initials, sort").eq("company_id", ctx.companyId).order("sort").order("created_at")),
      fill_ins: FILL_INS.map(({ token, hint }) => ({ token, hint })),
    }),
  }),
  save_contract_section: tool({
    description:
      "Write a contract section (no section_id) or change one (with section_id; send only what changes). The body is Markdown (headings, bold, lists) and may use fill-ins like {Customer name} from list_contract_sections. A new one goes last; add it to a template with save_document_template to print it. Suggest the person has an attorney review contract wording.",
    input: z.object({
      section_id: z.uuid().optional(),
      title: z.string().trim().min(1).max(CONTRACT_LIMITS.title).optional().describe("Needed for a new one."),
      body_markdown: z.string().max(CONTRACT_LIMITS.body).optional(),
      place: z.enum(["signatures", "terms"]).optional().describe("Default terms."),
      initials: z.boolean().optional().describe("The customer initials it when they sign."),
      ...companyArg,
    }),
    area: "templates",
    run: async (ctx, a) => {
      const body = a.body_markdown === undefined ? undefined : markdownToGuide(a.body_markdown).html;
      if (body !== undefined && body.length > CONTRACT_LIMITS.body) throw new Error("That section is too long. Split it into two.");
      const fields = { ...(a.title && { title: a.title }), ...(body !== undefined && { body }), ...(a.place && { place: a.place }), ...(a.initials !== undefined && { initials: a.initials }) };
      if (a.section_id) {
        await changed(ctx.db.from("contract_sections").update(fields).eq("id", a.section_id).eq("company_id", ctx.companyId).select("id"), "That section");
        return { section_id: a.section_id, saved: true };
      }
      if (!a.title) throw new Error("Give the new section a title.");
      const last = await rows(ctx.db.from("contract_sections").select("sort").eq("company_id", ctx.companyId).order("sort", { ascending: false }).limit(1));
      const made = await one(ctx.db.from("contract_sections").insert({ ...fields, title: a.title, company_id: ctx.companyId, sort: (last[0]?.sort ?? -1) + 1 }).select("id").single(), "The section");
      return { section_id: made.id, saved: true };
    },
  }),
  delete_contract_section: tool({
    description: "Delete a contract section. Templates and packages that list it stop printing it; estimates already signed keep the words they were signed with.",
    input: z.object({ section_id: z.uuid(), ...companyArg }),
    area: "templates",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("contract_sections").delete().eq("id", a.section_id).eq("company_id", ctx.companyId).select("id"), "That section");
      return { deleted: true };
    },
  }),
};
