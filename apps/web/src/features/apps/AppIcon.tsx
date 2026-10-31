/** App icons: each app's own logo on a white tile, like a phone's home screen (see assets/apps/README.md). */
import { Link } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import abcSupplyLogo from "@/assets/apps/abc-supply.svg";
import chatgptLogo from "@/assets/apps/chatgpt.svg";
import claudeLogo from "@/assets/apps/claude.svg";
import crewtavoLogo from "@/assets/apps/crewtavo.svg";
import falLogo from "@/assets/apps/fal.svg";
import googleBusinessLogo from "@/assets/apps/google-business.svg";
import googleCalendarLogo from "@/assets/apps/google-calendar.svg";
import outlookLogo from "@/assets/apps/outlook.svg";
import quickbooksLogo from "@/assets/apps/quickbooks.svg";
import stripeLogo from "@/assets/apps/stripe.svg";
import sveltiaLogo from "@/assets/apps/sveltia.svg";
import twilioLogo from "@/assets/apps/twilio.svg";
import zohoLogo from "@/assets/apps/zoho.svg";
import type { AppRow } from "./catalog";

const LOGOS: Record<string, string> = {
  team_chat: crewtavoLogo,
  website_analytics: crewtavoLogo,
  website_forms: crewtavoLogo,
  careers: crewtavoLogo,
  drive: crewtavoLogo,
  marketing: crewtavoLogo,
  google_business: googleBusinessLogo,
  google_calendar: googleCalendarLogo,
  zoho_calendar: zohoLogo,
  outlook_calendar: outlookLogo,
  quickbooks: quickbooksLogo,
  zoho_books: zohoLogo,
  stripe: stripeLogo,
  abc_supply: abcSupplyLogo,
  twilio: twilioLogo,
  anthropic: claudeLogo,
  fal: falLogo,
  chatgpt: chatgptLogo,
  sveltia: sveltiaLogo,
};
/** Wordmark-shaped logos get more width. */
const WIDE = new Set(["zoho_calendar", "zoho_books", "abc_supply"]);
/** Logos that are already a whole app icon fill the tile. */
const FULL = new Set(["sveltia"]);

export type IconSize = "sm" | "md" | "lg";

export function AppIcon({ id, name, size = "md" }: { id: string; name: string; size?: IconSize }) {
  if (id === "apple_calendar") {
    // Like the calendar app on a phone: today's weekday and date.
    const now = new Date();
    return (
      <span className="app-icon app-icon-date" data-size={size} aria-hidden="true">
        <span>{now.toLocaleDateString("en-US", { weekday: "short" })}</span>
        <strong>{now.getDate()}</strong>
      </span>
    );
  }
  if (id === "ics_calendar") {
    return (
      <span className="app-icon app-icon-generic" data-size={size} aria-hidden="true">
        <Icon name="calendar" size={size === "lg" ? 50 : size === "md" ? 28 : 20} />
      </span>
    );
  }
  const src = LOGOS[id];
  return (
    <span className="app-icon" data-size={size} data-wide={WIDE.has(id) || undefined} data-full={FULL.has(id) || undefined} aria-hidden="true">
      {src ? <img src={src} alt="" /> : <span className="app-icon-letter">{name.slice(0, 1)}</span>}
    </span>
  );
}

/** Installed, or needs attention: a small badge on the icon's corner. */
export function appBadge(app: AppRow, installed: boolean): { tone: "good" | "danger"; label: string } | null {
  if (app.status === "error" || app.calendar_errors) return { tone: "danger", label: "Needs attention" };
  if (!installed) return null;
  return { tone: "good", label: app.calendars ? `${app.calendars} ${app.calendars === 1 ? "calendar" : "calendars"}` : "Installed" };
}

/** An app on the grid: its icon with its name beneath. */
export function AppTile({ app, installed }: { app: AppRow; installed: boolean }) {
  const badge = appBadge(app, installed);
  return (
    <Link to={`/apps/${app.id}`} className="app-tile" aria-label={`${app.name}${badge ? `, ${badge.label}` : ""}`}>
      <span className="app-tile-icon">
        <AppIcon id={app.id} name={app.name} />
        {badge && (
          <span className="app-badge" data-tone={badge.tone} aria-hidden="true">
            <Icon name={badge.tone === "good" ? "check" : "alert"} size={12} strokeWidth={2} />
          </span>
        )}
      </span>
      <span className="app-tile-name">{app.name}</span>
    </Link>
  );
}
