/** Public config, the signed-in user, onboarding (company + trade preset), the license and team invites. */
import { ADMINS, adminLevel, emailKey, getPreset, isPlaceholderEmail, isSubLogin, isTimeZoneName, memberPermissions, OFFICE, PERMISSIONS, presetSummaries, ROLE_LABELS, ROLES, signInPhone, STAFF, subSettings, TERMS_VERSION, WITH_SUBS, type Permission, type Role, type TradePreset } from "@crewtavo/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { platformOf } from "../lib/address";
import { confirmAdminGrant, confirmPassword, EMAILED_SIGN_INS, emailAuthLink, passwordIn, requireCompany, requireUser, signedInWithin } from "../lib/auth";
import { runInBackground } from "../lib/background";
import { appUrl, asJson, dbError, HttpError, must, readJson, uuid } from "../lib/http";
import { renderEmail } from "../lib/email";
import { allow } from "../lib/limit";
import { checkMailbox, emailConfigured, loadMailbox, sendEmail, smsConfigured } from "../lib/notify";
import { adminClient, publishableKey, type Db } from "../lib/supabase";
import { timeRates } from "../services/payRates";
import { saveLetterheadPicture } from "../services/letterhead";
import { emailCodesOffered } from "../services/signInCodes";
import { removeLogo, setLogo } from "../services/logo";
import { removePhoto, setPhoto } from "../services/photos";
import { adminAccess, allowAdminGrant, invitePerson, inviteStatus, sendInvite, welcomeLink, type TeamScope } from "../services/team";
import { clientIp } from "../lib/visitor";
import { railwayNeeded, setRailwaySetup } from "../services/railway";
import { emailOwners, tellOwners } from "./apps";

export const account = new Hono<AppEnv>();

/** The person's client and company, for the team service (services/team.ts). */
const teamScope = (c: Context<AppEnv>): TeamScope => ({ db: c.var.db, env: c.env, companyId: c.var.companyId, userId: c.var.userId, role: c.var.role, baseUrl: appUrl(c) });

/**
 * What the web app's Google Drive picker needs, all of it public: the OAuth client it signs in with,
 * the browser key, and the Google Cloud project's number (a client ID starts with it), which lets
 * Crewtavo read the files people pick. Null until GOOGLE_CLIENT_ID and GOOGLE_PICKER_API_KEY are set.
 */
function googlePicker(env: Env): { clientId: string; apiKey: string; appId: string } | null {
  const appId = env.GOOGLE_CLIENT_ID?.match(/^\d+/)?.[0];
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_PICKER_API_KEY || !appId) return null;
  return { clientId: env.GOOGLE_CLIENT_ID, apiKey: env.GOOGLE_PICKER_API_KEY, appId };
}

/** Everything the SPA needs at startup, so it has no build-time environment variables. */
account.get("/config", async (c) =>
  c.json(
    {
      // In a Crewtavo instance this server is the gateway, so the browser uses its own address ("").
      supabaseUrl: c.env.CREWTAVO_GATEWAY ? "" : c.env.SUPABASE_URL,
      supabaseKey: publishableKey(c.env),
      singleCompany: c.env.CREWTAVO_SINGLE_COMPANY === "1",
      // Where the instance runs (railway, compose or server), for setup steps that depend on it.
      platform: platformOf(c.env),
      // The Crewtavo Terms version that setting up a business agrees to (packages/core/src/terms.ts).
      termsVersion: TERMS_VERSION,
      mapsBrowserKey: c.env.GOOGLE_MAPS_BROWSER_KEY ?? null,
      // Import from Google Drive (routes/drive.ts): Google's file picker, with the deployment's
      // Google sign-in app. Null when it isn't set up.
      googlePicker: googlePicker(c.env),
      turnstileSiteKey: c.env.TURNSTILE_SITE_KEY ?? null,
      // Error reporting for the web app (DSNs are meant to be public).
      sentry:
        c.env.CREWTAVO_SENTRY_WEB_DSN || c.env.CREWTAVO_SENTRY_DSN
          ? { dsn: c.env.CREWTAVO_SENTRY_WEB_DSN || c.env.CREWTAVO_SENTRY_DSN, environment: c.env.CREWTAVO_SENTRY_ENVIRONMENT || "production" }
          : null,
      features: {
        ai: Boolean(c.env.ANTHROPIC_API_KEY),
        payments: Boolean(c.env.STRIPE_SECRET_KEY),
        email: emailConfigured(c.env),
        sms: smsConfigured(c.env),
        // Whether the sign-in page offers a sub a sign-in code by email (services/signInCodes.ts): the
        // way in when this Crewtavo can't text, and the one for a sub with no phone on file when it can.
        emailCodes: await emailCodesOffered(c.env),
        devMail: Boolean(c.env.MAILPIT_URL && !c.env.RESEND_API_KEY),
        roofInsights: Boolean(c.env.GOOGLE_MAPS_SERVER_KEY),
      },
    },
    200,
    { "Cache-Control": "public, max-age=300" },
  ),
);

account.get("/health", (c) => c.json({ ok: true }));

account.get("/presets", (c) => c.json(presetSummaries()));

/**
 * The signed-in person and their companies. A sub's company is company_basics() (the companies row
 * is closed to them), and their membership says which sub they sign in as and what the office lets
 * them do. can_create_company is false for a sign-in an office made for its sub (unless they're on
 * a team somewhere too); someone's own account can always start a business.
 */
account.get("/me", requireUser, async (c) => {
  const { db, userId } = c.var;
  const [profile, memberships, everyRole] = await Promise.all([
    db.from("profiles").select("user_id, email, full_name, phone, avatar_url, color").eq("user_id", userId).maybeSingle(),
    db
      .from("memberships")
      .select("company_id, role, role_id, subcontractor_id, company:companies(id, name, slug, trade_preset, timezone, currency, address, settings)")
      .eq("user_id", userId)
      .eq("active", true),
    adminClient(c.env).from("memberships").select("company_id, role").eq("user_id", userId),
  ]);
  const rows = must(memberships);
  const roleIds = rows.map((m) => m.role_id).filter((id): id is string => Boolean(id));
  const roles = roleIds.length ? must(await db.from("company_roles").select("id, name, permissions").in("id", roleIds)) : [];
  const byId = new Map(roles.map((r) => [r.id, r]));
  // A sub's company and sub record: what the field app needs, read for them. And the countries whose
  // numbers get sign-in codes, for whether theirs does (the companies row is closed to them).
  const subRows = rows.filter((m) => m.role === "subcontractor" && m.subcontractor_id);
  const [basics, subRecords, subCompanies] = subRows.length
    ? await Promise.all([
        Promise.all(subRows.map(async (m) => (await db.rpc("company_basics", { p_company: m.company_id })).data?.[0] ?? null)),
        adminClient(c.env).from("subcontractors").select("id, company_id, name, can_contact_clients, uses_clock, phone, email").in("id", subRows.map((m) => m.subcontractor_id!)).then((r) => must(r)),
        adminClient(c.env).from("companies").select("id, settings").in("id", subRows.map((m) => m.company_id)).then((r) => must(r)),
      ])
    : [[], [], []];
  const basicsOf = new Map(basics.filter((b) => b).map((b) => [b!.id, b!]));
  // Which companies send email from their own mailbox (Settings → Email) and which added their own
  // Anthropic or fal.ai key (Apps), so email and AI are on for them; integrations is admin-only.
  const companyIds = rows.map((m) => m.company_id);
  // ...and which have agreed to the current license (only owners and admins can read agreements).
  // ...and, on Railway, whether the owner still has to connect it (services/railway.ts).
  const [connected, agreements, railways] = companyIds.length
    ? await Promise.all([
        adminClient(c.env).from("integrations").select("company_id, provider").in("provider", ["email", "anthropic", "fal"]).neq("status", "disconnected").in("company_id", companyIds),
        adminClient(c.env).from("terms_acceptances").select("company_id").eq("version", TERMS_VERSION).in("company_id", companyIds),
        adminClient(c.env).from("integrations").select("company_id, status").eq("provider", "railway").in("company_id", companyIds),
      ]).then(([apps, terms, railway]) => [must(apps), must(terms), must(railway)] as const)
    : [[], [], []];
  const withMailbox = new Set(connected.filter((r) => r.provider === "email").map((r) => r.company_id));
  const withClaudeKey = new Set(connected.filter((r) => r.provider === "anthropic").map((r) => r.company_id));
  const withFal = new Set(connected.filter((r) => r.provider === "fal").map((r) => r.company_id));
  const agreed = new Set(agreements.map((r) => r.company_id));
  const all = must(everyRole);
  return c.json({
    profile: must(profile, "Profile not found."),
    can_create_company: !isSubLogin(c.var.appMetadata) || all.some((m) => m.role !== "subcontractor"),
    memberships: rows.flatMap((m) => {
      const custom = m.role_id ? byId.get(m.role_id) : undefined;
      const sub = m.role === "subcontractor" ? subRecords.find((x) => x.id === m.subcontractor_id) : undefined;
      const company = m.role === "subcontractor" ? basicsOf.get(m.company_id) : m.company;
      // A sub's sign-in whose sub the office turned off reaches nothing, so it isn't offered.
      if (!company || (m.role === "subcontractor" && !sub)) return [];
      const staff = m.role !== "subcontractor";
      return [{
        role: m.role,
        company,
        role_name: custom?.name ?? ROLE_LABELS[m.role as Role],
        permissions: memberPermissions(m.role as Role, custom ? custom.permissions : null),
        subcontractor: sub
          ? {
              id: sub.id, name: sub.name, can_contact_clients: sub.can_contact_clients, uses_clock: sub.uses_clock,
              ...codeWaysOf(sub, subCompanies.find((x) => x.id === m.company_id)?.settings, ownSignIn(c.var.appMetadata, m.company_id, sub.id, all)),
            }
          : null,
        // Whether email goes out for this company (its own mailbox): for a sub too, whose notices it sends.
        email_connected: withMailbox.has(m.company_id),
        ai_connected: staff && withClaudeKey.has(m.company_id),
        // Apps → fal.ai: Find paving on the measuring map.
        fal_connected: staff && withFal.has(m.company_id),
        terms_accepted: agreed.has(m.company_id),
        // Only the owner is asked to connect Railway at sign-in.
        railway_needed:
          m.role === "owner" &&
          railwayNeeded(c.env, railways.find((r) => r.company_id === m.company_id) ?? null, (m.company as { settings?: unknown } | null)?.settings ?? null),
      }];
    }),
  });
});

/**
 * Whether this is a sign-in Crewtavo made for this sub, and nobody's sign-in elsewhere (`ours` in
 * services/subAccess.ts): codes go only to those, and notices go to the office's record for them.
 */
const ownSignIn = (appMetadata: unknown, companyId: string, subId: string, memberships: ReadonlyArray<{ company_id: string }>) =>
  isSubLogin(appMetadata, companyId, subId) && memberships.every((x) => x.company_id === companyId);

/**
 * For a sub's own sign-in (own_sign_in), what's on the office's record for them: a number sign-in
 * codes are texted to (an area the company texts codes to), and an email that isn't a placeholder,
 * which codes and notices go to; and whether there's a phone for texts at all (phone_on_file). Their
 * Profile, notification settings and the sign-out question say how to get back in and where notices
 * go by these, never showing the number or address themselves. Someone's own account gets none: it
 * signs in, and is told, as it always has.
 */
function codeWaysOf(sub: { phone: string | null; email: string | null }, settings: unknown, own: boolean) {
  return {
    own_sign_in: own,
    has_phone: own && Boolean(signInPhone(sub.phone, subSettings(settings).sign_in_countries)),
    has_email: own && Boolean(emailKey(sub.email) && !isPlaceholderEmail(sub.email)),
    phone_on_file: own && Boolean(sub.phone?.trim()),
  };
}

account.patch("/me", requireUser, async (c) => {
  const body = await readJson(c, z.object({ full_name: z.string().trim().min(1).max(120).optional(), phone: z.string().max(40).nullable().optional() }));
  const { error } = await c.var.db.from("profiles").update(body).eq("user_id", c.var.userId);
  if (error) throw dbError(error);
  return c.json({ ok: true });
});

/** How soon after signing in someone without a password yet can choose their first one. */
const FIRST_PASSWORD_SECONDS = 10 * 60;

/**
 * A new password for the signed-in person (Settings → Profile). Asks for the current one, so a
 * leftover or stolen session can't set its own and then pass every password check (confirmPassword).
 * Someone without one yet (they sign in with Google, or skipped it after an invitation) chooses a
 * first one within 10 minutes of signing in with Google, an emailed link or a code. Every other
 * sign-in ends, as after a reset.
 */
account.post("/account/password", requireUser, async (c) => {
  const body = await readJson(c, z.object({ current: z.string().max(200).optional(), password: z.string().min(8).max(72) }));
  if (body.current) await confirmPassword(c, body.current, "account-password");
  else {
    // The token requireUser checked: how and when this session signed in.
    let claims: Record<string, unknown> | null = null;
    try {
      claims = JSON.parse(Buffer.from(c.var.token.split(".")[1] ?? "", "base64url").toString("utf8"));
    } catch {
      // Not a token Auth made: no recent sign-in to go by.
    }
    if (!signedInWithin(claims, ["oauth", ...EMAILED_SIGN_INS], FIRST_PASSWORD_SECONDS)) {
      throw new HttpError(400, "Enter your current password. If you don't have one yet, sign out and in again, then set it within 10 minutes.");
    }
  }
  const admin = adminClient(c.env);
  const { error } = await admin.auth.admin.updateUserById(c.var.userId, { password: body.password });
  if (error?.status && error.status < 500) throw new HttpError(400, "Choose a stronger password: at least 8 characters, mixing letters and numbers.");
  if (error) {
    console.error("Couldn't change a password", error.message);
    throw new HttpError(500, "Couldn't change your password. Try again in a moment.");
  }
  await admin.auth.admin.signOut(c.var.token, "others");
  return c.json({ ok: true });
});

account.post("/companies", requireUser, async (c) => {
  const body = await readJson(
    c,
    z.object({
      name: z.string().trim().min(1).max(200),
      trade_preset: z.string().default("general"),
      timezone: z.string().default("America/New_York"),
      terms_version: z.string().max(40).optional(),
    }),
  );
  checkTermsVersion(body.terms_version);
  // A sign-in an office made for its sub is for their work with that business (the database
  // refuses it too); someone's own account the office gave sub access to isn't stopped.
  const { data: mine, error: mineError } = await adminClient(c.env).from("memberships").select("role").eq("user_id", c.var.userId);
  if (mineError) throw dbError(mineError);
  if (isSubLogin(c.var.appMetadata) && !mine?.some((m) => m.role !== "subcontractor")) {
    throw new HttpError(403, "This sign-in is for your work with another business. To run your own business on Crewtavo, use a different email address.");
  }
  // A Crewtavo instance belongs to one business; everyone after the owner joins it by invite.
  if (c.env.CREWTAVO_SINGLE_COMPANY === "1") {
    const { data: existing } = await adminClient(c.env).from("companies").select("id").limit(1);
    if (existing?.length) throw new HttpError(403, "This Crewtavo already has a business. Ask its owner to invite you.");
  }
  let preset: TradePreset;
  try {
    preset = getPreset(body.trade_preset);
  } catch {
    throw new HttpError(400, "Unknown trade preset.");
  }
  if (!isTimeZoneName(body.timezone)) throw new HttpError(400, "Unknown time zone. Pick one from the list, like America/New_York.");
  const { db } = c.var;
  const { data: companyId, error } = await db.rpc("create_company", {
    p_name: body.name,
    p_trade_preset: preset.id,
    p_timezone: body.timezone,
  });
  if (error) throw dbError(error);
  await applyPreset(db, companyId as string, preset);
  // An instance on Railway: the next screen offers to connect Railway and set up a web address.
  if (c.env.CREWTAVO_SINGLE_COMPANY === "1" && platformOf(c.env) === "railway") await setRailwaySetup(adminClient(c.env), companyId as string, "pending");
  // The business exists either way; if this fails, the owner is asked to agree again when it opens.
  const agreed = await db.rpc("accept_terms", { p_company: companyId as string, p_version: TERMS_VERSION });
  if (agreed.error) console.error("Couldn't record the license agreement", agreed.error.message);
  return c.json({ id: companyId }, 201);
});

/** The version the person read must be the one in force: an old page may show older terms. */
function checkTermsVersion(version: string | undefined) {
  if (!version) throw new HttpError(400, "Agree to the Crewtavo Terms to continue.");
  if (version !== TERMS_VERSION) throw new HttpError(409, "The Crewtavo Terms changed since this page opened. Reload the page, read them and agree again.");
}

/** Agreements to the terms for this business, newest first (Settings → Terms and license). */
account.get("/terms", requireUser, requireCompany(ADMINS), async (c) => {
  const rows = must(
    await c.var.db
      .from("terms_acceptances")
      .select("id, full_name, email, role, version, accepted_at")
      .eq("company_id", c.var.companyId)
      .order("accepted_at", { ascending: false })
      .limit(50),
  );
  return c.json({ version: TERMS_VERSION, accepted: rows.some((r) => r.version === TERMS_VERSION), agreements: rows });
});

/** An owner or admin agrees to the current license on behalf of the business. */
account.post("/terms", requireUser, requireCompany(ADMINS), async (c) => {
  const body = await readJson(c, z.object({ version: z.string().max(40).optional() }));
  checkTermsVersion(body.version);
  const { error } = await c.var.db.rpc("accept_terms", { p_company: c.var.companyId, p_version: TERMS_VERSION });
  if (error) throw dbError(error);
  return c.json({ ok: true }, 201);
});

/** Load a trade preset into a new company. Runs as the new owner, so RLS still applies. */
async function applyPreset(db: Db, companyId: string, preset: TradePreset) {
  const formulas = new Map(preset.formulas.map((f) => [f.name, f]));
  const steps = [
    db.from("services").insert(
      preset.services.map((s, i) => {
        const formula = s.formula_name ? formulas.get(s.formula_name) : undefined;
        return {
          company_id: companyId,
          name: s.name,
          unit: s.unit,
          unit_price: s.unit_price,
          unit_cost: s.unit_cost ?? null,
          category: s.category ?? null,
          formula: formula?.formula ?? null,
          formula_target: formula?.sets ?? "quantity",
          sort: i,
        };
      }),
    ),
    db.from("checklist_templates").insert(
      preset.checklists.map((cl) => ({ company_id: companyId, name: cl.name, job_type: cl.job_type ?? null, items: asJson(cl.items) })),
    ),
    db.from("intake_forms").insert(
      preset.intake_forms.map((f) => ({
        company_id: companyId,
        slug: f.slug,
        name: f.name,
        kind: f.kind,
        questions: asJson(f.questions),
        lead_time_days: f.lead_time_days,
        slot_minutes: f.slot_minutes ?? null,
        max_per_day: f.max_per_day ?? null,
        requires_approval: f.requires_approval,
      })),
    ),
    db.from("sop_categories").insert(preset.sop_categories.map((name, i) => ({ company_id: companyId, name, sort: i }))),
    db
      .from("companies")
      .update({ settings: asJson({ job_types: preset.job_types, formulas: preset.formulas, weather_rules: preset.weather_rules, payment_terms_days: 30 }) })
      .eq("id", companyId),
  ];
  for (const result of await Promise.all(steps)) {
    if (result.error) throw dbError(result.error);
  }
}

/**
 * The team: everyone but subs, whose sign-ins are on their page under Subs. With ?with_subs=1, for
 * naming people on Timesheets, reports and the schedule, subs' sign-ins too (on or off), each with
 * `sub`: their business's id and name, and their name and photo but not their phone or email.
 */
account.get("/team", requireUser, requireCompany(), async (c) => {
  const { db, companyId } = c.var;
  const withSubs = c.req.query("with_subs") === "1";
  let query = db.from("memberships").select("user_id, role, role_id, active, subcontractor_id").eq("company_id", companyId);
  if (!withSubs) query = query.neq("role", "subcontractor");
  const members = must(await query);
  const profiles = must(
    await db.from("profiles").select("user_id, full_name, email, phone, color, avatar_url").in("user_id", members.map((m) => m.user_id)),
  );
  const byId = new Map(profiles.map((p) => [p.user_id, p]));
  // Subs' business names: the subs list is the office's, so just the names, read with the server's key.
  const subIds = members.map((m) => m.subcontractor_id).filter((id): id is string => Boolean(id));
  const subNames = new Map(
    subIds.length ? must(await adminClient(c.env).from("subcontractors").select("id, name").eq("company_id", companyId).in("id", subIds)).map((x) => [x.id, x.name]) : [],
  );
  // Pay rates are for the office (the column isn't readable by members directly); crews see names and roles.
  const rates = new Map<string, number | null>();
  if (["owner", "admin", "office"].includes(c.var.role)) {
    const rows = must(await adminClient(c.env).from("memberships").select("user_id, labor_rate").eq("company_id", companyId));
    for (const r of rows) rates.set(r.user_id, r.labor_rate);
  }
  return c.json(
    members.map(({ subcontractor_id, ...m }) => {
      const profile = byId.get(m.user_id) ?? null;
      if (!subcontractor_id) return { ...m, labor_rate: rates.get(m.user_id) ?? null, profile };
      return {
        ...m,
        labor_rate: null,
        profile: profile && { ...profile, email: null, phone: null },
        sub: { id: subcontractor_id, name: subNames.get(subcontractor_id) ?? "Subcontractor" },
      };
    }),
  );
});

/**
 * The pay rate each time entry is costed at, for job costs and reports: approved time at the rate
 * it was approved at, the rest at the person's current rate. For the time on some jobs, or the time
 * started between two moments. Like members' rates, the column isn't readable by members directly;
 * the office reads it here, with the job costs area.
 */
account.post("/time/rates", requireUser, requireCompany(OFFICE, "job_costs"), async (c) => {
  const body = await readJson(
    c,
    z.object({
      job_ids: z.array(uuid).min(1).max(300).optional(),
      from: z.iso.datetime({ offset: true }).optional(),
      to: z.iso.datetime({ offset: true }).optional(),
    }),
  );
  if (!body.job_ids && !(body.from && body.to)) throw new HttpError(400, "Choose the jobs or the dates.");
  // Approved time at the rate it was approved at, the rest at the person's current rate (services/payRates.ts).
  return c.json(await timeRates(adminClient(c.env), c.var.companyId, body));
});

/** The person's own password, asked for before admin-level access is given (confirmAdminGrant). */
const currentPassword = z.string().max(200).optional();

const ADMIN_IF_NOT_YOU = "If this wasn't you, sign in, check Settings → People, and change your password.";

/**
 * Admin-level access given (an invite, someone's new role, or a role's new areas): on record, on
 * every owner's bell (tellOwners) and by email, after the response, so it never holds up the change.
 */
function noteAdminGrant(c: Context<AppEnv>, who: { email: string; full_name: string | null }, what: string) {
  const summary = `${who.full_name || who.email} ${what}`;
  const title = "Someone was given admin access";
  const link = "/settings?tab=team";
  runInBackground(c, tellOwners(c, { verb: "team.admin_access", summary, title, body: `${summary}. ${ADMIN_IF_NOT_YOU}`, link }).then((ownerIds) => emailOwners(c, ownerIds, { title, who, details: `What: ${what}`, ifNotYou: ADMIN_IF_NOT_YOU, link })));
}

/** A level or custom role, as people read it. */
async function accessName(c: Context<AppEnv>, role: Role, roleId?: string | null): Promise<string> {
  if (!roleId) return ROLE_LABELS[role];
  return (await c.var.db.from("company_roles").select("name").eq("id", roleId).maybeSingle()).data?.name ?? ROLE_LABELS[role];
}

/** Someone on the team, by name. */
async function personName(c: Context<AppEnv>, userId: string): Promise<string> {
  const { data } = await c.var.db.from("profiles").select("full_name, email").eq("user_id", userId).maybeSingle();
  return data?.full_name || data?.email || "someone";
}

account.post("/team/invite", requireUser, requireCompany(ADMINS, "team"), async (c) => {
  const { current_password, ...body } = await readJson(
    c,
    z.object({
      email: z.email(),
      full_name: z.string().trim().max(120).optional(),
      role: z.enum(ROLES).default("field_crew"),
      role_id: uuid.nullable().optional(),
      current_password: currentPassword,
    }),
  );
  // Admin-level access asks for the password before any account is made (services/team.ts).
  const grant: { who?: { email: string; full_name: string | null } } = {};
  const invited = await invitePerson(teamScope(c), body, async () => (grant.who = await confirmAdminGrant(c, current_password)));
  if (grant.who) noteAdminGrant(c, grant.who, `invited ${body.email.toLowerCase()} as ${await accessName(c, body.role, body.role_id)}`);
  // The link comes back either way, so the admin can text it too (or instead, when email isn't connected).
  return c.json(invited, 201);
});

/**
 * Someone's level or custom role (Settings → People). Through here rather than straight to the
 * database, which refuses admin-level access from the browser (the admin_grants migration): giving
 * it asks for the password. Written with the person's own client, so the database's other rules hold
 * (nobody gives areas they don't have, nobody changes their own role, there's always an owner).
 */
account.patch("/team/:userId/access", requireUser, requireCompany(ADMINS, "team"), async (c) => {
  const parsed = uuid.safeParse(c.req.param("userId"));
  if (!parsed.success) throw new HttpError(404, "That person isn't on your team.");
  const targetId = parsed.data;
  const { db, companyId, userId, role } = c.var;
  const body = await readJson(c, z.object({ role: z.enum(STAFF as [Role, ...Role[]]), role_id: uuid.nullable().optional(), current_password: currentPassword }));
  const member = must(await db.from("memberships").select("role, role_id").eq("company_id", companyId).eq("user_id", targetId).maybeSingle(), "That person isn't on your team.");
  if (member.role === "subcontractor") throw new HttpError(400, "A sub's sign-in is given and taken away on their page, under Subs.");
  if (targetId === userId && role !== "owner") throw new HttpError(403, "Ask an owner to change your own role or access.");
  if (body.role === "owner" && role !== "owner") throw new HttpError(403, "Only an owner can make someone an owner.");
  if (member.role === "owner" && role !== "owner") throw new HttpError(403, "Only an owner can do that for another owner.");
  const roleId = body.role_id ?? null;
  // A custom role sets the level itself (its base role).
  const custom = roleId ? must(await db.from("company_roles").select("name, base_role, permissions").eq("id", roleId).eq("company_id", companyId).maybeSingle(), "That role no longer exists.") : null;
  const level = custom?.base_role ?? body.role;
  // As the database counts it: admin-level access they didn't have, or a different admin-level role.
  const givesAdmin = adminLevel(level, custom?.permissions) && (level !== member.role || roleId !== member.role_id);
  const who = givesAdmin ? await confirmAdminGrant(c, body.current_password) : null;
  if (who) await allowAdminGrant(c.env, companyId, userId, targetId);
  const { data, error } = await db.from("memberships").update({ role: level, role_id: roleId }).eq("company_id", companyId).eq("user_id", targetId).select("user_id");
  if (error) throw dbError(error);
  if (!data.length) throw new HttpError(404, "That person isn't on your team.");
  if (who) noteAdminGrant(c, who, `made ${await personName(c, targetId)} ${custom?.name ?? ROLE_LABELS[level]}`);
  return c.json({ ok: true });
});

/** A custom role as Settings → Roles saves it. */
const roleRow = z.object({
  name: z.string().trim().min(1).max(60),
  base_role: z.enum(STAFF.filter((r) => r !== "owner") as [Role, ...Role[]]),
  permissions: z.array(z.enum(PERMISSIONS.map((p) => p.key) as [Permission, ...Permission[]])).max(PERMISSIONS.length),
  current_password: currentPassword,
});

/**
 * A role that becomes admin-level (it wasn't, or is new) asks for the password, as giving a person
 * admin access does, and the database is told to let it through (`id` is the role's). Null otherwise.
 */
async function roleGrant(c: Context<AppEnv>, id: string, row: { base_role: Role; permissions: string[] }, was: { base_role: Role; permissions: string[] } | null, password: string | undefined) {
  if (!adminLevel(row.base_role, row.permissions) || (was && adminLevel(was.base_role, was.permissions))) return null;
  const who = await confirmAdminGrant(c, password);
  await allowAdminGrant(c.env, c.var.companyId, c.var.userId, id);
  return who;
}

/**
 * Custom roles made and changed (Settings → Roles), here for the password a role that becomes
 * admin-level asks for. Written with the person's own client, so the database's rules hold (nobody
 * gives a role areas they don't have, or changes the role they have). Deleting one stays in the browser.
 */
account.post("/team/roles", requireUser, requireCompany(ADMINS, "team"), async (c) => {
  const { current_password, ...row } = await readJson(c, roleRow);
  // Its id is chosen here, so the database knows it's the role the password was given for.
  const id = crypto.randomUUID();
  const who = await roleGrant(c, id, row, null, current_password);
  const made = must(await c.var.db.from("company_roles").insert({ id, company_id: c.var.companyId, ...row }).select("id").single());
  if (who) noteAdminGrant(c, who, `made the ${row.name} role, with admin access`);
  return c.json(made, 201);
});

account.put("/team/roles/:id", requireUser, requireCompany(ADMINS, "team"), async (c) => {
  const parsed = uuid.safeParse(c.req.param("id"));
  if (!parsed.success) throw new HttpError(404, "That role no longer exists.");
  const id = parsed.data;
  const { db, companyId } = c.var;
  const { current_password, ...row } = await readJson(c, roleRow);
  const was = must(await db.from("company_roles").select("base_role, permissions").eq("id", id).eq("company_id", companyId).maybeSingle(), "That role no longer exists.");
  const who = await roleGrant(c, id, row, was, current_password);
  const { data, error } = await db.from("company_roles").update(row).eq("id", id).eq("company_id", companyId).select("id");
  if (error) throw dbError(error);
  if (!data.length) throw new HttpError(404, "That role no longer exists.");
  if (who) noteAdminGrant(c, who, `gave the ${row.name} role admin access`);
  return c.json({ id });
});

/** Who on the team hasn't set up their account yet, and when their latest link went out. */
account.get("/team/invites", requireUser, requireCompany(ADMINS, "team"), async (c) => {
  const members = must(await c.var.db.from("memberships").select("user_id").eq("company_id", c.var.companyId).eq("active", true).neq("role", "subcontractor").neq("user_id", c.var.userId));
  const admin = adminClient(c.env);
  // One lookup per person: a team is a handful of people, and only Settings → People asks.
  const accounts = await Promise.all(members.map((m) => admin.auth.admin.getUserById(m.user_id)));
  return c.json(
    accounts.flatMap(({ data }) => {
      const user = data.user;
      if (!user || user.last_sign_in_at) return [];
      const sent = [user.invited_at, user.recovery_sent_at, user.created_at].filter((t): t is string => Boolean(t)).map((t) => new Date(t).getTime());
      return [{ user_id: user.id, sent_at: new Date(Math.max(...sent)).toISOString() }];
    }),
  );
});

/**
 * Someone's photo, shown in place of their initials (services/photos.ts). The browser sends it as a
 * small square JPEG, base64. People set their own; owners and admins who manage the team set anyone's
 * on it, and as with roles, only an owner sets another owner's. A sub sets their own.
 */
account.put("/team/:userId/photo", requireUser, requireCompany(WITH_SUBS), async (c) => {
  const targetId = await photoTarget(c);
  const body = await readJson(c, z.object({ photo: z.string().min(100).max(1_400_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }));
  if (!(await allow(c.env, `photo:${c.var.userId}`, 30, 3600))) throw new HttpError(429, "Too many photo changes. Wait a while and try again.");
  return c.json({ avatar_url: await setPhoto(adminClient(c.env), c.var.companyId, targetId, body.photo) });
});

account.delete("/team/:userId/photo", requireUser, requireCompany(WITH_SUBS), async (c) => {
  await removePhoto(adminClient(c.env), await photoTarget(c));
  return c.json({ ok: true });
});

/**
 * The business logo (services/logo.ts), from Settings → Company. The browser sends it as a PNG,
 * base64. Owners and admins change it, as they do the rest of the company's settings.
 */
account.put("/company/logo", requireUser, requireCompany(ADMINS), async (c) => {
  const body = await readJson(c, z.object({ logo: z.string().min(100).max(1_400_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }));
  if (!(await allow(c.env, `logo:${c.var.companyId}`, 30, 3600))) throw new HttpError(429, "Too many logo changes. Wait a while and try again.");
  return c.json({ logo: await setLogo(adminClient(c.env), c.var.companyId, body.logo) });
});

account.delete("/company/logo", requireUser, requireCompany(ADMINS), async (c) => {
  await removeLogo(adminClient(c.env), c.var.companyId);
  return c.json({ ok: true });
});

/**
 * A picture of the business's own letterhead (services/letterhead.ts), for an estimate template:
 * its top or its bottom, as a PNG, base64. It goes on the template when the template is saved. Those
 * who change the templates (Settings → Estimate template) add them.
 */
account.put("/templates/letterhead", requireUser, requireCompany(OFFICE, "settings"), async (c) => {
  const body = await readJson(c, z.object({ picture: z.string().min(100).max(1_900_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }));
  if (!(await allow(c.env, `letterhead:${c.var.companyId}`, 60, 3600))) throw new HttpError(429, "Too many letterhead changes. Wait a while and try again.");
  return c.json(await saveLetterheadPicture(adminClient(c.env), c.var.companyId, body.picture));
});

/** Whose photo the request changes: the person's own, or a teammate's for those who manage the team. */
async function photoTarget(c: Context<AppEnv>): Promise<string> {
  const parsed = uuid.safeParse(c.req.param("userId"));
  if (!parsed.success) throw new HttpError(404, "That person isn't on your team.");
  const { companyId, userId, role, permissions } = c.var;
  if (parsed.data === userId) return userId;
  if (!ADMINS.includes(role) || !permissions.includes("team")) throw new HttpError(403, "You don't have permission to do that. Ask an admin if you need it.");
  const { data: member, error } = await c.var.db.from("memberships").select("role").eq("company_id", companyId).eq("user_id", parsed.data).maybeSingle();
  if (error) throw dbError(error);
  if (!member) throw new HttpError(404, "That person isn't on your team.");
  if (member.role === "owner" && role !== "owner") throw new HttpError(403, "Only an owner can do that for another owner.");
  return parsed.data;
}

/**
 * A new invite for someone who hasn't set up their account yet (the first link expired, or never
 * arrived): emailed when the company's email works, and the link comes back to copy either way.
 */
account.post("/team/:userId/invite-link", requireUser, requireCompany(ADMINS, "team"), async (c) => {
  const parsed = uuid.safeParse(c.req.param("userId"));
  if (!parsed.success) throw new HttpError(404, "That person isn't on your team.");
  const targetId = parsed.data;
  const { companyId, userId, role } = c.var;
  if (!(await allow(c.env, `invite-link:${userId}`, 20, 3600))) throw new HttpError(429, "Too many invites. Wait a while and try again.");

  const { data: member, error } = await c.var.db.from("memberships").select("role, role_id, active").eq("company_id", companyId).eq("user_id", targetId).maybeSingle();
  if (error) throw dbError(error);
  if (!member?.active) throw new HttpError(404, "That person isn't on your team.");
  if (member.role === "subcontractor") throw new HttpError(400, "A sub signs in with a link from their page under Subs.");
  // As with changing their role, only an owner acts for an owner.
  if (member.role === "owner" && role !== "owner") throw new HttpError(403, "Only an owner can do that for another owner.");
  // A link into an account with admin-level access asks for the password, as giving that access does.
  if (await adminAccess(c.var.db, companyId, member.role, member.role_id)) await confirmAdminGrant(c, await passwordIn(c));
  const invite = await inviteStatus(c.env, companyId, targetId);
  if (invite.status !== "pending") {
    throw invite.status === "joined"
      ? new HttpError(400, "They've already set up their account. If they can't get in, use Reset password.")
      : new HttpError(403, "This person also uses Crewtavo with another business, so they need to use Forgot password on the sign-in screen.");
  }

  const link = await welcomeLink(c.env, appUrl(c), invite.email);
  const profile = (await c.var.db.from("profiles").select("full_name").eq("user_id", targetId).maybeSingle()).data;
  const sent = await sendInvite(teamScope(c), { email: invite.email, name: profile?.full_name }, link);
  return c.json({ emailed: sent.sent, reason: sent.sent ? null : sent.reason ?? null, link });
});

/**
 * "Forgot password" and "Email me a sign-in link". The link is sent from the person's company
 * mailbox when it has a working one (or the install's own email, which also takes over if the
 * mailbox fails), so it reaches everyone; without either it falls back to Supabase's mailer.
 * Always answers the same way, so it can't reveal who has an account.
 */
account.post("/auth/email-link", async (c) => {
  const body = await readJson(c, z.object({ email: z.email(), kind: z.enum(["recovery", "magiclink"]) }));
  const email = body.email.trim().toLowerCase();
  const ip = clientIp(c);
  if (!(await allow(c.env, `auth-link:ip:${ip}`, 20, 3600)) || !(await allow(c.env, `auth-link:email:${email}`, 4, 900))) {
    throw new HttpError(429, "Too many requests. Wait a few minutes and try again.");
  }
  // A sub's stand-in address (no email of their own) is never sent anything.
  if (isPlaceholderEmail(email)) return c.json({ sent: true });
  const admin = adminClient(c.env);
  // A one-business instance that can't send email says so instead of pretending a link went out.
  // The answer is the same for every address, so it doesn't reveal who has an account.
  if (c.env.CREWTAVO_SINGLE_COMPANY === "1" && !emailConfigured(c.env)) {
    const { data: mailbox } = await admin.from("integrations").select("company_id").eq("provider", "email").eq("status", "connected").limit(1);
    if (!mailbox?.length) return c.json({ sent: false, reason: "email_off" });
  }
  const redirectTo = `${appUrl(c)}/`;
  const { data: userId } = await admin.rpc("user_id_for_email", { p_email: email });
  if (!userId) return c.json({ sent: true });

  const { data: memberships } = await admin.from("memberships").select("company_id, company:companies(name, email)").eq("user_id", userId).eq("active", true);
  // A company's own mailbox sends the link only when the person belongs to that one company. With
  // several, any of them could have added this person, and whoever runs a mailbox can read the link.
  const only = memberships?.length === 1 ? memberships[0]! : null;
  const onlyCompany = only?.company as unknown as { name: string; email: string | null } | undefined;
  // And only while it works: one whose sign-in failed (a changed or revoked app password, a refused
  // Resend key) would just fail again.
  const mailbox = only ? await loadMailbox(c.env, only.company_id).catch(() => null) : null;
  let sender: { id: string | null; name: string; email: string | null } | null = null;
  if (only && onlyCompany && mailbox && mailbox.status !== "error") {
    // Without the install's own email, only Supabase's mailer could take over from the mailbox, and
    // only before the link is made: making one starts its wait (a minute by default) before it will
    // email that person. So the mailbox has to sign in first.
    if (emailConfigured(c.env) || (await checkMailbox(c.env, only.company_id, mailbox))) {
      sender = { id: only.company_id, name: onlyCompany.name, email: onlyCompany.email };
    }
  }
  if (!sender && emailConfigured(c.env)) {
    sender = { id: null, name: onlyCompany?.name ?? "Crewtavo", email: onlyCompany?.email ?? null };
  }
  if (!sender) {
    const fallback = body.kind === "recovery"
      ? await admin.auth.resetPasswordForEmail(email, { redirectTo })
      : await admin.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirectTo } });
    if (fallback.error) console.error("Supabase auth email failed", fallback.error.message);
    return c.json({ sent: true });
  }

  const { data, error } = await admin.auth.admin.generateLink({ type: body.kind, email, options: { redirectTo } });
  if (error || !data.properties?.hashed_token) {
    console.error("Couldn't create an auth link", error);
    return c.json({ sent: true });
  }
  const link = emailAuthLink(appUrl(c), data.properties.hashed_token, body.kind);
  const text = body.kind === "recovery"
    ? `Someone asked to reset the password for your ${sender.name} account on Crewtavo. Choose a new password here:\n\n${link}\n\nIf that wasn't you, ignore this email. Your password stays the same.`
    : `Here's your link to sign in to ${sender.name} on Crewtavo. It works once and expires soon:\n\n${link}\n\nIf you didn't ask for it, ignore this email.`;
  const message = { to: email, subject: body.kind === "recovery" ? `Reset your ${sender.name} password` : `Your ${sender.name} sign-in link`, ...renderEmail({ companyName: sender.name, text }), replyTo: sender.email ?? undefined, fromName: sender.name };
  let result = await sendEmail(c.env, message, sender.id);
  // The company mailbox didn't take it: the install's own email still can (Supabase's mailer can't
  // now, see above).
  if (!result.sent && sender.id && emailConfigured(c.env)) {
    console.error("Auth email not sent from the company mailbox", result.reason);
    result = await sendEmail(c.env, message, null);
  }
  if (!result.sent) console.error("Auth email not sent", result.reason);
  return c.json({ sent: true });
});
