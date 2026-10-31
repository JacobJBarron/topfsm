/**
 * Crewtavo - Marketing on its Apps page, once it's installed: who has it, and where its tabs are.
 * Installing and uninstalling it is features/marketing/useMarketingSwitch.ts.
 */
import { Link } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";

export function MarketingPanel() {
  return (
    <section id="app-setup" className="card card-pad stack-sm" aria-labelledby="marketing-setup" style={{ gap: 12 }}>
      <h2 id="marketing-setup" className="section-title" style={{ fontSize: 16 }}>Marketing is on</h2>
      <span className="muted">
        Owners, admins and office staff with the marketing area have <strong>Marketing</strong> in the menu. Choose when clients are asked for a review, and how
        many reminders follow, in <strong>Reviews</strong>. Set the reward for each referral in <strong>Referrals</strong>, and write and send email in{" "}
        <strong>Campaigns</strong>.
      </span>
      <div className="row wrap" style={{ gap: 8 }}>
        <Link className="btn" to="/marketing?tab=reviews"><Icon name="star" size={16} />Reviews</Link>
        <Link className="btn" to="/marketing?tab=referrals"><Icon name="gift" size={16} />Referrals</Link>
        <Link className="btn" to="/marketing?tab=campaigns"><Icon name="mail" size={16} />Campaigns</Link>
      </div>
    </section>
  );
}
