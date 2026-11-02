/**
 * Links in a message to a client that stand for the client (their review link, a campaign's
 * tracked link, their unsubscribe link): shown in the office as a short label, not the live link.
 * The message is kept as it was sent. An office user who opened the review link to check it would
 * count as the client opening it (which stops their reminders), and the full link fills several
 * lines of the timeline.
 */

const URL_PATTERN = /https?:\/\/[^\s<>"]+/g;

const TRACKED: Array<{ path: RegExp; label: string }> = [
  { path: /^\/api\/public\/r\//, label: "Review link" },
  { path: /^\/api\/public\/c\//, label: "Tracked link" },
  { path: /^\/(u|api\/public\/unsubscribe)\//, label: "Unsubscribe link" },
];

export type MessagePart = { text: string } | { label: string; host: string };

/** A message's text, with each tracked link as its label and the host it's on. */
export function messageParts(body: string | null | undefined): MessagePart[] {
  const text = body ?? "";
  const parts: MessagePart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    let url: URL | null = null;
    try {
      url = new URL(match[0]);
    } catch {
      url = null;
    }
    const tracked = url ? TRACKED.find((t) => t.path.test(url!.pathname)) : undefined;
    if (!url || !tracked) continue;
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ label: tracked.label, host: url.host });
    last = match.index + match[0].length;
  }
  if (last < text.length || !parts.length) parts.push({ text: text.slice(last) });
  return parts;
}
