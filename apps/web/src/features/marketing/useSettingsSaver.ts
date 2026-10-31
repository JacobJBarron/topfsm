/**
 * Company settings for Marketing, merged into companies.settings (owners and admins only). The patch
 * can be worked out from the settings as they are when it saves, for a part of them another screen
 * also saves (settings.reviews). Its Save button says when it's saved (useJustDone).
 */
import { useMutation } from "@tanstack/react-query";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";

type Settings = Record<string, unknown>;

export function useSettingsSaver() {
  const session = useSession();
  return useMutation({
    meta: { inline: true },
    mutationFn: async (patch: Settings | ((current: Settings) => Settings)) => {
      const current = unwrap(await supabase().from("companies").select("settings").eq("id", session.company.id).single());
      const settings = (current.settings ?? {}) as Settings;
      const change = typeof patch === "function" ? patch(settings) : patch;
      unwrap(await supabase().from("companies").update({ settings: { ...settings, ...change } as never }).eq("id", session.company.id));
    },
    onSuccess: () => session.refresh(),
  });
}
