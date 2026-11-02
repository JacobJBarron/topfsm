/**
 * Crewtavo - Marketing on its Apps page, once it's installed: who has it, and where its tabs are.
 * Installing and uninstalling it is features/marketing/useMarketingSwitch.ts. An admin who connects
 * apps without the marketing area manages it here but can't open Marketing, so the tabs aren't
 * offered to them: the page says who has it instead.
 */
import { Link } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { useSession } from "@/lib/session";
import { usesMarketing } from "./catalog";

export function MarketingPanel() {
  const session = useSession();
  const opens = usesMarketing(session);
  return (
    <section id="app-setup" className="card card-pad stack-sm" aria-labelledby="marketing-setup" style={{ gap: 12 }}>
      <h2 id="marketing-setup" className="section-title" style={{ fontSize: 16 }}>Marketing is on</h2>
      <span className="muted">
        Owners, admins and office staff with the marketing area have <strong>Marketing</strong> in the menu. Choose when clients are asked for a review, and how
        many reminders follow, in <strong>Reviews</strong>. Set the credit for each friend who becomes a client, and when clients are asked for
        referrals, in <strong>Referrals</strong>. In <strong>Campaigns</strong>, turn on the automated campaigns (re-engage past clients, win back
        lost quotes, close pending quotes), write one-off emails, and see the opens, clicks and work each brings in. In <strong>Social</strong>, post job
        photos marked OK to share and 4 and 5-star Google reviews to your Facebook Page, Instagram and Google Business Profile, now or later, or have
        new 5-star reviews post by themselves.
      </span>
      <span className="muted">
        Connect <Link to="/apps/google_business">Google Business Profile</Link> to bring your Google reviews into Reviews, reply to them, and stop asking clients who already left one.
        Connect <Link to="/apps/meta">Facebook & Instagram</Link> to post to your Page and Instagram account.
      </span>
      {opens ? (
        <div className="row wrap" style={{ gap: 8 }}>
          <Link className="btn" to="/marketing?tab=reviews"><Icon name="star" size={16} />Reviews</Link>
          <Link className="btn" to="/marketing?tab=referrals"><Icon name="gift" size={16} />Referrals</Link>
          <Link className="btn" to="/marketing?tab=campaigns"><Icon name="mail" size={16} />Campaigns</Link>
          <Link className="btn" to="/marketing?tab=social"><Icon name="share" size={16} />Social</Link>
        </div>
      ) : (
        <span className="muted small">Your role doesn't have the marketing area, so Marketing isn't in your menu. An owner can add it to your role in Settings → Roles.</span>
      )}
    </section>
  );
}
