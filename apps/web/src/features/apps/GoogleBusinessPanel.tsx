/**
 * Google Business Profile on its Apps page. Before signing in: what to set up first, Google's access
 * request (the step that takes weeks) before anything else (GoogleBeforeSignIn). Once signed in: what
 * Google is waiting on, with Google's form and the project number it asks for; the location reviews
 * come from, picked from the accounts the sign-in manages; Google's review link for it, offered and
 * never used without asking; Sync now; and that Marketing has to be installed for any of it.
 * Marketing → Reviews shows the reviews (features/marketing/GoogleReviews.tsx).
 */
import { APPROVAL_MESSAGE, GOOGLE_ACCESS_FORM, OWN_APP_APPROVAL_MESSAGE } from "@crewtavo/core/reviews";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatTime, timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { locationSavedWords, progressWords, tooSoon } from "../marketing/googleReviewData";
import { BUSINESS_SCOPE, CopyRow } from "./AppKeysCard";
import type { AppRow } from "./catalog";

interface PickedLocation { name: string; title: string; address: string | null; verified: boolean }
interface Accounts { accounts: Array<{ name: string; title: string; locations: PickedLocation[] }>; problem: string | null }

/** The three APIs the reviews need, by the names Google Cloud's library gives them. */
const APIS = "My Business Account Management API, My Business Business Information API and Google My Business API";

/**
 * Check again: Google is asked now whether it lets Crewtavo in (and a location is picked when there's
 * only one), and the answer is said either way, so pressing it is never met with nothing.
 */
export function useCheckAgain(onDone: () => void) {
  return useMutation({
    meta: { inline: true },
    mutationFn: () => api.get<Accounts>("/apps/google_business/locations"),
    onSuccess: (res) => {
      if (!res.problem) toast.success("Google lets Crewtavo in now. Your reviews are on their way.");
      else if (res.problem === "approval" || res.problem === "not_enabled") toast.info("Google still isn't letting Crewtavo in. Crewtavo checks again every 6 hours.");
      onDone();
    },
  });
}

/** Sync now: asks Google for new reviews. Pressed again too soon, it says so as news, not as an error. */
export function useSyncNow(onDone: () => void) {
  return useMutation({
    meta: { inline: true, success: "Checking Google for new reviews" },
    mutationFn: () => api.post("/reviews/google/sync"),
    onError: (error) => {
      if (tooSoon(error)) toast.info((error as Error).message);
    },
    onSettled: onDone,
  });
}

/**
 * Google hasn't approved the project's access yet (or its APIs aren't on): what that means, who asks
 * Google and with what, and Check again. Office staff without Apps get the message and who can act.
 */
export function ApprovalCallout({ own, projectNumber, admin, notEnabled = false, onCheck, checking = false }: {
  own: boolean;
  projectNumber: string | null;
  admin: boolean;
  notEnabled?: boolean;
  onCheck?: () => void;
  checking?: boolean;
}) {
  const project = own ? "your Google app's" : "this server's";
  return (
    <div className="callout callout-warning" role="status">
      <Icon name="clock" size={20} />
      <div className="grow stack-sm" style={{ gap: 8 }}>
        <strong>{notEnabled ? `The Business Profile APIs aren't turned on in ${project} Google Cloud project yet.` : own ? OWN_APP_APPROVAL_MESSAGE : APPROVAL_MESSAGE}</strong>
        {!admin ? (
          <span style={{ fontWeight: 400 }}>Review asks keep working meanwhile. An owner or admin can {notEnabled ? "fix this" : "request access"} in Apps.</span>
        ) : notEnabled ? (
          <span style={{ fontWeight: 400 }}>Whoever owns {project} Google Cloud project turns on the {APIS}, then Check again.</span>
        ) : (
          <>
            <span style={{ fontWeight: 400 }}>
              Whoever owns {project} Google Cloud project fills in Google's access request form, using an email that manages your Business Profile. The profile needs to have
              been verified for 60 days or more, and Google takes about 2 weeks. Review asks keep working meanwhile, and Crewtavo checks again every 6 hours.
            </span>
            {projectNumber && (
              <span className="row wrap" style={{ gap: 8, fontWeight: 400 }}>
                Project number: <code className="code-pill">{projectNumber}</code>
                <Button size="sm" icon="copy" onClick={() => copyText(projectNumber, "Project number copied")}>Copy</Button>
              </span>
            )}
          </>
        )}
        {admin && (
          <div className="row wrap" style={{ gap: 8 }}>
            {!notEnabled && <a className="btn btn-sm" href={GOOGLE_ACCESS_FORM} target="_blank" rel="noreferrer">Google's access request form <Icon name="external" size={12} /></a>}
            {onCheck && <Button size="sm" variant="ghost" icon="refresh" loading={checking} onClick={onCheck}>Check again</Button>}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Google's review link for the location, when it would change the company's: Use this link fills
 * in Your review link, Keep mine stops offering it for this location. `onUse` lets a page save it
 * its own way.
 */
export function ReviewLinkOffer({ link, title, onUse, onDone }: { link: string; title: string | null; onUse?: () => Promise<unknown>; onDone?: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const decide = useMutation({
    meta: { inline: true },
    mutationFn: async (use: boolean) => (use && onUse ? onUse() : api.post("/apps/google_business/review-link", { use })),
    onSuccess: async (_, use) => {
      if (use) toast.success("Review link saved");
      await session.refresh();
      queryClient.invalidateQueries({ queryKey: ["apps"] });
      queryClient.invalidateQueries({ queryKey: ["google-reviews", session.company.id] });
      onDone?.();
    },
  });
  return (
    <div className="callout callout-info">
      <Icon name="link" size={20} />
      <div className="grow stack-sm" style={{ gap: 8, minWidth: 0 }}>
        <span>Google's review link for {title ?? "your business"}</span>
        <code className="code-pill ellipsis" style={{ fontWeight: 400 }}>{link}</code>
        <div className="row wrap" style={{ gap: 8 }}>
          <Button size="sm" variant="primary" loading={decide.isPending && decide.variables === true} onClick={() => decide.mutate(true)}>Use this link</Button>
          <Button size="sm" variant="ghost" loading={decide.isPending && decide.variables === false} onClick={() => decide.mutate(false)}>Keep mine</Button>
        </div>
        <FormError error={decide.error} />
      </div>
    </div>
  );
}

/**
 * Before signing in: Google's access request first (about 2 weeks), what the server's Google Cloud
 * project needs (this app's redirect address, the scope and the APIs), then signing in, which works
 * before Google approves and starts bringing reviews in once it does.
 */
export function GoogleBeforeSignIn({ app, onConnect, connecting }: { app: AppRow; onConnect: () => void; connecting: boolean }) {
  const project = app.google_business?.project_number ?? null;
  return (
    <section id="app-setup" className="card card-pad stack" aria-labelledby="google-business-setup">
      <div className="stack-sm" style={{ gap: 4 }}>
        <h2 id="google-business-setup" className="section-title" style={{ fontSize: 16 }}>Before you sign in</h2>
        <span className="muted small">Your reviews come in through this server's Google Cloud project, the one Google Calendar sign-in uses. Google approves each project's access to reviews first.</span>
      </div>
      <ol className="app-steps" style={{ gap: 14 }}>
        <li><div className="stack-sm" style={{ gap: 8 }}>
          <span>
            Ask Google for access first: it takes about 2 weeks. Whoever owns the Google Cloud project fills in Google's form with an email that manages your Business Profile,
            which must have been verified for 60 days or more.
          </span>
          {project && (
            <span className="row wrap small" style={{ gap: 8 }}>
              Project number: <code className="code-pill">{project}</code>
              <Button size="sm" icon="copy" onClick={() => copyText(project, "Project number copied")}>Copy</Button>
            </span>
          )}
          <a className="btn btn-sm" style={{ justifySelf: "start" }} href={GOOGLE_ACCESS_FORM} target="_blank" rel="noreferrer">Google's access request form <Icon name="external" size={12} /></a>
        </div></li>
        <li><div className="stack-sm" style={{ gap: 8 }}>
          <span>In that Google Cloud project, add this redirect address to its OAuth client, add the scope to its consent screen, and turn on the {APIS}.</span>
          {app.redirect_uri && <CopyRow label="Authorized redirect URI" value={app.redirect_uri} />}
          <CopyRow label="Scope" value={BUSINESS_SCOPE} />
        </div></li>
        <li><div className="stack-sm" style={{ gap: 8 }}>
          <span>Sign in with a Google account that manages your Business Profile. You can sign in before Google approves: Crewtavo checks every 6 hours and starts once it does.</span>
          <Button variant="primary" style={{ justifySelf: "start" }} loading={connecting} onClick={onConnect}>Sign in with Google</Button>
        </div></li>
      </ol>
    </section>
  );
}

/**
 * Installed: what's in the way, the location, Google's review link and syncing. Signed in with no
 * location in use (none picked yet, the one picked lost, or one kept from before disconnecting that
 * this sign-in can't reach), the locations to pick from show, unless Google isn't letting Crewtavo
 * list them yet.
 */
export function GoogleBusinessPanel({ app, onChanged, onReconnect, reconnecting }: { app: AppRow; onChanged: () => void; onReconnect: () => void; reconnecting: boolean }) {
  const session = useSession();
  const g = app.google_business;
  const [picking, setPicking] = useState(false);
  const check = useCheckAgain(onChanged);
  const sync = useSyncNow(onChanged);
  if (!g || app.status === "disconnected") return null;
  const problem = g.problem;
  const waiting = problem === "approval" || problem === "not_enabled";
  // Locations are listed through the sign-in, so not while it needs reconnecting or Google isn't letting Crewtavo in.
  const listable = app.status === "connected" && !waiting;
  const pick = listable && (picking || problem === "pick" || !g.location);

  return (
    <section id="app-setup" className="card card-pad stack" aria-labelledby="google-business-panel">
      <h2 id="google-business-panel" className="section-title" style={{ fontSize: 16 }}>Your reviews</h2>
      {!g.marketing_on && (
        <div className="callout callout-warning">
          <Icon name="pause" size={20} />
          <div className="grow">
            Marketing is off, so reviews aren't brought in and replies can't be posted. Reviews already here are kept.{" "}
            <Link to="/apps/marketing">Install Marketing</Link>
          </div>
        </div>
      )}
      {app.status === "error" && (
        <div className="callout callout-danger" role="alert">
          <Icon name="alert" size={20} />
          <div className="grow stack-sm" style={{ gap: 8 }}>
            <span>Google sign-in expired, so reviews aren't coming in. Reconnect with an owner or manager of the Business Profile.</span>
            <Button size="sm" variant="primary" icon="refresh" style={{ justifySelf: "start" }} loading={reconnecting} onClick={onReconnect}>Reconnect</Button>
          </div>
        </div>
      )}
      {waiting && (
        <ApprovalCallout own={g.own_app} projectNumber={g.project_number} admin notEnabled={problem === "not_enabled"} onCheck={() => check.mutate()} checking={check.isPending} />
      )}
      {problem === "location" && (
        <div className="callout callout-warning" role="status">
          <Icon name="alert" size={20} />
          <div className="grow stack-sm" style={{ gap: 8 }}>
            <span>{g.problem_message}</span>
            <div className="row wrap" style={{ gap: 8 }}>
              <Button size="sm" variant="ghost" icon="refresh" loading={check.isPending} onClick={() => check.mutate()}>Check again</Button>
              {g.problem_detail === "no_access" && <Button size="sm" variant="ghost" loading={reconnecting} onClick={onReconnect}>Reconnect</Button>}
            </div>
          </div>
        </div>
      )}
      {problem === "error" && (
        <div className="callout callout-warning" role="status">
          <Icon name="alert" size={20} />
          <div className="grow">{g.problem_message} {g.next_sync_at ? `Crewtavo tries again at ${formatTime(g.next_sync_at, session.company.timezone)}.` : null}</div>
        </div>
      )}
      <FormError error={check.error} />

      {pick ? (
        <LocationPicker
          current={g.location}
          kept={g.kept_location ?? null}
          reviewCount={g.review_count}
          marketingOn={g.marketing_on}
          onDone={() => { setPicking(false); onChanged(); }}
          onCancel={g.location ? () => setPicking(false) : undefined}
          onReconnect={onReconnect}
          reconnecting={reconnecting}
        />
      ) : g.location ? (
        <div className="row wrap" style={{ gap: 10 }}>
          <Icon name="pin" size={18} />
          <span className="grow" style={{ minWidth: 0 }}>
            <strong style={{ display: "block" }}>{g.location.title}</strong>
            <span className="muted small">{g.location.address ?? "Service area business"}{g.location.maps_uri && <> · <a href={g.location.maps_uri} target="_blank" rel="noreferrer">On Google Maps</a></>}</span>
          </span>
          {listable && <Button size="sm" onClick={() => setPicking(true)}>Change location</Button>}
        </div>
      ) : null}

      {/* Signed out at Google, the page is about reconnecting first. */}
      {g.review_url?.suggested && g.location && app.status === "connected" && <ReviewLinkOffer link={g.review_url.suggested} title={g.location.title} onDone={onChanged} />}

      {g.location && app.status === "connected" && (
        <div className="row wrap" style={{ gap: 10 }}>
          <span className="muted small grow">
            {progressWords(g.progress ?? null) ?? (g.last_synced_at ? `Last synced ${timeAgo(g.last_synced_at)}` : "Not synced yet")}
            {/* Marketing → Reviews isn't there while Marketing is off. */}
            {g.review_count && g.marketing_on ? ` · ${g.review_count.toLocaleString("en-US")} ${g.review_count === 1 ? "review" : "reviews"} in Marketing → Reviews` : ""}
          </span>
          {!waiting && <Button size="sm" variant="ghost" icon="refresh" disabled={!g.marketing_on} loading={sync.isPending} onClick={() => sync.mutate()}>Sync now</Button>}
        </div>
      )}
      <FormError error={tooSoon(sync.error) ? null : sync.error} />
    </section>
  );
}

/**
 * The accounts the sign-in manages and their locations, to pick the one whose reviews come in.
 * Picking another than the one the reviews here came from (`kept`, which may be from before
 * disconnecting) removes them, so that's asked first. A Google account that manages no Business
 * Profile signs in with another.
 */
function LocationPicker({ current, kept, reviewCount, marketingOn, onDone, onCancel, onReconnect, reconnecting }: {
  current: { id: string; title: string | null } | null;
  kept: string | null;
  reviewCount: number;
  marketingOn: boolean;
  onDone: () => void;
  onCancel?: () => void;
  onReconnect: () => void;
  reconnecting: boolean;
}) {
  const session = useSession();
  const [chosen, setChosen] = useState<{ account: string; location: string; title: string } | null>(null);
  const list = useQuery({ queryKey: ["google-locations", session.company.id], queryFn: () => api.get<Accounts>("/apps/google_business/locations") });
  const save = useMutation({
    meta: { inline: true, success: locationSavedWords },
    mutationFn: (pick: { account: string; location: string }) => api.put<{ removed: number; syncing: boolean }>("/apps/google_business/location", pick),
    onSuccess: onDone,
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    if (kept && kept !== chosen.location && reviewCount > 0) {
      const ok = await confirm({
        title: `Bring in ${chosen.title}'s reviews instead?`,
        body: `The ${reviewCount.toLocaleString("en-US")} ${reviewCount === 1 ? "review" : "reviews"} from ${current?.title ?? "the old location"} are removed, and asks start again for the clients they matched.`,
        confirmLabel: "Change location",
        danger: true,
      });
      if (!ok) return;
    }
    save.mutate({ account: chosen.account, location: chosen.location });
  };
  if (list.isPending) return <CardSkeleton lines={3} title={false} />;
  if (list.error) return <ErrorState compact error={list.error} onRetry={() => list.refetch()} />;
  const accounts = list.data.accounts.filter((a) => a.locations.length);
  if (!accounts.length && list.data.problem && list.data.problem !== "pick") return <span className="muted small">Google isn't letting Crewtavo see your locations yet.</span>;
  if (!accounts.length) {
    return (
      <div className="stack-sm" style={{ gap: 8 }}>
        <span className="muted small">The Google account you signed in with doesn't manage a Business Profile. Sign in with the one that does.</span>
        <Button size="sm" variant="primary" style={{ justifySelf: "start" }} loading={reconnecting} onClick={onReconnect}>Sign in with another Google account</Button>
      </div>
    );
  }
  return (
    <form className="stack-sm" onSubmit={submit}>
      <strong className="small">Pick your business's location</strong>
      <span className="muted small">Crewtavo brings in one location's reviews.</span>
      {accounts.map((account) => (
        <fieldset key={account.name} className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          {accounts.length > 1 && <legend className="muted small strong" style={{ marginBottom: 6 }}>{account.title}</legend>}
          {account.locations.map((l) => {
            const on = chosen?.location === l.name || (!chosen && current?.id === l.name);
            return (
              <label key={l.name} className={`card-row choice-row${on ? " picked" : ""}`} style={{ cursor: "pointer" }}>
                <input type="radio" name="google-location" checked={on} onChange={() => setChosen({ account: account.name, location: l.name, title: l.title })} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <strong style={{ display: "block" }}>{l.title}</strong>
                  <span className="muted small">{l.address ?? "Service area business"}{l.verified ? "" : " · Not verified on Google yet"}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
      ))}
      {!marketingOn && <span className="muted small">Reviews start coming in once Marketing is installed again.</span>}
      <FormError error={save.error} />
      <div className="row wrap" style={{ gap: 8 }}>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!chosen || chosen.location === current?.id}>Use this location</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button variant="ghost" loading={reconnecting} onClick={onReconnect}>Sign in with another Google account</Button>
      </div>
    </form>
  );
}
