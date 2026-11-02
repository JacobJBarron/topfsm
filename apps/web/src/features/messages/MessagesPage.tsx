/** Message center: conversations by client (emails, texts, notes), with replies by email or text. */
import { textsOff, textsOffReason } from "@crewtavo/core/marketing";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { initials } from "@/components/ui/Avatar";
import { ApiError, api, searchTerm, supabase, unwrap } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { hasRole, useSession } from "@/lib/session";
import { ClientPicker, type PickedClient } from "../clients/ClientForm";
import { MessageBody } from "../clients/MessageBody";
import { ConnectEmailHint } from "../settings/ConnectEmailHint";

const FILTERS = [
  { key: "all", label: "All", channels: ["sms", "email", "note", "call"] },
  { key: "in", label: "From clients", channels: ["sms", "email", "note", "call"] },
  { key: "email", label: "Email", channels: ["email"] },
  { key: "sms", label: "Texts", channels: ["sms"] },
] as const;
const ICON: Record<string, IconName> = { email: "mail", sms: "messages", note: "note", call: "phone" };

interface Msg { id: string; channel: string; direction: string; subject: string | null; body: string; status: string; created_at: string; client: { id: string; display_name: string } | null }

export function MessagesPage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [search, setSearch] = useState("");
  const [composing, setComposing] = useState(false);
  const term = useDeferredValue(searchTerm(search));
  const selected = params.get("client");
  const f = FILTERS.find((x) => x.key === filter)!;

  const messages = useQuery({
    queryKey: ["messages", session.company.id, filter],
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    queryFn: async () => {
      let q = supabase()
        .from("messages")
        .select("id, channel, direction, subject, body, status, created_at, client:clients(id, display_name)")
        .eq("company_id", session.company.id)
        .in("channel", [...f.channels])
        .not("client_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(500);
      if (filter === "in") q = q.eq("direction", "in");
      return unwrap(await q) as unknown as Msg[];
    },
  });
  // One row per client: their latest message.
  const conversations = useMemo(() => {
    const seen = new Map<string, Msg & { count: number }>();
    for (const m of messages.data ?? []) {
      if (!m.client) continue;
      const existing = seen.get(m.client.id);
      if (existing) existing.count++;
      else seen.set(m.client.id, { ...m, count: 1 });
    }
    return [...seen.values()].filter((c) => !term || c.client!.display_name.toLowerCase().includes(term.toLowerCase()) || c.body.toLowerCase().includes(term.toLowerCase()));
  }, [messages.data, term]);
  const open = (clientId: string | null) => setParams(clientId ? { client: clientId } : {}, { replace: true });
  // Conversations move to the top as messages come in.
  const list = useListAnimation<HTMLDivElement>();

  return (
    <div className="messages-page stack" data-open={selected ? "" : undefined} style={{ gap: "inherit" }}>
      <PageHeader title="Messages" actions={hasRole(session, "admin", "office", "estimator") && <Button icon="plus" onClick={() => setComposing(true)}>New message</Button>} />
      {!session.config.features.email && !session.config.features.sms && (
        <div className="callout callout-info"><Icon name="info" size={20} /><div className="grow">Email and texting aren't turned on yet. You can still add notes.<ConnectEmailHint /></div></div>
      )}
      <div className="inbox" data-open={selected ? "" : undefined}>
        <section className="inbox-list" aria-label="Conversations">
          <div className="input-group"><span className="addon"><Icon name="search" size={16} /></span><input className="input" type="search" placeholder="Search conversations" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search conversations" /></div>
          <div className="tabs" role="group" aria-label="Filter messages">
            {FILTERS.map((x) => <button key={x.key} type="button" className="tab" aria-pressed={filter === x.key} onClick={() => setFilter(x.key)}>{x.label}</button>)}
          </div>
          <div className={`card${messages.isPlaceholderData ? " is-stale" : ""}`} ref={list}>
            {messages.isPending && <Loading label="Loading conversations">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="card-row"><Skeleton width={36} height={36} circle /><span className="grow stack-sm"><Skeleton width="50%" /><Skeleton width="85%" height={10} /></span></div>)}</Loading>}
            {messages.error && <ErrorState compact error={messages.error} onRetry={() => messages.refetch()} />}
            {messages.data && conversations.length === 0 && <EmptyState compact icon="messages" title={term ? "No conversations match" : "No messages yet"} />}
            {conversations.map((c) => (
              <button key={c.client!.id} type="button" className="card-row inbox-row" aria-current={selected === c.client!.id} onClick={() => open(c.client!.id)}>
                <span className="avatar" style={{ background: c.direction === "in" ? "var(--green)" : undefined }}>{initials(c.client!.display_name)}</span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="row-between"><strong className="ellipsis">{c.client!.display_name}</strong><span className="muted small nowrap">{timeAgo(c.created_at)}</span></span>
                  <span className="muted small ellipsis" style={{ display: "block" }}>
                    <Icon name={ICON[c.channel] ?? "messages"} size={12} /> {c.direction === "in" ? "" : c.direction === "internal" ? "Note: " : "You: "}{c.subject ? `${c.subject} · ` : ""}<MessageBody body={c.body} />
                  </span>
                </span>
                {c.direction === "in" && <span className="unread-dot" title="Latest message is from the client" style={{ marginTop: 6 }} />}
              </button>
            ))}
          </div>
        </section>
        <section className="inbox-thread" style={{ minHeight: 0 }}>
          {selected ? <Thread key={selected} clientId={selected} onBack={() => open(null)} /> : (
            <div className="card" style={{ height: "100%", display: "grid", placeItems: "center" }}>
              <EmptyState icon="messages" title="Pick a conversation" />
            </div>
          )}
        </section>
      </div>
      {composing && <NewMessage onClose={() => setComposing(false)} onSent={(id) => { setComposing(false); open(id); }} />}
    </div>
  );
}

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};

function Thread({ clientId, onBack }: { clientId: string; onBack: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const body = useRef<HTMLDivElement>(null);
  const thread = useQuery({
    queryKey: ["client", clientId, "thread"],
    refetchInterval: 15_000,
    queryFn: async () => {
      const [client, rows] = await Promise.all([
        supabase().from("clients").select("id, display_name, email, phone, sms_opt_out_at").eq("id", clientId).maybeSingle(),
        supabase().from("messages").select("id, channel, direction, subject, body, status, created_at").eq("client_id", clientId).order("created_at", { ascending: false }).limit(300),
      ]);
      return { client: unwrap(client), rows: unwrap(rows).reverse() };
    },
  });
  const count = thread.data?.rows.length ?? 0;
  useEffect(() => {
    // Keep the newest message in view (scroll the thread, never the page).
    const el = body.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: count && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
  }, [count]);
  if (thread.isPending)
    return (
      <Loading label="Loading conversation" className="card thread">
        <div className="thread-head"><Skeleton width={160} height={16} /></div>
        <div className="thread-body">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={i === 1 ? 70 : 48} width={i % 2 ? "55%" : "65%"} radius={12} style={{ alignSelf: i % 2 ? "flex-end" : "flex-start" }} />)}</div>
      </Loading>
    );
  if (thread.error || !thread.data.client) return <div className="card"><ErrorState error={thread.error ?? new ApiError("This client no longer exists. They may have been deleted.", 404)} onRetry={thread.error ? () => thread.refetch() : undefined} /></div>;
  const { client, rows } = thread.data;
  let lastDay = "";
  return (
    <div className="card thread">
      <div className="thread-head">
        <button type="button" className="icon-btn mobile-only" aria-label="Back to conversations" onClick={onBack}><Icon name="arrowLeft" size={20} /></button>
        <span className="who">
          <Link to={`/clients/${client.id}`} className="strong ellipsis" style={{ color: "var(--ink)" }}>{client.display_name}</Link>
          <span className="muted small ellipsis">{[client.phone, client.email].filter(Boolean).join(" · ") || "No phone or email on file"}</span>
        </span>
        {client.phone && <a className="icon-btn" href={`tel:${client.phone}`} aria-label={`Call ${client.display_name}`}><Icon name="phone" size={20} /></a>}
      </div>
      <div className="thread-body" ref={body}>
        {rows.length === 0 && <EmptyState compact icon="messages" title="No messages yet" />}
        {rows.map((m) => {
          const mine = m.direction !== "in";
          const note = m.direction === "internal";
          const day = dayLabel(m.created_at);
          const showDay = day !== lastDay;
          lastDay = day;
          return (
            <Fragment key={m.id}>
              {showDay && <span className="thread-day">{day}</span>}
              <div className="msg" data-mine={mine || undefined} data-note={note || undefined} data-failed={m.status === "failed" || undefined}>
                <div className="msg-bubble">{m.subject && <span className="msg-subject">{m.subject}</span>}<MessageBody body={m.body} /></div>
                <span className="msg-meta">
                  <Icon name={ICON[m.channel] ?? "messages"} size={12} />
                  {note ? "Internal note" : m.channel === "email" ? "Email" : m.channel === "sms" ? "Text" : "Call"} · <span title={formatDateTime(m.created_at)}>{new Date(m.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
                  {m.status === "failed" && <span className="text-danger strong">· Not delivered</span>}
                </span>
              </div>
            </Fragment>
          );
        })}
      </div>
      <Composer key={client.id} client={client} onSent={() => { queryClient.invalidateQueries({ queryKey: ["client", clientId] }); queryClient.invalidateQueries({ queryKey: ["messages", session.company.id] }); }} />
    </div>
  );
}

function Composer({ client, onSent }: { client: { id: string; display_name: string; email: string | null; phone: string | null; sms_opt_out_at: string | null }; onSent: () => void }) {
  const session = useSession();
  const { features } = session.config;
  const [channel, setChannel] = useState<"email" | "sms" | "note">(client.phone && features.sms && !textsOff(client) ? "sms" : client.email && features.email ? "email" : "note");
  const [subject, setSubject] = useState(`A note from ${session.company.name}`);
  const [body, setBody] = useState("");
  const send = useMutation({
    // A note shows up in the thread right away; a sent email or text goes out to the client, so it's said.
    meta: { inline: true, success: () => (channel === "note" ? null : channel === "email" ? "Email sent" : "Text sent") },
    mutationFn: async () => {
      if (channel === "note") return unwrap(await supabase().from("messages").insert({ company_id: session.company.id, client_id: client.id, channel: "note", direction: "internal", body: body.trim() }));
      return api.post("/messages/send", { client_id: client.id, channel, subject: channel === "email" ? subject.trim() : undefined, body: body.trim() });
    },
    onSuccess: () => {
      setBody("");
      onSent();
    },
    // A failed email or text is still recorded (as "not delivered"), so refresh the thread either way.
    onError: onSent,
  });
  const problem =
    channel === "email" ? (!client.email ? "No email address on file for this client." : !features.email ? "Email isn't turned on yet." : null)
    : channel === "sms" ? (!client.phone ? "No phone number on file for this client." : textsOff(client) ? textsOffReason(client.display_name) : !features.sms ? "Texting isn't turned on yet." : null)
    : null;
  const canSend = body.trim().length > 0 && !problem && (channel !== "email" || subject.trim().length > 0);
  return (
    <form className="composer" onSubmit={(e: FormEvent) => { e.preventDefault(); if (canSend && !send.isPending) send.mutate(); }}>
      <div className="row wrap" style={{ gap: 10 }}>
        <div className="segmented" role="group" aria-label="Send as">
          <button type="button" aria-pressed={channel === "sms"} onClick={() => { setChannel("sms"); send.reset(); }}><Icon name="messages" size={14} />Text</button>
          <button type="button" aria-pressed={channel === "email"} onClick={() => { setChannel("email"); send.reset(); }}><Icon name="mail" size={14} />Email</button>
          <button type="button" aria-pressed={channel === "note"} onClick={() => { setChannel("note"); send.reset(); }}><Icon name="note" size={14} />Note</button>
        </div>
        {problem && <span className="small" style={{ color: "var(--warning)", fontWeight: 600 }}>{problem}</span>}
      </div>
      {channel === "email" && <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder="Subject" aria-label="Subject" />}
      <div className="composer-row">
        <textarea
          className="textarea grow"
          rows={1}
          value={body}
          maxLength={channel === "sms" ? 1600 : 10000}
          onChange={(e) => { setBody(e.target.value); if (send.isError) send.reset(); }}
          placeholder={channel === "note" ? "Internal note (the client won't see it)" : `Message ${client.display_name}…`}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
          aria-label="Message"
          disabled={Boolean(problem)}
        />
        <Button type="submit" variant="primary" icon="send" loading={send.isPending} disabled={!canSend} aria-label={channel === "note" ? "Add note" : "Send"} title="Send (⌘/Ctrl + Enter)" />
      </div>
      {channel === "sms" && body.length > 160 && <span className="muted small">{body.length.toLocaleString()} characters · sends as {Math.ceil(body.length / 153)} texts</span>}
      <FormError error={send.error} />
    </form>
  );
}

function NewMessage({ onClose, onSent }: { onClose: () => void; onSent: (clientId: string) => void }) {
  const [client, setClient] = useState<PickedClient>(null);
  return (
    <Dialog open onClose={onClose} title="New message" size="sm">
      <div className="stack-sm">
        <ClientPicker value={client} onChange={(c) => { setClient(c); if (c) onSent(c.id); }} allowCreate={false} />
      </div>
    </Dialog>
  );
}
