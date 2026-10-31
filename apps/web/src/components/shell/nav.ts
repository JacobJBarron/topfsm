import { isStaff, type Permission } from "@crewtavo/core/roles";
import { can, hasRole, type Session } from "@/lib/session";
import type { IconName } from "../ui/Icon";

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  roles?: string[]; // limit to these access levels (owners always see everything)
  perm?: Permission | Permission[]; // and to roles that include this area (all of them, for a list)
  only?: string[]; // only these access levels, owners included (e.g. "My day" for crews); a sub sees nothing else
  except?: string[]; // screens under this one that are a section of their own (not highlighted here)
  also?: string[]; // other screens that count as this section (highlighted in the sidebar)
  keywords?: string; // other words people search for it by
  feature?: "team_chat" | "website" | "careers" | "drive" | "marketing"; // only while the business has this app on (Apps)
  trade?: string; // only for businesses set up for this trade (companies.trade_preset)
}

/**
 * Kept short on purpose: the everyday work first, then a few tools. Setup screens (automations,
 * online booking, apps) live in Settings, the sales board and map measuring open from Quotes.
 */
export const NAV_GROUPS: NavItem[][] = [
  [
    { to: "/", label: "Home", icon: "home", keywords: "dashboard today overview" },
    { to: "/paving", label: "Paving", icon: "paving", roles: ["admin", "office", "estimator"], perm: "sales", trade: "paving", keywords: "takeoff asphalt sealcoat striping stalls parking lot estimate proposal find paving" },
    { to: "/roofing", label: "Roofing", icon: "roofing", roles: ["admin", "office", "estimator"], perm: "sales", trade: "roofing_exteriors", keywords: "roof estimate squares pitch shingles metal tear-off measure good better best proposal" },
    { to: "/field", label: "My day", icon: "clock", only: ["crew_lead", "field_crew", "subcontractor"], except: ["/field/paperwork", "/field/jobs"], keywords: "today my visits route" },
    { to: "/field/jobs", label: "My jobs", icon: "job", only: ["subcontractor"], keywords: "offers accept decline take turn down price owed paid 1099 total" },
    { to: "/field/paperwork", label: "My paperwork", icon: "file", only: ["subcontractor"], keywords: "w-9 w9 insurance certificate liability workers comp upload send" },
    { to: "/schedule", label: "Schedule", icon: "calendar", keywords: "calendar visits appointments dispatch route crews tasks" },
    { to: "/chat", label: "Team chat", icon: "chat", feature: "team_chat", keywords: "chat channels messages talk team crew announcements" },
  ],
  [
    { to: "/clients", label: "Clients", icon: "clients", keywords: "customers contacts properties addresses" },
    { to: "/requests", label: "Requests", icon: "requests", keywords: "inquiries leads assessments website form messages contact form" },
    { to: "/quotes", label: "Quotes", icon: "quote", roles: ["admin", "office", "estimator"], also: ["/pipeline", "/measure"], keywords: "estimates proposals bids" },
    { to: "/jobs", label: "Jobs", icon: "job", keywords: "work orders projects recurring" },
    { to: "/invoices", label: "Invoices", icon: "invoice", roles: ["admin", "office"], perm: "invoices", also: ["/payouts"], keywords: "billing bills payments" },
    { to: "/drive", label: "Drive", icon: "folder", roles: ["admin", "office", "estimator"], feature: "drive", keywords: "files documents folders google drive upload pdf word docx trash" },
  ],
  [
    { to: "/marketing", label: "Marketing", icon: "marketing", roles: ["admin", "office"], perm: "marketing", feature: "marketing", keywords: "campaigns email blasts reviews referrals" },
    { to: "/website", label: "Website", icon: "globe", roles: ["admin", "office"], perm: "marketing", feature: "website", keywords: "site web page blog posts edit content cms sveltia decap" },
    { to: "/finance", label: "Finance", icon: "finance", roles: ["admin", "office"], perm: ["reports", "invoices"], keywords: "reports revenue profit payments money collected net volume fees deposits owed goal" },
    { to: "/metrics", label: "Metrics", icon: "metrics", roles: ["admin", "office"], perm: "reports", keywords: "reports analytics numbers sales conversion lead sources visits hours team clients" },
    { to: "/timesheets", label: "Timesheets", icon: "clock", keywords: "time clock hours payroll" },
    { to: "/applicants", label: "Applicants", icon: "user", roles: ["admin", "office"], perm: "hiring", feature: "careers", keywords: "careers jobs hiring applications apply candidates resumes cv interviews employment" },
    { to: "/subs", label: "Subcontractors", icon: "users", roles: ["admin", "office"], perm: "subs", keywords: "subs contractors 1099 w-9 w9 insurance certificates coi liability workers comp audit paperwork vendors" },
    { to: "/equipment", label: "Equipment", icon: "truck", keywords: "trucks mowers trailers tools fleet maintenance" },
    { to: "/kb", label: "Knowledge base", icon: "book", keywords: "sop procedures training how to guides" },
    { to: "/apps", label: "Apps", icon: "apps", roles: ["admin"], perm: "apps", keywords: "integrations connect app store team chat website forms formspree contact form careers job applications hiring drive files documents google drive marketing reviews referrals campaigns google reviews google business profile quickbooks zoho books stripe payments google calendar outlook twilio texts sms claude chatgpt ai assistant sveltia cms website" },
  ],
];

/** Screens that open from another one rather than the sidebar. Search lists them with the rest. */
export const OTHER_SCREENS: NavItem[] = [
  { to: "/measure", label: "Measure", icon: "area", roles: ["admin", "office", "estimator"], keywords: "measurement map draw area length count square feet acres satellite aerial property" },
  { to: "/pipeline", label: "Sales board", icon: "pipeline", roles: ["admin", "office", "estimator"], keywords: "pipeline leads deals" },
  { to: "/messages", label: "Messages", icon: "messages", keywords: "texts sms email inbox conversations" },
  { to: "/payouts", label: "Stripe deposits", icon: "dollar", roles: ["admin", "office"], perm: "invoices", keywords: "payouts bank stripe fees" },
  // Every file deleted in Crewtavo waits here, for the whole team, whether or not Drive is installed.
  { to: "/drive/trash", label: "Trash", icon: "trash", keywords: "deleted files removed photos restore undo undelete recycle bin get back" },
];

export const SETTINGS_ITEM: NavItem = { to: "/settings", label: "Settings", icon: "settings", also: ["/automations", "/booking"] };
/** A sub's settings are their profile and notifications. */
export const PROFILE_ITEM: NavItem = { to: "/settings?tab=profile", label: "Profile", icon: "user", only: ["subcontractor"] };

/** The sidebar's last link: Settings, or a sub's profile. */
export const settingsItem = (session: { role: string }) => (session.role === "subcontractor" ? PROFILE_ITEM : SETTINGS_ITEM);

/** Bottom bar on phones for the team; everything else lives under More. */
export const MOBILE_TABS: NavItem[] = [
  { to: "/", label: "Home", icon: "home" },
  { to: "/field", label: "My day", icon: "clock" },
  { to: "/schedule", label: "Schedule", icon: "calendar" },
  { to: "/chat", label: "Chat", icon: "chat", feature: "team_chat" },
  { to: "/clients", label: "Clients", icon: "clients" },
];
/** A sub's bottom bar: all they have, so there's no More. */
export const SUB_TABS: NavItem[] = [
  { to: "/field", label: "My day", icon: "clock", only: ["subcontractor"], except: ["/field/paperwork", "/field/jobs"] },
  { to: "/field/jobs", label: "My jobs", icon: "job", only: ["subcontractor"] },
  { to: "/field/paperwork", label: "Paperwork", icon: "file", only: ["subcontractor"] },
  { to: "/settings?tab=profile", label: "Profile", icon: "user", only: ["subcontractor"] },
];

/** The phone's bottom bar for this person. */
export function mobileTabs(session: { role: string; company?: { settings?: Record<string, unknown> | null } }): NavItem[] {
  if (session.role === "subcontractor") return SUB_TABS;
  return MOBILE_TABS.filter((item) => !item.feature || featureOn(session.company?.settings, item.feature));
}

/**
 * The screens a sub can open: My day and their visits, My jobs and an offer in it, My paperwork, and
 * Settings (which shows them only their profile). Anything else opened by its address goes to My day.
 */
export const subCanOpen = (pathname: string) => /^\/field(\/paperwork|\/jobs(\/[^/]+)?|\/visits\/[^/]+)?\/?$/.test(pathname) || /^\/settings\/?$/.test(pathname);

/** What people start most often: the sidebar's Create menu, the phone's More sheet and search. */
export function createItems(session: Pick<Session, "role" | "permissions">): Array<{ to: string; label: string; icon: IconName; keywords: string }> {
  if (!isStaff(session.role)) return [];
  const canSell = hasRole(session, "admin", "office", "estimator");
  return [
    ...(canSell
      ? [
          { to: "/clients?new=1", label: "Client", icon: "clients" as const, keywords: "add customer lead" },
          { to: "/requests?new=1", label: "Request", icon: "requests" as const, keywords: "inquiry lead" },
          ...(can(session, "sales") ? [{ to: "/quotes?new=1", label: "Quote", icon: "quote" as const, keywords: "estimate proposal" }] : []),
          { to: "/measure", label: "Measurement", icon: "area" as const, keywords: "measure map draw area" },
        ]
      : []),
    ...(hasRole(session, "admin", "office") && can(session, "invoices") ? [{ to: "/invoices?new=1", label: "Invoice", icon: "invoice" as const, keywords: "bill" }] : []),
    ...(hasRole(session, "admin", "office", "estimator", "crew_lead") && can(session, "schedule") ? [{ to: "/schedule?new=1", label: "Visit or task", icon: "calendar" as const, keywords: "schedule appointment" }] : []),
  ];
}

/** Whether a person sees a navigation item. */
export function navVisible(session: { role: string; permissions: readonly string[]; company?: { settings?: Record<string, unknown> | null; trade_preset?: string } }, item: NavItem): boolean {
  // A sub sees only what's listed for them by name: everything else is the team's.
  if (session.role === "subcontractor") return Boolean(item.only?.includes("subcontractor"));
  if (item.feature && !featureOn(session.company?.settings, item.feature)) return false;
  if (item.trade && session.company?.trade_preset !== item.trade) return false;
  if (item.only) return item.only.includes(session.role);
  if (session.role === "owner") return true;
  if (item.roles && !item.roles.includes(session.role)) return false;
  return [item.perm ?? []].flat().every((p) => session.permissions.includes(p));
}

/**
 * An app the business turned on in Apps: companies.settings.team_chat.enabled, .careers.enabled,
 * .drive.enabled, .marketing.enabled, or .website.enabled once its editor is added.
 */
export function featureOn(settings: Record<string, unknown> | null | undefined, feature: NonNullable<NavItem["feature"]>): boolean {
  return (settings?.[feature] as { enabled?: boolean } | undefined)?.enabled === true;
}
