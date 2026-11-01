/**
 * Crewtavo - Website Forms on its Apps page, the way Formspree works. Install makes a form with its
 * own address: put the address in the action of the form on your website (or paste a form that's
 * ready to go), and each message lands in Requests and the inboxes listed here. Uninstall stops
 * taking messages and keeps every form, its address and its requests (routes/websiteForms.ts).
 *
 * Crewtavo - Careers uses the same page for its careers forms (kind "careers"): each application
 * lands in Applicants, résumé and all, instead of Requests.
 */
import { exampleApplicationForm } from "@crewtavo/core/careers";
import { exampleForm } from "@crewtavo/core/websiteForms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, useJustDone } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import styles from "./WebsiteFormsPanel.module.css";

export interface WebsiteForm {
  id: string;
  key: string;
  name: string;
  email_to: string[];
  redirect_url: string | null;
  allowed_sites: string[];
  created_at: string;
  /** Where the form sends: https://<this Crewtavo>/f/<key>. */
  url: string;
  last_message_at: string | null;
}

export type FormKind = "contact" | "careers";

export interface WebsiteFormsSetup {
  enabled: boolean;
  /** Whether this Crewtavo can send email: without it, messages only show in Requests. */
  email_ready: boolean;
  /** The business has a promo code turned on, so the form to paste has a box for one. Older servers leave it out. */
  promo_codes?: boolean;
  forms: WebsiteForm[];
}

export function useWebsiteFormsSwitch(kind: FormKind = "contact") {
  const session = useSession();
  const queryClient = useQueryClient();
  const careers = kind === "careers";
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.post<{ enabled: boolean }>("/website-forms/enabled", { enabled, kind }),
    onSuccess: async (res) => {
      // Careers adds Applicants to the sidebar, from the company's settings.
      if (careers) await session.refresh();
      await queryClient.invalidateQueries({ queryKey: ["apps"] });
      queryClient.invalidateQueries({ queryKey: ["website-forms"] });
      return res;
    },
    meta: { success: (res: { enabled: boolean }) => (res.enabled ? null : careers ? "Careers uninstalled" : "Website Forms uninstalled") },
  });
  const turnOff = async () => {
    const ok = await confirm({
      title: careers ? "Uninstall Careers?" : "Uninstall Website Forms?",
      body: careers
        ? "Your website's Apply form stops sending to Crewtavo right away, and people who fill it in are told it wasn't sent. Applicants leaves the sidebar, but every applicant and résumé is kept and every form keeps its address, so installing it again picks up where you left off."
        : "Forms on your website stop sending to Crewtavo right away, and people who fill one in are told it wasn't sent. Every form keeps its address and its messages stay in Requests, so installing it again picks up where you left off.",
      confirmLabel: "Uninstall",
      danger: true,
    });
    if (ok) toggle.mutate(false);
  };
  return { toggle, turnOff };
}

const list = (text: string) => text.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean);

/** Installed: each form's address, who gets its email, and the rest of its settings. */
export function WebsiteFormsPanel({ kind = "contact" }: { kind?: FormKind }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const careers = kind === "careers";
  const setup = useQuery({
    queryKey: ["website-forms", session.company.id, kind],
    queryFn: () => api.get<WebsiteFormsSetup>(careers ? "/website-forms?kind=careers" : "/website-forms"),
    // Until the first message arrives, look again every few seconds, so a test from the website shows here.
    refetchInterval: (q) => (q.state.data?.forms.length && !q.state.data.forms.some((f) => f.last_message_at) ? 10_000 : false),
  });
  const [adding, setAdding] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: (name: string) => api.post<WebsiteForm>("/website-forms", { name, kind }),
    onSuccess: () => {
      setAdding(null);
      queryClient.invalidateQueries({ queryKey: ["website-forms"] });
    },
    meta: { success: "Form added" },
  });

  if (setup.error) return <div className="card"><ErrorState error={setup.error} onRetry={() => setup.refetch()} /></div>;
  if (!setup.data) {
    return (
      <section className="card card-pad stack-sm" aria-busy="true" aria-label="Loading">
        <Skeleton width={260} height={20} /><Skeleton height={38} /><Skeleton width="70%" height={14} />
      </section>
    );
  }
  const { forms, email_ready, promo_codes = false } = setup.data;
  const submitAdd = (e: FormEvent) => {
    e.preventDefault();
    if (adding?.trim()) add.mutate(adding.trim());
  };

  return (
    <>
      {!email_ready && (
        <div className="callout callout-warning" role="status">
          <Icon name="mail" size={20} />
          <div className="grow">
            Email isn't set up in Crewtavo yet, so {careers ? "applications only show in Applicants" : "messages only show in Requests"}. <Link to="/settings?tab=email" className="strong">Connect your email</Link> to get each one in your inbox too.
          </div>
        </div>
      )}
      {forms.map((form, i) => <FormCard key={form.id} form={form} first={i === 0} kind={kind} promoBox={promo_codes} />)}
      <section className="card card-pad stack-sm" aria-labelledby="website-forms-add" style={{ gap: 10 }}>
        <h2 id="website-forms-add" className="section-title" style={{ fontSize: 16 }}>{forms.length ? "Another form" : "Add a form"}</h2>
        <span className="muted small">
          {careers
            ? "One for each website, or a separate one for seasonal hiring: each gets its own address and its own people to email."
            : "A quote form and a contact form, or one for each website: each gets its own address, and its name on each request."}
        </span>
        {adding === null ? (
          <Button icon="plus" style={{ justifySelf: "start" }} onClick={() => setAdding("")}>Add a form</Button>
        ) : (
          <form className="row wrap" style={{ gap: 8 }} onSubmit={submitAdd}>
            <input className="input grow" style={{ minWidth: 0, flexBasis: 220 }} autoFocus maxLength={80} placeholder={careers ? "Seasonal crew" : "Quote form"} aria-label="The new form's name" value={adding} onChange={(e) => setAdding(e.target.value)} />
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!adding.trim()}>Add</Button>
            <Button variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
          </form>
        )}
      </section>
    </>
  );
}

/** One form: its address and how to use it, then who gets its email, then the rest. */
function FormCard({ form, first, kind, promoBox }: { form: WebsiteForm; first: boolean; kind: FormKind; promoBox: boolean }) {
  const careers = kind === "careers";
  const queryClient = useQueryClient();
  const [name, setName] = useState(form.name);
  const [emails, setEmails] = useState(form.email_to.join(", "));
  const [ownPage, setOwnPage] = useState(Boolean(form.redirect_url));
  const [redirect, setRedirect] = useState(form.redirect_url ?? "");
  const [sites, setSites] = useState(form.allowed_sites.join(", "));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["website-forms"] });

  const changes = {
    ...(name.trim() !== form.name ? { name: name.trim() } : {}),
    ...(list(emails).join(",") !== form.email_to.join(",") ? { email_to: list(emails) } : {}),
    ...((ownPage ? redirect.trim() : "") !== (form.redirect_url ?? "") ? { redirect_url: ownPage ? redirect.trim() || null : null } : {}),
    ...(list(sites).join(",") !== form.allowed_sites.join(",") ? { allowed_sites: list(sites) } : {}),
  };
  const dirty = Object.keys(changes).length > 0;
  const save = useMutation({
    mutationFn: () => api.patch<WebsiteForm>(`/website-forms/${form.id}`, changes),
    onSuccess: (saved) => {
      // In one spelling, as it was saved: greenlawn.com for https://www.greenlawn.com/contact.
      setEmails(saved.email_to.join(", "));
      setSites(saved.allowed_sites.join(", "));
      setRedirect(saved.redirect_url ?? "");
      setOwnPage(Boolean(saved.redirect_url));
      refresh();
    },
  });
  const newAddress = useMutation({
    mutationFn: () => api.post<WebsiteForm>(`/website-forms/${form.id}/address`),
    onSuccess: () => {
      toast.success("New address made", { description: "Put it in your form's action." });
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/website-forms/${form.id}`),
    onSuccess: refresh,
    meta: { success: `${form.name} deleted` },
  });
  const justSaved = useJustDone(save);

  // A careers form sends its résumé along: multipart, or the file never leaves the browser.
  const opening = careers ? `<form action="${form.url}" method="POST" enctype="multipart/form-data">` : `<form action="${form.url}" method="POST">`;
  const example = careers ? exampleApplicationForm(form.url) : exampleForm(form.url, { promo: promoBox });
  const heading = `website-form-${form.id}`;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (dirty) save.mutate();
  };

  return (
    <section id={first ? "app-setup" : undefined} className="card card-pad stack" aria-labelledby={heading} style={{ gap: 14 }}>
      <div className="stack-sm" style={{ gap: 6 }}>
        <div className="row-between wrap" style={{ gap: 8 }}>
          <h2 id={heading} className="section-title" style={{ fontSize: 16 }}>{form.name}</h2>
          <StatusPill label={form.last_message_at ? (careers ? "Taking applications" : "Taking messages") : careers ? "Waiting for an application" : "Waiting for a message"} tone={form.last_message_at ? "good" : "muted"} />
        </div>
        <span className="muted small" role="status">
          {form.last_message_at
            ? careers
              ? <>Last application {timeAgo(form.last_message_at)}. <Link to="/applicants" className="strong">See them in Applicants</Link></>
              : <>Last message {timeAgo(form.last_message_at)}. <Link to="/requests?from=website" className="strong">See them in Requests</Link></>
            : <>Send a test from your website once the address is in your form. It shows up here and in {careers ? "Applicants" : "Requests"} within seconds.</>}
        </span>
      </div>

      <div className="stack-sm">
        <strong>Point your form at this address</strong>
        <div className="row wrap" style={{ gap: 8 }}>
          <code className="code-pill grow" aria-label="The form's address">{form.url}</code>
          <Button icon="copy" onClick={() => copyText(form.url, "Address copied")}>Copy</Button>
        </div>
        <span className="muted small">
          In your website's form, set the <code className={styles.inline}>action</code> to it and the <code className={styles.inline}>method</code> to POST{careers && <>, with <code className={styles.inline}>enctype="multipart/form-data"</code> so résumés come along</>}:
        </span>
        <div className="row wrap" style={{ gap: 8 }}>
          <code className="code-pill grow" aria-label="Your form's first line">{opening}</code>
          <Button icon="copy" onClick={() => copyText(opening, "Copied")}>Copy</Button>
        </div>
        {careers ? (
          <span className="muted small">
            Fields named <strong>name</strong>, <strong>email</strong>, <strong>phone</strong>, <strong>position</strong>, <strong>start_date</strong>, <strong>availability</strong>, <strong>pay</strong>, <strong>experience</strong>, <strong>drivers_license</strong>, <strong>location</strong> and <strong>message</strong> fill in the applicant, in the usual spellings of each.
            Anything else your form asks comes along too. A file field named <strong>resume</strong> is their résumé: up to 3 files of 10 MB each, PDF, Word or a photo. <code className={styles.inline}>_gotcha</code>, <code className={styles.inline}>_subject</code> and <code className={styles.inline}>_next</code> work as they do with Formspree.
          </span>
        ) : (
          <span className="muted small">
            Fields named <strong>name</strong>, <strong>email</strong>, <strong>phone</strong>, <strong>address</strong> and <strong>message</strong> fill in the client and the request.
            A field named <strong>promo</strong>, <strong>promo_code</strong>, <strong>promocode</strong>, <strong>coupon</strong>, <strong>coupon_code</strong> or <strong>discount_code</strong> (in any case, with spaces or dashes too) is checked as a promo code. A valid one is ready to apply on the quote.
            Anything else your form asks comes along with the message. Moving from Formspree? Change the action to this address: <code className={styles.inline}>_gotcha</code>, <code className={styles.inline}>_subject</code>, <code className={styles.inline}>_next</code> and <code className={styles.inline}>_replyto</code> work the same.
          </span>
        )}
      </div>

      <details className="app-details">
        <summary>Need a form? Copy one that's ready to paste</summary>
        <div className="stack-sm" style={{ marginTop: 10 }}>
          <pre className={styles.code}>{example}</pre>
          <Button icon="copy" style={{ justifySelf: "start" }} onClick={() => copyText(example, "Form copied")}>Copy the form</Button>
          <span className="muted small">Paste it where the form should go, in your site builder's HTML or Code block. It takes your website's own fonts and colors.</span>
        </div>
      </details>

      <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
        <Field
          label={careers ? "Email each application to" : "Email each message to"}
          hint={careers
            ? "Up to 5 addresses, separated by commas. Reply to the email to answer the applicant; their résumé stays in Crewtavo. Leave it empty to only see applications in Applicants."
            : "Up to 5 addresses, separated by commas. Reply to the email to answer whoever sent it. Leave it empty to only see messages in Requests."}
        >
          <input className="input" type="text" inputMode="email" autoComplete="off" spellCheck={false} placeholder="office@greenlawn.com" value={emails} onChange={(e) => setEmails(e.target.value)} />
        </Field>

        <details className="app-details">
          <summary>More settings</summary>
          <div className="stack" style={{ gap: 14, marginTop: 12 }}>
            <Field label="Form name" hint={careers ? "Shown on each applicant it brings in, for the people who set up apps." : "Each request from it is called this, unless the form sends a _subject."}>
              <input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="After someone sends it">
              <div className="stack-sm">
                <div className="segmented" role="group" aria-label="After someone sends it" style={{ justifySelf: "start" }}>
                  <button type="button" aria-pressed={!ownPage} onClick={() => setOwnPage(false)}>A thank-you page from Crewtavo</button>
                  <button type="button" aria-pressed={ownPage} onClick={() => setOwnPage(true)}>My own page</button>
                </div>
                {ownPage && (
                  <input className="input" type="text" inputMode="url" spellCheck={false} placeholder="https://greenlawn.com/thanks" aria-label="Your thank-you page's address" value={redirect} onChange={(e) => setRedirect(e.target.value)} />
                )}
              </div>
            </Field>
            <Field label="Only take messages from" optional hint="Your website, like greenlawn.com, so a copy of your form somewhere else can't send to Crewtavo. Leave it empty to take messages from any website.">
              <input className="input" type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder="greenlawn.com" value={sites} onChange={(e) => setSites(e.target.value)} />
            </Field>
            <div className="row wrap" style={{ gap: 8 }}>
              <Button
                icon="refresh"
                loading={newAddress.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: `Get a new address for ${form.name}?`,
                    body: "The address on your website stops taking messages right away. Put the new one in your form's action straight after. Use this when bots have found your form.",
                    confirmLabel: "Get a new address",
                  });
                  if (ok) newAddress.mutate();
                }}
              >
                Get a new address
              </Button>
              <Button
                variant="danger"
                icon="trash"
                loading={remove.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: `Delete ${form.name}?`,
                    body: careers ? "Its address stops taking applications right away. The applicants it brought in stay in Applicants." : "Its address stops taking messages right away. The messages it already sent stay in Requests.",
                    confirmLabel: "Delete",
                    danger: true,
                  });
                  if (ok) remove.mutate();
                }}
              >
                Delete form
              </Button>
            </div>
          </div>
        </details>

        <Button type="submit" style={{ justifySelf: "start" }} loading={save.isPending} done={justSaved} disabled={!dirty && !justSaved}>Save changes</Button>
      </form>
    </section>
  );
}
