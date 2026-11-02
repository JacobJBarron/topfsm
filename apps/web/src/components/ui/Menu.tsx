/**
 * Dropdown menu in the browser's top layer (popover="auto"): light dismiss and Escape come free,
 * and it's never clipped by a card or dialog. Arrow keys move between items.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type MenuEntry =
  | { label: string; icon?: IconName; onSelect: () => void; danger?: boolean; disabled?: boolean; hidden?: boolean; /** Shown on hover, e.g. why it's turned off. */ title?: string }
  | { separator: true; hidden?: boolean }
  | { heading: string; hidden?: boolean };

export function Menu({
  items,
  label = "More actions",
  trigger,
  triggerClassName = "btn btn-icon",
  align = "end",
}: {
  items: MenuEntry[];
  label?: string;
  trigger?: ReactNode;
  triggerClassName?: string;
  align?: "start" | "end";
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const m = menu.current;
    if (!m) return;
    const onToggle = (e: Event) => {
      const isOpen = (e as Event & { newState: string }).newState === "open";
      setOpen(isOpen);
      if (isOpen) {
        place();
        focusItem(0);
      }
    };
    m.addEventListener("toggle", onToggle);
    return () => m.removeEventListener("toggle", onToggle);
  });
  const visible = items.filter((i) => !i.hidden);
  if (!visible.some((i) => "onSelect" in i)) return null;

  const place = () => {
    const b = button.current!.getBoundingClientRect();
    const m = menu.current!;
    const width = Math.max(m.offsetWidth, 200);
    const left = align === "end" ? Math.max(8, b.right - width) : Math.min(b.left, window.innerWidth - width - 8);
    const below = b.bottom + 6;
    const fitsBelow = below + m.offsetHeight < window.innerHeight - 8;
    m.style.left = `${left}px`;
    m.style.top = fitsBelow ? `${below}px` : "auto";
    m.style.bottom = fitsBelow ? "auto" : `${window.innerHeight - b.top + 6}px`;
  };

  const focusItem = (dir: 1 | -1 | 0) => {
    const nodes = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)") ?? []);
    if (!nodes.length) return;
    const index = nodes.indexOf(document.activeElement as HTMLButtonElement);
    const next = dir === 0 ? 0 : (index + dir + nodes.length) % nodes.length;
    nodes[next].focus();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={triggerClassName}
        aria-label={label}
        title={trigger ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        popovertarget={id}
      >
        {trigger ?? <Icon name="more" size={20} />}
      </button>
      <div
        ref={menu}
        id={id}
        className="menu"
        role="menu"
        popover="auto"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); focusItem(1); }
          if (e.key === "ArrowUp") { e.preventDefault(); focusItem(-1); }
          if (e.key === "Tab") menu.current?.hidePopover();
        }}
      >
        {visible.map((item, i) =>
          "separator" in item ? (
            <div key={`s${i}`} className="menu-sep" role="separator" />
          ) : "heading" in item ? (
            <div key={`h${i}`} className="menu-label">{item.heading}</div>
          ) : (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="menu-item"
              data-danger={item.danger || undefined}
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                menu.current?.hidePopover();
                button.current?.focus();
                item.onSelect();
              }}
            >
              {item.icon && <Icon name={item.icon} size={16} />}
              {item.label}
            </button>
          ),
        )}
      </div>
    </>
  );
}
