/** Notes, emails and texts for a client, newest first, with a note composer (Ctrl/⌘+Enter saves). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, useJustDone } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { hasRole, useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";
import { MessageBody } from "./MessageBody";

const ICON: Record<string, IconName> = { note: "note", email: "mail", sms: "messages", call: "phone" };

function label(m: { channel: string; direction: string; subject: string | null }) {
  if (m.channel === "note") return m.direction === "in" ? "From client" : "Note";
  const what = m.channel === "email" ? "Email" : m.channel === "sms" ? "Text" : "Call";
  return m.direction === "in" ? `${what} from client` : `${what} sent`;
}

const newestFirst = (a: { created_at: string }, b: { created_at: string }) => b.created_at.localeCompare(a.created_at);

export function Timeline({ clientId }: { clientId: string }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [limit, setLimit] = useState(25);
  const listRef = useListAnimation<HTMLDivElement>();
  // Every page size loaded so far is under this key, so adding and deleting reach them all.
  const key = ["client", clientId, "messages"];
  const messages = useQuery({
    queryKey: [...key, limit],
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("messages")
          .select("id, channel, direction, subject, body, status, created_at, sent_by")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false })
          .limit(limit + 1),
      ),
  });
  type Message = NonNullable<typeof messages.data>[number];

  // The note shows at the top of the list and the button says it's added, so there's no toast.
  const add = useMutation({
    mutationFn: async () =>
      unwrap(
        await supabase()
          .from("messages")
          .insert({ company_id: session.company.id, client_id: clientId, channel: "note", direction: "internal", body: note.trim() })
          .select("id, channel, direction, subject, body, status, created_at, sent_by")
          .single(),
      ),
    onSuccess: (row) => {
      setNote("");
      queryClient.setQueriesData<Message[]>({ queryKey: key }, (rows) => (rows && !rows.some((r) => r.id === row.id) ? [row, ...rows] : rows));
      queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const added = useJustDone(add);
  const remove = useMutation({
    // Undo's toast says how it went (removeLater below).
    meta: { inline: true },
    mutationFn: async (id: string) => unwrap(await supabase().from("messages").delete().eq("id", id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  /** Takes the note off the list at once; it's deleted when the Undo toast leaves. */
  const removeLater = (m: Message) =>
    undoable({
      title: "Note deleted",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueriesData<Message[]>({ queryKey: key }, (rows) => rows?.filter((r) => r.id !== m.id));
      },
      restore: () => queryClient.setQueriesData<Message[]>({ queryKey: key }, (rows) => (rows && !rows.some((r) => r.id === m.id) ? [...rows, m].sort(newestFirst) : rows)),
      commit: () => remove.mutateAsync(m.id),
    });

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (note.trim() && !add.isPending) add.mutate();
  };
  const rows = messages.data?.slice(0, limit) ?? [];
  const canDelete = hasRole(session, "admin", "office");

  return (
    <section className="stack" aria-labelledby="timeline-title">
      <h2 id="timeline-title" className="section-title">Notes and messages</h2>
      <form className="card card-pad stack-sm" onSubmit={submit}>
        <label className="sr-only" htmlFor="note">Add a note</label>
        <textarea
          id="note"
          className="textarea"
          placeholder="Add an internal note: gate quirks, preferences, history…"
          value={note}
          maxLength={4000}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        <div className="row-between">
          <span />
          {/* Like a message's send button: nothing to add until there's text. */}
          <Button size="sm" type="submit" loading={add.isPending} done={added} doneLabel="Added" disabled={!note.trim()}>Add note</Button>
        </div>
      </form>
      <div className="card">
        {messages.isPending &&
          [0, 1, 2].map((i) => (
            <div key={i} className="timeline-item">
              <Skeleton width={32} height={32} radius={8} />
              <span className="stack-sm"><Skeleton width={140} height={10} /><Skeleton width="80%" height={12} /></span>
            </div>
          ))}
        {messages.error && <ErrorState compact error={messages.error} onRetry={() => messages.refetch()} />}
        {messages.data?.length === 0 && <EmptyState inline title="No notes or messages yet" />}
        <div ref={listRef} className="timeline">
          {rows.map((m) => (
            <div key={m.id} className="timeline-item" data-kind={m.channel}>
              <span className="t-icon"><Icon name={ICON[m.channel] ?? "note"} size={16} /></span>
              <div style={{ minWidth: 0 }}>
                <div className="row-between">
                  <span className="t-meta">
                    <strong style={{ color: "var(--ink)" }}>{label(m)}</strong>
                    {m.subject ? ` · ${m.subject}` : ""} · <span title={formatDateTime(m.created_at)}>{timeAgo(m.created_at)}</span>
                    {m.status === "failed" && <span style={{ marginLeft: 6 }}><StatusPill label="Failed" tone="danger" /></span>}
                  </span>
                  {m.channel === "note" && m.direction === "internal" && (canDelete || m.sent_by === session.userId) && (
                    <Button size="sm" variant="ghost" icon="trash" aria-label="Delete note" onClick={() => removeLater(m)} />
                  )}
                </div>
                <div className="pre-wrap" style={{ marginTop: 2 }}><MessageBody body={m.body} /></div>
              </div>
            </div>
          ))}
        </div>
        {(messages.data?.length ?? 0) > limit && (
          <div className="list-foot"><span /><Button size="sm" onClick={() => setLimit((l) => l + 25)}>Show older</Button></div>
        )}
      </div>
    </section>
  );
}
