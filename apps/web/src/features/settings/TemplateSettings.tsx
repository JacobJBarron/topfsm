/**
 * Settings → Estimate template: how a business's estimates, proposals and invoices look, in every
 * trade. The letterhead (Crewtavo's in a style, color and lettering, or the business's own, uploaded),
 * the license and insurer, the contract (the terms printed above the signatures, and which of the
 * business's contract sections every estimate and every invoice prints, from Settings → Contract
 * terms), the signature lines and the footer, with a live preview of the letter-size pages.
 * A business can keep several templates (one is the default; a quote can pick another). One that
 * never saved a template prints with the built-in one, and its first save keeps it as "Standard".
 */
import {
  defaultTerms,
  documentColor,
  HEADER_STYLES,
  ownLetterhead,
  TEMPLATE_COLORS,
  TEMPLATE_LIMITS,
  templateSettings,
  type HeaderStyle,
  type TemplateSettings as Template,
} from "@crewtavo/core/documents";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LibrarySection } from "@crewtavo/core/contracts";
import { useEffect, useId, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button, useJustDone } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { CardSkeleton, Loading, Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { hasRole, useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";
import { CLASSIC_FONT, DocumentSheet, PrintableDocument, printDocument } from "../documents/EstimateDocument";
import { documentCompany, letterheadKey, sampleDocument, templatesKey, useLetterhead, useTemplates, websiteLabel, type TemplateRow } from "../documents/data";
import { CompanyLogo } from "./CompanyLogo";
import { contractPreview, contractSummary, inLibraryOrder, pickSection, placeLabel, useContractSections } from "./ContractSettings";
import { OwnLetterhead } from "./OwnLetterhead";
import styles from "./TemplateSettings.module.css";

type SectionId = "letterhead" | "details" | "contract" | "signatures" | "footer";

/** Before the contract sections load (or when there are none). */
const NO_SECTIONS: LibrarySection[] = [];

export function TemplateSettings() {
  const templates = useTemplates();
  const [selected, setSelected] = useState<string | null>(null);

  if (templates.isPending) {
    return (
      <Loading label="Loading your estimate template">
        <div className="stack">
          <CardSkeleton lines={2} />
          <div className="two-col">
            <div className="narrow stack-sm"><CardSkeleton lines={3} /><CardSkeleton lines={2} /><CardSkeleton lines={1} /></div>
            <div className="wide card card-pad"><Skeleton height={520} radius={4} /></div>
          </div>
        </div>
      </Loading>
    );
  }
  if (templates.error) return <div className="card"><ErrorState error={templates.error} onRetry={() => templates.refetch()} /></div>;
  const rows = templates.data;
  const current = rows.find((t) => t.id === selected) ?? rows.find((t) => t.is_default) ?? rows[0] ?? null;
  return <TemplateEditor key={current?.id ?? "built-in"} row={current} rows={rows} onSelect={setSelected} />;
}

function TemplateEditor({ row, rows, onSelect }: { row: TemplateRow | null; rows: TemplateRow[]; onSelect: (id: string | null) => void }) {
  const session = useSession();
  const { company } = session;
  const isAdmin = hasRole(session, "admin");
  const queryClient = useQueryClient();
  const letterhead = useLetterhead();
  // A business that never saved a template starts from the built-in look, with its trade's starter terms.
  const trade = company.trade_preset;
  const saved = useMemo(() => templateSettings(row?.settings, trade), [row, trade]);
  const [t, setT] = useState<Template>(saved);
  const [open, setOpen] = useState<Record<SectionId, boolean>>({ letterhead: true, details: true, contract: false, signatures: true, footer: false });
  const [previewing, setPreviewing] = useState<"estimate" | "invoice">("estimate");
  const library = useContractSections();
  const [naming, setNaming] = useState<null | "new" | "rename">(null);
  const dirty = JSON.stringify(t) !== JSON.stringify(saved);
  const set = <K extends keyof Template>(key: K, value: Template[K]) => setT((prev) => ({ ...prev, [key]: value }));
  const toggle = (id: SectionId) => setOpen((prev) => ({ ...prev, [id]: !prev[id] }));
  const reload = () => queryClient.invalidateQueries({ queryKey: templatesKey(company.id) });

  // The logo is changed right here (or in Settings → Company): the preview picks it up.
  useEffect(
    () =>
      queryClient.getMutationCache().subscribe((event) => {
        if (event.type === "updated" && event.action.type === "success") queryClient.invalidateQueries({ queryKey: letterheadKey(company.id) });
      }),
    [queryClient, company.id],
  );

  const save = useMutation({
    // The button says it saved, except after the first save: the editor starts again on the new
    // template then, so a toast says it instead.
    meta: { inline: true, success: (r: { first: boolean }) => (r.first ? "Template saved" : null) },
    mutationFn: async () => {
      const settings = templateSettings(t, trade);
      if (row) {
        unwrap(await supabase().from("document_templates").update({ settings: settings as never }).eq("id", row.id));
        return { id: row.id, settings, first: false };
      }
      // The first save keeps the built-in look as the business's own "Standard", used everywhere.
      const created = unwrap(await supabase().from("document_templates").insert({ company_id: company.id, name: "Standard", is_default: true, settings: settings as never }).select("id").single());
      return { id: created.id, settings, first: true };
    },
    onSuccess: ({ id, settings }) => {
      setT(settings);
      onSelect(id);
      return reload();
    },
  });

  const create = useMutation({
    meta: { inline: true, success: (r: { name: string }) => `“${r.name}” is ready. Change it, then save.` },
    mutationFn: async (name: string) => {
      // Before the business has a template of its own, the one it's been using becomes "Standard".
      if (!row) unwrap(await supabase().from("document_templates").insert({ company_id: company.id, name: "Standard", is_default: true, settings: saved as never }));
      const created = unwrap(await supabase().from("document_templates").insert({ company_id: company.id, name, is_default: false, settings: saved as never }).select("id, name").single());
      return created;
    },
    onSuccess: (created) => {
      setNaming(null);
      onSelect(created.id);
      return reload();
    },
  });

  const rename = useMutation({
    meta: { inline: true, success: "Template renamed" },
    mutationFn: async (name: string) => unwrap(await supabase().from("document_templates").update({ name }).eq("id", row!.id)),
    onSuccess: () => {
      setNaming(null);
      return reload();
    },
  });

  const makeDefault = useMutation({
    meta: { success: () => `“${row?.name}” is now used for every estimate and invoice, unless a quote picks another.` },
    mutationFn: async () => {
      // One default at a time (a unique index): the old one steps down first.
      unwrap(await supabase().from("document_templates").update({ is_default: false }).eq("company_id", company.id).eq("is_default", true));
      unwrap(await supabase().from("document_templates").update({ is_default: true }).eq("id", row!.id));
    },
    onSettled: reload,
  });

  const remove = useMutation({
    meta: { inline: true },
    mutationFn: async (id: string) => unwrap(await supabase().from("document_templates").delete().eq("id", id)),
    onSettled: reload,
  });
  // Gone at once, with Undo. Quotes that use it print with the default template once it's deleted for real.
  const deleteTemplate = (doomed: TemplateRow) =>
    undoable({
      title: "Template deleted",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: templatesKey(company.id) });
        queryClient.setQueryData<TemplateRow[]>(templatesKey(company.id), (old) => old?.filter((r) => r.id !== doomed.id));
        onSelect(null);
      },
      restore: () => {
        queryClient.setQueryData<TemplateRow[]>(templatesKey(company.id), (old) => (old && !old.some((r) => r.id === doomed.id) ? [...old, doomed].sort((a, b) => a.name.localeCompare(b.name)) : old));
        onSelect(doomed.id);
      },
      commit: () => remove.mutateAsync(doomed.id),
    });
  const justSaved = useJustDone(save);

  /** Leaving a template with changes that aren't saved asks first. */
  const leave = async () => !dirty || confirm({ title: "Discard your changes?", body: "The changes you made to this template aren't saved.", confirmLabel: "Discard changes", danger: true });

  // If the business's details can't load, the page still shows what the session knows.
  const doc = letterhead.data ?? documentCompany(company);
  const brand = documentColor({ color: null }, doc.settings);
  const custom = t.color && !TEMPLATE_COLORS.some((c) => c.hex === t.color) ? t.color : null;
  const colorName = t.color === null ? "Brand color" : TEMPLATE_COLORS.find((c) => c.hex === t.color)?.name ?? "Custom";
  const color = documentColor(t, doc.settings);
  const logoPath = ((doc.settings as { branding?: { logo?: string | null } } | null)?.branding?.logo ?? null) || null;
  const sample = sampleDocument(company.trade_preset);
  const name = row?.name ?? "Standard";
  const isDefault = row ? row.is_default : true;
  const own = ownLetterhead(t);
  // Crewtavo's header prints at the top unless the business's own letterhead has a top.
  const builtInTop = !own.header;
  const sections = library.data ?? NO_SECTIONS;
  // Sections deleted from the library since don't print, so they don't count.
  const counted = (ids: string[]) => (library.data ? inLibraryOrder(ids, library.data).length : ids.length);
  // The sample with the contract this template prints, filled in like a real estimate's (or invoice's).
  const preview = useMemo(
    () => contractPreview({ kind: previewing, sample, template: t, library: sections, company: { name: doc.name, phone: doc.phone, timezone: company.timezone } }),
    [previewing, sample, t, sections, doc.name, doc.phone, company.timezone],
  );

  const summary: Record<SectionId, string> = {
    letterhead: letterheadSummary(t, colorName),
    details: [doc.name, t.show_license && t.license.trim() ? `License ${t.license.trim()}` : null].filter(Boolean).join(" · "),
    contract: contractSummary(t.terms, counted(t.sections), counted(t.invoice_sections)),
    signatures: t.customer_signs && t.company_signs ? "The customer and your company sign" : t.customer_signs ? "The customer signs" : t.company_signs ? "Your company signs" : "No signature lines",
    footer: [own.footer ? "Your letterhead's bottom" : t.footer.trim(), t.page_numbers ? "Page numbers" : null].filter(Boolean).join(" · ") || "Nothing along the bottom",
  };

  return (
    <div className={styles.wrap}>
      <div className={`card card-pad ${styles.bar}`}>
        <div className={styles.intro}>
          <h2>Estimate template</h2>
          <p>How your estimates, proposals and invoices look. Change anything below and the page follows.</p>
        </div>
        <div className={styles.tools}>
          <label className={styles.picker}>
            Template
            <select
              className="select"
              value={row?.id ?? ""}
              onChange={async (e) => {
                const next = e.target.value;
                if (await leave()) onSelect(next || null);
              }}
            >
              {rows.length ? rows.map((r) => <option key={r.id} value={r.id}>{r.name}{r.is_default ? " (default)" : ""}</option>) : <option value="">Standard (default)</option>}
            </select>
          </label>
          <Button icon="plus" onClick={async () => (await leave()) && setNaming("new")}>New template</Button>
          <Menu
            label="More for this template"
            items={[
              { label: "Rename", icon: "edit", hidden: !row, onSelect: () => setNaming("rename") },
              { label: "Make it the default", icon: "check", hidden: !row || isDefault, onSelect: () => makeDefault.mutate() },
              { separator: true, hidden: !row || isDefault },
              {
                label: "Delete template",
                icon: "trash",
                danger: true,
                hidden: !row || isDefault,
                onSelect: () => row && deleteTemplate(row),
              },
            ]}
          />
          <span className={styles.spacer} />
          {dirty && <span className={styles.dirty}>Not saved yet</span>}
          <Button icon="printer" onClick={() => void printDocument()}>Print a sample</Button>
          <Button variant="primary" icon="check" loading={save.isPending} done={justSaved} disabled={!dirty && !justSaved} onClick={() => save.mutate()}>Save template</Button>
        </div>
        <span className={styles.which}>
          {isDefault ? "Used for every estimate and invoice, unless a quote picks another." : "Used on the quotes that pick it. Pick it on a quote, beside its totals."}
        </span>
        <FormError error={save.error} />
      </div>

      <div className={styles.layout}>
        <div className={styles.controls}>
          <Section id="letterhead" icon="palette" title="Letterhead" summary={summary.letterhead} open={open.letterhead} onToggle={toggle}>
            <div className={styles.group}>
              <span className={styles.label} id="letterhead-kind">Letterhead</span>
              <div className="segmented" role="group" aria-labelledby="letterhead-kind" style={{ justifySelf: "start" }}>
                <button type="button" aria-pressed={t.letterhead === "built_in"} onClick={() => set("letterhead", "built_in")}>Crewtavo's</button>
                <button type="button" aria-pressed={t.letterhead === "custom"} onClick={() => set("letterhead", "custom")}>Your own</button>
              </div>
            </div>

            {t.letterhead === "custom" && (
              <OwnLetterhead
                header={t.letterhead_header}
                footer={t.letterhead_footer}
                onChange={(pictures) => setT((prev) => ({ ...prev, letterhead: "custom", letterhead_header: pictures.header, letterhead_footer: pictures.footer }))}
              />
            )}
            {own.footer && builtInTop && <p className={styles.note}>Your letterhead has no top, so Crewtavo's header prints at the top of the first page, in the style below.</p>}

            {builtInTop && (
              <>
                <div className={styles.group}>
                  <span className={styles.label} id="header-style">Header style</span>
                  <div className={styles.tiles} role="group" aria-labelledby="header-style">
                    {HEADER_STYLES.map((h) => (
                      <button key={h.id} type="button" className={styles.tile} aria-pressed={t.header === h.id} onClick={() => set("header", h.id)}>
                        <MiniHeader style={h.id} color={color} />
                        {h.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.group}>
                  <span className={styles.label}>Logo</span>
                  {isAdmin ? (
                    <CompanyLogo path={logoPath} />
                  ) : doc.logo ? (
                    <div className="row wrap" style={{ gap: 12 }}>
                      <span className={styles.logoTile}><img src={doc.logo} alt="Your logo" /></span>
                      <span className="muted small">From Settings → Company. An admin can change it there.</span>
                    </div>
                  ) : (
                    <span className="muted small">No logo yet, so your initials go at the top. An admin can add a logo in Settings → Company.</span>
                  )}
                </div>
              </>
            )}

            <div className={styles.group}>
              <span className={styles.label} id="doc-color">Color <span className="muted" style={{ fontWeight: 400 }}>· {colorName}</span></span>
              <div className={styles.swatches} role="group" aria-labelledby="doc-color">
                <button type="button" className={styles.brandSwatch} style={{ "--swatch": brand } as CSSProperties} aria-pressed={t.color === null} onClick={() => set("color", null)}>
                  Brand color
                </button>
                {TEMPLATE_COLORS.map((c) => (
                  <button key={c.hex} type="button" className={styles.swatch} title={c.name} aria-label={c.name} aria-pressed={t.color === c.hex} style={{ background: c.hex, "--swatch": c.hex } as CSSProperties} onClick={() => set("color", c.hex)} />
                ))}
                {custom && <button type="button" className={styles.swatch} title="Custom" aria-label="Custom color" aria-pressed style={{ background: custom, "--swatch": custom } as CSSProperties} />}
              </div>
              <span className="muted small">Brand color is the one in Settings → Company, also on your Client Hub.</span>
            </div>

            <div className={styles.group}>
              <span className={styles.label} id="lettering">Lettering</span>
              <div className="segmented" role="group" aria-labelledby="lettering" style={{ justifySelf: "start" }}>
                <button type="button" aria-pressed={t.font === "modern"} onClick={() => set("font", "modern")}>Modern</button>
                <button type="button" aria-pressed={t.font === "classic"} onClick={() => set("font", "classic")} style={{ fontFamily: CLASSIC_FONT, fontSize: 14 }}>Classic</button>
              </div>
            </div>
          </Section>

          <Section id="details" icon="home" title="Business details" summary={summary.details} open={open.details} onToggle={toggle}>
            {own.header && <p className={styles.note}>Your own letterhead prints at the top in place of these.</p>}
            <div className={styles.readonly}>
              <strong>{doc.name}</strong>
              {doc.address.length ? doc.address.map((line, i) => <span key={i}>{line}</span>) : <span>No address yet</span>}
              {(doc.phone || doc.email) && <span>{[doc.phone, doc.email].filter(Boolean).join(" · ")}</span>}
              {doc.website && <span>{websiteLabel(doc.website)}</span>}
              {isAdmin ? <Link to="/settings?tab=company">Change in Settings → Company</Link> : <span className="small">An admin can change these in Settings → Company.</span>}
            </div>
            <Field label="Under the name" optional hint="A few words on what you do.">
              <input className="input" value={t.tagline} maxLength={TEMPLATE_LIMITS.tagline} placeholder={company.trade_preset === "roofing_exteriors" ? "Roofing · Siding · Gutters" : "What you do, in a few words"} onChange={(e) => set("tagline", e.target.value)} />
            </Field>
            <div className={styles.pair}>
              <Field label="License number" optional>
                <input className="input" value={t.license} maxLength={TEMPLATE_LIMITS.license} placeholder="#RC-104882" onChange={(e) => set("license", e.target.value)} />
              </Field>
              <Field label="Insured by" optional>
                <input className="input" value={t.insurer} maxLength={TEMPLATE_LIMITS.insurer} placeholder="Your insurance company" onChange={(e) => set("insurer", e.target.value)} />
              </Field>
            </div>
            <label className="switch-row">
              <input type="checkbox" className="switch" checked={t.show_license} onChange={(e) => set("show_license", e.target.checked)} />
              Show the license number
            </label>
            <label className="switch-row">
              <input type="checkbox" className="switch" checked={t.show_insurer} onChange={(e) => set("show_insurer", e.target.checked)} />
              Show who insures you
            </label>
          </Section>

          <Section id="contract" icon="file" title="Contract" summary={summary.contract} open={open.contract} onToggle={toggle}>
            <Field label="Printed above the signatures" hint="Payment, changes and your warranty, in plain words. Each line prints on its own line.">
              <textarea className="textarea" rows={7} value={t.terms} maxLength={TEMPLATE_LIMITS.terms} onChange={(e) => set("terms", e.target.value)} />
            </Field>
            {t.terms.trim() !== defaultTerms(trade) && (
              <Button size="sm" variant="ghost" icon="undo" style={{ justifySelf: "start" }} onClick={() => set("terms", defaultTerms(trade))}>Use the suggested wording</Button>
            )}
            {library.isPending ? (
              <div className={styles.group} aria-hidden="true"><Skeleton width="45%" /><Skeleton width="80%" /><Skeleton width="70%" /></div>
            ) : library.error ? (
              <ErrorState compact title="Your contract sections couldn't load" error={library.error} onRetry={() => library.refetch()} />
            ) : sections.length ? (
              <>
                <SectionPicks
                  label="Sections on estimates"
                  hint="After the terms above, in the order of your contract terms. A package can bring more, and a quote can add more for one job."
                  library={sections}
                  ids={t.sections}
                  showPlace
                  onChange={(ids) => set("sections", ids)}
                />
                <SectionPicks label="Sections on invoices" hint="Printed after the invoice's totals." library={sections} ids={t.invoice_sections} onChange={(ids) => set("invoice_sections", ids)} />
                <p className={styles.note}>
                  Write, change and reorder your sections in <Link to="/settings?tab=contracts">Settings → Contract terms</Link>.
                </p>
              </>
            ) : (
              <p className={styles.note}>
                Add sections like payment, your warranty and the right to cancel in <Link to="/settings?tab=contracts">Settings → Contract terms</Link>, then pick the ones every estimate and invoice prints here.
              </p>
            )}
          </Section>

          <Section id="signatures" icon="signature" title="Signatures" summary={summary.signatures} open={open.signatures} onToggle={toggle}>
            <div className={styles.group}>
              <label className="switch-row">
                <input type="checkbox" className="switch" checked={t.customer_signs} onChange={(e) => set("customer_signs", e.target.checked)} />
                The customer signs
              </label>
              <input className="input" aria-label="Words under the customer's line" value={t.customer_label} maxLength={TEMPLATE_LIMITS.label} placeholder="Customer" disabled={!t.customer_signs} onChange={(e) => set("customer_label", e.target.value)} />
            </div>
            <div className={styles.group}>
              <label className="switch-row">
                <input type="checkbox" className="switch" checked={t.company_signs} onChange={(e) => set("company_signs", e.target.checked)} />
                Your company signs too
              </label>
              <input className="input" aria-label="Words under your company's line" value={t.company_label} maxLength={TEMPLATE_LIMITS.label} placeholder={`${doc.name} representative`} disabled={!t.company_signs} onChange={(e) => set("company_label", e.target.value)} />
            </div>
            <label className="switch-row">
              <input type="checkbox" className="switch" checked={t.sign_dates} onChange={(e) => set("sign_dates", e.target.checked)} />
              A date beside each signature
            </label>
            <p className={styles.note}>
              Each salesperson's signature is saved the first time they sign, so on site it's one tap. <Link to="/settings?tab=profile">Add yours in Profile</Link>.
            </p>
          </Section>

          <Section id="footer" icon="list" title="Footer" summary={summary.footer} open={open.footer} onToggle={toggle}>
            {own.footer ? (
              <p className={styles.note}>The bottom of your own letterhead prints along the bottom of the page. To print words here instead, upload your letterhead again and leave its bottom out.</p>
            ) : (
              <Field label="Along the bottom of every page" optional>
                <input className="input" value={t.footer} maxLength={TEMPLATE_LIMITS.footer} placeholder="Licensed and insured · Family owned since 1998" onChange={(e) => set("footer", e.target.value)} />
              </Field>
            )}
            <label className="switch-row">
              <input type="checkbox" className="switch" checked={t.page_numbers} onChange={(e) => set("page_numbers", e.target.checked)} />
              Page numbers
            </label>
          </Section>
        </div>

        <section className={styles.preview} aria-label="Live preview">
          <div className={styles.previewHead}>
            <span><Icon name="eye" size={16} />Live preview, with a sample {previewing === "invoice" ? "invoice" : company.trade_preset === "roofing_exteriors" ? "roof estimate" : "estimate"}</span>
            <div className="segmented" role="group" aria-label="Sample to show">
              <button type="button" aria-pressed={previewing === "estimate"} onClick={() => setPreviewing("estimate")}>Estimate</button>
              <button type="button" aria-pressed={previewing === "invoice"} onClick={() => setPreviewing("invoice")}>Invoice</button>
            </div>
            <span>Letter size · prints and saves as a PDF</span>
          </div>
          <DocumentSheet template={preview.template} company={doc} data={preview.data} />
        </section>
      </div>

      <PrintableDocument template={preview.template} company={doc} data={preview.data} />
      {naming === "new" && (
        <NameDialog
          title="New template"
          description={`It starts as a copy of “${name}”.`}
          confirmLabel="Make the template"
          pending={create.isPending}
          error={create.error}
          taken={rows.map((r) => r.name)}
          onClose={() => setNaming(null)}
          onSave={(value) => create.mutate(value)}
        />
      )}
      {naming === "rename" && row && (
        <NameDialog
          title="Rename template"
          initial={row.name}
          confirmLabel="Save name"
          pending={rename.isPending}
          error={rename.error}
          taken={rows.filter((r) => r.id !== row.id).map((r) => r.name)}
          onClose={() => setNaming(null)}
          onSave={(value) => rename.mutate(value)}
        />
      )}
    </div>
  );
}

/**
 * The Letterhead fold's line: whose letterhead prints, its color and lettering. With the business's
 * own letterhead that has no top, Crewtavo's header still prints there, so it says which style.
 */
export function letterheadSummary(t: Pick<Template, "letterhead" | "letterhead_header" | "letterhead_footer" | "header" | "font">, colorName: string): string {
  const own = ownLetterhead(t);
  const style = HEADER_STYLES.find((h) => h.id === t.header)?.label ?? "Classic";
  const lettering = `${t.font === "classic" ? "Classic" : "Modern"} lettering`;
  if (t.letterhead !== "custom") return `${style} · ${colorName} · ${lettering}`;
  if (own.header) return `Your own letterhead · ${colorName} · ${lettering}`;
  if (own.footer) return `${style} header · Your letterhead's bottom · ${colorName} · ${lettering}`;
  return "Your own letterhead, not uploaded yet";
}

/** One fold of the template's settings: a header that says what's chosen, and the choices. */
function Section({ id, icon, title, summary, open, onToggle, children }: { id: SectionId; icon: IconName; title: string; summary: string; open: boolean; onToggle: (id: SectionId) => void; children: ReactNode }) {
  const bodyId = useId();
  return (
    <div className={styles.section}>
      <button type="button" className={styles.sectionHead} aria-expanded={open} aria-controls={bodyId} onClick={() => onToggle(id)}>
        <span className={styles.sectionIcon} aria-hidden="true"><Icon name={icon} /></span>
        <span className={styles.sectionTitle}>
          <strong>{title}</strong>
          <span>{summary}</span>
        </span>
        <span className={styles.chevron} aria-hidden="true"><Icon name="chevronDown" /></span>
      </button>
      <div id={bodyId} className={styles.sectionBody} hidden={!open}>{children}</div>
    </div>
  );
}

/** A checklist of the library's sections, in its order, for the ones a template prints. */
function SectionPicks({ label, hint, library, ids, showPlace = false, onChange }: { label: string; hint: string; library: LibrarySection[]; ids: string[]; showPlace?: boolean; onChange: (ids: string[]) => void }) {
  const labelId = useId();
  const hintId = useId();
  const chosen = new Set(ids.map((id) => id.toLowerCase()));
  return (
    <div className={styles.group}>
      <span className={styles.label} id={labelId}>{label}</span>
      <div className={styles.picks} role="group" aria-labelledby={labelId} aria-describedby={hintId}>
        {library.map((s) => (
          <label key={s.id} className="checkbox">
            <input type="checkbox" checked={chosen.has(s.id.toLowerCase())} onChange={(e) => onChange(pickSection(ids, s.id, e.target.checked, library))} />
            <span className={styles.pick}>
              {s.title}
              {showPlace && (
                <span className={styles.pickMeta}>
                  {placeLabel(s.place)}
                  {s.initials ? " · The customer initials it" : ""}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
      <span className="muted small" id={hintId}>{hint}</span>
    </div>
  );
}

/** A tiny page in each header style, in the template's color. */
function MiniHeader({ style, color }: { style: HeaderStyle; color: string }) {
  const vars = { "--mini-color": color } as CSSProperties;
  if (style === "centered") {
    return (
      <span className={`${styles.mini} ${styles.miniCentered}`} style={vars} aria-hidden="true">
        <i className={styles.square} /><i className={styles.name} /><i className={styles.line} />
      </span>
    );
  }
  if (style === "banner") {
    return (
      <span className={`${styles.mini} ${styles.miniBanner}`} style={vars} aria-hidden="true">
        <span><span><i className={styles.square} /><i className={styles.name} /></span><i className={styles.line} /></span>
      </span>
    );
  }
  return (
    <span className={`${styles.mini} ${styles.miniClassic}`} style={vars} aria-hidden="true">
      <span><i className={styles.square} /><i className={styles.name} /></span>
      <span><i style={{ width: 22 }} /><i style={{ width: 16 }} /><i style={{ width: 20 }} /></span>
    </span>
  );
}

/** Naming a new template, or renaming one. */
function NameDialog({ title, description, initial = "", confirmLabel, pending, error, taken, onClose, onSave }: {
  title: string;
  description?: string;
  initial?: string;
  confirmLabel: string;
  pending: boolean;
  error: unknown;
  taken: string[];
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const clean = value.trim();
  const duplicate = taken.some((n) => n.trim().toLowerCase() === clean.toLowerCase());
  return (
    <Dialog open onClose={onClose} title={title} description={description} size="sm">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (clean && !duplicate) onSave(clean);
        }}
      >
        <Field label="Name" error={duplicate ? "You already have a template with that name." : null} hint="Like “Storm and insurance work”.">
          <input className="input" value={value} maxLength={TEMPLATE_LIMITS.name} required onChange={(e) => setValue(e.target.value)} />
        </Field>
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={pending} disabled={!clean || duplicate}>{confirmLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}
