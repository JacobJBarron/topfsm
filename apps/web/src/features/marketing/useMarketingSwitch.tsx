/**
 * Crewtavo - Marketing on its Apps page: Install turns it on, and Uninstall turns it off, which
 * takes Marketing out of the sidebar and stops every automatic message it sends to clients (review
 * asks, their reminders, referral asks and campaigns, automated ones too: scheduled ones go back to
 * drafts), keeping everything (POST /api/marketing/enabled, public.marketing_set_enabled). Referral
 * credits keep going on invoices: the business promised them, and following up on sent quotes
 * (Close pending quotes) isn't marketing, so it keeps going while its rule is on. Win-back emails
 * waiting are cancelled for good, so the confirm says how many; re-engage emails go once it's back.
 */
import type { AutomatedState } from "@crewtavo/core/campaigns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { confirm } from "@/components/ui/Confirm";
import { api, supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { waitingWords } from "./automatedForm";

/** How many win-back emails are waiting, and whether quotes are followed up, or nulls when that can't be read. */
async function automatedNow(companyId: string): Promise<{ winBacks: number | null; followUp: boolean | null }> {
  try {
    const states = unwrap(await supabase().rpc("automated_campaign_states", { p_company: companyId })) as unknown as AutomatedState[];
    return {
      winBacks: states.find((x) => x.template_key === "win_back_lost_quotes")?.waiting ?? 0,
      followUp: states.find((x) => x.template_key === "quote_followup")?.enabled ?? false,
    };
  } catch {
    return { winBacks: null, followUp: null };
  }
}

/** What uninstalling stops and what keeps going, as two short lists. */
export function UninstallSummary({ winBacks, followUp }: { winBacks: number | null; followUp: boolean | null }) {
  const keeps = [
    "Review, referral and campaign links already sent",
    "Promo codes on quotes and online booking",
    "Referral credits clients have earned, or earn later from links already shared, on their invoices",
    followUp ? "Following up on sent quotes, which isn't marketing" : followUp === null ? "Following up on sent quotes, while its rule in Automations is on" : null,
  ].filter(Boolean) as string[];
  return (
    <div className="stack-sm">
      <p style={{ margin: 0 }}>Marketing leaves the sidebar for everyone, and every automatic message it sends to clients stops:</p>
      <ul className="app-steps">
        <li>Review asks and their reminders. Reminders that were due aren't sent later.</li>
        <li>Referral asks</li>
        <li>Campaigns: scheduled ones go back to drafts, and one that's sending stops where it is</li>
        <li>Automated campaigns. {waitingWords(winBacks)}</li>
      </ul>
      <p style={{ margin: 0 }}>These keep working:</p>
      <ul className="app-steps">{keeps.map((k) => <li key={k}>{k}</li>)}</ul>
      <p style={{ margin: 0 }}>Your campaigns, promo codes, review requests and referrals are kept, and come back if you install it again.</p>
    </div>
  );
}

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
    const now = await automatedNow(session.company.id);
    const ok = await confirm({ title: "Uninstall Marketing?", body: <UninstallSummary {...now} />, confirmLabel: "Uninstall", danger: true });
    if (ok) toggle.mutate(false);
  };
  return { toggle, turnOff };
}
