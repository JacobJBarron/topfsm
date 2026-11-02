/**
 * The bell: notifications for me (from automations such as "a quote was approved") and the
 * company's activity feed. New notifications are checked for every 30 seconds while Crewtavo is open
 * (and whenever it comes back into view), and show as a toast. Opening the bell to "For you" marks
 * what's there as read; the new ones keep their dot until it closes, so it's clear which they were.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase, unwrap } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { Icon, type IconName } from "../ui/Icon";
import { Skeleton } from "../ui/Skeleton";

// By notification kind, and by the first word of an activity's verb ("autopay.failed", "payment_method.expiring") or its subject.
const ICONS: Record<string, IconName> = { quote: "quote", invoice: "invoice", request: "requests", job: "job", visit: "calendar", client: "clients", equipment: "truck", subs: "users", jobs: "job", applicant: "user", autopay: "card", payment_method: "card" };

const subjectPath = (type: string, id: string | null) =>
  !id ? null : ({ client: `/clients/${id}`, request: `/requests/${id}`, quote: `/quotes/${id}`, job: `/jobs/${id}`, invoice: `/invoices/${id}`, equipment: `/equipment/${id}` } as Record<string, string>)[type] ?? null;

export function NotificationsButton() {
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"mine" | "activity">("mine");
  /** Marked read while the bell is open: still shown as new until it closes. */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const key = ["notifications", session.company.id, session.userId];
  const showActivity = hasRole(session, "admin", "office", "estimator");

  const notifications = useQuery({
    queryKey: key,
    meta: { silent: true },
    refetchInterval: 30_000,
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("notifications")
          .select("id, kind, title, body, link, read_at, created_at")
          .eq("company_id", session.company.id)
          .eq("user_id", session.userId)
          .order("created_at", { ascending: false })
          .limit(40),
      ),
  });
  const activity = useQuery({
    queryKey: ["activity", session.company.id],
    enabled: open && tab === "activity",
    meta: { silent: true },
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("activity")
          .select("id, verb, subject_type, subject_id, summary, created_at")
          .eq("company_id", session.company.id)
          .neq("verb", "visit.reminder")
          .order("created_at", { ascending: false })
          .limit(50),
      ),
  });
  const unread = notifications.data?.filter((n) => !n.read_at).length ?? 0;

  // New notifications for me that arrive while Crewtavo is open show as a toast. The first load (and
  // switching company) only marks what's already there as seen.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    seen.current = null;
  }, [session.userId, session.company.id]);
  useEffect(() => {
    const rows = notifications.data;
    if (!rows) return;
    if (!seen.current) {
      seen.current = new Set(rows.map((n) => n.id));
      return;
    }
    const fresh = rows.filter((n) => !seen.current!.has(n.id));
    fresh.forEach((n) => seen.current!.add(n.id));
    for (const n of fresh.filter((n) => !n.read_at).slice(0, 3)) {
      toast.info(n.title, { description: n.body ?? undefined, action: n.link ? { label: "View", onClick: () => navigate(n.link!) } : undefined });
    }
  }, [notifications.data, navigate]);

  useEffect(() => {
    const p = panel.current;
    if (!p) return;
    const onToggle = (e: Event) => {
      const isOpen = (e as Event & { newState: string }).newState === "open";
      setOpen(isOpen);
      if (!isOpen) setFresh(new Set());
      if (isOpen && button.current) {
        const r = button.current.getBoundingClientRect();
        p.style.top = `${r.bottom + 8}px`;
        p.style.left = `${Math.max(12, Math.min(window.innerWidth - p.offsetWidth - 12, r.right - p.offsetWidth))}px`;
        notifications.refetch();
      }
    };
    p.addEventListener("toggle", onToggle);
    return () => p.removeEventListener("toggle", onToggle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markRead = useMutation({
    // Marking happens by itself as the bell opens; if it doesn't go through, the dots simply come back.
    meta: { inline: true },
    mutationFn: async (ids: string[]) =>
      unwrap(await supabase().from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", session.userId).eq("company_id", session.company.id).is("read_at", null).in("id", ids)),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: key });
      const now = new Date().toISOString();
      queryClient.setQueryData<typeof notifications.data>(key, (old) => old?.map((n) => (ids.includes(n.id) ? { ...n, read_at: n.read_at ?? now } : n)));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  // Seen once they're on screen: as the bell opens to "For you", and any that arrive while it's open.
  useEffect(() => {
    if (!open || tab !== "mine") return;
    const ids = notifications.data?.filter((n) => !n.read_at && !fresh.has(n.id)).map((n) => n.id) ?? [];
    if (!ids.length) return;
    setFresh((shown) => new Set([...shown, ...ids]));
    markRead.mutate(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, notifications.data]);

  const openLink = (path: string | null) => {
    panel.current?.hidePopover();
    if (path) navigate(path);
  };

  return (
    <>
      <button ref={button} type="button" className="icon-btn" aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"} title="Notifications" popovertarget={id} aria-expanded={open}>
        <Icon name="bell" size={20} />
        {unread > 0 && <span className="dot-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>
      <div ref={panel} id={id} className="panel" popover="auto" role="dialog" aria-label="Notifications">
        <div className="panel-head">
          <h2>Notifications</h2>
        </div>
        {showActivity && (
          <div className="underline-tabs" role="tablist" style={{ padding: "0 16px" }}>
            <button type="button" role="tab" aria-selected={tab === "mine"} onClick={() => setTab("mine")}>For you{unread ? <span className="badge badge-green">{unread}</span> : null}</button>
            <button type="button" role="tab" aria-selected={tab === "activity"} onClick={() => setTab("activity")}>Activity</button>
          </div>
        )}
        <div className="panel-body">
          {tab === "mine" && (
            <>
              {notifications.isPending && <PanelSkeleton />}
              {notifications.data?.length === 0 && (
                <div className="empty-state empty-state-sm">
                  <span className="empty-icon"><Icon name="bell" size={20} /></span>
                  <h3>You're all caught up</h3>
                </div>
              )}
              {notifications.data?.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className="notice"
                  data-unread={!n.read_at || fresh.has(n.id) || undefined}
                  onClick={() => openLink(n.link)}
                >
                  <span className="n-icon"><Icon name={ICONS[n.kind] ?? "bell"} size={16} /></span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <div className="n-title">{n.title}</div>
                    {n.body && <div className="n-body">{n.body}</div>}
                    <div className="n-time">{timeAgo(n.created_at)}</div>
                  </span>
                </button>
              ))}
            </>
          )}
          {tab === "activity" && (
            <>
              {activity.isPending && <PanelSkeleton />}
              {activity.data?.length === 0 && (
                <div className="empty-state empty-state-sm">
                  <span className="empty-icon"><Icon name="history" size={20} /></span>
                  <h3>No activity yet</h3>
                </div>
              )}
              {activity.data?.map((a) => (
                <button key={a.id} type="button" className="notice" onClick={() => openLink(subjectPath(a.subject_type, a.subject_id))}>
                  <span className="n-icon"><Icon name={ICONS[a.verb.split(".")[0]] ?? ICONS[a.subject_type] ?? "history"} size={16} /></span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <div className="n-body" style={{ color: "var(--ink)" }}>{a.summary}</div>
                    <div className="n-time">{timeAgo(a.created_at)}</div>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function PanelSkeleton() {
  return (
    <div className="skeleton-wrap" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="notice" style={{ pointerEvents: "none" }}>
          <Skeleton width={32} height={32} radius={8} />
          <span style={{ flex: 1, display: "grid", gap: 6 }}>
            <Skeleton width="60%" height={12} />
            <Skeleton width="90%" height={10} />
          </span>
        </div>
      ))}
    </div>
  );
}
