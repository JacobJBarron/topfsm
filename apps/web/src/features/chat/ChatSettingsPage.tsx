/**
 * Chat settings (/chat/settings), for owners and admins.
 *   Channels: add, rename, sort and archive channels.
 *   Roles: how each role looks in chat (name color, its own group in the member list, whether
 *   anyone can @mention it, crew channels for its own crew only) and what it can do in each channel.
 * Roles themselves (who has which) are in Settings → Roles; this page only decides chat.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CHANNEL_PRESETS, CHAT_COLORS, channelSlug, type ChannelPreset, type ChatColor } from "@crewtavo/core/chat";
import { Button, useJustDone } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { api } from "@/lib/api";
import { hasRole, useSession } from "@/lib/session";
import { chatKeys, chatOn } from "./data";
import { Avatar, badgeStyle, ChannelIcon, channelLabel, roleColor } from "./ui";
import s from "./chat.module.css";

interface SettingsChannel {
  id: string;
  kind: "text" | "announcement";
  name: string;
  category: string;
  topic: string | null;
  crew_id: string | null;
  position: number;
  archived: boolean;
}
interface Rule {
  channel_id: string;
  role: string | null;
  role_id: string | null;
  can_see: boolean;
  can_post: boolean;
  can_manage: boolean;
}
interface RoleSetting {
  role: string | null;
  role_id: string | null;
  color: ChatColor;
  show_separately: boolean;
  mentionable: boolean;
  own_crew_only: boolean;
}
interface SettingsRole {
  key: string;
  label: string;
  custom: boolean;
  base_role: string;
  description: string | null;
  people: Array<{ id: string; name: string; color: string | null; photo: string | null }>;
}
interface SettingsData {
  channels: SettingsChannel[];
  rules: Rule[];
  settings: RoleSetting[];
  roles: SettingsRole[];
  crews: Array<{ id: string; name: string }>;
}

const keyOf = (r: { role: string | null; role_id: string | null }) => r.role_id ?? r.role ?? "";
const DEFAULT_SETTING = { color: "default" as ChatColor, show_separately: true, mentionable: true, own_crew_only: false };

export function ChatSettingsPage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "channels" ? "channels" : "roles";
  const allowed = hasRole(session, "admin");
  const data = useQuery({
    queryKey: chatKeys.settings(session.company.id),
    enabled: allowed && chatOn(session),
    queryFn: () => api.get<SettingsData>("/chat/settings"),
  });
  if (!allowed) return <NoAccess title="Chat settings" />;
  if (!chatOn(session)) {
    return (
      <>
        <BackLink to="/chat">Team chat</BackLink>
        <div className="card"><EmptyState icon="chat" title="Team chat is off" action={<Link className="btn btn-primary" to="/apps/team_chat">Install it from Apps</Link>}>Install it to set up its channels and roles.</EmptyState></div>
      </>
    );
  }
  return (
    <>
      <BackLink to="/chat">Team chat</BackLink>
      <PageHeader title="Chat settings">
        <p className="muted" style={{ margin: 0, flexBasis: "100%" }}>
          Who sees each channel goes by role, the same roles as <Link to="/settings?tab=roles">Settings → Roles</Link>. Give someone a different role there.
        </p>
      </PageHeader>
      <div className="segmented" role="group" aria-label="Chat settings" style={{ alignSelf: "flex-start" }}>
        <button type="button" aria-pressed={tab === "roles"} onClick={() => setParams({}, { replace: true })}>Roles</button>
        <button type="button" aria-pressed={tab === "channels"} onClick={() => setParams({ tab: "channels" }, { replace: true })}>Channels</button>
      </div>
      {data.error && <div className="card"><ErrorState error={data.error} onRetry={() => data.refetch()} /></div>}
      {data.isPending && (
        <Loading label="Loading chat settings" className="stack">
          <Skeleton height={44} /><Skeleton height={220} /><Skeleton height={320} />
        </Loading>
      )}
      {data.data && (tab === "roles" ? <RolesTab data={data.data} /> : <ChannelsTab data={data.data} />)}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------------------------

type Access = { can_see: boolean; can_post: boolean; can_manage: boolean };
const NONE: Access = { can_see: false, can_post: false, can_manage: false };

function RolesTab({ data }: { data: SettingsData }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const initial = useMemo(() => snapshot(data), [data]);
  const [draft, setDraft] = useState(initial);
  const [selected, setSelected] = useState(() => data.roles.find((r) => r.key === "crew_lead")?.key ?? data.roles[0]?.key ?? "owner");
  useEffect(() => setDraft(initial), [initial]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  // The bar stays a moment after saving, its button saying so, then leaves. A failure is a toast.
  const save = useMutation({
    mutationFn: () =>
      api.put("/chat/settings/roles", {
        settings: Object.entries(draft.settings).map(([key, v]) => ({ ...refFor(key, data.roles), ...v })),
        rules: Object.entries(draft.rules).map(([k, v]) => {
          const [channel_id, key] = k.split("|");
          return { channel_id, ...refFor(key, data.roles), ...v };
        }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKeys.all(company.id) }),
  });

  const saved = useJustDone(save);
  const role = data.roles.find((r) => r.key === selected) ?? data.roles[0];
  const owner = role.key === "owner";
  const base = role.custom ? role.base_role : null;
  const baseLabel = base ? data.roles.find((r) => r.key === base)?.label ?? base : null;
  const setting = draft.settings[role.key] ?? (base ? draft.settings[base] : undefined) ?? DEFAULT_SETTING;
  const ownSetting = Boolean(draft.settings[role.key]);
  const access = (channel: string): { value: Access; inherited: boolean } => {
    if (owner) return { value: { can_see: true, can_post: true, can_manage: true }, inherited: false };
    const own = draft.rules[`${channel}|${role.key}`];
    if (own) return { value: own, inherited: false };
    if (base) return { value: draft.rules[`${channel}|${base}`] ?? NONE, inherited: true };
    return { value: NONE, inherited: false };
  };
  const setSetting = (patch: Partial<typeof DEFAULT_SETTING>) => setDraft((d) => ({ ...d, settings: { ...d.settings, [role.key]: { ...setting, ...patch } } }));
  const setAccess = (channel: string, what: keyof Access, on: boolean) => {
    const current = access(channel).value;
    let next = { ...current, [what]: on };
    if (what === "can_see" && !on) next = NONE;
    if (what !== "can_see" && on) next.can_see = true;
    setDraft((d) => ({ ...d, rules: { ...d.rules, [`${channel}|${role.key}`]: next } }));
  };
  const followBase = () =>
    setDraft((d) => ({
      settings: Object.fromEntries(Object.entries(d.settings).filter(([k]) => k !== role.key)),
      rules: Object.fromEntries(Object.entries(d.rules).filter(([k]) => !k.endsWith(`|${role.key}`))),
    }));
  const customised = role.custom && (ownSetting || Object.keys(draft.rules).some((k) => k.endsWith(`|${role.key}`)));
  const channels = data.channels.filter((c) => !c.archived);
  const sample = role.people[0]?.name ?? "New teammate";
  const builtIn = data.roles.filter((r) => !r.custom);
  const custom = data.roles.filter((r) => r.custom);

  return (
    <div className="row wrap" style={{ alignItems: "flex-start", gap: 28 }}>
      <nav aria-label="Roles" className="stack-sm" style={{ flex: "1 1 220px", maxWidth: 300, gap: 2 }}>
        <span className="small strong muted" style={{ textTransform: "uppercase", letterSpacing: "var(--tracking-caps)", padding: "0 10px 4px" }}>Built-in roles</span>
        {builtIn.map((r) => <RoleButton key={r.key} role={r} color={(draft.settings[r.key] ?? DEFAULT_SETTING).color} on={r.key === role.key} onClick={() => setSelected(r.key)} />)}
        {custom.length > 0 && <span className="small strong muted" style={{ textTransform: "uppercase", letterSpacing: "var(--tracking-caps)", padding: "14px 10px 4px" }}>Custom roles</span>}
        {custom.map((r) => <RoleButton key={r.key} role={r} color={(draft.settings[r.key] ?? draft.settings[r.base_role] ?? DEFAULT_SETTING).color} on={r.key === role.key} onClick={() => setSelected(r.key)} />)}
        <Link to="/settings?tab=roles" className="small" style={{ padding: "10px" }}>Add or change roles in Settings</Link>
      </nav>

      <div className="stack grow" style={{ flex: "999 1 520px", minWidth: 0 }}>
        <div className="row wrap" style={{ gap: 12 }}>
          <span className={s.jobIcon} style={{ width: 44, height: 44, background: badgeStyle(setting.color).background, color: roleColor(setting.color) }}><Icon name="lock" size={20} /></span>
          <div className="grow" style={{ minWidth: 200 }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "var(--tracking-tight)" }}>{role.label}</h2>
            <span className="muted small">{role.custom ? `Custom role, at the ${baseLabel} level` : owner ? "Can see and do everything in chat" : "Built-in role"}{role.description ? ` · ${role.description}` : ""}</span>
          </div>
          <span className="row" style={{ gap: 0 }}>
            {role.people.slice(0, 5).map((p, i) => (
              <span key={p.id} style={{ marginLeft: i ? -8 : 0, borderRadius: "50%", boxShadow: "0 0 0 2px var(--page)" }}><Avatar name={p.name} color={p.color} photo={p.photo} size={30} /></span>
            ))}
            <span className="muted small" style={{ marginLeft: 10 }}>{role.people.length ? `${role.people.length} ${role.people.length === 1 ? "person" : "people"}` : "Nobody has this role yet"}</span>
          </span>
        </div>

        {customised && (
          <div className="callout">
            <Icon name="info" size={20} />
            <div className="grow"><span>This role has its own chat rules.</span><span style={{ display: "block", fontWeight: 400 }}>Without them it follows {baseLabel}.</span></div>
            <Button size="sm" onClick={followBase}>Follow {baseLabel}</Button>
          </div>
        )}

        <section className="card" aria-labelledby="chat-look">
          <div className="card-head"><h3 id="chat-look">How it looks in chat</h3></div>
          <div className="card-pad stack-sm">
            <strong>Name color</strong>
            <span className="muted small">Names and @mentions for this role use this color.</span>
            <div className="row wrap" style={{ gap: 4, marginLeft: -5 }}>
              {CHAT_COLORS.map((c) => (
                <button key={c.key} type="button" className="icon-btn" style={{ borderRadius: "50%" }} aria-label={c.label} aria-pressed={setting.color === c.key} title={c.label} onClick={() => setSetting({ color: c.key })}>
                  <span style={{ width: 28, height: 28, borderRadius: "50%", display: "grid", placeItems: "center", background: roleColor(c.key), color: "var(--page)", boxShadow: setting.color === c.key ? "0 0 0 2px var(--surface), 0 0 0 4px var(--ink)" : "inset 0 0 0 1px rgba(0,0,0,.08)" }}>
                    {setting.color === c.key && <Icon name="check" size={14} strokeWidth={2} />}
                  </span>
                </button>
              ))}
            </div>
            <div className={s.msg} data-head="" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", padding: 12, marginTop: 6 }}>
              <span className={s.avatar} style={{ background: role.people[0]?.color || "var(--avatar)", cursor: "default" }} aria-hidden="true">{sample.split(/\s+/).map((w) => w[0]).slice(0, 2).join("")}</span>
              <div className={s.msgMain}>
                <div className={s.msgHead}>
                  <span className={s.name} style={{ color: roleColor(setting.color), cursor: "default" }}>{sample}</span>
                  <span className={s.roleBadge} style={badgeStyle(setting.color)}>{role.label}</span>
                  <span className={s.time}>Today at 6:52 AM</span>
                </div>
                <p className={s.body}>Truck 3 is loaded. <span className={s.mention} data-role="" style={badgeStyle(setting.color)}>@{role.label}</span> bring water, it's a hot one.</p>
              </div>
            </div>
          </div>
          <SwitchRow label="Show separately in the member list" hint={`People with this role get their own group, like "${role.label} · ${role.people.length}".`} checked={setting.show_separately} onChange={(v) => setSetting({ show_separately: v })} />
          <SwitchRow label="Anyone can @mention this role" hint={`Typing @${role.label} notifies everyone who has it. When this is off, only owners, admins, the office and a channel's managers can.`} checked={setting.mentionable} onChange={(v) => setSetting({ mentionable: v })} />
          {!owner && <SwitchRow label="Crew channels: their own crew only" hint="Someone on North crew sees North's channel but not the other crews'. Crews are set in Settings → Crews." checked={setting.own_crew_only} onChange={(v) => setSetting({ own_crew_only: v })} />}
        </section>

        <section className="card" aria-labelledby="chat-access">
          <div className="card-head"><h3 id="chat-access">Channel access</h3></div>
          <p className="muted small" style={{ margin: 0, padding: "12px 20px 0" }}>Manage lets someone pin messages, change the topic and remove other people's messages.</p>
          {owner && <div className="callout" style={{ margin: "12px 20px 0" }}><Icon name="lock" size={16} /><div className="grow"><span>Owners can see and do everything. This can't be changed.</span></div></div>}
          <div style={{ overflowX: "auto", padding: "8px 0 12px" }}>
            <table className="table" style={{ minWidth: 520 }}>
              <thead>
                <tr><th scope="col">Channel</th><th scope="col" style={{ textAlign: "center" }}>Can see</th><th scope="col" style={{ textAlign: "center" }}>Can post</th><th scope="col" style={{ textAlign: "center" }}>Can manage</th></tr>
              </thead>
              <tbody>
                {channels.map((c) => {
                  const a = access(c.id);
                  const crew = c.crew_id ? data.crews.find((x) => x.id === c.crew_id)?.name : null;
                  return (
                    <tr key={c.id}>
                      <th scope="row" style={{ fontWeight: 600 }}>
                        <span className="row" style={{ gap: 8 }}>
                          <span className="muted"><ChannelIcon channel={c} size={16} /></span>
                          <span>
                            {c.name}
                            {(crew && setting.own_crew_only) || a.inherited ? (
                              <span className="muted small" style={{ display: "block", fontWeight: 400 }}>
                                {[crew && setting.own_crew_only ? `Only people on ${crew}` : null, a.inherited ? `Same as ${baseLabel}` : null].filter(Boolean).join(" · ")}
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </th>
                      {(["can_see", "can_post", "can_manage"] as const).map((what) => (
                        <td key={what} style={{ textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={a.value[what]}
                            disabled={owner}
                            onChange={(e) => setAccess(c.id, what, e.target.checked)}
                            aria-label={`${role.label} ${what === "can_see" ? "can see" : what === "can_post" ? "can post in" : "can manage"} ${channelLabel(c)}`}
                            style={{ width: 18, height: 18, accentColor: "var(--green)", cursor: owner ? "not-allowed" : "pointer" }}
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {(dirty || saved) && (
          <div className="card row wrap" role="status" style={{ position: "sticky", bottom: 16, padding: "10px 10px 10px 18px", background: "var(--solid)", color: "var(--on-solid)", borderColor: "transparent", boxShadow: "var(--shadow-lg)", zIndex: 5 }}>
            <strong className="grow" style={{ minWidth: 200 }}>{dirty ? "You have unsaved changes." : "Your changes are saved."}</strong>
            {dirty && <Button variant="ghost" style={{ color: "var(--on-solid)" }} onClick={() => setDraft(initial)}>Reset</Button>}
            <Button variant="primary" loading={save.isPending} done={saved} onClick={() => dirty && save.mutate()}>Save changes</Button>
          </div>
        )}
      </div>
    </div>
  );
}

function RoleButton({ role, color, on, onClick }: { role: SettingsRole; color: ChatColor; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="nav-link"
      aria-current={on || undefined}
      style={{ width: "100%", minHeight: 44, border: 0, font: "inherit", fontWeight: 600, background: on ? "var(--raised)" : "none", cursor: "pointer" }}
      onClick={onClick}
    >
      <span style={{ width: 12, height: 12, borderRadius: "50%", background: roleColor(color), flex: "none" }} aria-hidden="true" />
      <span className="grow" style={{ textAlign: "left" }}>{role.label}</span>
      <span className="muted small">{role.people.length}</span>
    </button>
  );
}

function SwitchRow({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="card-row" style={{ cursor: "pointer", alignItems: "center" }}>
      <span className="grow">
        <strong style={{ display: "block" }}>{label}</strong>
        <span className="muted small">{hint}</span>
      </span>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Settings and rules by key, so the page can compare what's changed and send it all back. */
function snapshot(data: SettingsData) {
  const settings: Record<string, typeof DEFAULT_SETTING> = {};
  for (const st of data.settings) settings[keyOf(st)] = { color: st.color, show_separately: st.show_separately, mentionable: st.mentionable, own_crew_only: st.own_crew_only };
  for (const r of data.roles) if (!r.custom && !settings[r.key]) settings[r.key] = { ...DEFAULT_SETTING };
  const rules: Record<string, Access> = {};
  for (const r of data.rules) rules[`${r.channel_id}|${keyOf(r)}`] = { can_see: r.can_see, can_post: r.can_post, can_manage: r.can_manage };
  return { settings, rules };
}

function refFor(key: string, roles: SettingsRole[]) {
  const role = roles.find((r) => r.key === key);
  return role?.custom ? { role: null, role_id: key } : { role: key, role_id: null };
}

// ---------------------------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------------------------

function ChannelsTab({ data }: { data: SettingsData }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<SettingsChannel | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: chatKeys.all(company.id) });
  const update = useMutation({
    mutationFn: ({ id, ...patch }: { id: string; name?: string; category?: string; topic?: string | null; position?: number; archived?: boolean }) => api.patch(`/chat/settings/channels/${id}`, patch),
    onSettled: refresh,
  });
  const active = data.channels.filter((c) => !c.archived);
  const archived = data.channels.filter((c) => c.archived);
  const categories = [...new Map(active.map((c) => [c.category, c])).keys()];

  /** Move a channel one place up or down within its category. */
  const move = async (channel: SettingsChannel, step: -1 | 1) => {
    const ordered = [...active].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    const i = ordered.findIndex((c) => c.id === channel.id);
    const j = i + step;
    if (j < 0 || j >= ordered.length) return;
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    await Promise.all(ordered.map((c, n) => (c.position !== n * 10 ? api.patch(`/chat/settings/channels/${c.id}`, { position: n * 10 }) : null)));
    refresh();
  };

  return (
    <div className="stack">
      <div className="row wrap" style={{ justifyContent: "space-between" }}>
        <span className="muted">Who can see each channel is on the Roles tab.</span>
        <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add a channel</Button>
      </div>
      {categories.map((cat) => (
        <section key={cat} className="card" aria-label={cat}>
          <div className="card-head"><h3>{cat}</h3></div>
          {active.filter((c) => c.category === cat).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)).map((c) => (
            <div key={c.id} className="card-row">
              <span className="muted"><ChannelIcon channel={c} /></span>
              <span className="grow">
                <strong style={{ display: "block" }}>{c.name}</strong>
                <span className="muted small">{c.topic || "No topic"}{c.crew_id ? ` · ${data.crews.find((x) => x.id === c.crew_id)?.name ?? "a crew"}'s channel` : ""}</span>
              </span>
              <Menu
                items={[
                  { label: "Edit", icon: "edit", onSelect: () => setEditing(c) },
                  { label: "Move up", icon: "chevronUp", onSelect: () => void move(c, -1) },
                  { label: "Move down", icon: "chevronDown", onSelect: () => void move(c, 1) },
                  { label: "Archive", icon: "archive", onSelect: () => update.mutate({ id: c.id, archived: true }) },
                ]}
              />
            </div>
          ))}
        </section>
      ))}
      {archived.length > 0 && (
        <section className="card" aria-label="Archived">
          <div className="card-head"><h3>Archived</h3><span className="muted small">Read-only, and only owners, admins and the channel's managers see them.</span></div>
          {archived.map((c) => (
            <div key={c.id} className="card-row">
              <span className="muted"><ChannelIcon channel={c} /></span>
              <span className="grow"><strong>{c.name}</strong></span>
              <Button size="sm" icon="restore" loading={update.isPending && update.variables?.id === c.id} onClick={() => update.mutate({ id: c.id, archived: false })}>Restore</Button>
            </div>
          ))}
        </section>
      )}
      {data.channels.length === 0 && <div className="card"><EmptyState inline title="No channels yet" action={<Button onClick={() => setAdding(true)}>Add a channel</Button>} /></div>}
      <AddChannel open={adding} onClose={() => setAdding(false)} crews={data.crews} categories={categories} onAdded={refresh} />
      <EditChannel channel={editing} onClose={() => setEditing(null)} categories={categories} onSaved={refresh} />
    </div>
  );
}

function AddChannel({ open, onClose, crews, categories, onAdded }: { open: boolean; onClose: () => void; crews: SettingsData["crews"]; categories: string[]; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<ChannelPreset>("everyone");
  const [crew, setCrew] = useState("");
  const [category, setCategory] = useState("");
  const [topic, setTopic] = useState("");
  useEffect(() => {
    if (open) {
      setName("");
      setPreset("everyone");
      setCrew(crews[0]?.id ?? "");
      setCategory("");
      setTopic("");
    }
  }, [open, crews]);
  const add = useMutation({
    meta: { inline: true, success: "Channel added" },
    mutationFn: () => api.post("/chat/settings/channels", { name, preset, category: category || undefined, topic: topic || undefined, crew_id: preset === "crew" ? crew || null : null }),
    onSuccess: () => {
      onAdded();
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) add.mutate();
  };
  return (
    <Dialog open={open} onClose={onClose} title="Add a channel">
      <form className="dialog-body stack" onSubmit={submit}>
        <Field label="Name" hint={preset !== "announcement" && name.trim() ? `It'll be #${channelSlug(name)}` : undefined}>
          <input className="input" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} placeholder={preset === "announcement" ? "Announcements" : "equipment"} required autoFocus />
        </Field>
        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="strong" style={{ marginBottom: 6 }}>Who it's for</legend>
          {CHANNEL_PRESETS.map((p) => (
            <label key={p.key} className={`card-row choice-row${preset === p.key ? " picked" : ""}`} style={{ cursor: "pointer" }}>
              <input type="radio" name="preset" checked={preset === p.key} onChange={() => setPreset(p.key)} />
              <span className="grow"><strong style={{ display: "block" }}>{p.label}</strong><span className="muted small">{p.hint}</span></span>
            </label>
          ))}
        </fieldset>
        {preset === "crew" && (
          <Field label="Crew">
            {crews.length ? (
              <select className="select" value={crew} onChange={(e) => setCrew(e.target.value)}>
                {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            ) : (
              <span className="muted small">No crews yet. Add them in <Link to="/settings?tab=crews">Settings → Crews</Link>; each new crew gets its own channel.</span>
            )}
          </Field>
        )}
        <Field label="Category" optional hint="Channels are grouped by category in the list.">
          <input className="input" list="chat-categories" value={category} maxLength={40} onChange={(e) => setCategory(e.target.value)} placeholder={preset === "crew" ? "Crews" : preset === "office" ? "Office" : "Company"} />
          <datalist id="chat-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Topic" optional>
          <input className="input" value={topic} maxLength={300} onChange={(e) => setTopic(e.target.value)} placeholder="What it's for" />
        </Field>
        <FormError error={add.error} />
        <div className="form-actions">
          <FormChecks />
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={preset === "crew" && !crew}>Add channel</Button>
        </div>
      </form>
    </Dialog>
  );
}

function EditChannel({ channel, onClose, categories, onSaved }: { channel: SettingsChannel | null; onClose: () => void; categories: string[]; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [topic, setTopic] = useState("");
  useEffect(() => {
    if (channel) {
      setName(channel.name);
      setCategory(channel.category);
      setTopic(channel.topic ?? "");
    }
  }, [channel]);
  const save = useMutation({
    meta: { inline: true, success: "Channel saved" },
    mutationFn: () => api.patch(`/chat/settings/channels/${channel!.id}`, { name, category: category.trim() || channel!.category, topic: topic.trim() || null }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  if (!channel) return null;
  const text = channel.kind !== "announcement";
  return (
    <Dialog open onClose={onClose} title={`Edit ${channelLabel(channel)}`} size="sm">
      <form className="dialog-body stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Name" hint={text && name.trim() && channelSlug(name) !== name ? `It'll be #${channelSlug(name)}` : undefined}>
          <input className="input" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Category">
          <input className="input" list="chat-categories-edit" value={category} maxLength={40} onChange={(e) => setCategory(e.target.value)} />
          <datalist id="chat-categories-edit">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Topic" optional>
          <textarea className="textarea" rows={3} value={topic} maxLength={300} onChange={(e) => setTopic(e.target.value)} />
        </Field>
        <FormError error={save.error} />
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}
