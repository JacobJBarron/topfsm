/**
 * Kinds of notification a person can also get by email, text or a push to their phone (the bell in
 * the app always shows everything). Mirrors the check on public.notification_prefs.
 */
export const NOTIFICATION_TOPICS = [
  { key: "schedule", label: "My schedule changes", hint: "Added to or taken off a visit, moved or cancelled" },
  { key: "client", label: "Messages from clients", hint: "Texts and Client Hub messages" },
  { key: "time", label: "Clock reminders", hint: "When a clock has been running too long" },
  { key: "equipment", label: "Equipment maintenance", hint: "Service coming due or overdue" },
  // People with the subs area only (packages/core/src/roles.ts).
  { key: "subs", label: "Subcontractors", hint: "Insurance running out, paperwork a sub sends in, and answers to job offers" },
  // Owners, admins and office staff with the marketing area, while Google Business Profile brings
  // reviews in (apps/api/src/services/googleReviews.ts). By email only 1 and 2 stars (byEmail).
  // Owners and admins who connect apps hear when it needs them (reviewNoticesFor).
  { key: "reviews", label: "Google reviews", hint: "New reviews, low ratings first. Email only for 1 and 2 stars" },
  // Subs only: their job offers and their pay (on by default, texts too: an offer waits for their answer).
  { key: "jobs", label: "My jobs", hint: "Job offers, and what you're owed and paid" },
  { key: "alerts", label: "Other alerts", hint: "From your company's automations, like a quote being approved" },
  { key: "chat", label: "Team chat", hint: "When someone @mentions you or your role" },
  // Owners and admins: Railway's warnings (services/hosting.ts) and storage nearing its limit
  // (services/storageUsage.ts). Off Railway, Settings → Profile calls it "Storage".
  { key: "hosting", label: "Railway", hint: "Before the trial runs out, or when the bill goes over the plan or storage fills up" },
] as const;
export type NotificationTopic = (typeof NOTIFICATION_TOPICS)[number]["key"];

export const NOTIFICATION_CHANNELS = ["email", "sms", "push"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Defaults until a person changes them (same as the column defaults). */
export const DEFAULT_NOTIFICATION_PREFS: Record<NotificationChannel, NotificationTopic[]> = {
  email: ["schedule", "jobs", "hosting", "reviews"],
  sms: ["jobs"],
  push: ["schedule", "client", "equipment", "subs", "jobs", "time", "alerts", "chat", "hosting", "reviews"],
};

/**
 * notifications.kind -> topic. Automations use the subject's type (quote, invoice...) as the kind.
 */
export function notificationTopic(kind: string): NotificationTopic {
  if (kind === "schedule" || kind === "client" || kind === "equipment" || kind === "time" || kind === "chat" || kind === "hosting" || kind === "subs" || kind === "jobs") return kind;
  // A new review, one of 1 or 2 stars (or changed down to that), and Google access starting or stopping.
  if (kind === "review" || kind === "review_low" || kind === "review_access") return "reviews";
  return "alerts";
}

/**
 * What the Google reviews topic brings someone, so it's offered to everyone it reaches: "reviews"
 * (new reviews and Google's first sync, for owners, admins and office staff with the marketing
 * area, as private.marketing_office picks them), "access" (Google Business Profile needing a
 * sign-in or a location picked, for owners and admins with the apps area but not marketing, as
 * private.apps_admins picks them), or null. Nothing goes while Marketing is uninstalled.
 */
export function reviewNoticesFor(who: { role: string; permissions: readonly string[] }, marketingInstalled: boolean): "reviews" | "access" | null {
  if (!marketingInstalled) return null;
  const has = (area: string) => who.role === "owner" || who.permissions.includes(area);
  if ((who.role === "owner" || who.role === "admin" || who.role === "office") && has("marketing")) return "reviews";
  if (who.role === "admin" && has("apps")) return "access";
  return null;
}

/** The topic's words for someone who hears only when Google Business Profile needs them. */
export const REVIEW_ACCESS_HINT = "When Google Business Profile needs signing in again or a location picked";

/**
 * Whether a kind goes by email for someone who has its topic on. A review of 3 stars or more is
 * only for the bell and the phone: an email is for the ones to answer first (review_low).
 */
export const byEmail = (kind: string) => kind !== "review";
