/** "Connect your email" for notices where email is off: a link for people who can (`then` says what it's for), a pointer for everyone else. */
import { Link } from "react-router-dom";
import { can, hasRole, useSession } from "@/lib/session";

export function ConnectEmailHint({ then = "to turn it on" }: { then?: string }) {
  const session = useSession();
  const canConnect = hasRole(session, "admin") && (can(session, "apps") || can(session, "settings"));
  return canConnect ? (
    <> <Link to="/settings?tab=email" className="strong">Connect your email</Link> {then}.</>
  ) : (
    <> An owner can turn it on in Settings → Email.</>
  );
}
