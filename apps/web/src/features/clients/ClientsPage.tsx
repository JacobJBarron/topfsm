import { autopaySettings } from "@crewtavo/core/autopay";
import { isPlaceholderEmail } from "@crewtavo/core/email";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { ListPageSkeleton, TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus } from "@/components/ui/StatusPill";
import { api, searchTerm, supabase, unwrap } from "@/lib/api";
import { downloadCsv, toCsv } from "@/lib/csv";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { NewClientDialog, useClientTags } from "./ClientForm";
import { ImportClientsDialog } from "./ImportClientsDialog";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "lead", label: "Leads" },
  { key: "active", label: "Active" },
  { key: "archived", label: "Archived" },
  { key: "no_card", label: "Card not set up" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];
const PAGE = 50;
/** What POST /clients/autopay/invite takes at once. */
const INVITE_CHUNK = 200;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ClientsPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const autopay = autopaySettings(session.company.settings, session.company.trade_preset);
  const money = hasRole(session, "admin", "office") && can(session, "invoices");
  // Card not set up: active clients with no card they agreed to that can be charged, for the office when every client needs one on file.
  const noCard = money && autopay.enabled && autopay.card_required;
  const filters = FILTERS.filter((f) => f.key !== "no_card" || noCard);
  const [filter, setFilter] = useState<FilterKey>(() => (filters.find((x) => x.key === params.get("status"))?.key as FilterKey | undefined) ?? "all");
  const [tag, setTag] = useState("");
  const [sort, setSort] = useState<"name" | "newest">("name");
  const [limit, setLimit] = useState(PAGE);
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [importing, setImporting] = useState(false);
  const [inviting, setInviting] = useState(false);
  const term = useDeferredValue(searchTerm(search));
  const creating = params.get("new") === "1";
  const setCreating = (on: boolean) => setParams(on ? { new: "1" } : {}, { replace: true });
  const canEdit = hasRole(session, "admin", "office", "estimator");
  // Autopay invites are for the people who look after money, once the company has autopay on and can send.
  const invites = money && autopay.enabled && (session.config.features.email || session.config.features.sms);
  const tags = useClientTags();
  useEffect(() => setLimit(PAGE), [filter, tag, term, sort]);

  const counts = useQuery({
    queryKey: ["clients", session.company.id, "counts", noCard],
    meta: { silent: true },
    queryFn: async () => {
      const count = async (status?: string) => {
        let q = supabase().from("clients").select("id", { count: "exact", head: true }).eq("company_id", session.company.id);
        q = status ? q.eq("status", status) : q.neq("status", "archived");
        return (await q).count ?? 0;
      };
      const withoutCard = async () =>
        (await supabase().from("clients").select("id, card:autopay_authorizations(id, method:client_payment_methods!inner(status))", { count: "exact", head: true }).eq("company_id", session.company.id).eq("status", "active")
          .is("card.revoked_at", null).in("card.method.status", ["active", "pending"]).is("card", null)).count ?? 0;
      const [all, lead, active, archived, no_card] = await Promise.all([count(), count("lead"), count("active"), count("archived"), noCard ? withoutCard() : 0]);
      return { all, lead, active, archived, no_card } as Record<FilterKey, number>;
    },
  });

  const clients = useQuery({
    queryKey: ["clients", session.company.id, filter, term, tag, sort, limit],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let q = supabase()
        .from("clients")
        .select("id, display_name, company_name, email, phone, status, tags, created_at, properties(line1, city, region), card:autopay_authorizations(id, method:client_payment_methods!inner(status))", { count: "exact" })
        .eq("company_id", session.company.id)
        .order(sort === "name" ? "display_name" : "created_at", { ascending: sort === "name" })
        .limit(limit);
      // Card not set up: active clients with no agreement in force on a card that can be charged (active,
      // or a bank account being checked). An anti-join: a removed card, or one saved but not agreed to, counts.
      if (filter === "no_card") q = q.eq("status", "active").is("card.revoked_at", null).in("card.method.status", ["active", "pending"]).is("card", null);
      else q = filter === "all" ? q.neq("status", "archived") : q.eq("status", filter);
      if (term) q = q.or(`display_name.ilike.%${term}%,company_name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`);
      if (tag) q = q.contains("tags", [tag]);
      const { data, error, count } = await q;
      return { rows: unwrap({ data, error }), total: count ?? 0 };
    },
  });

  const exportCsv = useMutation({
    meta: { success: (n: number) => `Exported ${n} ${n === 1 ? "client" : "clients"}` },
    mutationFn: async () => {
      const rows: Array<Record<string, unknown>> = [];
      for (let from = 0; ; from += 1000) {
        const page = unwrap(
          await supabase()
            .from("clients")
            .select("display_name, company_name, email, phone, status, lead_source, tags, created_at, properties(line1, city, region, postal_code)")
            .eq("company_id", session.company.id)
            .order("display_name")
            .range(from, from + 999),
        );
        rows.push(
          ...page.map((c) => ({
            ...c,
            tags: c.tags.join("; "),
            address: c.properties[0]?.line1 ?? "",
            city: c.properties[0]?.city ?? "",
            state: c.properties[0]?.region ?? "",
            zip: c.properties[0]?.postal_code ?? "",
            created_at: c.created_at.slice(0, 10),
          })),
        );
        if (page.length < 1000) break;
      }
      const csv = toCsv(rows, [
        { key: "display_name", label: "Name" }, { key: "company_name", label: "Company" }, { key: "email", label: "Email" }, { key: "phone", label: "Phone" },
        { key: "address", label: "Address" }, { key: "city", label: "City" }, { key: "state", label: "State" }, { key: "zip", label: "ZIP" },
        { key: "status", label: "Status" }, { key: "lead_source", label: "Lead source" }, { key: "tags", label: "Tags" }, { key: "created_at", label: "Added" },
      ]);
      downloadCsv(`clients-${new Date().toISOString().slice(0, 10)}.csv`, csv);
      return rows.length;
    },
  });

  const data = clients.data;
  const isFiltered = Boolean(term || tag || filter !== "all");

  if (clients.isPending && !data) return <ListPageSkeleton columns={5} tabs={4} />;

  return (
    <>
      <PageHeader
        title="Clients"
        actions={
          canEdit && (
            <>
              <Menu
                label={invites ? "More actions" : "Import and export"}
                items={[
                  { label: "Import from a spreadsheet", icon: "upload", onSelect: () => setImporting(true) },
                  { label: exportCsv.isPending ? "Exporting…" : "Download as spreadsheet", icon: "download", onSelect: () => exportCsv.mutate(), disabled: exportCsv.isPending },
                  { separator: true, hidden: !invites },
                  { label: "Send autopay invites", icon: "card", onSelect: () => setInviting(true), hidden: !invites },
                ]}
              />
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New client</Button>
            </>
          )
        }
      />
      <div className="toolbar">
        <div className="input-group">
          <span className="addon"><Icon name="search" size={16} /></span>
          <input className="input" type="search" placeholder="Search name, company, email or phone" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search clients" />
        </div>
        <div className="tabs" role="group" aria-label="Filter clients">
          {filters.map((f) => (
            <button key={f.key} type="button" className="tab" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
              {counts.data && <span className="badge">{counts.data[f.key]}</span>}
            </button>
          ))}
        </div>
        {!!tags.data?.length && (
          <select className="select" style={{ width: "auto" }} value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag">
            <option value="">Any tag</option>
            {tags.data.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <select className="select" style={{ width: "auto", marginLeft: "auto" }} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
          <option value="name">Name A–Z</option>
          <option value="newest">Newest first</option>
        </select>
      </div>

      {clients.error && !data ? (
        <div className="card"><ErrorState error={clients.error} onRetry={() => clients.refetch()} /></div>
      ) : clients.isFetching && !data ? (
        <TableSkeleton columns={5} />
      ) : data && data.rows.length === 0 ? (
        <div className="card">
          {filter === "no_card" && !term && !tag ? (
            <EmptyState icon="card" title="Every active client has a card set up" />
          ) : isFiltered ? (
            <EmptyState icon="search" title="No clients match" action={<Button onClick={() => { setSearch(""); setTag(""); setFilter("all"); }}>Clear filters</Button>} />
          ) : (
            <EmptyState
              icon="clients"
              title="No clients yet"
              // New client in the header is the page's one green button; these are the two ways to start.
              action={canEdit && (<><Button icon="plus" onClick={() => setCreating(true)}>Add your first client</Button><Button icon="upload" onClick={() => setImporting(true)}>Import from a spreadsheet</Button></>)}
            />
          )}
        </div>
      ) : (
        data && (
          <div className={`card${clients.isPlaceholderData ? " is-stale" : ""}`}>
            <table className="table table-stack">
              <thead>
                <tr><th>Name</th><th>Contact</th><th>Service address</th><th>Tags</th><th>Status</th></tr>
              </thead>
              <tbody>
                {data.rows.map((c) => (
                  <tr key={c.id} className="row-link" onClick={() => navigate(`/clients/${c.id}`)}>
                    <td>
                      <Link className="cell-link" to={`/clients/${c.id}`} onClick={(e) => e.stopPropagation()}>{c.display_name}</Link>
                      {c.company_name && c.company_name !== c.display_name && <div className="muted small">{c.company_name}</div>}
                    </td>
                    {/* "—" is the one mark for a missing value. A phone alone takes the email's line; on a
                        phone, where rows stack without column names, a dash says nothing and is left out. */}
                    <td>
                      {c.email && <div className="ellipsis" style={{ maxWidth: 240 }}>{c.email}</div>}
                      {c.phone && <div className={c.email ? "muted small" : undefined}>{c.phone}</div>}
                      {!c.email && !c.phone && <span className="muted hide-mobile">—</span>}
                    </td>
                    <td>
                      {c.properties[0] ? [c.properties[0].line1, c.properties[0].city].filter(Boolean).join(", ") : <span className="muted hide-mobile">—</span>}
                      {c.properties.length > 1 && <span className="muted"> +{c.properties.length - 1}</span>}
                    </td>
                    <td>
                      {c.tags.length ? (
                        <div className="row wrap" style={{ gap: 4 }}>{c.tags.slice(0, 3).map((t) => <span key={t} className="tag">{t}</span>)}{c.tags.length > 3 && <span className="tag">+{c.tags.length - 3}</span>}</div>
                      ) : (
                        <span className="muted hide-mobile">—</span>
                      )}
                    </td>
                    <td><EntityStatus kind="client" status={c.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="list-foot">
              <span>Showing {data.rows.length} of {data.total}</span>
              {data.rows.length < data.total && <Button size="sm" loading={clients.isFetching} onClick={() => setLimit((l) => l + PAGE)}>Load more</Button>}
            </div>
          </div>
        )
      )}

      <NewClientDialog open={creating} initialName={search.trim()} onClose={() => setCreating(false)} onCreated={(id) => navigate(`/clients/${id}`)} />
      {importing && <ImportClientsDialog onClose={() => setImporting(false)} />}
      {inviting && <AutopayInvitesDialog onClose={() => setInviting(false)} />}
    </>
  );
}

/** Every page of a PostgREST read, 1000 rows at a time. */
async function allPages<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const batch = unwrap(await page(from, from + 999)) as T[];
    rows.push(...batch);
    if (batch.length < 1000) return rows;
  }
}

/**
 * Send autopay invites to many clients at once: every active client not on autopay, or those with
 * one tag, by email or by text. The server skips anyone invited in the last 7 days and stops at the
 * company's hourly limit; the toast says how many went.
 */
function AutopayInvitesDialog({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const { company } = session;
  const features = session.config.features;
  const tags = useClientTags();
  const [tag, setTag] = useState("");
  const [channel, setChannel] = useState<"email" | "sms">(features.email ? "email" : "sms");
  const who = useQuery({
    queryKey: ["clients", company.id, "autopay-invites", tag],
    queryFn: async () => {
      const [clients, agreed] = await Promise.all([
        allPages<{ id: string; email: string | null; phone: string | null }>((from, to) => {
          let q = supabase().from("clients").select("id, email, phone").eq("company_id", company.id).eq("status", "active").order("id").range(from, to);
          if (tag) q = q.contains("tags", [tag]);
          return q;
        }),
        allPages<{ client_id: string }>((from, to) => supabase().from("autopay_authorizations").select("client_id").eq("company_id", company.id).is("revoked_at", null).order("client_id").range(from, to)),
      ]);
      const on = new Set(agreed.map((a) => a.client_id));
      return clients.filter((c) => !on.has(c.id));
    },
  });
  const rows = who.data ?? [];
  const reachable = rows.filter((c) => (channel === "email" ? Boolean(c.email) && !isPlaceholderEmail(c.email) : Boolean(c.phone)));
  const send = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      let sent = 0;
      let skipped = rows.length - reachable.length;
      const ids = reachable.map((c) => c.id);
      for (let i = 0; i < ids.length; i += INVITE_CHUNK) {
        const r = await api.post<{ sent: number; skipped: number }>("/clients/autopay/invite", { client_ids: ids.slice(i, i + INVITE_CHUNK), channel });
        sent += r.sent;
        skipped += r.skipped;
      }
      return { sent, skipped };
    },
    onSuccess: (r) => {
      toast.success(`Sent ${r.sent}. Skipped ${r.skipped}.`);
      onClose();
    },
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!reachable.length) return;
    const ok = await confirm({
      title: `Send ${plural(reachable.length, "autopay invite")}?`,
      body: "Each client gets a link to save a card or bank account and agree to be charged after each visit. Anyone invited in the last 7 days is skipped.",
      confirmLabel: "Send invites",
    });
    if (ok) send.mutate();
  };
  const without = rows.length - reachable.length;

  return (
    <Dialog open onClose={onClose} title="Send autopay invites" description="A link to save a card and agree to automatic charges. Clients already on autopay aren't sent one.">
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Who">
            <select className="select" value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">All active clients not on autopay</option>
              {tags.data?.map((t) => <option key={t} value={t}>Active clients tagged {t}</option>)}
            </select>
          </Field>
          <Field label="Send by">
            <select className="select" value={channel} onChange={(e) => setChannel(e.target.value as "email" | "sms")}>
              <option value="email" disabled={!features.email}>Email</option>
              <option value="sms" disabled={!features.sms}>Text</option>
            </select>
          </Field>
        </div>
        <span className="muted small" role="status">
          {who.isPending
            ? "Counting clients…"
            : `${plural(rows.length, "client")} not on autopay${tag ? `, tagged ${tag}` : ""}.${without ? ` ${without} without ${channel === "email" ? "an email address" : "a phone number"} ${without === 1 ? "is" : "are"} skipped.` : ""}`}
        </span>
        <FormError error={send.error ?? who.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="send" loading={send.isPending} disabled={who.isPending || !reachable.length}>
            {reachable.length ? `Send ${plural(reachable.length, "invite")}` : "Send invites"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
