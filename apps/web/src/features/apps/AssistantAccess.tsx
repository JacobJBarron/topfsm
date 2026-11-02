/**
 * AI assistants (Claude, ChatGPT): the ones you've connected, each only reading until you choose what
 * it can change or give it full access; and owner and admin controls for the company: on or off,
 * read-only, and what they did.
 */
import { ASSISTANT_AREA_GROUPS, ASSISTANT_AREAS, ASSISTANT_TOOL_LABELS, areasForRole, describeAssistantAccess, type AssistantAccess as Access, type AssistantArea } from "@crewtavo/core/assistants";
import { PERMISSIONS } from "@crewtavo/core/roles";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { assistantAppFor, disconnect, loadConnections, setAccess, type AssistantConnection } from "./assistantConnections";

/** The assistants the signed-in person has connected; `poll` checks again every so many milliseconds. */
export function useAssistantConnections(poll: number | false = false) {
  const session = useSession();
  return useQuery({ queryKey: ["assistant-connections", session.userId], queryFn: () => loadConnections(supabase()), refetchInterval: poll });
}

export function AssistantAccess() {
  const session = useSession();
  const { company } = session;
  const settings = (company.settings ?? {}) as { assistants?: { enabled?: boolean; read_only?: boolean } };
  const enabled = settings.assistants?.enabled !== false;
  const readOnly = settings.assistants?.read_only === true;
  // The switches change in place, which says it worked.
  const save = useMutation({
    mutationFn: async (patch: { enabled?: boolean; read_only?: boolean }) => {
      const current = unwrap(await supabase().from("companies").select("settings").eq("id", company.id).single());
      const s = (current.settings ?? {}) as Record<string, unknown>;
      unwrap(await supabase().from("companies").update({ settings: { ...s, assistants: { enabled, read_only: readOnly, ...(s.assistants as object), ...patch } } as never }).eq("id", company.id));
    },
    onSuccess: () => session.refresh(),
  });
  const calls = useQuery({
    queryKey: ["assistant-calls", company.id],
    queryFn: async () => {
      const rows = unwrap(await supabase().from("assistant_calls").select("id, user_id, tool, ok, detail, created_at").eq("company_id", company.id).order("created_at", { ascending: false }).limit(15));
      const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))] as string[];
      const people = ids.length ? unwrap(await supabase().from("profiles").select("user_id, full_name").in("user_id", ids)) : [];
      const names = new Map(people.map((p) => [p.user_id, p.full_name]));
      return rows.map((r) => ({ ...r, who: (r.user_id && names.get(r.user_id)) || "Someone" }));
    },
  });

  return (
    <div className="stack-sm" style={{ borderTop: "1px solid var(--divider)", paddingTop: 12 }}>
      <label className="switch-row">
        <input type="checkbox" className="switch" checked={enabled} disabled={save.isPending} onChange={(e) => save.mutate({ enabled: e.target.checked })} />
        Let my team use AI assistants with Crewtavo
      </label>
      <label className="switch-row" style={{ opacity: enabled ? 1 : 0.5 }}>
        <input type="checkbox" className="switch" checked={readOnly} disabled={!enabled || save.isPending} onChange={(e) => save.mutate({ read_only: e.target.checked })} />
        Look things up only, whatever each person allows
      </label>
      <span className="muted small">Each person signs in with their own Crewtavo account, and an assistant can only see and do what that person's role allows.</span>
      <details className="more-options">
        <summary>Recent assistant activity</summary>
        {calls.isPending ? (
          <Skeleton height={60} radius={8} />
        ) : !calls.data?.length ? (
          <span className="muted small">Nothing yet.</span>
        ) : (
          <div className="card" style={{ boxShadow: "none" }}>
            {calls.data.map((c) => (
              <div key={c.id} className="card-row" style={{ fontSize: 13 }}>
                <span className="grow" style={{ minWidth: 0 }}>
                  <strong>{c.who}</strong> · {ASSISTANT_TOOL_LABELS[c.tool] ?? c.tool}
                  {!c.ok && <span style={{ color: "var(--danger)" }}> · didn't work{c.detail ? `: ${c.detail}` : ""}</span>}
                </span>
                <span className="muted small">{timeAgo(c.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </details>
    </div>
  );
}

/**
 * The assistants this person has connected, with what each can change. Everyone has it in Settings
 * → AI assistants, whatever their role; owners and admins also see it on the Claude and ChatGPT
 * pages, under the steps to connect, with only that app's own (`app`) and ones that are neither's.
 */
export function ConnectedAssistants({ card = false, app }: { card?: boolean; app?: string }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const key = ["assistant-connections", session.userId];
  const settings = (session.company.settings ?? {}) as { assistants?: { enabled?: boolean; read_only?: boolean } };
  // The company's own setting comes first (AssistantAccess above).
  const companyNote =
    settings.assistants?.enabled === false
      ? `AI assistants are turned off for ${session.company.name} for now.`
      : settings.assistants?.read_only === true
        ? `For now ${session.company.name} only lets assistants look things up, whatever you choose here.`
        : null;
  const connections = useAssistantConnections();
  const shown = (connections.data ?? []).filter((c) => !app || (assistantAppFor(c.name) ?? app) === app);
  const [editing, setEditing] = useState<AssistantConnection | null>(null);
  const remove = useMutation({
    meta: { success: "Disconnected" },
    mutationFn: (clientId: string) => disconnect(supabase(), clientId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const askDisconnect = async (c: AssistantConnection) => {
    const body = "It stops working with Crewtavo. You can connect it again any time, and it starts out only reading.";
    if (await confirm({ title: `Disconnect ${c.name}?`, body, confirmLabel: "Disconnect", danger: true })) remove.mutate(c.clientId);
  };

  return (
    <div className={card ? "card card-pad stack-sm" : "stack-sm"} style={card ? undefined : { borderTop: "1px solid var(--divider)", paddingTop: 12 }}>
      <strong>Your connected assistants</strong>
      <span className="muted small">
        An assistant you connect can look things up, but can't add or change anything until you choose what it can change. Only one with full access can delete.
      </span>
      {connections.isPending ? (
        <Skeleton height={52} radius={8} />
      ) : connections.error ? (
        <span className="muted small">{(connections.error as Error).message}</span>
      ) : !shown.length ? (
        <span className="muted small">None yet. Once you connect one with the link above, it shows up here.</span>
      ) : (
        <div className="card" style={{ boxShadow: "none" }}>
          {shown.map((c) => (
            <div key={c.clientId} className="card-row" style={{ gap: 10, flexWrap: "wrap" }}>
              <span className="app-icon" data-size="sm" aria-hidden="true">
                {c.logo ? <img src={c.logo} alt="" /> : <span className="app-icon-letter">{c.name.slice(0, 1)}</span>}
              </span>
              <span className="grow" style={{ minWidth: 0 }}>
                <strong>{c.name}</strong>
                <span className="muted small" style={{ display: "block" }}>
                  Connected {timeAgo(c.connectedAt)} · {describeAssistantAccess(c.access)}
                </span>
              </span>
              <Button size="sm" icon="lock" disabled={remove.isPending} onClick={() => setEditing(c)} aria-label={`What ${c.name} can change`}>
                Access
              </Button>
              <Button size="sm" variant="ghost" loading={remove.isPending && remove.variables === c.clientId} disabled={remove.isPending} onClick={() => askDisconnect(c)}>
                Disconnect
              </Button>
            </div>
          ))}
        </div>
      )}
      {companyNote && <span className="muted small">{companyNote}</span>}
      {editing && <AccessDialog connection={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

const LEVELS: Array<{ level: Access["level"]; label: string; hint: string }> = [
  { level: "read", label: "Read only", hint: "Looks things up. Can't add or change anything." },
  { level: "areas", label: "Choose what it can change", hint: "Adds and changes things in the areas you tick, but doesn't delete." },
  { level: "full", label: "Full access", hint: "Everything you can change, including deleting, people and money." },
  { level: "full_no_money", label: "Full access, no money", hint: "Everything you can change, including deleting, except quotes, invoices, payments and pay." },
];

/** What each full level lets it do, for the warning before giving it. */
const FULL_WARNING: Record<"full" | "full_no_money", (name: string) => { title: string; body: string; confirmLabel: string }> = {
  full: (name) => ({
    title: `Give ${name} full access?`,
    body: `${name} will be able to add, change and delete anything you can in Crewtavo: clients, jobs and the schedule, quotes, invoices and payments, people and roles, time and pay, and the business's setup. It still can't change anyone's sign-in or password, connected apps and keys, or its own access, and it can't refund or delete payments. Everything it does shows in Recent assistant activity, and you can switch it back to Read only any time.`,
    confirmLabel: "Give full access",
  }),
  full_no_money: (name) => ({
    title: `Give ${name} full access, without money?`,
    body: `${name} will be able to add, change and delete anything you can in Crewtavo except money: clients, jobs and the schedule, people and roles, time, and the business's setup. It can't change quotes, invoices, payments or pay, anyone's sign-in or password, connected apps and keys, or its own access. Everything it does shows in Recent assistant activity, and you can switch it back to Read only any time.`,
    confirmLabel: "Give full access",
  }),
};

function savedMessage(name: string, access: Access) {
  if (access.level === "full") return `${name} has full access now`;
  if (access.level === "full_no_money") return `${name} has full access, without money, now`;
  if (access.level === "areas") return `${name} can change ${access.areas.map((a) => ASSISTANT_AREAS.find((x) => x.key === a)?.label.toLowerCase() ?? a).join(", ")} now`;
  return `${name} can only read now`;
}

/** Read only, chosen areas, or full access with or without money, which asks first. Areas the person's role can't change aren't offered. */
function AccessDialog({ connection, onClose }: { connection: AssistantConnection; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const offered = areasForRole(session.role, session.role === "owner" ? PERMISSIONS.map((p) => p.key) : session.permissions);
  const [level, setLevel] = useState(connection.access.level);
  const [areas, setAreas] = useState<AssistantArea[]>(connection.access.areas.filter((a) => offered.includes(a)));
  const toggle = (area: AssistantArea, on: boolean) => setAreas(on ? [...areas, area] : areas.filter((a) => a !== area));
  const save = useMutation({
    meta: { inline: true, success: (saved: Access | null) => (saved ? savedMessage(connection.name, saved) : null) },
    mutationFn: async (): Promise<Access | null> => {
      const access: Access = level === "areas" && !areas.length ? { level: "read", areas: [] } : { level, areas: level === "areas" ? areas : [] };
      if ((access.level === "full" || access.level === "full_no_money") && connection.access.level !== access.level) {
        if (!(await confirm({ ...FULL_WARNING[access.level](connection.name), danger: true }))) return null;
      }
      await setAccess(supabase(), session.userId, connection.clientId, access);
      return access;
    },
    onSuccess: (saved) => {
      if (!saved) return;
      queryClient.invalidateQueries({ queryKey: ["assistant-connections", session.userId] });
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} title={`What ${connection.name} can change`} description="It always sees only what your role lets you see.">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sr-only">Access</legend>
          {LEVELS.map((l) => (
            <label key={l.level} className={`card-row choice-row${level === l.level ? " picked" : ""}`} style={{ cursor: "pointer" }}>
              <input type="radio" name="access" checked={level === l.level} onChange={() => setLevel(l.level)} />
              <span className="grow">
                <strong style={{ display: "block" }}>{l.label}</strong>
                <span className="muted small">{l.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {level === "areas" && (
          <fieldset className="stack-sm" style={{ border: 0, padding: "0 0 0 12px", margin: 0 }}>
            <legend className="small strong" style={{ marginBottom: 6 }}>It can change</legend>
            {ASSISTANT_AREA_GROUPS.map((group) => (
              <div key={group} className="stack-sm" style={{ gap: 6 }}>
                <span className="muted small strong">{group}</span>
                {ASSISTANT_AREAS.filter((a) => a.group === group).map((a) => {
                  const allowed = offered.includes(a.key);
                  return (
                    <label key={a.key} className="checkbox" style={{ opacity: allowed ? 1 : 0.55 }}>
                      <input type="checkbox" checked={allowed && areas.includes(a.key)} disabled={!allowed} onChange={(e) => toggle(a.key, e.target.checked)} />
                      <span>
                        {a.label}
                        {!allowed && <span className="muted small" style={{ display: "block", fontWeight: 400 }}>Your role can't change this</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            ))}
            {!areas.length && <span className="muted small">Tick at least one, or it stays read only.</span>}
          </fieldset>
        )}
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}
