/**
 * QuickBooks, Zoho Books and Google Business Profile with the business's own app at Intuit, Zoho or
 * Google: step by step to make one (every address it asks for, ready to copy), then its Client ID and
 * secret pasted here. Nobody has to set up the server, and the keys stay on this business's own
 * server, encrypted.
 */
import { GOOGLE_ACCESS_FORM } from "@crewtavo/core/reviews";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import type { AppRow } from "./catalog";

const INTUIT_DEVELOPER = "https://developer.intuit.com/";
const GOOGLE_CLOUD = "https://console.cloud.google.com/";
/** The three APIs Google Business Profile's reviews need turned on in the project. */
const GOOGLE_APIS = [
  { name: "My Business Account Management API", href: "https://console.cloud.google.com/apis/library/mybusinessaccountmanagement.googleapis.com" },
  { name: "My Business Business Information API", href: "https://console.cloud.google.com/apis/library/mybusinessbusinessinformation.googleapis.com" },
  { name: "Google My Business API", href: "https://console.cloud.google.com/apis/library/mybusiness.googleapis.com" },
];
export const BUSINESS_SCOPE = "https://www.googleapis.com/auth/business.manage";

/** Zoho's data centers: an app made in one only signs in accounts there (registry.ts keeps the same list). */
const ZOHO_REGIONS = [
  { label: "United States", tld: "zoho.com" },
  { label: "Europe", tld: "zoho.eu" },
  { label: "United Kingdom", tld: "zoho.uk" },
  { label: "India", tld: "zoho.in" },
  { label: "Australia", tld: "zoho.com.au" },
  { label: "Japan", tld: "zoho.jp" },
  { label: "Canada", tld: "zohocloud.ca" },
  { label: "Saudi Arabia", tld: "zoho.sa" },
  { label: "China", tld: "zoho.com.cn" },
];
const accountsOf = (tld: string) => `https://accounts.${tld}`;
const regionOf = (accountsServer: string | null | undefined) => ZOHO_REGIONS.find((r) => accountsOf(r.tld) === accountsServer) ?? ZOHO_REGIONS[0]!;

/** One value to copy into the provider's form, with the name that form gives it. */
export function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="app-copy">
      <span>{label}</span>
      <code className="code-pill">{value}</code>
      <Button size="sm" icon="copy" aria-label={`Copy ${label}`} onClick={() => copyText(value, `${label} copied`)}>Copy</Button>
    </div>
  );
}

/**
 * `anchor` makes it the page's #app-setup; off when another card on the page already is (Google
 * Business Profile's Before you sign in, or its panel once installed).
 */
export function AppKeysCard({ app, onChanged, onConnect, connecting, anchor = true }: { app: AppRow; onChanged: () => void; onConnect: () => void; connecting: boolean; anchor?: boolean }) {
  const keys = app.app_keys ?? null;
  const setupId = anchor ? "app-setup" : undefined;
  const [editing, setEditing] = useState(false);
  const qbo = app.id === "quickbooks";
  const google = app.id === "google_business";
  const provider = qbo ? "Intuit" : google ? "Google" : "Zoho";
  const remove = useMutation({
    meta: { success: `${provider} app keys removed` },
    mutationFn: () => api.delete(`/apps/${app.id}/app-keys`),
    onSettled: onChanged,
  });
  const askRemove = async () => {
    const body = google
      ? `${app.name} is uninstalled, and installing it again uses this server's Google app, if it has one. The reviews already here stay.`
      : `${app.name} is uninstalled, and installing it again needs your ${provider} app's keys. Nothing already synced is deleted.`;
    if (await confirm({ title: `Remove your ${provider} app keys?`, body, confirmLabel: "Remove keys", danger: true })) remove.mutate();
  };

  if (keys && !editing) {
    const end = keys.client_id.slice(-4);
    return (
      <section id={setupId} className="card card-pad stack-sm" aria-labelledby="app-keys-title" style={{ gap: 8 }}>
        <h2 id="app-keys-title" className="section-title" style={{ fontSize: 16 }}>Your {provider} app</h2>
        <span className="muted small">
          Client ID ending in <strong>{end}</strong>
          {qbo ? (keys.sandbox ? " · Development keys, for a sandbox company" : " · Production keys") : google ? null : ` · ${regionOf(keys.accounts_server).label}`}
          . The secret is stored encrypted on your server and never shown again.
        </span>
        {app.status === "disconnected" && (
          <div className="callout" style={{ marginTop: 4 }}>
            <Icon name="info" size={20} />
            <div className="grow stack-sm" style={{ gap: 8 }}>
              <span>Last step: {google ? "sign in with Google and pick your location." : `sign in to ${app.name} and pick your company.`}</span>
              <Button variant="primary" style={{ justifySelf: "start" }} loading={connecting} onClick={onConnect}>{google ? "Sign in with Google" : `Sign in to ${app.name}`}</Button>
            </div>
          </div>
        )}
        <div className="row wrap" style={{ gap: 8 }}>
          <Button size="sm" onClick={() => setEditing(true)}>Change keys</Button>
          <Button size="sm" variant="ghost" loading={remove.isPending} onClick={askRemove}>Remove keys</Button>
        </div>
      </section>
    );
  }

  return (
    <section id={setupId} className="card card-pad stack" aria-labelledby="app-keys-title">
      <div className="stack-sm" style={{ gap: 4 }}>
        <h2 id="app-keys-title" className="section-title" style={{ fontSize: 16 }}>{keys ? `Change your ${provider} app keys` : `Set up ${app.name}`}</h2>
        <span className="muted small">
          {qbo
            ? "QuickBooks connects through an app you make at Intuit, for your business only. It's free, and these steps give you everything Intuit asks for."
            : google
              ? googleIntro(app)
              : "Zoho Books connects through an app you make in Zoho's API Console, for your business only. It's free and takes about five minutes."}
        </span>
      </div>
      {qbo ? <IntuitSteps app={app} /> : google ? <GoogleSteps app={app} /> : null}
      <KeysForm app={app} initial={keys} onSaved={() => { setEditing(false); onChanged(); }} onCancel={keys ? () => setEditing(false) : undefined} />
    </section>
  );
}

/**
 * Google Business Profile's own app: beside this server's when it has one (signed in with no keys of
 * the company's), otherwise the only way in, so it doesn't speak of a server's project there isn't.
 */
function googleIntro(app: AppRow): string {
  if (app.available && !app.app_keys) {
    return "Use your own Google Cloud project instead of this server's. It's free, but Google approves each project's access to reviews on its own, which takes about 2 weeks, even if this server's project is approved already.";
  }
  return "Google Business Profile connects through a Google Cloud project you make for your business. It's free, but Google approves each project's access to reviews first, which takes about 2 weeks.";
}

function IntuitSteps({ app }: { app: AppRow }) {
  const origin = app.redirect_uri ? new URL(app.redirect_uri).origin : window.location.origin;
  const page = `${origin}/apps/quickbooks`;
  return (
    <ol className="app-steps" style={{ gap: 14 }}>
      <li><div className="stack-sm" style={{ gap: 8 }}>
        <span>Sign in to Intuit Developer with your Intuit account, then create an app for <strong>QuickBooks Online</strong>. Name it Crewtavo and give it the <strong>Accounting</strong> permission.</span>
        <a className="btn btn-sm" style={{ justifySelf: "start" }} href={INTUIT_DEVELOPER} target="_blank" rel="noreferrer">Open Intuit Developer <Icon name="external" size={12} /></a>
      </div></li>
      <li><div className="stack-sm" style={{ gap: 8 }}>
        <span>In the app's <strong>production</strong> settings, fill in its details with these:</span>
        <CopyRow label="Host domain" value={new URL(origin).host} />
        <CopyRow label="Launch URL" value={page} />
        <CopyRow label="Disconnect URL" value={page} />
        <CopyRow label="Connect/Reconnect URL" value={page} />
        <CopyRow label="End-user license agreement URL" value={`${origin}/license`} />
        <span className="small">For <strong>Privacy policy URL</strong>, use your website's privacy page, or your website's address if it doesn't have one.</span>
      </div></li>
      <li><div className="stack-sm" style={{ gap: 8 }}>
        <span>Add this under <strong>Redirect URIs</strong> in the production settings:</span>
        {app.redirect_uri && <CopyRow label="Redirect URI" value={app.redirect_uri} />}
      </div></li>
      <li>Answer Intuit's <strong>app assessment questionnaire</strong>. Intuit asks it even of an app only your business uses, and your production keys unlock once it's reviewed, which can take a few days.</li>
      <li>Copy the production <strong>Client ID</strong> and <strong>Client Secret</strong> from <strong>Keys and credentials</strong>, and paste them below.</li>
    </ol>
  );
}

/** A Google Cloud project for the business's own Google app: Google's access request comes early, since it's the step that takes weeks. */
export function GoogleSteps({ app }: { app: AppRow }) {
  return (
    <ol className="app-steps" style={{ gap: 14 }}>
      <li><div className="stack-sm" style={{ gap: 8 }}>
        <span>In Google Cloud, create a project for Crewtavo, signed in with a Google account that manages your Business Profile.</span>
        <a className="btn btn-sm" style={{ justifySelf: "start" }} href={GOOGLE_CLOUD} target="_blank" rel="noreferrer">Open Google Cloud <Icon name="external" size={12} /></a>
      </div></li>
      <li><div className="stack-sm" style={{ gap: 8 }}>
        <span>
          Ask Google for access to the Business Profile APIs now: it takes about 2 weeks. Google's form asks for the project number (on the project's
          dashboard) and an email that manages your profile, which must have been verified for 60 days or more.
        </span>
        <a className="btn btn-sm" style={{ justifySelf: "start" }} href={GOOGLE_ACCESS_FORM} target="_blank" rel="noreferrer">Google's access request form <Icon name="external" size={12} /></a>
      </div></li>
      <li><div className="stack-sm" style={{ gap: 8 }}>
        <span>Turn on these three APIs in the project:</span>
        <ul className="app-access">{GOOGLE_APIS.map((a) => <li key={a.name}><a href={a.href} target="_blank" rel="noreferrer">{a.name} <Icon name="external" size={12} /></a></li>)}</ul>
      </div></li>
      <li><div className="stack-sm" style={{ gap: 8 }}>
        <span>Under <strong>Google Auth Platform</strong>, set up the consent screen as <strong>External</strong>, add this scope under <strong>Data access</strong>, and publish the app so it says <strong>In production</strong>. An app left in Testing signs out after 7 days.</span>
        <CopyRow label="Scope" value={BUSINESS_SCOPE} />
        <span className="small">Google shows an "unverified app" screen at sign-in until it reviews the app. That's fine for your own business: click <strong>Advanced</strong>, then continue.</span>
      </div></li>
      <li><div className="stack-sm" style={{ gap: 8 }}>
        <span>Under <strong>Clients</strong>, create an OAuth client of type <strong>Web application</strong> with this redirect URI:</span>
        {app.redirect_uri && <CopyRow label="Authorized redirect URI" value={app.redirect_uri} />}
      </div></li>
      <li>Copy the <strong>Client ID</strong> and <strong>Client secret</strong> Google shows, and paste them below.</li>
    </ol>
  );
}

function KeysForm({ app, initial, onSaved, onCancel }: { app: AppRow; initial: NonNullable<AppRow["app_keys"]> | null; onSaved: () => void; onCancel?: () => void }) {
  const qbo = app.id === "quickbooks";
  const zohoBooks = app.id === "zoho_books";
  const [clientId, setClientId] = useState(initial?.client_id ?? "");
  const [secret, setSecret] = useState("");
  const [show, setShow] = useState(false);
  const [sandbox, setSandbox] = useState(initial?.sandbox ?? false);
  const [region, setRegion] = useState(regionOf(initial?.accounts_server).tld);
  const zoho = ZOHO_REGIONS.find((r) => r.tld === region)!;
  const origin = app.redirect_uri ? new URL(app.redirect_uri).origin : window.location.origin;
  const save = useMutation({
    meta: { inline: true, success: `${qbo ? "Intuit" : zohoBooks ? "Zoho" : "Google"} app keys saved` },
    mutationFn: () => api.put(`/apps/${app.id}/app-keys`, { client_id: clientId.trim(), client_secret: secret.trim(), ...(qbo ? { sandbox } : zohoBooks ? { accounts_server: accountsOf(region) } : {}) }),
    onSuccess: () => {
      setSecret("");
      onSaved();
    },
  });
  const ready = clientId.trim().length >= 8 && secret.trim().length >= 8;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    // Tokens belong to the app that issued them, so new keys sign out of the old app.
    if (app.status !== "disconnected" && !(await confirm({ title: `Use these keys instead?`, body: `${app.name} signs out, and you sign in again with the new app. Nothing already synced is deleted.`, confirmLabel: "Use new keys" }))) return;
    save.mutate();
  };

  return (
    <form className="stack" onSubmit={submit}>
      {zohoBooks && (
        <ol className="app-steps" style={{ gap: 14 }}>
          <li><div className="stack-sm" style={{ gap: 8 }}>
            <span>Pick where your Zoho account is. When you're in Zoho Books, the address shows it: <strong>books.zoho.eu</strong> is Europe.</span>
            <select className="select" style={{ maxWidth: 260 }} value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Where your Zoho account is">
              {ZOHO_REGIONS.map((r) => <option key={r.tld} value={r.tld}>{r.label} (books.{r.tld})</option>)}
            </select>
          </div></li>
          <li><div className="stack-sm" style={{ gap: 8 }}>
            <span>Open Zoho's API Console, click <strong>Add Client</strong> (or <strong>Get Started</strong>) and choose <strong>Server-based Applications</strong>.</span>
            <a className="btn btn-sm" style={{ justifySelf: "start" }} href={`https://api-console.${zoho.tld}/`} target="_blank" rel="noreferrer">Open Zoho API Console <Icon name="external" size={12} /></a>
          </div></li>
          <li><div className="stack-sm" style={{ gap: 8 }}>
            <span>Fill it in with these, then click <strong>Create</strong>:</span>
            <CopyRow label="Client Name" value="Crewtavo" />
            <CopyRow label="Homepage URL" value={origin} />
            {app.redirect_uri && <CopyRow label="Authorized Redirect URIs" value={app.redirect_uri} />}
          </div></li>
          <li>Copy the <strong>Client ID</strong> and <strong>Client Secret</strong> Zoho shows, and paste them below.</li>
        </ol>
      )}
      <Field label="Client ID">
        <input className="input" autoComplete="off" spellCheck={false} value={clientId} onChange={(e) => { setClientId(e.target.value); save.reset(); }} />
      </Field>
      <Field label="Client Secret" hint={initial ? "Paste the secret again, even if only the Client ID changed." : undefined}>
        <div className="input-group">
          <input className="input" type={show ? "text" : "password"} autoComplete="off" spellCheck={false} value={secret} onChange={(e) => { setSecret(e.target.value); save.reset(); }} style={{ paddingLeft: 12, paddingRight: 36 }} />
          <button type="button" className="icon-btn addon-right" style={{ position: "absolute", right: 2, pointerEvents: "auto" }} aria-label={show ? "Hide secret" : "Show secret"} onClick={() => setShow(!show)}><Icon name={show ? "eye" : "lock"} size={14} /></button>
        </div>
      </Field>
      {qbo && (
        <label className="checkbox">
          <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} />
          <span>
            These are development keys
            <span className="muted small" style={{ display: "block", fontWeight: 400 }}>They work right away, but only with a QuickBooks sandbox company, so they're for trying it out. Add the Redirect URI to the development settings too.</span>
          </span>
        </label>
      )}
      <FormError error={save.error} />
      <div className="row wrap" style={{ gap: 8 }}>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>Save keys</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}
