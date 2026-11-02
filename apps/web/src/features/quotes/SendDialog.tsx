/** Email, text or copy a client link for a quote or invoice. */
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useSession } from "@/lib/session";
import { formatPhoneTyping } from "@/lib/validate";

type Channel = "email" | "sms" | "link";

export function SendDialog({
  kind,
  id,
  number,
  email,
  phone,
  textsOffSince,
  onClose,
  onSent,
}: {
  kind: "quote" | "invoice";
  id: string;
  number?: number | null;
  email: string | null;
  phone: string | null;
  /** When the client texted STOP: Crewtavo doesn't text their number, though another one can be texted. */
  textsOffSince?: string | null;
  onClose: () => void;
  onSent?: () => void;
}) {
  const { company, config } = useSession();
  const [channel, setChannel] = useState<Channel>(email ? "email" : phone && !textsOffSince ? "sms" : "link");
  const [to, setTo] = useState(email ?? "");
  const label = `${kind === "quote" ? "Quote" : "Invoice"} #${number ?? ""}`.trim();
  const [subject, setSubject] = useState(`${label} from ${company.name}`);
  const [message, setMessage] = useState("");
  const send = useMutation({
    meta: { inline: true },
    mutationFn: () =>
      api.post<{ link: string; sent: boolean; reason?: string }>(`/${kind}s/${id}/send`, {
        channel,
        to: channel === "link" ? undefined : to.trim() || undefined,
        subject: channel === "email" ? subject.trim() || undefined : undefined,
        message: message.trim() || undefined,
      }),
    onSuccess: (r) => {
      onSent?.();
      if (channel === "link") copyText(r.link, "Link copied. Paste it into a message to your client.");
    },
  });
  useEffect(
    () => setTo(channel === "email" ? email ?? "" : channel === "sms" && !textsOffSince ? formatPhoneTyping(phone ?? "") : ""),
    [channel, email, phone, textsOffSince],
  );

  const unavailable = (channel === "email" && !config.features.email) || (channel === "sms" && !config.features.sms);
  const done = send.data;

  return (
    <Dialog open onClose={onClose} title={done ? (done.sent ? "Sent" : "Link ready") : `Send ${kind}`} description={done ? undefined : `${label} for your client to ${kind === "quote" ? "review and approve" : "view and pay"} online.`}>
      {done ? (
        <div className="dialog-body">
          {done.sent ? (
            <div className="stack-sm" style={{ justifyItems: "center", textAlign: "center", padding: "8px 0" }}>
              <span className="success-mark"><Icon name="check" size={30} strokeWidth={3} /></span>
              <strong style={{ fontSize: 16 }}>{channel === "email" ? `Emailed to ${to}` : `Texted to ${to}`}</strong>
              {config.features.devMail && <span className="muted small">Development mode: it's in the local Mailpit inbox.</span>}
            </div>
          ) : (
            done.reason && done.reason !== "Link only" && <div className="callout callout-warning"><Icon name="alert" size={20} /><div className="grow">{done.reason} Copy the link and send it yourself.</div></div>
          )}
          <div className="field">
            <span>Client link</span>
            <div className="row">
              <input className="input" readOnly value={done.link} onFocus={(e) => e.target.select()} />
              <Button icon="copy" onClick={() => copyText(done.link, "Link copied")}>Copy</Button>
            </div>
          </div>
          <div className="form-actions">
            <a className="btn" href={done.link} target="_blank" rel="noreferrer"><Icon name="external" size={16} />Preview</a>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); send.mutate(); }}>
          <div className="segmented" role="group" aria-label="How to send">
            <button type="button" aria-pressed={channel === "email"} onClick={() => setChannel("email")}>Email</button>
            <button type="button" aria-pressed={channel === "sms"} onClick={() => setChannel("sms")}>Text</button>
            <button type="button" aria-pressed={channel === "link"} onClick={() => setChannel("link")}>Copy link</button>
          </div>
          {textsOffSince && <p className="muted small" style={{ margin: 0 }}>They texted STOP, so their own number can't be texted. You can text a different one.</p>}
          {unavailable && (
            <div className="callout callout-info">
              <Icon name="info" size={20} />
              <div className="grow">{channel === "email" ? "Email" : "Texting"} isn't turned on yet. Use “Copy link” and send it yourself.</div>
            </div>
          )}
          {channel !== "link" && (
            <Field label={channel === "email" ? "To" : "Mobile number"} requiredMessage={channel === "email" ? "Add the email to send it to." : "Add the number to text it to."}>
              <input
                className="input"
                type={channel === "email" ? "email" : "tel"}
                value={to}
                onChange={(e) => setTo(channel === "sms" ? formatPhoneTyping(e.target.value) : e.target.value)}
                required
                placeholder={channel === "email" ? "client@example.com" : "(555) 555-0123"}
              />
            </Field>
          )}
          {channel === "email" && <Field label="Subject"><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} required /></Field>}
          {channel !== "link" && (
            <Field label="Message" optional hint="The link is added automatically.">
              <textarea className="textarea" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={channel === "sms" ? 400 : 4000} placeholder={kind === "quote" ? "Thanks for having us out. Here's what we recommend…" : "Thanks for your business."} />
            </Field>
          )}
          {channel === "link" && <p className="muted" style={{ margin: 0 }}>Copies a link you can paste into any message, and marks the {kind} as sent.</p>}
          <FormError error={send.error} />
          <div className="form-actions">
            <FormChecks />
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" icon={channel === "link" ? "copy" : "send"} loading={send.isPending} disabled={unavailable}>
              {channel === "link" ? "Copy link" : channel === "email" ? "Send email" : "Send text"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
