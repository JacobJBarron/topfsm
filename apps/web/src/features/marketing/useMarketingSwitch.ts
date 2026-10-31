/**
 * Crewtavo - Marketing on its Apps page: Install turns it on, and Uninstall turns it off, which
 * takes Marketing out of the sidebar and stops every automatic message it sends to clients (review
 * asks, their reminders and campaigns: scheduled ones go back to drafts), keeping everything (POST
 * /api/marketing/enabled, public.marketing_set_enabled).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { confirm } from "@/components/ui/Confirm";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

export function useMarketingSwitch() {
  const session = useSession();
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.post<{ enabled: boolean }>("/marketing/enabled", { enabled }),
    onSuccess: async (res) => {
      // Marketing in the sidebar comes from the company's settings.
      await session.refresh();
      await queryClient.invalidateQueries({ queryKey: ["apps"] });
      return res;
    },
    // Installing shows on the page itself (its ring, then Uninstall).
    meta: { success: (res: { enabled: boolean }) => (res.enabled ? null : "Marketing uninstalled") },
  });
  const turnOff = async () => {
    const ok = await confirm({
      title: "Uninstall Marketing?",
      body:
        "Marketing leaves the sidebar for everyone, and every automatic message it sends to clients stops: review asks, their reminders and campaigns. " +
        "Scheduled campaigns go back to drafts, and one that's sending stops where it is. " +
        "Review and referral links already sent keep working, and promo codes keep working on quotes and online booking. " +
        "Your campaigns, promo codes, review requests and referrals are kept, and come back if you install it again. Reminders that were due aren't sent later.",
      confirmLabel: "Uninstall",
      danger: true,
    });
    if (ok) toggle.mutate(false);
  };
  return { toggle, turnOff };
}
