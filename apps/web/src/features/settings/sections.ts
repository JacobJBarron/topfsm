/**
 * The sections of Settings each person sees, grouped the way people look for things: you, the
 * business, the team, and what it connects to. Search (the command palette) lists the same ones,
 * with the words people type when they're looking for them.
 */
import type { IconName } from "@/components/ui/Icon";
import { can, hasRole, isSub, type Session } from "@/lib/session";

export type SettingsTab = "profile" | "company" | "payments" | "schedule" | "address" | "hosting" | "storage" | "team" | "roles" | "crews" | "prices" | "templates" | "contracts" | "checklists" | "email" | "calendars" | "assistants" | "maps" | "data" | "license";
export type SettingsItem = { label: string; icon: IconName; keywords: string } & ({ tab: SettingsTab } | { to: string });

export function settingsGroups(session: Session): Array<{ title: string; items: SettingsItem[] }> {
  const isAdmin = hasRole(session, "admin");
  const isOffice = hasRole(session, "admin", "office");
  const managesTeam = isAdmin && can(session, "team");
  const managesSettings = isOffice && can(session, "settings");
  const canSell = hasRole(session, "admin", "office", "estimator");
  const sellsPackages = canSell && can(session, "sales");
  const managesEmail = isAdmin && (can(session, "apps") || can(session, "settings"));
  const connectsApps = isAdmin && can(session, "apps");
  const profile: SettingsItem = { tab: "profile", label: "Profile", icon: "user", keywords: "my account name photo picture avatar password phone notifications theme dark mode appearance spare keys recovery calendar feed directions maps app measure map default imagery" };
  // A sub's settings are their own profile and notifications.
  if (isSub(session)) return [{ title: "You", items: [profile] }];

  const groups: Array<{ title: string; items: Array<SettingsItem | false | undefined> }> = [
    { title: "You", items: [profile] },
    {
      title: "Business",
      items: [
        isAdmin && { tab: "company", label: "Company", icon: "home", keywords: "business name address phone email website brand color sales tax time zone workday hours quotes valid invoice due" },
        // Autopay's terms, timing and cap, and the cards brought in from Stripe: for the people who look after money.
        isAdmin && can(session, "invoices") && { tab: "payments", label: "Payments", icon: "card", keywords: "payments autopay automatic charge card on file saved card bank receipts tips tip stripe limit cap terms refund" },
        isAdmin && { tab: "schedule", label: "Schedule and routes", icon: "navigation", keywords: "routes route optimize organize order stops lawn mowing drive time driving speed shop automatic time steps 5 minutes 15 minutes precision calendar snap" },
        isAdmin && session.config.singleCompany && { tab: "address", label: "Web address", icon: "globe", keywords: "domain url custom domain cloudflare railway link" },
        isAdmin && session.config.singleCompany && session.config.platform === "railway" && { tab: "hosting", label: "Hosting", icon: "cloud", keywords: "railway cost costs bill billing usage plan hobby pro trial credit card limit upgrade memory cpu disk storage server" },
        // Every Crewtavo has files, on Railway or not.
        isAdmin && can(session, "settings") && { tab: "storage", label: "Storage", icon: "hardDrive", keywords: "storage space room disk files photos uploads limit quota full gb tb volume bucket who's using usage per person role trash" },
        canSell && { tab: "prices", label: "Price list", icon: "list", keywords: "services products prices rates costs catalog formulas materials import" },
        sellsPackages && { to: "/packages", label: "Packages", icon: "package", keywords: "packages bundles tiers good better best options choices pictures photos highlights warranty sell offer roof systems" },
        managesSettings && { tab: "templates", label: "Estimate template", icon: "palette", keywords: "estimate quote proposal invoice template letterhead logo color font lettering terms warranty signature signatures license insurance insurer footer print pdf paper look" },
        managesSettings && { tab: "contracts", label: "Contract terms", icon: "file", keywords: "contract builder terms and conditions clauses sections disclaimers fine print agreement warranty payment right to cancel liens permits initials fill-ins legal attorney" },
        isAdmin && { tab: "maps", label: "Maps", icon: "map", keywords: "imagery satellite aerial google esri measure key api cloud default map" },
        managesSettings && { to: "/booking", label: "Online booking", icon: "globe", keywords: "booking form request form website embed intake" },
        session.role === "owner" && { tab: "data", label: "Your data", icon: "download", keywords: "export download backup all data everything spreadsheet spreadsheets csv excel google sheets zip copy move switch leave another app crm jobber housecall pro" },
      ],
    },
    {
      title: "Team",
      items: [
        managesTeam && { tab: "team", label: "People", icon: "users", keywords: "team members staff employees invite users photos pictures" },
        managesTeam && { tab: "roles", label: "Roles", icon: "lock", keywords: "permissions access levels custom roles" },
        managesSettings && { tab: "crews", label: "Crews", icon: "clients", keywords: "teams groups" },
        managesSettings && { tab: "checklists", label: "Checklists", icon: "clipboard", keywords: "forms inspections job checklist" },
      ],
    },
    {
      title: "Automate and connect",
      items: [
        managesEmail && { tab: "email", label: "Email", icon: "mail", keywords: "smtp outgoing mail sender gmail outlook mailbox" },
        connectsApps && { tab: "calendars", label: "Calendars", icon: "calendar", keywords: "google calendar outlook apple ics calendar file import sync" },
        { tab: "assistants", label: "AI assistants", icon: "sparkle", keywords: "claude chatgpt mcp connector ai assistant access permissions read only full access" },
        isOffice && can(session, "automations") && { to: "/automations", label: "Automations", icon: "bolt", keywords: "rules reminders follow ups workflows" },
      ],
    },
    { title: "About", items: [{ tab: "license", label: "Terms and license", icon: "file", keywords: "terms license agpl open source source code version updates about" }] },
  ];
  return groups.map((g) => ({ title: g.title, items: g.items.filter((i): i is SettingsItem => Boolean(i)) })).filter((g) => g.items.length);
}
