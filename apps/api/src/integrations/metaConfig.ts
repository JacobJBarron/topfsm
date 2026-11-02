/**
 * Meta's Graph API version and what sign-in asks for, in a file of their own: the app registry
 * (registry.ts) reads them, and integrations/meta.ts, which needs the registry's errors, uses them.
 */

/** The Graph API version every call uses (v26.0 came out on 29 July 2026). */
export const GRAPH_VERSION = "v26.0";
export const DIALOG = "https://www.facebook.com";

/** What sign-in asks for: list and post to the Page, Pages in a business portfolio, and Instagram publishing. */
export const META_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "business_management", "instagram_basic", "instagram_content_publish"] as const;
/** Instagram publishing for a Page in a business portfolio also needs these (Meta's content publishing guide). */
export const META_ADS_SCOPES = ["ads_management", "ads_read"] as const;
