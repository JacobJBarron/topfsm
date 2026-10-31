/**
 * One app's page, laid out like an app store listing. Before it's installed: its icon, name and
 * Install, a strip of facts, screenshots, what it does and what Crewtavo can see and do in it.
 * Install turns it on or signs in right away, or opens its setup (a key, a calendar link, the
 * connector link) under the name. Once it's installed: Open and Uninstall, then managing it
 * (calendars, sign-in, keys) before the rest of the listing.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { BackLink, useDocumentTitle } from "@/components/ui/PageHeader";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { api, supabase } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useDriveSwitch } from "../drive/useDriveSwitch";
import { useMarketingSwitch } from "../marketing/useMarketingSwitch";
import { CalendarFeedCard } from "../settings/CalendarFeedCard";
import { AbcSupplyPanel } from "./AbcSupplyPanel";
import { AnalyticsPanel, useAnalyticsSwitch } from "./AnalyticsPanel";
import { AppIcon, AppTile } from "./AppIcon";
import { AppKeysCard } from "./AppKeysCard";
import { AssistantAccess, ConnectedAssistants, useAssistantConnections } from "./AssistantAccess";
import { assistantAppFor, CONNECTOR_STEPS, disconnect as disconnectAssistant } from "./assistantConnections";
import { CalendarRow, GoogleCalendarPanel, LinkCalendarsPanel, AddCalendarForm, useCalendars, type CalendarSource } from "./CalendarPanels";
import { categoryName, infoFor, LINK_ACCESS, MORE_LABELS, useApps, type AppInfo, type AppRow } from "./catalog";
import { DrivePanel } from "./DrivePanel";
import { InstallRing, type InstallPhase } from "./InstallRing";
import { useIsInstalled } from "./installed";
import { MarketingPanel } from "./MarketingPanel";
import { SCREENSHOTS } from "./screenshots";
import { StripePanel } from "./StripePanel";
import { TeamChatPanel, useTeamChatSwitch } from "./TeamChatPanel";
import { WebsiteFormsPanel, useWebsiteFormsSwitch } from "./WebsiteFormsPanel";
import { WebsitePanel } from "./WebsitePanel";

const GOOGLE_SETTINGS = "https://calendar.google.com/calendar/r/settings";
// fal.ai: where a key is made, and where credit is added.
const FAL_KEYS = "https://fal.ai/dashboard/keys";
const FAL_BILLING = "https://fal.ai/dashboard/billing";
const GOOGLE_SIGNIN_GUIDE = "https://crewtavo.com/docs/connections/google-calendar/#instant-updates-with-google-sign-in";

/**
 * What Crewtavo's Stripe key may do: add its webhook, customers and invoices (with their items),
 * and read payments, fees, deposits and the account's name. Stripe's create-key form sets these
 * from its link (each name is a row there; balance transactions come under Balance). Stripe doesn't
 * document that, so if it stops, people still land on the form.
 */
const STRIPE_KEY_PERMISSIONS = ["webhook_write", "customer_write", "invoice_write", "charge_read", "balance_read", "balance_transaction_source_read", "payout_read", "connected_account_read"];
const STRIPE_NEW_KEY = `https://dashboard.stripe.com/apikeys/create?name=Crewtavo&${STRIPE_KEY_PERMISSIONS.map((p) => `permissions%5B%5D=rak_${p}`).join("&")}`;

/** Google Calendar on a server without Google sign-in: it works by secret address, like the link apps. */
const byLinkOnly = (app: AppRow) => app.id === "google_calendar" && !app.available;

/**
 * QuickBooks and Zoho Books sign in with the business's own app at Intuit or Zoho. Install shows its
 * keys first when the server has no app of its own, or when the business saved some (to change them).
 */
const keysFirst = (app: AppRow) => Boolean(app.takes_app_keys && (!app.available || app.app_keys));

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function statusOf(app: AppRow, installed: boolean): { label: string; tone: Tone } {
  if (app.status === "error" || app.calendar_errors) return { label: "Needs attention", tone: "danger" };
  if (installed) return app.calendars ? { label: plural(app.calendars, "calendar"), tone: "good" } : { label: "Installed", tone: "good" };
  if (!app.available && !byLinkOnly(app) && !app.takes_app_keys) return { label: "Not available yet", tone: "muted" };
  return { label: "Not installed", tone: "muted" };
}

/** Signed in or a key added: what /apps/:id/disconnect takes away. Stripe set up for the server isn't the company's to remove. */
const hasAccount = (app: AppRow) =>
  (app.auth === "oauth" || app.auth === "api_key") && app.status !== "disconnected" && !(app.id === "stripe" && !app.stripe?.own);

/** Where Open goes: a page in Crewtavo, or the app itself. */
const openTarget = (app: AppRow, info: AppInfo) => (app.id === "stripe" && !app.stripe?.own ? "/payouts" : (info.open ?? info.website));

export function AppDetailPage() {
  const { id = "" } = useParams();
  const apps = useApps();
  const app = apps.data?.apps.find((a) => a.id === id);
  useDocumentTitle(app?.name ?? "Apps");

  if (!apps.allowed) return <NoAccess title="Apps" />;
  if (apps.error) return <><BackLink to="/apps">Apps</BackLink><div className="card"><ErrorState error={apps.error} onRetry={() => apps.refetch()} /></div></>;
  if (apps.isPending) {
    return (
      <Loading label="Loading app">
        <BackLink to="/apps">Apps</BackLink>
        <div className="app-hero">
          <Skeleton width={112} height={112} radius={26} />
          <div className="stack-sm grow"><Skeleton width={220} height={28} /><Skeleton width={280} height={14} /><Skeleton width={120} height={36} radius={999} /></div>
        </div>
      </Loading>
    );
  }
  if (!app) {
    return (
      <>
        <BackLink to="/apps">Apps</BackLink>
        <div className="card"><EmptyState icon="apps" title="That app isn't here" action={<Link className="btn" to="/apps">See all apps</Link>}>It may have been renamed or removed.</EmptyState></div>
      </>
    );
  }
  return <AppListing key={app.id} app={app} all={apps.data!.apps} mcpUrl={apps.data!.mcp_url} />;
}

function AppListing({ app, all, mcpUrl }: { app: AppRow; all: AppRow[]; mcpUrl: string }) {
  const info = infoFor(app);
  const session = useSession();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { isInstalled, connections } = useIsInstalled();
  const installed = isInstalled(app);
  const calendars = useCalendars(app.category === "Calendar");
  // Install pressed: installing right away ("working"), or waiting on the setup below for a key, a
  // calendar link or the connector link ("waiting"); then the ring fills ("done") and Uninstall shows.
  // Back from signing in to it: the ring finishes filling there too.
  const [phase, setPhase] = useState<InstallPhase | null>(() => (params.get("status") === "connected" ? "done" : null));
  const started = useRef(0);
  const setup = phase === "waiting";
  const refresh = () => {
    for (const key of ["apps", "calendars", "google-calendars"]) queryClient.invalidateQueries({ queryKey: [key] });
    // The company's own Anthropic key turns on Ask and the other AI buttons, a fal.ai key Find paving
    // on the measuring map (lib/session.tsx), and the website's editor puts Website in the menu.
    if (app.id === "anthropic" || app.id === "fal" || app.auth === "site") session.refresh();
  };
  const connect = useMutation({
    mutationFn: () => api.post<{ authorization_url: string }>(`/apps/${app.id}/connect`),
    onSuccess: (res) => window.location.assign(res.authorization_url), // the provider sends the person back to this page
  });
  const chatSwitch = useTeamChatSwitch();
  const analyticsSwitch = useAnalyticsSwitch();
  const formsSwitch = useWebsiteFormsSwitch();
  const careersSwitch = useWebsiteFormsSwitch("careers");
  const driveSwitch = useDriveSwitch();
  const marketingSwitch = useMarketingSwitch();
  // Built-in apps turn on and off in the company's settings.
  const builtinSwitch =
    app.id === "website_analytics" ? analyticsSwitch
    : app.id === "website_forms" ? formsSwitch
    : app.id === "careers" ? careersSwitch
    : app.id === "drive" ? driveSwitch
    : app.id === "marketing" ? marketingSwitch
    : chatSwitch;

  // Uninstall takes this app's own assistants and calendars with it.
  const assistants = connections.filter((c) => assistantAppFor(c.name) === app.id);
  const sources = (calendars.data?.calendars ?? []).filter((s) => s.app === app.id);
  const uninstall = useMutation({
    meta: { success: `${app.name} uninstalled` },
    mutationFn: async () => {
      for (const c of assistants) await disconnectAssistant(supabase(), c.clientId);
      // Google's own calendars go with its sign-in; the ones added by address are removed here.
      if (hasAccount(app)) await api.post(`/apps/${app.id}/disconnect`);
      if (app.auth === "site") await api.delete(`/apps/${app.id}/site`);
      await Promise.all(sources.filter((s) => s.kind !== "google").map((s) => api.delete(`/calendars/${s.id}`)));
    },
    onSuccess: () => setPhase(null),
    onSettled: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["assistant-connections"] });
      queryClient.invalidateQueries({ queryKey: ["schedule"] });
    },
  });
  const canUninstall = installed && (app.auth === "builtin" || app.auth === "site" || hasAccount(app) || assistants.length > 0 || sources.length > 0);

  const askUninstall = async () => {
    if (app.auth === "builtin") return builtinSwitch.turnOff();
    const body = uninstallBody(app, { assistants: assistants.length, calendars: sources.length });
    if (await confirm({ title: `Uninstall ${app.name}?`, body, confirmLabel: "Uninstall", danger: true })) uninstall.mutate();
  };

  const install = () => {
    started.current = Date.now();
    const failed = { onError: () => setPhase(null) };
    if (app.auth === "builtin") {
      setPhase("working");
      return builtinSwitch.toggle.mutate(true, failed);
    }
    // Signing in is the setup; Google also offers adding a calendar by its address instead.
    if (app.auth === "oauth" && app.available && app.id !== "google_calendar" && !keysFirst(app)) {
      setPhase("working");
      return connect.mutate(undefined, failed);
    }
    setPhase("waiting");
  };
  useEffect(() => {
    if (setup) document.getElementById("app-install")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }, [setup]);
  // Installed: the ring fills, held long enough to be seen when installing was quick, then Uninstall.
  useEffect(() => {
    if (phase === "done") {
      const finish = setTimeout(() => setPhase(null), 650);
      return () => clearTimeout(finish);
    }
    if (!phase) return;
    if (installed) {
      const fill = setTimeout(() => setPhase("done"), Math.max(0, started.current + 900 - Date.now()));
      return () => clearTimeout(fill);
    }
    // Installing that never shows up as installed (the page couldn't refresh) gives Install back.
    if (phase === "working") {
      const giveUp = setTimeout(() => setPhase(null), 20_000);
      return () => clearTimeout(giveUp);
    }
  }, [phase, installed]);

  const status = statusOf(app, installed);
  const callback = params.get("status") ? { ok: params.get("status") === "connected", message: params.get("message") } : null;
  const unavailable = !app.available && !byLinkOnly(app) && !app.takes_app_keys;
  const needsReconnect = app.auth === "oauth" && app.status === "error" && app.available;
  const open = openTarget(app, info);

  // The buttons next to the name: Install, which turns into its progress ring and then Uninstall,
  // like an app store's; and once it's installed, Open (or Reconnect when it needs it).
  let actions: ReactNode;
  if (phase) {
    actions = <InstallRing phase={phase} name={app.name} onStop={() => setPhase(null)} />;
  } else if (installed) {
    actions = (
      <>
        {canUninstall && (
          <Button className="app-get" variant="danger-solid" loading={uninstall.isPending || builtinSwitch.toggle.isPending} onClick={askUninstall}>Uninstall</Button>
        )}
        {needsReconnect ? (
          <Button className="app-get" variant="primary" icon="refresh" loading={connect.isPending} onClick={() => connect.mutate()}>Reconnect</Button>
        ) : open.startsWith("/") ? (
          <Link className="btn app-get" to={open}>Open</Link>
        ) : (
          <a className="btn app-get" href={open} target="_blank" rel="noreferrer">Open <Icon name="external" size={14} /></a>
        )}
      </>
    );
  } else if (unavailable) {
    actions = <Button className="app-get" disabled>Install</Button>;
  } else {
    actions = <Button className="app-get" variant="primary" onClick={install}>Install</Button>;
  }

  const others = all.filter((a) => a.category === app.category && a.id !== app.id);
  const googleSources = sources.filter((s) => s.app === "google_calendar" && s.kind !== "google");
  const access = byLinkOnly(app) ? LINK_ACCESS : info.access;
  const connectsWith = byLinkOnly(app) ? "Secret address (ICS)" : info.connectsWith;
  const shots = SCREENSHOTS[app.id] ?? [];

  // Google, signed in or not: adding a calendar by its secret address instead.
  const googleByAddress = (
    <details className="card card-pad app-details" open={googleSources.length > 0 || undefined}>
      <summary>Or add a calendar by its secret address</summary>
      <div className="stack" style={{ marginTop: 12 }}>
        <span className="muted small">Works without signing in, and only shows that calendar on your schedule. For visits in Google without signing in, use <Link to="/settings?tab=calendars">Settings → Calendars</Link>.</span>
        {googleSources.map((s) => <CalendarRow key={s.id} source={s} />)}
        <span id="google_calendar-add" />
        <AddCalendarForm app="google_calendar" appName="Google" steps={info.steps} addOnPaste />
      </div>
    </details>
  );
  const googleSignIn = (
    <section className="card card-pad stack-sm" aria-labelledby="google-sign-in" style={{ gap: 10 }}>
      <h2 id="google-sign-in" className="section-title" style={{ fontSize: 16 }}>Sign in with Google</h2>
      <span className="muted small">Pick which of your calendars show on the schedule, and put visits on a Google calendar that stays up to date.</span>
      <Button variant="primary" style={{ justifySelf: "start" }} loading={connect.isPending} onClick={() => connect.mutate()}>Sign in with Google</Button>
    </section>
  );

  return (
    <>
      <BackLink to="/apps">Apps</BackLink>

      <header className="app-hero">
        <AppIcon id={app.id} name={app.name} size="lg" />
        <div className="app-hero-text">
          <h1 className="app-hero-name">{app.name}</h1>
          <p className="app-hero-tagline">{info.tagline}</p>
          <div className="app-hero-actions">
            {actions}
            {((installed && !phase) || unavailable) && <StatusPill label={status.label} tone={status.tone} />}
            {installed && app.id === "stripe" && !app.stripe?.own && <span className="muted small">Set up for this server</span>}
          </div>
        </div>
      </header>

      <dl className="app-facts" aria-label="About this app">
        <div><dt>Category</dt><dd>{categoryName(app.category)}</dd></div>
        <div><dt>Made by</dt><dd>{info.developer}</dd></div>
        {connectsWith && <div><dt>Connects with</dt><dd>{connectsWith}</dd></div>}
        <div><dt>Status</dt><dd>{status.label}</dd></div>
      </dl>

      {callback && (
        <div className={`callout ${callback.ok ? "callout-good" : "callout-warning"}`} role={callback.ok ? "status" : "alert"}>
          <Icon name={callback.ok ? "check" : "alert"} size={20} />
          <div className="grow">
            {callback.ok ? `${app.name} is installed.` : (callback.message ?? `${app.name} couldn't be installed. Try again.`)}
            {callback.ok && <span style={{ display: "block", fontWeight: 400 }}>{app.id === "google_calendar" ? "Now pick the calendars to show on your schedule." : app.category === "Accounting" ? "New invoices and payments will sync automatically." : null}</span>}
          </div>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setParams({}, { replace: true })}><Icon name="x" size={16} /></button>
        </div>
      )}

      {/* ---- Installing it ---- */}
      {!installed && unavailable && <NotAvailable app={app} />}
      {!installed && setup && !unavailable && (
        <div id="app-install" className="stack" style={{ scrollMarginTop: 16 }}>
          {byLinkOnly(app) ? (
            <GoogleBySecretAddress app={app} sources={googleSources} />
          ) : keysFirst(app) ? (
            <AppKeysCard app={app} onChanged={refresh} onConnect={() => connect.mutate()} connecting={connect.isPending} />
          ) : app.id === "google_calendar" ? (
            <>{googleSignIn}{googleByAddress}</>
          ) : app.auth === "link" ? (
            <LinkCalendarsPanel app={app.id} appName={app.name} steps={info.steps} />
          ) : app.auth === "site" ? (
            <WebsitePanel app={app} onSaved={refresh} />
          ) : app.id === "abc_supply" ? (
            <AbcSupplyPanel app={app} onChanged={refresh} />
          ) : app.auth === "connector" || app.id === "anthropic" ? (
            <>
              <ConnectorCard app={app} mcpUrl={mcpUrl} setup />
              {app.id === "anthropic" && <KeyCard app={app} onSaved={refresh} />}
            </>
          ) : (
            <KeyCard app={app} onSaved={refresh} />
          )}
        </div>
      )}

      {/* ---- Managing it ---- */}
      {installed && (
        <>
          {byLinkOnly(app) && <GoogleBySecretAddress app={app} sources={googleSources} />}
          {app.auth === "oauth" && app.available && (app.status === "disconnected" ? app.id === "google_calendar" && googleSignIn : <AccountCard app={app} />)}
          {app.app_keys && <AppKeysCard app={app} onChanged={refresh} onConnect={() => connect.mutate()} connecting={connect.isPending} />}
          {app.id === "google_calendar" && app.status === "connected" && <GoogleCalendarPanel />}
          {app.id === "google_calendar" && app.available && googleByAddress}
          {app.auth === "link" && <LinkCalendarsPanel app={app.id} appName={app.name} steps={info.steps} />}
          {(app.auth === "connector" || app.id === "anthropic") && <ConnectorCard app={app} mcpUrl={mcpUrl} />}
          {app.id === "stripe" && app.stripe && <StripePanel app={app} onChanged={refresh} />}
          {app.auth === "api_key" && app.id !== "abc_supply" && <KeyCard app={app} onSaved={refresh} />}
          {app.id === "abc_supply" && <AbcSupplyPanel app={app} onChanged={refresh} />}
          {app.id === "website_analytics" && <AnalyticsPanel />}
          {app.id === "website_forms" && <WebsiteFormsPanel />}
          {app.id === "careers" && <WebsiteFormsPanel kind="careers" />}
          {app.id === "drive" && <DrivePanel />}
          {app.id === "marketing" && <MarketingPanel />}
          {app.id === "team_chat" && <TeamChatPanel />}
          {app.auth === "site" && <WebsitePanel app={app} onSaved={refresh} />}
        </>
      )}

      {shots.length > 0 && (
        <section aria-label="Screenshots" className="app-shots">
          {shots.map((shot) => (
            <figure key={shot.light}>
              <img className="app-shot-light" src={shot.light} alt={shot.alt} loading="lazy" />
              <img className="app-shot-dark" src={shot.dark} alt={shot.alt} loading="lazy" />
            </figure>
          ))}
        </section>
      )}

      {/* ---- What it does ---- */}
      {info.highlights.length > 0 && (
        <section aria-labelledby="app-highlights" className="stack-sm" style={{ gap: 12 }}>
          <h2 id="app-highlights" className="section-title">What it does</h2>
          <div className="app-highlights">
            {info.highlights.map((h) => (
              <div key={h.title} className="app-highlight">
                <span className="app-highlight-icon"><Icon name={h.icon} size={20} /></span>
                <strong>{h.title}</strong>
                <span className="muted small">{h.text}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="app-about" className="stack-sm" style={{ gap: 8 }}>
        <h2 id="app-about" className="section-title">About</h2>
        <p className="app-about">{info.about}</p>
      </section>

      <section aria-labelledby="app-info" className="stack-sm" style={{ gap: 8 }}>
        <h2 id="app-info" className="section-title">Information</h2>
        <dl className="card app-info">
          <div><dt>Made by</dt><dd>{info.developer}</dd></div>
          <div><dt>Category</dt><dd>{categoryName(app.category)}</dd></div>
          {connectsWith && <div><dt>Connects with</dt><dd>{connectsWith}</dd></div>}
          {access.length > 0 && (
            <div>
              <dt>Crewtavo can</dt>
              <dd><ul className="app-access">{access.map((a) => <li key={a}>{a}</li>)}</ul></dd>
            </div>
          )}
          <div><dt>Who can change it</dt><dd>Owners and admins of {session.company.name}</dd></div>
          <div><dt>Website</dt><dd><a href={info.website} target="_blank" rel="noreferrer">{new URL(info.website).hostname.replace(/^www\./, "")} <Icon name="external" size={12} /></a></dd></div>
        </dl>
      </section>

      {others.length > 0 && (
        <section aria-labelledby="app-more" className="stack-sm" style={{ gap: 12 }}>
          <h2 id="app-more" className="section-title">{MORE_LABELS[app.category] ?? "More apps"}</h2>
          <div className="app-grid">{others.map((a) => <AppTile key={a.id} app={a} installed={isInstalled(a)} />)}</div>
        </section>
      )}
    </>
  );
}

/** What Uninstall takes away, in the words of each kind of app. */
function uninstallBody(app: AppRow, counts: { assistants: number; calendars: number }): string {
  const again = "You can install it again any time.";
  if (app.id === "google_calendar") {
    const visits = app.status !== "disconnected" ? " The visits calendar Crewtavo made is removed from your Google account." : "";
    return `Its calendars come off the schedule.${visits} Your own Google calendars aren't changed. ${again}`;
  }
  if (app.auth === "link") return `${counts.calendars === 1 ? "Its calendar comes" : `Its ${counts.calendars} calendars come`} off the schedule. The calendars themselves aren't changed. ${again}`;
  if (app.id === "stripe") return `Crewtavo's webhook comes out of your Stripe account, and new invoices and payments stop showing up here. Nothing already recorded is deleted. ${again}`;
  if (app.category === "Accounting") {
    const keys = app.app_keys ? ` Your ${app.id === "quickbooks" ? "Intuit" : "Zoho"} app's keys stay, so installing it again is one sign-in.` : "";
    return `Syncing stops right away. Nothing already synced is deleted.${keys} ${again}`;
  }
  if (app.id === "abc_supply") return `Estimates stop getting prices from ABC, and your ABC app's keys are removed from Crewtavo. The materials in your price list and the prices already on estimates stay. ${again}`;
  if (app.id === "fal") return `Find paving stops working, and your fal.ai key is removed from Crewtavo. Shapes it already found stay on your drawings. ${again}`;
  if (app.category === "AI") {
    const parts = [];
    if (counts.assistants) parts.push(`${app.name} stops working with your Crewtavo account. Anyone else on your team who connected it keeps theirs.`);
    if (hasAccount(app)) parts.push("Your Anthropic key is removed, so Crewtavo's writing help stops using it.");
    return `${parts.join(" ")} ${again}`;
  }
  if (app.id === "twilio") return `Texts stop going out from your number. Nothing already sent is deleted. ${again}`;
  if (app.auth === "site") return `Website comes out of the menu. Your website, its editor and everything on it stay as they are. ${again}`;
  return `Crewtavo stops using it right away. Nothing already here is deleted. ${again}`;
}

/**
 * Google Calendar with nothing to set up: its secret address brings a calendar onto the schedule,
 * and the subscribe link puts visits on Google Calendar. Google sign-in (instant, but a Google
 * Cloud project for whoever runs the server) stays as a footnote.
 */
function GoogleBySecretAddress({ app, sources }: { app: AppRow; sources: CalendarSource[] }) {
  return (
    <>
      <section id="google-setup" className="card card-pad stack" aria-labelledby="google-in">
        <div className="stack-sm" style={{ gap: 4 }}>
          <h2 id="google-in" className="section-title" style={{ fontSize: 16 }}>1. Show your Google Calendar on the schedule</h2>
          <span className="muted small">About a minute, on a computer: Google's phone app doesn't show this address.</span>
        </div>
        <ol className="app-steps">
          <li>
            <a className="btn btn-sm" href={GOOGLE_SETTINGS} target="_blank" rel="noreferrer">Open Google Calendar settings <Icon name="external" size={12} /></a>
          </li>
          <li>On the left, under <strong>Settings for my calendars</strong>, click your calendar.</li>
          <li>Scroll down to <strong>Integrate calendar</strong> and copy the <strong>Secret address in iCal format</strong>.</li>
          <li>Paste it here. It's added as soon as you paste.</li>
        </ol>
        {sources.map((s) => <CalendarRow key={s.id} source={s} />)}
        <span id="google_calendar-add" />
        <AddCalendarForm app="google_calendar" appName="Google" addOnPaste />
        <span className="muted small">Each calendar has its own address: repeat this for the others you want to see. Have a calendar file instead? <Link to="/settings?tab=calendars">Upload it in Settings</Link>.</span>
      </section>
      <CalendarFeedCard title="2. Show your visits in Google Calendar" />
      <details className="card card-pad app-details">
        <summary>Instant updates with Google sign-in</summary>
        <div className="stack-sm small" style={{ marginTop: 10 }}>
          <span>
            Whoever runs your Crewtavo server can turn on Google sign-in. Then you pick calendars from your account instead of pasting addresses, and visits reach Google within
            minutes instead of whenever Google next checks. It takes a Google Cloud project, so most businesses don't need it.
          </span>
          <a href={GOOGLE_SIGNIN_GUIDE} target="_blank" rel="noreferrer">Setup guide <Icon name="external" size={12} /></a>
          {app.redirect_uri && <span>Redirect address: <button type="button" className="link-btn small" onClick={() => copyText(app.redirect_uri!, "Copied")}>{app.redirect_uri}</button></span>}
        </div>
      </details>
    </>
  );
}

/** The provider account a sign-in app is connected to. */
function AccountCard({ app }: { app: AppRow }) {
  if (app.status === "disconnected") return null;
  return (
    <section className="card card-pad stack-sm" aria-label="Account" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 10 }}>
        <Icon name={app.status === "error" ? "alert" : "check"} size={16} />
        <span className="grow">
          {app.status === "error" ? <strong>{app.name} needs to be reconnected</strong> : <>Connected{app.account_label ? <> to <strong>{app.account_label}</strong></> : null}</>}
        </span>
      </div>
      {app.last_error && <span className="small" style={{ color: "var(--danger)", fontWeight: 600 }}>{app.last_error}</span>}
      {app.last_sync_at && app.status === "connected" && <span className="muted small">Last synced {timeAgo(app.last_sync_at)}</span>}
    </section>
  );
}

function NotAvailable({ app }: { app: AppRow }) {
  return (
    <section className="callout" aria-label="Not available yet">
      <Icon name="info" size={20} />
      <div className="grow stack-sm" style={{ gap: 6 }}>
        <span>Not available yet</span>
        <span style={{ fontWeight: 400 }}>Ask whoever set up Crewtavo to turn on {app.name}.</span>
        <details>
          <summary style={{ cursor: "pointer", fontWeight: 400 }}>Setup details</summary>
          <div className="stack-sm small" style={{ gap: 4, marginTop: 6, fontWeight: 400 }}>
            <a href={app.docs} target="_blank" rel="noreferrer">Setup guide <Icon name="external" size={12} /></a>
            {app.redirect_uri && <span>Redirect address: <button type="button" className="link-btn small" onClick={() => copyText(app.redirect_uri!, "Copied")}>{app.redirect_uri}</button></span>}
          </div>
        </details>
      </div>
    </section>
  );
}

/**
 * Claude and ChatGPT connect to Crewtavo with the MCP link. While installing (`setup`), it checks
 * every few seconds, so the page turns to installed once the assistant has connected.
 */
function ConnectorCard({ app, mcpUrl, setup = false }: { app: AppRow; mcpUrl: string; setup?: boolean }) {
  const steps = CONNECTOR_STEPS[app.id] ?? [];
  useAssistantConnections(setup ? 5000 : false);
  return (
    <section className="card card-pad stack-sm" aria-labelledby="connector-title" style={{ gap: 12 }}>
      <h2 id="connector-title" className="section-title" style={{ fontSize: 16 }}>Use Crewtavo in {app.name}</h2>
      <div className="row wrap" style={{ gap: 8 }}>
        <code className="code-pill grow">{mcpUrl}</code>
        <Button icon="copy" onClick={() => copyText(mcpUrl, "Connector link copied")}>Copy</Button>
      </div>
      {steps.length > 0 && <ol className="app-steps">{steps.map((s) => <li key={s}>{s}</li>)}</ol>}
      {setup ? (
        <span className="muted small row" style={{ gap: 8 }} role="status">
          <Icon name="refresh" size={14} />
          Once {app.name} has connected, it shows as installed here.
        </span>
      ) : (
        <>
          <ConnectedAssistants app={app.id} />
          <AssistantAccess />
        </>
      )}
    </section>
  );
}

/** Apps that use a key (a company's own Anthropic key, for example). The key is never shown again. */
function KeyCard({ app, onSaved }: { app: AppRow; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const stripe = app.id === "stripe";
  const save = useMutation({
    meta: { inline: true, success: stripe ? "Stripe connected" : `${app.name} key saved` },
    mutationFn: () => api.put(`/apps/${app.id}/key`, { api_key: key.trim() }),
    onSuccess: () => {
      setKey("");
      onSaved();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim().length >= 10) save.mutate();
  };
  // Until the company's own Stripe key is in: how to get one from the form Stripe fills in.
  const stripeSteps = stripe && !app.stripe?.own;
  const fal = app.id === "fal";
  const falSteps = fal && app.status !== "connected";
  return (
    <section id="app-setup" className="card card-pad stack-sm" aria-labelledby="key-title" style={{ gap: 10 }}>
      <h2 id="key-title" className="section-title" style={{ fontSize: 16 }}>
        {app.id === "anthropic" ? "Your own Anthropic key (optional)" : stripe ? (app.stripe?.own ? "Stripe key" : app.stripe ? "Use your own Stripe account" : "Connect your Stripe account") : fal ? (falSteps ? "Connect your fal.ai account" : "fal.ai key") : `${app.name} key`}
      </h2>
      {stripeSteps && (
        <>
          <ol className="app-steps">
            <li>Click <strong>Get a key from Stripe</strong> and sign in if Stripe asks. A new key named Crewtavo opens with what it needs already set, so leave the list as it is (most of it stays at None).</li>
            <li>Scroll to the bottom of Stripe's page, click <strong>Create key</strong> and enter the code Stripe sends you.</li>
            <li>Copy the key Stripe shows you, then paste it below.</li>
          </ol>
          <a className="btn btn-primary" style={{ justifySelf: "start" }} href={STRIPE_NEW_KEY} target="_blank" rel="noreferrer">
            <Icon name="external" size={16} />
            Get a key from Stripe
          </a>
        </>
      )}
      {falSteps && (
        <>
          <span className="muted small">About two minutes. fal.ai bills you directly: Find paving costs about half a cent for each thing it looks for, so $5 of credit covers hundreds of lots.</span>
          <ol className="app-steps">
            <li>Click <strong>Get a key from fal.ai</strong> and sign in with Google or GitHub (or make an account).</li>
            <li>Click <strong>Create Key</strong>, name it Crewtavo, keep the <strong>API</strong> scope, and copy the key. fal.ai only shows it once.</li>
            <li>Add a few dollars of credit under <a href={FAL_BILLING} target="_blank" rel="noreferrer">Billing</a>.</li>
            <li>Paste the key below. Crewtavo checks it with fal.ai before saving, at no cost.</li>
          </ol>
          <a className="btn btn-primary" style={{ justifySelf: "start" }} href={FAL_KEYS} target="_blank" rel="noreferrer">
            <Icon name="external" size={16} />
            Get a key from fal.ai
          </a>
        </>
      )}
      <span className="muted small">
        {app.id === "anthropic" ? "Crewtavo's writing help and answers from your guides use this key when you add one. " : null}
        {fal && !falSteps ? <>Find paving is on the measuring map, next to the takeoff items. <a href={FAL_BILLING} target="_blank" rel="noreferrer">Check your fal.ai credit</a>. </> : null}
        {stripe ? "Crewtavo adds the webhook it needs to your Stripe account. " : null}
        {app.status === "connected" && app.account_label && (!stripe || app.stripe?.own) ? `Saved: ${app.account_label}.` : "It's stored encrypted and never shown again."}
        {stripe && app.stripe?.own ? <> To switch keys, <a href={STRIPE_NEW_KEY} target="_blank" rel="noreferrer">get a new one from Stripe</a>.</> : null}
      </span>
      <form className="row" style={{ gap: 8 }} onSubmit={submit}>
        <div className="input-group grow">
          <input className="input" type={show ? "text" : "password"} autoComplete="off" spellCheck={false} placeholder={(stripe ? app.stripe?.own : app.status === "connected") ? "Paste a new key to replace it" : stripe ? "Paste the key from Stripe" : "Paste your key"} value={key} onChange={(e) => { setKey(e.target.value); save.reset(); }} aria-label={stripe ? "Key from Stripe" : `${app.name} API key`} style={{ paddingLeft: 12, paddingRight: 36 }} />
          <button type="button" className="icon-btn addon-right" style={{ position: "absolute", right: 2, pointerEvents: "auto" }} aria-label={show ? "Hide key" : "Show key"} onClick={() => setShow(!show)}><Icon name={show ? "eye" : "lock"} size={14} /></button>
        </div>
        <Button type="submit" loading={save.isPending} disabled={key.trim().length < 10}>{stripe ? "Connect" : "Save"}</Button>
      </form>
      {save.error && <span className="field-error">{(save.error as Error).message}</span>}
    </section>
  );
}
