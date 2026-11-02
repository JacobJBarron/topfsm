/** One-click unsubscribe from marketing email (/u/:token). Transactional email keeps working. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { publicFetch } from "@/lib/publicApi";

export function UnsubscribePage() {
  const { token = "" } = useParams();
  const isTest = token === "test";
  const status = useQuery({
    queryKey: ["unsubscribe", token],
    enabled: !isTest,
    retry: false,
    queryFn: () => publicFetch<{ company: string; unsubscribed: boolean }>(`/public/unsubscribe/${token}`),
  });
  const change = useMutation({
    mutationFn: (resubscribe: boolean) => publicFetch<{ unsubscribed: boolean }>(`/public/unsubscribe/${token}`, { resubscribe }),
    onSuccess: () => status.refetch(),
  });
  // Unsubscribing is one click: do it as soon as the page opens.
  useEffect(() => {
    if (status.data && !status.data.unsubscribed && !change.isPending && !change.isSuccess) change.mutate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data]);
  useEffect(() => {
    document.title = "Email preferences";
  }, []);

  return (
    <div className="public-page">
      <div className="public-wrap" style={{ maxWidth: 520 }}>
        <div className="card card-pad stack" style={{ textAlign: "center", justifyItems: "center", padding: 32 }}>
          {isTest ? (
            <>
              <span className="success-mark"><Icon name="check" size={30} strokeWidth={3} /></span>
              <h1 style={{ fontSize: 24, letterSpacing: "var(--tracking-display)" }}>This is a test email</h1>
              <p className="muted" style={{ margin: 0 }}>In a real campaign, this link unsubscribes the client from marketing email.</p>
            </>
          ) : status.isPending ? (
            <div className="stack-sm" style={{ width: "100%", justifyItems: "center" }}><Skeleton width={64} height={64} circle /><Skeleton width="70%" height={20} /><Skeleton width="90%" /></div>
          ) : status.error ? (
            <>
              <span className="empty-icon" style={{ width: 52, height: 52, borderRadius: "var(--radius-card)", display: "grid", placeItems: "center", background: "var(--danger-tint)", color: "var(--danger)" }}><Icon name="link" size={24} /></span>
              <h1 style={{ fontSize: 24, letterSpacing: "var(--tracking-display)" }}>This link isn't working</h1>
              <p className="muted" style={{ margin: 0 }}>{(status.error as Error).message}</p>
            </>
          ) : status.data?.unsubscribed ? (
            <>
              <span className="success-mark"><Icon name="check" size={30} strokeWidth={3} /></span>
              <h1 style={{ fontSize: 24, letterSpacing: "var(--tracking-display)" }}>You're unsubscribed</h1>
              <p className="muted" style={{ margin: 0 }}>You won't get marketing emails or review requests from {status.data.company} anymore. You'll still get your quotes, invoices and visit reminders.</p>
              <Button variant="ghost" loading={change.isPending} onClick={() => change.mutate(true)}>Subscribe again</Button>
            </>
          ) : (
            <>
              <span className="success-mark"><Icon name="mail" size={28} /></span>
              <h1 style={{ fontSize: 24, letterSpacing: "var(--tracking-display)" }}>You're subscribed</h1>
              <p className="muted" style={{ margin: 0 }}>You'll get occasional email from {status.data?.company}.</p>
              <Button loading={change.isPending} onClick={() => change.mutate(false)}>Unsubscribe</Button>
            </>
          )}
          <FormError error={change.error} />
        </div>
      </div>
    </div>
  );
}
