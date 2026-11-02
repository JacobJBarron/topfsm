import { isPlaceholderEmail } from "@crewtavo/core/email";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, useJustDone } from "@/components/ui/Button";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Face } from "@/components/ui/Avatar";
import { Icon, type IconName } from "@/components/ui/Icon";
import { MapsAppSetting } from "@/components/ui/MapsLink";
import { api, supabase } from "@/lib/api";
import { can, hasRole, isSub, useSession } from "@/lib/session";
import { setTheme, useTheme, type ThemeChoice } from "@/lib/theme";
import { formatPhoneTyping } from "@/lib/validate";
import { signingInNote, subCodeWays } from "../auth/textCode";
import { MeasureMapSetting } from "../measure/ImageryPicker";
import { CalendarFeedCard } from "./CalendarFeedCard";
import { NotificationSettings } from "./NotificationSettings";
import { PhotoButtons } from "./ProfilePhoto";
import { SignatureCard } from "./SignatureCard";
import { SpareKeysCard } from "./SpareKeysCard";

const COLORS = ["#0f2a35", "#3b7d23", "#3474d4", "#c9852a", "#d2445c", "#8b5cf6", "#0e7490", "#57534e"];

export function ProfileSettings() {
  const session = useSession();
  // People who sign estimates for the business keep their signature here.
  const signs = hasRole(session, "admin", "office", "estimator") && can(session, "sales");
  // A sub has no schedule color or calendar feed. On a sign-in Crewtavo made for them, they sign in
  // with a link or a code and stay signed in (no password); someone's own account keeps its password.
  const sub = isSub(session);
  const madeForSub = sub && session.subcontractor?.own_sign_in !== false;
  const email = isPlaceholderEmail(session.profile.email) ? null : session.profile.email;
  const [name, setName] = useState(session.profile.full_name);
  const [phone, setPhone] = useState(session.profile.phone ?? "");
  const [color, setColor] = useState(session.profile.color ?? COLORS[0]);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      await api.patch("/me", { full_name: name.trim(), phone: phone.trim() || null });
      if (sub) return;
      const { error } = await supabase().from("profiles").update({ color }).eq("user_id", session.userId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => session.refresh(),
  });
  const changePassword = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      if (password.length < 8) throw new Error("Use at least 8 characters.");
      if (password !== confirmPw) throw new Error("The passwords don't match.");
      // Checked against the current one on the server (apps/api/src/routes/account.ts).
      await api.post("/account/password", { current: current || undefined, password });
    },
    onSuccess: () => {
      setCurrent("");
      setPassword("");
      setConfirmPw("");
    },
  });
  const saved = useJustDone(save);
  const changed = useJustDone(changePassword);
  return (
    <div className="two-col">
      <form className="wide card card-pad stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="row" style={{ gap: 14 }}>
          <span className="avatar" style={{ width: 72, height: 72, fontSize: 24, background: color }}><Face name={name || email} photo={session.profile.avatar_url} /></span>
          <div className="stack-sm" style={{ gap: 8 }}>
            <div>
              <strong style={{ fontSize: 16 }}>{name || "Your name"}</strong>
              {email && <div className="muted small">{email}</div>}
            </div>
            <PhotoButtons userId={session.userId} photo={session.profile.avatar_url} />
          </div>
        </div>
        <div className="form-grid">
          <Field label="Full name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="name" /></Field>
          <Field label="Mobile phone" optional hint={madeForSub ? `Texts about your jobs go here. Leave it empty to get them at the number ${session.company.name} has for you.` : undefined}>
            <input className="input" type="tel" value={phone} onChange={(e) => setPhone(formatPhoneTyping(e.target.value))} maxLength={40} autoComplete="tel" />
          </Field>
        </div>
        {!sub && <div className="field">
          <span>Color on the schedule</span>
          <div className="row wrap" style={{ gap: 8 }}>
            {COLORS.map((c) => (
              <button key={c} type="button" aria-label={`Color ${c}`} aria-pressed={color === c} onClick={() => setColor(c)} style={{ width: 32, height: 32, borderRadius: "50%", background: c, border: color === c ? "3px solid var(--surface)" : "0", boxShadow: color === c ? `0 0 0 2px ${c}` : "none", cursor: "pointer", transition: "box-shadow 150ms" }} />
            ))}
          </div>
        </div>}
        <FormError error={save.error} />
        <div className="form-actions"><FormChecks /><Button type="submit" variant="primary" loading={save.isPending} done={saved}>Save profile</Button></div>
      </form>
      <div className="narrow stack">
      {signs && <SignatureCard />}
      <NotificationSettings phone={session.profile.phone} />
      <Appearance />
      <MapsAppSetting />
      {!sub && <MeasureMapSetting />}
      {!sub && <CalendarFeedCard />}
      <SpareKeysCard />
      {madeForSub && (
        <div className="card card-pad stack-sm">
          <strong>Signing in</strong>
          <span className="muted small">{signingInNote(session.company.name, subCodeWays(session.config.features, session.subcontractor))}</span>
        </div>
      )}
      {!madeForSub && <form className="card card-pad stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); changePassword.mutate(); }}>
        <strong>Change password</strong>
        <Field label="Current password" hint="Leave it empty if you don't have one yet."><input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="New password" hint="At least 8 characters."><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={8} /></Field>
        <Field label="Confirm new password" error={confirmPw && password !== confirmPw ? "The passwords don't match." : null}><input className="input" type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" required /></Field>
        <FormError error={changePassword.error} />
        <Button type="submit" loading={changePassword.isPending} done={changed} doneLabel="Password changed" style={{ justifySelf: "start" }}>Change password</Button>
      </form>}
      </div>
    </div>
  );
}

const THEMES: Array<{ value: ThemeChoice; label: string; icon: IconName }> = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "system", label: "System", icon: "monitor" },
];

/** Light, dark or the device's setting. Applies right away and is remembered on this device. */
function Appearance() {
  const theme = useTheme();
  return (
    <div className="card card-pad stack-sm">
      <strong id="appearance-title">Appearance</strong>
      <div className="segmented" role="group" aria-labelledby="appearance-title" style={{ justifySelf: "start" }}>
        {THEMES.map((t) => (
          <button key={t.value} type="button" aria-pressed={theme === t.value} onClick={() => setTheme(t.value)}>
            <Icon name={t.icon} size={14} />
            {t.label}
          </button>
        ))}
      </div>
      <span className="muted small">System follows your device's light or dark setting. Saved on this device.</span>
    </div>
  );
}
