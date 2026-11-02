/**
 * Crewtavo - Drive on its Apps page: Install turns it on (the first time it also makes the company's
 * "Company files" folder), and Uninstall turns it off, which takes Drive out of the sidebar and keeps
 * every file and folder (POST /api/drive/enabled, public.drive_set_enabled).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { confirm } from "@/components/ui/Confirm";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

export function useDriveSwitch() {
  const session = useSession();
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.post<{ enabled: boolean }>("/drive/enabled", { enabled }),
    onSuccess: async (res) => {
      // Drive in the sidebar comes from the company's settings.
      await session.refresh();
      await queryClient.invalidateQueries({ queryKey: ["apps"] });
      queryClient.invalidateQueries({ queryKey: ["drive"] });
      return res;
    },
    // Installing shows on the page itself (its ring, then Uninstall), and so do errors: on Railway,
    // what to do when Drive's bucket couldn't be made.
    meta: { success: (res: { enabled: boolean }) => (res.enabled ? null : "Drive uninstalled"), inline: true },
  });
  const turnOff = async () => {
    const ok = await confirm({
      title: "Uninstall Drive?",
      body: "Drive leaves the sidebar for everyone. Your files stay on their clients and jobs, and your company folders come back if you install Drive again.",
      confirmLabel: "Uninstall",
      danger: true,
    });
    if (ok) toggle.mutate(false);
  };
  return { toggle, turnOff };
}
