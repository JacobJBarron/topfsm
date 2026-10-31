/** A message's text in the office, its tracked links as short labels (lib/trackedLinks.ts). */
import { Icon } from "@/components/ui/Icon";
import { messageParts } from "@/lib/trackedLinks";

export function MessageBody({ body }: { body: string | null | undefined }) {
  return (
    <>
      {messageParts(body).map((part, i) =>
        "label" in part ? (
          <span key={i} className="tag" title={`${part.host}/… (the client's own link: opening it here would count as theirs)`}>
            <Icon name="link" size={12} /> {part.label}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}
