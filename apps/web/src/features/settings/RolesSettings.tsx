/**
 * Roles: name a role, pick its access level, and choose which areas it includes. Owners also give a
 * role, or a built-in level, a storage limit for everyone with it (Settings → Storage has the rest).
 */
import { adminLevel, LEVEL_PERMISSIONS, LEVEL_SUMMARY, PERMISSIONS, ROLE_LABELS, STAFF, type Permission, type Role } from "@crewtavo/core/roles";
import { formatBytes } from "@crewtavo/core/storage";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { CardSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { useListAnimation } from "@/lib/motion";
import { useSession } from "@/lib/session";
import { useCompanyRoles, type CompanyRole } from "./roles";
import { gbField, parseGb, refreshStorage, setAllowance, setsAllowances, useStorageOverview } from "./storage";
import { AllowanceDialog, GbInput } from "./StorageSettings";
import { YourPassword } from "./TeamSettings";

// The team's levels. A custom role is never a sub's (the database refuses it).
const LEVELS = STAFF.filter((r) => r !== "owner");
const label = (p: Permission) => PERMISSIONS.find((x) => x.key === p)?.label ?? p;

export function RolesSettings() {
  const session = useSession();
  const queryClient = useQueryClient();
  const roles = useCompanyRoles();
  const team = useQuery({ queryKey: ["team", session.company.id], queryFn: () => api.get<Array<{ role_id: string | null; active: boolean }>>("/team") });
  const [editing, setEditing] = useState<CompanyRole | "new" | null>(null);
  // Storage limits for everyone with a role: owners only.
  const owner = setsAllowances(session);
  const storage = useStorageOverview(owner);
  const [limitFor, setLimitFor] = useState<{ key: string; name: string } | null>(null);
  const storageLimit = (key: string) => storage.data?.roles?.find((r) => r.role_key === key)?.limit_bytes ?? null;
  const remove = useMutation({
    meta: { success: "Role deleted" },
    mutationFn: async (id: string) => unwrap(await supabase().from("company_roles").delete().eq("id", id)),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["company-roles", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["team", session.company.id] });
    },
  });
  const count = (id: string) => team.data?.filter((m) => m.active && m.role_id === id).length ?? 0;
  const cards = useListAnimation<HTMLDivElement>();

  return (
    <div className="stack">
      <div className="row-between">
        <span />
        <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>New role</Button>
      </div>
      {roles.error ? (
        <div className="card"><ErrorState error={roles.error} onRetry={() => roles.refetch()} /></div>
      ) : roles.isPending ? (
        <Loading label="Loading roles"><div className="grid-cards">{[0, 1, 2].map((i) => <CardSkeleton key={i} lines={3} />)}</div></Loading>
      ) : roles.data.length === 0 ? (
        <div className="card"><EmptyState inline title="No custom roles yet" action={<Button onClick={() => setEditing("new")}>Add a role</Button>} /></div>
      ) : (
        <div className="grid-cards" ref={cards}>
          {roles.data.map((r) => (
            <div key={r.id} className="card card-pad stack-sm role-card">
              <div className="row-between" style={{ alignItems: "flex-start" }}>
                <div className="stack-sm" style={{ gap: 2 }}>
                  <strong style={{ fontSize: 16 }}>{r.name}</strong>
                  <span className="muted small">{ROLE_LABELS[r.base_role]} access · {count(r.id)} {count(r.id) === 1 ? "person" : "people"}</span>
                </div>
                <div className="row" style={{ gap: 2 }}>
                  <button type="button" className="icon-btn" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}><Icon name="edit" size={16} /></button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Delete ${r.name}`}
                    onClick={async () => {
                      const n = count(r.id);
                      if (await confirm({ title: `Delete “${r.name}”?`, body: n ? `${n} ${n === 1 ? "person has" : "people have"} this role. They keep ${ROLE_LABELS[r.base_role]} access.` : undefined, confirmLabel: "Delete role", danger: true })) remove.mutate(r.id);
                    }}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                {r.permissions.length ? r.permissions.map((p) => <span key={p} className="chip">{label(p)}</span>) : <span className="muted small">Their own work only</span>}
              </div>
              {owner && storageLimit(r.id) && <span className="muted small">Storage: {formatBytes(storageLimit(r.id)!)} each</span>}
            </div>
          ))}
        </div>
      )}
      <div className="card">
        <div className="card-head"><strong>Built-in roles</strong></div>
        {STAFF.map((r) => (
          <div key={r} className="card-row" style={{ alignItems: "flex-start" }}>
            <strong style={{ width: 110, flex: "none" }}>{ROLE_LABELS[r]}</strong>
            <span className="stack-sm" style={{ gap: 4 }}>
              <span className="muted small">{LEVEL_SUMMARY[r]}</span>
              {owner && storage.data && r !== "owner" && (
                <button type="button" className="link-btn small" style={{ justifySelf: "start" }} onClick={() => setLimitFor({ key: r, name: ROLE_LABELS[r] })} aria-label={`Storage limit for ${ROLE_LABELS[r]}`}>
                  {storageLimit(r) ? `Storage: ${formatBytes(storageLimit(r)!)} each` : "Storage limit"}
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
      {editing && (
        <RoleDialog
          role={editing === "new" ? null : editing}
          existing={roles.data ?? []}
          storage={owner && storage.data ? { limit: editing === "new" ? null : storageLimit(editing.id) } : null}
          onClose={() => setEditing(null)}
        />
      )}
      {limitFor && <AllowanceDialog target={{ role: limitFor.key }} name={limitFor.name} current={storageLimit(limitFor.key)} onClose={() => setLimitFor(null)} />}
    </div>
  );
}

/**
 * A role's name, level and areas. `storage` (owners only) adds its storage limit: the role's limit
 * now, saved with the role (null: none).
 */
export function RoleDialog({ role, existing, storage, onClose }: { role: CompanyRole | null; existing: CompanyRole[]; storage: { limit: number | null } | null; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [name, setName] = useState(role?.name ?? "");
  const [level, setLevel] = useState<Role>(role?.base_role ?? "office");
  const [perms, setPerms] = useState<Permission[]>(role?.permissions ?? [...LEVEL_PERMISSIONS.office]);
  // What's typed, or the role's limit as it stands (which may arrive after the dialog opens).
  const [typed, setTyped] = useState<string | null>(null);
  const size = typed ?? gbField(storage?.limit);
  // A new role saved before its storage limit failed: trying again saves that role, not another.
  const created = useRef<string | null>(null);
  const allowed = LEVEL_PERMISSIONS[level];
  const kept = perms.filter((p) => allowed.includes(p));
  // Saving admin access the role didn't have takes your password (POST and PUT /api/team/roles check it).
  const grants = adminLevel(level, kept) && !(role && adminLevel(role.base_role, role.permissions));
  const [password, setPassword] = useState("");

  const save = useMutation({
    meta: { inline: true, success: role ? "Role saved" : "Role created" },
    mutationFn: async (current_password: string) => {
      const clean = name.trim();
      if (!clean) throw new Error("Give the role a name.");
      const id = role?.id ?? created.current;
      if (existing.some((r) => r.id !== id && r.name.trim().toLowerCase() === clean.toLowerCase())) throw new Error("There's already a role with that name.");
      // Checked before anything's saved, so a size that isn't one saves nothing.
      let limit: number | null | undefined;
      if (storage) {
        const parsed = size.trim() ? parseGb(size) : null;
        if (parsed && "problem" in parsed) throw new Error(`Storage limit: ${parsed.problem}`);
        limit = parsed ? parsed.bytes : null;
      }
      const row = { name: clean, base_role: level, permissions: kept, current_password: current_password || undefined };
      let saved = id;
      if (saved) await api.put(`/team/roles/${saved}`, row);
      else saved = created.current = (await api.post<{ id: string }>("/team/roles", row)).id;
      if (storage && limit !== undefined && gbField(limit) !== gbField(storage.limit)) await setAllowance(session.company.id, { role: saved! }, limit);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company-roles", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["team", session.company.id] });
      if (storage) refreshStorage(queryClient);
      onClose();
    },
  });

  const changeLevel = (next: Role) => {
    setLevel(next);
    // Keep what still applies; a brand-new role starts with everything the level allows.
    setPerms(role ? perms.filter((p) => LEVEL_PERMISSIONS[next].includes(p)) : [...LEVEL_PERMISSIONS[next]]);
  };

  return (
    <Dialog open onClose={onClose} title={role ? `Edit ${role.name}` : "New role"}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(grants ? password : ""); setPassword(""); }}>
        <Field label="Name" requiredMessage="Give the role a name."><input className="input" value={name} onChange={(e) => { setName(e.target.value); save.reset(); }} maxLength={60} placeholder="e.g. Foreman" required autoFocus /></Field>
        <Field label="Access level" hint={LEVEL_SUMMARY[level]}>
          <select className="select" value={level} onChange={(e) => changeLevel(e.target.value as Role)}>
            {LEVELS.map((l) => <option key={l} value={l}>{ROLE_LABELS[l]}</option>)}
          </select>
        </Field>
        {allowed.length > 0 ? (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ marginBottom: 8 }}>Can use</legend>
            <div className="perm-list">
              {PERMISSIONS.filter((p) => allowed.includes(p.key)).map((p) => (
                <label key={p.key} className="switch-row">
                  <input type="checkbox" className="switch" checked={perms.includes(p.key)} onChange={(e) => setPerms(e.target.checked ? [...perms, p.key] : perms.filter((x) => x !== p.key))} />
                  {p.label}
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <p className="muted small" style={{ margin: 0 }}>This level sees only their own visits and time.</p>
        )}
        {storage && (
          <Field label="Storage limit for everyone with this role" optional hint="For each person with this role who has no limit of their own: it stops what they add to Drive, plans and guides. Leave it empty for no limit.">
            <GbInput value={size} placeholder="No limit" onChange={(v) => { setTyped(v); save.reset(); }} />
          </Field>
        )}
        {grants && <YourPassword value={password} onChange={setPassword} />}
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{role ? "Save role" : "Create role"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
