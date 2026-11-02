/**
 * Marketing → Referrals' "Credit, offer and email" form (Referrals.tsx): what it shows, read from
 * settings.referrals, and the settings it saves (packages/core/src/marketing.ts referralSettings
 * reads them back, as the database does for a new referral).
 */
import { DEFAULT_REFERRAL_MESSAGE, MAX_REFERRAL_AMOUNT, referralSettings, type ReferralRewardKind } from "@crewtavo/core/marketing";

type Settings = Record<string, unknown>;

export interface ReferralForm {
  kind: ReferralRewardKind;
  /** As typed: "50", "12.5". */
  value: string;
  offer: string;
  message: string;
}

/** The form as the settings are now. No credit set shows an empty box. */
export function referralForm(settings: Settings | null | undefined): ReferralForm {
  const { reward, offer, message } = referralSettings(settings);
  return { kind: reward.kind, value: reward.value > 0 ? String(reward.value) : "", offer: offer ?? "", message };
}

/** The credit as it's saved: a percent or dollars, to the cent. Empty is no credit. */
export const rewardValue = (form: Pick<ReferralForm, "value">) => {
  const value = Number(form.value);
  return form.value.trim() && Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
};

/** What's wrong with the credit, or null. An empty box is no credit, which is allowed. */
export function rewardError(form: Pick<ReferralForm, "kind" | "value">): string | null {
  if (!form.value.trim()) return null;
  const value = Number(form.value);
  if (form.kind === "percent") return Number.isFinite(value) && value >= 1 && value <= 100 ? null : "Pick a percentage from 1 to 100.";
  return Number.isFinite(value) && value >= 0 && value <= MAX_REFERRAL_AMOUNT ? null : "Enter an amount up to $10,000.";
}

/** The email can't go without the client's link in it. */
export const messageError = (form: Pick<ReferralForm, "message">) => (form.message.includes("{{link}}") ? null : "Include {{link}} so clients get their own link to share.");

/**
 * The change useSettingsSaver makes, worked out from the settings as they are when it saves: the
 * rest of settings.referrals is kept. The default email isn't written down, so a better one later
 * reaches businesses that never changed it.
 */
export function referralPatch(form: ReferralForm, current: Settings): Settings {
  const referrals = (current.referrals as Record<string, unknown> | undefined) ?? {};
  const message = form.message.trim();
  return {
    referrals: {
      ...referrals,
      reward: { kind: form.kind, value: rewardValue(form) },
      offer: form.offer.trim() || null,
      message: message && message !== DEFAULT_REFERRAL_MESSAGE.trim() ? message : null,
    },
  };
}

/** A credit was saved, and the form changes it: friends referred already keep theirs. Setting the first one says nothing. */
export function rewardChanged(form: ReferralForm, settings: Settings | null | undefined): boolean {
  const { reward } = referralSettings(settings);
  return reward.value > 0 && (form.kind !== reward.kind || rewardValue(form) !== reward.value);
}
