import { ADMINS, canMakeResetLink, LEVEL_SUMMARY, type Role } from "@crewtavo/core/roles";
import { formatBytes } from "@crewtavo/core/storage";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { SaveStatus, useSaveStatus } from "@/components/ui/SaveStatus";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { Face } from "@/components/ui/Avatar";
import { api, supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { timeAgo } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { can, useSession } from "@/lib/session";
import { RatesCard } from "../subs/RatesCard";
import { handlesTeamPay, useTeamRateCounts } from "../subs/payData";
import { PhotoButtons } from "./ProfilePhoto";
import { accessFor, choiceFor, givesAdmin, patchFor, roleChoices, roleName, useCompanyRoles } from "./roles";
import { limitable, setsAllowances, useStorageOverview, type StoragePerson } from "./storage";
import { AllowanceDialog } from "./StorageSettings";
import { PASSWORD_HINT } from "../apps/catalog";

export interface Member { user_id: string; role: Role; role_id: string | null; active: boolean; labor_rate: number | null; profile: { full_name: string; email: string | null; color: string | null; avatar_url: string | null } | null }
/** Someone invited who hasn't set up their account yet, and when their latest link went out. */
interface PendingInvite { user_id: string; sent_at: string }
/** What an invite (new or resent) did: emailed or not, and the link to copy either way. */
interface InviteSent { emailed: boolean; reason: string | null; link: string | null }

export function TeamSettings() {
  const session = useSession();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  // A hired applicant's "Invite to your team" (features/careers/ApplicantPage.tsx) opens the invite filled in.
  const handed = (location.state as { invite?: { name: string; email: string } } | null)?.invite;
  const [inviting, setInviting] = useState(Boolean(handed));
  const stopInviting = () => {
    setInviting(false);
    if (handed) navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  };
  const [resetting, setResetting] = useState<Member | null>(null);
  const [resending, setResending] = useState<Member | null>(null);
  // A role change that gives admin access, waiting on the changer's password.
  const [granting, setGranting] = useState<{ member: Member; choice: string } | null>(null);
  const [photoFor, setPhotoFor] = useState<string | null>(null);
  const [ratesFor, setRatesFor] = useState<Member | null>(null);
  const [storageFor, setStorageFor] = useState<{ member: Member; usage: StoragePerson | undefined } | null>(null);
  // Piece rates (per square, per job, per day) are pay, for the office with job costs, as hourly pay is.
  const pieceRates = handlesTeamPay(session);
  const rateCounts = useTeamRateCounts(session.company.id, pieceRates);
  // The team only: a sub's sign-in is on their page under Subcontractors (GET /team leaves them out).
  const team = useQuery({ queryKey: ["team", session.company.id], queryFn: () => api.get<Member[]>("/team") });
  const invites = useQuery({ queryKey: ["team-invites", session.company.id], queryFn: () => api.get<PendingInvite[]>("/team/invites") });
  const pending = new Map((invites.data ?? []).map((i) => [i.user_id, i.sent_at]));
  const roles = useCompanyRoles();
  const refreshTeam = () => {
    queryClient.invalidateQueries({ queryKey: ["team", session.company.id] });
    queryClient.invalidateQueries({ queryKey: ["team-invites", session.company.id] });
    queryClient.invalidateQueries({ queryKey: ["dispatch-options", session.company.id] });
  };
  const update = useMutation({
    // Access and roles change things elsewhere, so they're announced.
    meta: { success: (_: unknown, v: { patch: { active: boolean } }) => (v.patch.active ? "Access restored" : "Access removed") },
    mutationFn: async ({ userId, patch }: { userId: string; patch: { active: boolean } }) =>
      unwrap(await supabase().from("memberships").update(patch).eq("company_id", session.company.id).eq("user_id", userId)),
    onSettled: refreshTeam,
  });
  // Roles go through the API, which asks for the changer's password when one gives admin access.
  const access = useMutation({
    meta: { success: "Role changed", inline: Boolean(granting) },
    mutationFn: ({ userId, choice, password }: { userId: string; choice: string; password?: string }) =>
      api.patch(`/team/${userId}/access`, { ...accessFor(choice, roles.data), current_password: password || undefined }),
    onSettled: refreshTeam,
  });
  const changeRole = (member: Member, choice: string) => (givesAdmin(choice, roles.data) ? setGranting({ member, choice }) : access.mutate({ userId: member.user_id, choice }));
  // A labor cost saves when its field loses focus, and says so beside the head count.
  const saving = useSaveStatus();
  const rate = useMutation({
    meta: { inline: true },
    mutationFn: async ({ userId, labor_rate }: { userId: string; labor_rate: number | null }) =>
      unwrap(await supabase().from("memberships").update({ labor_rate }).eq("company_id", session.company.id).eq("user_id", userId)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["team", session.company.id] }),
  });
  const isOwner = session.role === "owner";
  // A storage limit of their own, which only owners set (Settings → Storage has who's using what).
  const storage = useStorageOverview(setsAllowances(session));
  const storageOf = new Map((storage.data?.by_person ?? []).flatMap((p) => (p.user_id ? [[p.user_id, p] as const] : [])));
  const members = [...(team.data ?? [])].sort((a, b) => Number(b.active) - Number(a.active) || (a.profile?.full_name ?? "").localeCompare(b.profile?.full_name ?? ""));
  // Your own photo, and for those who manage the team, anyone's (an owner's only by an owner).
  const canSetPhoto = (m: Member) => m.user_id === session.userId || (ADMINS.includes(session.role) && can(session, "team") && (isOwner || m.role !== "owner"));
  const photoMember = members.find((m) => m.user_id === photoFor);
  const rows = useListAnimation<HTMLTableSectionElement>();

  return (
    <div className="stack">
      <div className="row-between">
        <span className="muted">
          {members.filter((m) => m.active).length} people with access{pending.size ? ` · ${pending.size} ${pending.size === 1 ? "hasn't" : "haven't"} joined yet` : ""}
        </span>
        <SaveStatus status={saving.status} />
        <span className="grow" />
        <Button variant="primary" icon="plus" onClick={() => setInviting(true)}>Invite someone</Button>
      </div>
      {team.isPending ? <TableSkeleton columns={4} rows={4} /> : team.error ? <div className="card"><ErrorState error={team.error} onRetry={() => team.refetch()} /></div> : (
        <div className="card">
          <table className="table table-stack">
            <thead><tr><th>Person</th><th>Role</th><th className="num">Labor cost / hr</th><th>Access</th></tr></thead>
            <tbody ref={rows}>
              {members.map((m) => {
                const me = m.user_id === session.userId;
                const locked = me || (m.role === "owner" && !isOwner);
                const name = m.profile?.full_name || "Invited user";
                const sentAt = m.active ? pending.get(m.user_id) : undefined;
                return (
                  <tr key={m.user_id} style={m.active ? undefined : { opacity: 0.6 }}>
                    <td>
                      <div className="row">
                        {canSetPhoto(m) ? (
                          <button type="button" className="avatar avatar-edit" style={{ width: 32, height: 32, fontSize: 12, background: m.profile?.color || "var(--text-3)" }} onClick={() => setPhotoFor(m.user_id)} aria-label={me ? "Your photo" : `${name}'s photo`} title={m.profile?.avatar_url ? "Change photo" : "Add a photo"}>
                            <Face name={name} photo={m.profile?.avatar_url} />
                            <span className="avatar-edit-badge" aria-hidden="true"><Icon name="camera" size={12} /></span>
                          </button>
                        ) : (
                          <span className="avatar" style={{ width: 32, height: 32, fontSize: 12, background: m.profile?.color || "var(--text-3)" }}><Face name={name} photo={m.profile?.avatar_url} /></span>
                        )}
                        <span>
                          <strong>{name}</strong>{me && <span className="chip" style={{ marginLeft: 6 }}>You</span>}<div className="muted small">{m.profile?.email}</div>
                          {sentAt && (
                            <div className="row" style={{ gap: 6, marginTop: 2 }}>
                              <StatusPill label="Invite pending" tone="warning" />
                              <span className="muted small">sent {timeAgo(sentAt)}</span>
                            </div>
                          )}
                          {sentAt ? !locked && (
                            <button type="button" className="link-btn small" onClick={() => setResending(m)}>Resend invite</button>
                          ) : m.active && !me && can(session, "team") && canMakeResetLink(session.role, m.role) && (
                            <button type="button" className="link-btn small" onClick={() => setResetting(m)}>Reset password</button>
                          )}
                          {isOwner && storage.data && m.active && limitable(m) && (
                            <div>
                              <button type="button" className="link-btn small" style={{ textAlign: "left" }} onClick={() => setStorageFor({ member: m, usage: storageOf.get(m.user_id) })} aria-label={`Storage limit for ${name}`}>
                                {storageLink(storageOf.get(m.user_id))}
                              </button>
                            </div>
                          )}
                        </span>
                      </div>
                    </td>
                    <td>
                      {locked ? <span>{roleName(m, roles.data)}</span> : (
                        <RolePicker value={choiceFor(m)} roles={roles.data} viewerIsOwner={isOwner || m.role === "owner"} disabled={!m.active} label={`Role for ${name}`} onChange={(choice) => changeRole(m, choice)} />
                      )}
                    </td>
                    <td className="num">
                      <MoneyInput value={Number(m.labor_rate ?? 0)} max={1000} width={110} label={`Labor cost for ${name}`} onSave={(v) => void saving.track(rate.mutateAsync({ userId: m.user_id, labor_rate: v || null }))} />
                      {pieceRates && (
                        <div>
                          <button type="button" className="link-btn small" onClick={() => setRatesFor(m)}>
                            {rateCounts.data?.[m.user_id] ? `${rateCounts.data[m.user_id]} piece ${rateCounts.data[m.user_id] === 1 ? "rate" : "rates"}` : "Piece rates"}
                          </button>
                        </div>
                      )}
                    </td>
                    <td>
                      {locked ? <StatusPill label={m.active ? "Active" : "Removed"} tone={m.active ? "good" : "muted"} /> : (
                        <Button
                          size="sm"
                          variant={m.active ? "danger" : "secondary"}
                          onClick={async () => {
                            if (!m.active) return update.mutate({ userId: m.user_id, patch: { active: true } });
                            if (await confirm({ title: `Remove ${name}'s access?`, body: "They're signed out of this company right away. Their visits, time and notes stay on record, and you can restore access later.", confirmLabel: "Remove access", danger: true })) update.mutate({ userId: m.user_id, patch: { active: false } });
                          }}
                        >
                          {m.active ? "Remove" : "Restore"}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {inviting && <InviteDialog prefill={handed} onClose={stopInviting} />}
      {resetting && <ResetPasswordDialog member={resetting} onClose={() => setResetting(null)} />}
      {resending && <ResendInviteDialog member={resending} onClose={() => setResending(null)} />}
      {granting && (
        <GrantWithPassword
          name={granting.member.profile?.full_name || granting.member.profile?.email || "this person"}
          roleLabel={roleName(accessFor(granting.choice, roles.data), roles.data)}
          busy={access.isPending}
          error={access.error}
          onGrant={(password) => access.mutate({ userId: granting.member.user_id, choice: granting.choice, password }, { onSuccess: () => setGranting(null) })}
          onClose={() => {
            setGranting(null);
            access.reset();
          }}
        />
      )}
      {photoMember && <PhotoDialog member={photoMember} onClose={() => setPhotoFor(null)} />}
      {storageFor && (
        <AllowanceDialog
          target={{ user: storageFor.member.user_id }}
          name={storageFor.member.profile?.full_name || storageFor.member.profile?.email || "this person"}
          current={storageFor.usage?.limit_source === "person" ? storageFor.usage.limit_bytes : null}
          roleLimit={storageFor.usage?.limit_source === "role" ? storageFor.usage.limit_bytes : null}
          onClose={() => setStorageFor(null)}
        />
      )}
      {ratesFor && (
        <Dialog open onClose={() => setRatesFor(null)} title={ratesFor.profile?.full_name ? `Piece rates for ${ratesFor.profile.full_name}` : "Piece rates"} size="lg" description="Pay per square, per job or per day, on top of or instead of their hourly cost. Pay on a job is filled in from these, and goes into their pay period once the work is done.">
          <div className="dialog-body">
            <RatesCard payee={{ user_id: ratesFor.user_id }} bare />
            <div className="form-actions"><Button variant="primary" onClick={() => setRatesFor(null)}>Done</Button></div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** A person's storage limit, as the link to change it says it: their own, their role's, or none yet. */
function storageLink(usage: StoragePerson | undefined): string {
  if (!usage?.limit_bytes) return "Storage limit";
  return `Storage: ${formatBytes(usage.limit_bytes)}${usage.limit_source === "role" ? " (role)" : ""}`;
}

/** The changer's own password, for anything that gives admin access (the API checks it with confirmPassword). */
export function YourPassword({ value, onChange, autoFocus }: { value: string; onChange: (password: string) => void; autoFocus?: boolean }) {
  return (
    <Field label="Your Crewtavo password" hint={PASSWORD_HINT} requiredMessage="Enter your password to give someone admin access.">
      <input className="input" type="password" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="current-password" maxLength={200} required autoFocus={autoFocus} />
    </Field>
  );
}

/** A role change that gives admin access, with the changer's password; it's cleared once sent, and a wrong one says so here. */
function GrantWithPassword({ name, roleLabel, busy, error, onGrant, onClose }: { name: string; roleLabel: string; busy: boolean; error: unknown; onGrant: (password: string) => void; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const first = name.split(/\s+/)[0];
  return (
    <Dialog open onClose={onClose} title={`Give ${first} the ${roleLabel} role?`} size="sm">
      <form
        className="stack-sm"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onGrant(password);
          setPassword("");
        }}
      >
        <div className="muted" style={{ marginTop: -6 }}>This gives {first} admin access, including payments, email and who's on the team.</div>
        <YourPassword value={password} onChange={setPassword} autoFocus />
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Change role</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Someone's photo, from their avatar in the list: shown wherever the team sees them. */
function PhotoDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  const session = useSession();
  const me = member.user_id === session.userId;
  const name = member.profile?.full_name || member.profile?.email || "Team member";
  const first = name.split(/\s+/)[0];
  return (
    <Dialog open onClose={onClose} title={me ? "Your photo" : `${first}'s photo`} size="sm">
      <div className="dialog-body">
        <div className="stack-sm" style={{ justifyItems: "center", textAlign: "center" }}>
          <span className="avatar" style={{ width: 96, height: 96, fontSize: 32, background: member.profile?.color || "var(--text-3)" }}><Face name={name} photo={member.profile?.avatar_url} /></span>
          <PhotoButtons userId={member.user_id} photo={member.profile?.avatar_url} />
          <p className="muted small" style={{ margin: 0 }}>
            {me
              ? "It shows wherever your team sees you: the schedule, timesheets and team chat."
              : `It shows wherever your team sees ${first}: the schedule, timesheets and team chat. ${first} can also change it in Settings → Profile.`}
          </p>
        </div>
        <div className="form-actions"><Button variant="primary" onClick={onClose}>Done</Button></div>
      </div>
    </Dialog>
  );
}

/**
 * A one-time link for someone to choose a new password, for when they're locked out (POST
 * /api/team/:id/password-link). Emailed when the company can send email; otherwise the admin hands
 * it over. Only for people below the admin's own level (canMakeResetLink).
 */
export function ResetPasswordDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  const session = useSession();
  const name = member.profile?.full_name || member.profile?.email || "this person";
  const first = name.split(/\s+/)[0];
  // Whoever opens the link has their account, so for someone with admin access it takes your password.
  const admin = givesAdmin(choiceFor(member), useCompanyRoles().data);
  const [password, setPassword] = useState("");
  const reset = useMutation({
    meta: { inline: true },
    mutationFn: (current_password: string) => api.post<{ emailed: boolean; link: string | null }>(`/team/${member.user_id}/password-link`, { current_password: current_password || undefined }),
  });
  return (
    <Dialog open onClose={onClose} title={reset.data ? (reset.data.emailed ? "Reset link sent" : "Reset link ready") : `Reset ${first}'s password?`}>
      {reset.data ? (
        <div className="dialog-body">
          {reset.data.emailed ? (
            <div className="stack-sm" style={{ justifyItems: "center", textAlign: "center" }}>
              <span className="success-mark"><Icon name="check" size={30} strokeWidth={3} /></span>
              <p style={{ margin: 0 }}>We emailed {member.profile?.email ?? first} a link to choose a new password.</p>
              {session.config.features.devMail && <span className="muted small">Test mode: the email is in the local Mailpit inbox (http://localhost:56324).</span>}
            </div>
          ) : (
            <div className="stack-sm">
              <div className="callout callout-warning">
                <Icon name="lock" size={20} />
                <div className="grow small">
                  Give this link to {first} yourself, in person or by text. Whoever opens it can choose a new password for {first}'s account, so don't share it anywhere else. It works once and stops working within a day.
                </div>
              </div>
              <Button icon="copy" onClick={() => copyText(reset.data!.link!, "Reset link copied")}>Copy reset link</Button>
            </div>
          )}
          <p className="muted small" style={{ margin: 0 }}>{first} will see a note about this when they're back in, and it's in your activity log.</p>
          <div className="form-actions"><Button variant="primary" onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <form className="dialog-body" onSubmit={(e: FormEvent) => { e.preventDefault(); reset.mutate(password); setPassword(""); }}>
          <p style={{ margin: 0 }}>This makes a one-time link for {name} to choose a new password. Their current password keeps working until they do.</p>
          {admin && <YourPassword value={password} onChange={setPassword} autoFocus />}
          <FormError error={reset.error} />
          <div className="form-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" icon="lock" loading={reset.isPending}>Make reset link</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function InviteDialog({ onClose, prefill }: { onClose: () => void; prefill?: { name: string; email: string } }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState(prefill?.email ?? "");
  const [name, setName] = useState(prefill?.name ?? "");
  const roles = useCompanyRoles();
  const [choice, setChoice] = useState<string | null>(null);
  const employee = roles.data?.find((r) => r.base_role === "field_crew");
  const picked = choice ?? (employee ? `role:${employee.id}` : "level:field_crew");
  const admin = givesAdmin(picked, roles.data);
  const [password, setPassword] = useState("");
  const invite = useMutation({
    meta: { inline: true },
    mutationFn: (current_password: string) =>
      api.post<InviteSent & { invited: boolean }>("/team/invite", { email: email.trim(), full_name: name.trim() || undefined, ...accessFor(picked, roles.data), current_password: current_password || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["team-invites", session.company.id] });
    },
  });
  return (
    <Dialog open onClose={onClose} title={invite.data ? (invite.data.invited ? (invite.data.emailed ? "Invite sent" : "Invite ready") : "Added to your team") : "Invite someone"}>
      {invite.data ? (
        <InviteResult
          sent={invite.data}
          message={invite.data.invited
            ? invite.data.emailed ? `We emailed ${email} a link to set up their account.` : `${email} can join with the link below.`
            : `${email} already had an account and now has access.${invite.data.emailed ? " We emailed them to let them know." : ""}`}
          onClose={onClose}
        />
      ) : (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); invite.mutate(admin ? password : ""); setPassword(""); }}>
          <div className="form-grid">
            <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={200} /></Field>
            <Field label="Name" optional><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
          </div>
          <Field label="Role" hint={levelHint(picked, roles.data)}>
            <RolePicker value={picked} roles={roles.data} viewerIsOwner={session.role === "owner"} onChange={setChoice} label="Role" />
          </Field>
          {admin && <YourPassword value={password} onChange={setPassword} />}
          <FormError error={invite.error} />
          <div className="form-actions">
            <FormChecks />
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" icon="send" loading={invite.isPending}>Send invite</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/**
 * After an invite goes out: what happened, and the one-time link to copy. Always offered, so the
 * admin can text it too when the email lands in spam or isn't read.
 */
function InviteResult({ sent, message, onClose }: { sent: InviteSent; message: string; onClose: () => void }) {
  const session = useSession();
  return (
    <div className="dialog-body">
      <div className="stack-sm" style={{ justifyItems: "center", textAlign: "center" }}>
        <span className="success-mark"><Icon name="check" size={30} strokeWidth={3} /></span>
        <p style={{ margin: 0 }}>{message}</p>
        {session.config.features.devMail && sent.emailed && <span className="muted small">Test mode: the email is in the local Mailpit inbox (http://localhost:56324).</span>}
      </div>
      {sent.link && (
        <div className="stack-sm">
          {sent.emailed ? (
            <p className="muted small" style={{ margin: 0 }}>
              You can also text them the link. It works once and expires in a day. Only send it to them: it lets whoever opens it into their account.
            </p>
          ) : (
            <div className="callout callout-info">
              <Icon name="info" size={20} />
              <div className="grow small">
                {sent.reason ?? "Email isn't connected yet."} Copy the link and text it to them. It works once and expires in a day.
                {can(session, "apps") || session.role === "owner" ? <> To send invites automatically, <Link to="/settings?tab=email">connect your email</Link>.</> : null}
              </div>
            </div>
          )}
          <Button icon="copy" onClick={() => copyText(sent.link!, "Invite link copied")}>Copy invite link</Button>
        </div>
      )}
      <div className="form-actions"><Button variant="primary" onClick={onClose}>Done</Button></div>
    </div>
  );
}

/** A new invite for someone who hasn't set up their account yet (POST /api/team/:id/invite-link). */
export function ResendInviteDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const email = member.profile?.email;
  const name = member.profile?.full_name || email || "this person";
  const first = name.split(/\s+/)[0];
  // The link opens their account, so for someone with admin access it takes your password.
  const admin = givesAdmin(choiceFor(member), useCompanyRoles().data);
  const [password, setPassword] = useState("");
  const resend = useMutation({
    meta: { inline: true },
    mutationFn: (current_password: string) => api.post<InviteSent>(`/team/${member.user_id}/invite-link`, { current_password: current_password || undefined }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["team-invites", session.company.id] }),
  });
  return (
    <Dialog open onClose={onClose} title={resend.data ? (resend.data.emailed ? "Invite sent" : "Invite ready") : `Resend ${first}'s invite?`}>
      {resend.data ? (
        <InviteResult sent={resend.data} message={resend.data.emailed ? `We emailed ${email ?? first} a new link to set up their account.` : `${first} can join with the link below.`} onClose={onClose} />
      ) : (
        <form className="dialog-body" onSubmit={(e: FormEvent) => { e.preventDefault(); resend.mutate(password); setPassword(""); }}>
          <p style={{ margin: 0 }}>{first} hasn't set up their account yet. This makes a new one-time link for them to join {session.company.name}, and emails it if your email is connected.</p>
          {admin && <YourPassword value={password} onChange={setPassword} autoFocus />}
          <FormError error={resend.error} />
          <div className="form-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" icon="send" loading={resend.isPending}>Resend invite</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function levelHint(choice: string, roles: ReturnType<typeof useCompanyRoles>["data"]): string {
  const patch = patchFor(choice);
  const level = patch.role ?? roles?.find((r) => r.id === patch.role_id)?.base_role;
  return level ? LEVEL_SUMMARY[level] : "";
}

function RolePicker({ value, roles, viewerIsOwner, disabled, label, onChange }: { value: string; roles: ReturnType<typeof useCompanyRoles>["data"]; viewerIsOwner: boolean; disabled?: boolean; label: string; onChange: (choice: string) => void }) {
  const choices = roleChoices(roles, viewerIsOwner);
  return (
    <select className="select input-sm" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {(["Your roles", "Built-in"] as const).map((g) => {
        const items = choices.filter((c) => c.group === g);
        return items.length ? <optgroup key={g} label={g}>{items.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</optgroup> : null;
      })}
    </select>
  );
}
