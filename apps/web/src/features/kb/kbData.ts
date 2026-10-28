/** Shared knowledge base data: categories, the page index and what the current person still has to read. */
import { ROLE_LABELS as LEVEL_LABELS, STAFF } from "@crewtavo/core/roles";
import { useQuery } from "@tanstack/react-query";
import { supabase, unwrap } from "@/lib/api";
import { can, hasRole, useSession } from "@/lib/session";

export interface SopIndexRow {
  id: string;
  title: string;
  category_id: string | null;
  required: boolean;
  status: string;
  revision: number;
  updated_at: string;
  audience: string[] | null;
  tags: string[];
  cover_path: string | null;
}

/** Who a guide is for: the team's levels (a sub never reads guides). */
export const ROLE_LABELS: Record<string, string> = Object.fromEntries(STAFF.map((r) => [r, LEVEL_LABELS[r]]));

export function useIsEditor() {
  const session = useSession();
  return hasRole(session, "admin", "office") && can(session, "kb_edit");
}

export function useCategories() {
  const { company } = useSession();
  return useQuery({
    queryKey: ["kb", company.id, "categories"],
    queryFn: async () => unwrap(await supabase().from("sop_categories").select("id, name, icon, sort, cover_path").eq("company_id", company.id).order("sort").order("name")),
  });
}

/** Every page the person can see (crews only get published ones, via RLS) plus their read receipts. */
export function useSopIndex() {
  const { company, userId, role } = useSession();
  return useQuery({
    queryKey: ["kb", company.id, "index"],
    queryFn: async () => {
      const [pages, acks] = await Promise.all([
        supabase().from("sop_pages").select("id, title, category_id, required, status, revision, updated_at, audience, tags, cover_path").eq("company_id", company.id).order("title").limit(2000),
        supabase().from("sop_acknowledgements").select("page_id, revision").eq("company_id", company.id).eq("user_id", userId),
      ]);
      const rows = unwrap(pages) as SopIndexRow[];
      const read = new Set(unwrap(acks).map((a) => `${a.page_id}:${a.revision}`));
      const isRead = (p: SopIndexRow) => read.has(`${p.id}:${p.revision}`);
      const forMe = (p: SopIndexRow) => !p.audience?.length || p.audience.includes(role);
      const toRead = rows.filter((p) => p.required && p.status === "published" && forMe(p) && !isRead(p));
      return { pages: rows, isRead, toRead };
    },
  });
}
