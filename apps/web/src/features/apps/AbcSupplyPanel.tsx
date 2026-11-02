/**
 * ABC Supply on its app page: step by step to make the business's own app in ABC's developer
 * portal, its Client ID and secret pasted here (checked with ABC before they're kept), then which
 * account and branch prices come from, and a search to look up a price. Connecting adds Roofing →
 * Catalog, which this page points to.
 */
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { CATALOG } from "../materials/data";
import { MaterialSearch } from "../materials/MaterialSearch";
import type { AppRow, SupplierSettings } from "./catalog";

const ABC_PORTAL = "https://partners-developer.abcsupply.com/";
const MY_ABC = "https://www.myabcsupply.com/";
/** ABC's form wants a redirect address even for apps that never sign anyone in; it fills in this one, which its guide suggests. */
const PLACEHOLDER_REDIRECT = "https://localhost:4000";

export function AbcSupplyPanel({ app, onChanged }: { app: AppRow; onChanged: () => void }) {
  const supplier = app.supplier ?? null;
  const [changing, setChanging] = useState(false);
  if (supplier && app.status !== "disconnected" && !changing) {
    return (
      <>
        <AccountCard app={app} supplier={supplier} onChanged={onChanged} onChangeKeys={() => setChanging(true)} />
        <section className="card card-pad stack-sm" aria-labelledby="abc-catalog" style={{ gap: 10 }}>
          <div className="row wrap" style={{ gap: 10 }}>
            <h2 id="abc-catalog" className="section-title grow" style={{ fontSize: 16 }}>Your catalog</h2>
            <Link className="btn btn-sm" to={CATALOG}>Open the Catalog</Link>
          </div>
          <span className="muted small">
            Roofing now has a Catalog: ABC's items at {supplier.branch_name} with your price on each, what your account buys most, every color and size, and your materials checked with ABC in one tap.
            Or look up a price for one of each here.
          </span>
          <MaterialSearch />
        </section>
      </>
    );
  }
  return (
    <section id="app-setup" className="card card-pad stack" aria-labelledby="abc-setup-title">
      <div className="stack-sm" style={{ gap: 4 }}>
        <h2 id="abc-setup-title" className="section-title" style={{ fontSize: 16 }}>{changing ? "Change your ABC Supply app" : "Connect your ABC Supply account"}</h2>
        <span className="muted small">
          ABC Supply gives your prices to an app you make in its developer portal, for your company only. It's free and takes about ten minutes, plus a business day or two for ABC to switch on your real prices.
          Once it's connected, Roofing gets a Catalog: ABC's items at your branch with your prices, what you buy most up front, and your materials kept current.
        </span>
      </div>
      <div className="callout" role="note">
        <Icon name="info" size={20} />
        <span className="grow" style={{ fontWeight: 400 }}>
          <strong>Before you start:</strong> have your ABC account number (top left in <a href={MY_ABC} target="_blank" rel="noreferrer">myABCSupply</a>, or on any ABC invoice) and a myABCSupply login that can see that account. No login yet? Sign up at myABCSupply or ask your branch.
        </span>
      </div>
      <ol className="app-steps" style={{ gap: 14 }}>
        <li><div className="stack-sm" style={{ gap: 8 }}>
          <span>
            Open ABC's developer portal and sign up with a work email you'll keep (ABC writes to it about your app). Confirm the email and set a password. When ABC asks for a <strong>Developer Organization</strong>, give it your company's name and click <strong>Complete ABC API Developer Account</strong>.
          </span>
          <a className="btn btn-sm" style={{ justifySelf: "start" }} href={ABC_PORTAL} target="_blank" rel="noreferrer">Open ABC's developer portal <Icon name="external" size={12} /></a>
        </div></li>
        <li><div className="stack-sm" style={{ gap: 8 }}>
          <span>Click <strong>Create New App</strong> and fill it in with these:</span>
          <CopyRow label="Application Name" value="Crewtavo" />
          <div className="app-copy"><span>Used by multiple ABC customers?</span><strong>No</strong><span /></div>
          <span className="small muted">That's ABC's question "Do you plan to integrate our APIs into a product or platform that will be used by multiple ABC customers?" The app is for your company only.</span>
          <CopyRow label="OAuth 2.0 Redirect URIs" value={PLACEHOLDER_REDIRECT} />
          <span className="small muted">ABC fills this in already: leave it as it is. Crewtavo doesn't use it, but ABC's form needs one. Description and Application URL can stay empty.</span>
          <span>Then click <strong>Create App</strong>. ABC sets it up in its sandbox, with test prices, right away.</span>
        </div></li>
        <li>Under <strong>Manage Applications</strong>, click <strong>Manage</strong> next to the app and copy its <strong>Client ID</strong> and <strong>Client Secret</strong>. Keep them private, like a password. Paste them below with <strong>Sandbox</strong> ticked and click <strong>Connect</strong> to try it with ABC's test prices.</li>
        <li><div className="stack-sm" style={{ gap: 8 }}>
          <span>
            For your real prices, click <strong>Manage</strong> next to the app again, then <strong>Production Request</strong>. Give ABC your myABCSupply email and your account number and click <strong>Continue</strong>. ABC usually approves it in a business day or two.
          </span>
        </div></li>
        <li>Once ABC approves it, come back to this page, click <strong>Change keys</strong>, and paste the app's keys again with <strong>Sandbox</strong> unticked. Your estimates then use your real prices.</li>
      </ol>
      <KeysForm sandboxFirst={!supplier} onSaved={() => { setChanging(false); onChanged(); }} onCancel={changing ? () => setChanging(false) : undefined} />
    </section>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="app-copy">
      <span>{label}</span>
      <code className="code-pill">{value}</code>
      <Button size="sm" icon="copy" aria-label={`Copy ${label}`} onClick={() => copyText(value, `${label} copied`)}>Copy</Button>
    </div>
  );
}

function KeysForm({ sandboxFirst, onSaved, onCancel }: { sandboxFirst: boolean; onSaved: () => void; onCancel?: () => void }) {
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [show, setShow] = useState(false);
  const [sandbox, setSandbox] = useState(sandboxFirst);
  const save = useMutation({
    meta: { inline: true, success: "ABC Supply connected" },
    mutationFn: () => api.put("/apps/abc_supply/keys", { client_id: clientId.trim(), client_secret: secret.trim(), sandbox }),
    onSuccess: () => {
      setSecret("");
      onSaved();
    },
  });
  const ready = clientId.trim().length >= 8 && secret.trim().length >= 8;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) save.mutate();
  };
  return (
    <form className="stack" onSubmit={submit}>
      <Field label="Client ID">
        <input className="input" autoComplete="off" spellCheck={false} value={clientId} onChange={(e) => { setClientId(e.target.value); save.reset(); }} />
      </Field>
      <Field label="Client Secret">
        <div className="input-group">
          <input className="input" type={show ? "text" : "password"} autoComplete="off" spellCheck={false} value={secret} onChange={(e) => { setSecret(e.target.value); save.reset(); }} style={{ paddingLeft: 12, paddingRight: 36 }} />
          <button type="button" className="icon-btn addon-right" style={{ position: "absolute", right: 2, pointerEvents: "auto" }} aria-label={show ? "Hide secret" : "Show secret"} onClick={() => setShow(!show)}><Icon name={show ? "eye" : "lock"} size={14} /></button>
        </div>
      </Field>
      <label className="checkbox">
        <input type="checkbox" checked={sandbox} onChange={(e) => { setSandbox(e.target.checked); save.reset(); }} />
        <span>
          Sandbox
          <span className="muted small" style={{ display: "block", fontWeight: 400 }}>ABC's test accounts and prices, which work as soon as the app is made. Untick it once ABC approves your Production Request.</span>
        </span>
      </label>
      <FormError error={save.error} />
      <div className="row wrap" style={{ gap: 8 }}>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>Connect</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
      <span className="muted small">Crewtavo checks the keys with ABC before keeping them, then keeps them encrypted on your server. It only reads your account, ABC's catalog and your prices: it can't order anything.</span>
    </form>
  );
}

/** Which account and branch prices come from, and the keys behind them. */
function AccountCard({ app, supplier, onChanged, onChangeKeys }: { app: AppRow; supplier: SupplierSettings; onChanged: () => void; onChangeKeys: () => void }) {
  const [shipTo, setShipTo] = useState(supplier.ship_to);
  const account = supplier.accounts.find((a) => a.number === shipTo) ?? supplier.accounts[0];
  const [branch, setBranch] = useState(supplier.branch);
  const branchNow = account?.branches.some((b) => b.number === branch) ? branch : (account?.branches.find((b) => b.home) ?? account?.branches[0])?.number ?? "";
  const choose = useMutation({
    meta: { inline: true, success: "Prices now come from there" },
    mutationFn: () => api.put("/apps/abc_supply/account", { ship_to: shipTo, branch: branchNow }),
    onSuccess: onChanged,
  });
  const changed = shipTo !== supplier.ship_to || branchNow !== supplier.branch;
  return (
    <section className="card card-pad stack-sm" aria-labelledby="abc-account" style={{ gap: 12 }}>
      <h2 id="abc-account" className="section-title" style={{ fontSize: 16 }}>Where prices come from</h2>
      {supplier.environment === "sandbox" && (
        <div className="callout callout-warning" role="status">
          <Icon name="info" size={20} />
          <span className="grow">These are ABC's sandbox test prices, not yours. Once ABC approves your Production Request, change the keys and untick Sandbox.</span>
        </div>
      )}
      {app.status === "error" && app.last_error && <span className="field-error" role="alert">{app.last_error}</span>}
      <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
        <Field label="ABC account">
          <select className="select" value={shipTo} onChange={(e) => { setShipTo(e.target.value); choose.reset(); }}>
            {supplier.accounts.map((a) => <option key={a.number} value={a.number}>{a.name} ({a.number}{a.city ? `, ${a.city}` : ""})</option>)}
          </select>
        </Field>
        <Field label="Branch">
          <select className="select" value={branchNow} onChange={(e) => { setBranch(e.target.value); choose.reset(); }}>
            {(account?.branches ?? []).map((b) => <option key={b.number} value={b.number}>{b.name}{b.home ? " (home branch)" : ""}</option>)}
          </select>
        </Field>
        {changed && <Button variant="primary" loading={choose.isPending} onClick={() => choose.mutate()}>Use these</Button>}
      </div>
      <FormError error={choose.error} />
      <span className="muted small">Each branch sets its own prices. Estimates are priced at {supplier.branch_name}{supplier.environment === "sandbox" ? ", in ABC's sandbox" : ""}.</span>
      <div className="row wrap" style={{ gap: 8 }}>
        <Button size="sm" onClick={onChangeKeys}>Change keys</Button>
      </div>
    </section>
  );
}
