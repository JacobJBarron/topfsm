import { useId, useState, type KeyboardEvent } from "react";
import { Icon } from "./Icon";

export interface TagOption {
  label: string;
  /** How many clients have it, shown beside it ("12 clients"). */
  count?: number;
}

/**
 * Tags, each removable (square and outlined, so a tag never looks like a status). Enter or comma adds;
 * Backspace on an empty field removes the last. Suggestions (or `options`, with how many have each)
 * open in a list as the field gets focus, narrowed as you type, the ones already chosen left out.
 */
export function TagInput({ value, onChange, suggestions = [], options, placeholder = "Add a tag", max = 20 }: { value: string[]; onChange: (tags: string[]) => void; suggestions?: string[]; options?: TagOption[]; placeholder?: string; max?: number }) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(-1);
  const listId = useId();
  const add = (raw: string) => {
    const tag = raw.trim().replace(/,+$/, "").slice(0, 40);
    setIndex(-1);
    if (!tag || value.length >= max || value.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...value, tag]);
    setDraft("");
  };
  const term = draft.trim().toLowerCase();
  const remaining = (options ?? suggestions.map((label) => ({ label }) as TagOption))
    .filter((s) => !value.some((v) => v.toLowerCase() === s.label.toLowerCase()) && (!term || s.label.toLowerCase().includes(term)))
    .slice(0, 50);
  const showList = open && remaining.length > 0 && value.length < max;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && remaining.length) {
      e.preventDefault();
      setOpen(true);
      setIndex((i) => (i + 1) % remaining.length);
    } else if (e.key === "ArrowUp" && remaining.length) {
      e.preventDefault();
      setIndex((i) => (i <= 0 ? remaining.length - 1 : i - 1));
    } else if (e.key === "Escape" && showList) {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(showList && remaining[index] ? remaining[index].label : draft);
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div className="input" style={{ position: "relative", height: "auto", minHeight: "var(--control)", display: "flex", flexWrap: "wrap", gap: 6, padding: "6px 8px", alignItems: "center" }} onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement)?.focus()}>
      {value.map((tag) => (
        <span key={tag} className="tag">
          {tag}
          <button type="button" aria-label={`Remove ${tag}`} onClick={() => onChange(value.filter((t) => t !== tag))}><Icon name="x" size={12} strokeWidth={2} /></button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => {
          setOpen(true);
          setIndex(-1);
          if (e.target.value.endsWith(",")) add(e.target.value);
          else setDraft(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          if (draft.trim()) add(draft);
        }}
        placeholder={value.length ? "" : placeholder}
        aria-label={placeholder}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-activedescendant={showList && index >= 0 ? `${listId}-${index}` : undefined}
        autoComplete="off"
        style={{ flex: "1 0 100px", border: 0, outline: "none", minWidth: 80, height: 24, background: "transparent" }}
      />
      {showList && (
        <div className="tag-suggest" id={listId} role="listbox" aria-label={placeholder}>
          {remaining.map((s, i) => (
            <button
              key={s.label}
              id={`${listId}-${i}`}
              type="button"
              role="option"
              aria-selected={i === index}
              className="menu-item"
              // Picking keeps the field's focus, so its typed text isn't added as a tag first.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== index && setIndex(i)}
              onClick={(e) => {
                e.stopPropagation();
                add(s.label);
              }}
            >
              <span className="grow ellipsis">{s.label}</span>
              {s.count != null && <span className="muted small tabular">{s.count.toLocaleString()} {s.count === 1 ? "client" : "clients"}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
