/**
 * Writing a marketing email, shared by a one-off campaign (CampaignPage) and the automated
 * campaigns' Edit email (AutomatedCampaigns): the subject, the message with its {{tokens}} to
 * insert where the cursor is, a preview with sample values, and sending yourself a test. The preview
 * draws a link on a line of its own as the button clients get (lib/email.ts on the server).
 */
import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";

export interface Token {
  token: string;
  label: string;
}

/** The message with sample values in place of its tokens. */
export const renderSample = (text: string, vars: Record<string, string>) => text.replace(/\{\{\s*([a-z_.]+)\s*\}\}/gi, (_, key: string) => vars[key] ?? "");

export function SubjectField({ value, onChange, placeholder, disabled }: { value: string; onChange: (subject: string) => void; placeholder?: string; disabled?: boolean }) {
  return (
    <Field label="Subject line">
      <input className="input" value={value} maxLength={200} disabled={disabled} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </Field>
  );
}

export function MessageField({ value, onChange, tokens, hint, disabled }: { value: string; onChange: (body: string) => void; tokens: Token[]; hint?: string; disabled?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (token: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <>
      <Field label="Message" hint={hint}>
        <textarea ref={ref} className="textarea" style={{ minHeight: 240 }} value={value} maxLength={20000} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      </Field>
      {!disabled && (
        <div className="token-list">
          {tokens.map((t) => (
            <button key={t.token} type="button" className="token" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(`{{${t.token}}}`)}>{t.label}</button>
          ))}
        </div>
      )}
    </>
  );
}

const LINK_TOKEN = /^\{\{\s*link\s*\}\}$/i;

/**
 * The message as paragraphs, as the email has them: {{link}} on a line of its own is a button named
 * `linkLabel`, and another link on its own line is an "Open" button.
 */
export function previewParagraphs(body: string, vars: Record<string, string>, linkLabel: string): Array<{ text: string; button?: string }> {
  return body
    .trim()
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => {
      const text = renderSample(p, vars).trim();
      if (LINK_TOKEN.test(p.trim())) return { text, button: linkLabel };
      if (/^https?:\/\/\S+$/.test(text)) return { text, button: "Open" };
      return { text: renderSample(p, vars) };
    });
}

export function EmailPreview({ companyName, subject, body, vars, unsubscribe, linkLabel }: { companyName: string; subject: string; body: string; vars: Record<string, string>; unsubscribe: boolean; linkLabel: string }) {
  const paragraphs = previewParagraphs(body, vars, linkLabel);
  return (
    <div className="stack-sm">
      <strong>Preview</strong>
      <div className="email-preview">
        <div className="sheet-inner">
          <div className="muted small" style={{ marginBottom: 6 }}>Subject: <strong style={{ color: "var(--ink)" }}>{renderSample(subject, vars) || "No subject"}</strong></div>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>{companyName}</div>
          {paragraphs.length ? (
            paragraphs.map((p, i) => (p.button ? <p key={i} className="email-button-row"><span className="email-button" title={p.text}>{p.button}</span></p> : <p key={i} className="email-paragraph">{p.text}</p>))
          ) : (
            <span className="muted">Your message appears here.</span>
          )}
        </div>
        <div className="email-foot">{companyName}{unsubscribe ? " · Unsubscribe" : ""}</div>
      </div>
    </div>
  );
}

/**
 * Send yourself (or whoever's typed) a test copy, posted to `path` with what's being written. Over
 * another dialog, `onSent` says it went there instead of a toast, which would sit on its buttons.
 */
export function TestEmailDialog({ path, body, defaultTo, onClose, onSent }: { path: string; body?: Record<string, unknown>; defaultTo: string; onClose: () => void; onSent?: (to: string) => void }) {
  const [to, setTo] = useState(defaultTo);
  const test = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ to: string }>(path, { ...body, to: to.trim() }),
    onSuccess: (r) => {
      if (onSent) onSent(r.to);
      else toast.success(`Test sent to ${r.to}`);
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Send a test" size="sm">
      <form onSubmit={(e) => { e.preventDefault(); test.mutate(); }}>
        <Field label="Send to"><input className="input" type="email" value={to} onChange={(e) => setTo(e.target.value)} required /></Field>
        <FormError error={test.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="mail" loading={test.isPending}>Send test</Button>
        </div>
      </form>
    </Dialog>
  );
}
