/**
 * Crewtavo - Marketing as a built-in app (features/marketing, features/apps): who has it in the
 * menu (only while it's installed, only the office with the marketing area), its listing in Apps,
 * the "Ask automatically" form read from the starter rules (features/marketing/askForm.ts),
 * Marketing's code keeping to core's subpaths and today's wording, review asks offered only the
 * ways they can go, alike on every page, and the Referrals tab's credit form
 * (features/marketing/referralForm.ts) and what it saves.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { ASK_CONDITIONS, DEFAULT_REFERRAL_MESSAGE, referralSettings } from "@crewtavo/core/marketing";
import { ROLES, STAFF } from "@crewtavo/core/roles";
import { describe, expect, it } from "vitest";
import { NAV_GROUPS, navVisible } from "../src/components/shell/nav";
import { APP_INFO } from "../src/features/apps/catalog";
import { askBody, askRules, daysInOrder, type AskRuleRow } from "../src/features/marketing/askForm";
import { messageError, referralForm, referralPatch, rewardChanged, rewardError, rewardValue } from "../src/features/marketing/referralForm";

const MARKETING = NAV_GROUPS.flat().find((item) => item.to === "/marketing")!;
const APPS = NAV_GROUPS.flat().find((item) => item.to === "/apps")!;
const ON = { marketing: { enabled: true } };
const person = (role: string, permissions: string[] = ["marketing"], settings: Record<string, unknown> = ON) => ({ role, permissions, company: { settings } });
const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("Marketing in the menu", () => {
  it("shows while it's installed, to owners, admins and office staff with the marketing area", () => {
    expect(STAFF.filter((role) => navVisible(person(role), MARKETING))).toEqual(["owner", "admin", "office"]);
    expect(navVisible(person("office", ["schedule", "sales"]), MARKETING)).toBe(false);
  });

  it("stays hidden while it isn't installed, for every role, the owner too", () => {
    for (const settings of [{}, { marketing: { enabled: false } }, { marketing: {} }, { drive: { enabled: true } }]) {
      for (const role of ROLES) expect(navVisible(person(role, ["marketing", "apps"], settings), MARKETING), `${role} ${JSON.stringify(settings)}`).toBe(false);
    }
  });

  it("is found by searching for its app", () => {
    expect(APPS.keywords).toContain("marketing reviews referrals campaigns");
  });
});

describe("Crewtavo - Marketing in Apps", () => {
  it("opens Marketing, and says what uninstalling does", () => {
    const info = APP_INFO.marketing!;
    expect(info.open).toBe("/marketing");
    expect(info.developer).toBe("Crewtavo");
    expect(info.highlights.map((h) => h.title)).toEqual(["Reviews", "Referrals", "Campaigns"]);
    expect(info.access).toContain("Uninstalling hides Marketing and stops every automatic message it sends to clients, and keeps everything");
    expect(info.website).toBe("https://crewtavo.com/docs/connections/marketing/");
  });

  it("has Crewtavo's own icon, and installs and uninstalls like the other built-in apps", () => {
    expect(source("../src/features/apps/AppIcon.tsx")).toContain("marketing: crewtavoLogo");
    const page = source("../src/features/apps/AppDetailPage.tsx");
    expect(page).toContain('app.id === "marketing" ? marketingSwitch');
    expect(page).toContain("<MarketingPanel />");
    expect(source("../src/features/marketing/useMarketingSwitch.ts")).toContain('api.post<{ enabled: boolean }>("/marketing/enabled"');
  });

  it("is off on its own page the way Drive is, there and on a campaign", () => {
    expect(source("../src/features/marketing/MarketingPage.tsx")).toContain('if (!featureOn(session.company.settings, "marketing")) return <MarketingOff />;');
    expect(source("../src/features/marketing/CampaignPage.tsx")).toContain('featureOn(session.company.settings, "marketing")');
  });
});

describe("the Ask automatically form", () => {
  const rule = (template_key: string, over: Partial<AskRuleRow> = {}): AskRuleRow => ({
    id: template_key, name: template_key === "review_recurring" ? "Ask for a Google review on recurring work" : "Ask for a Google review after a job", description: null, template_key,
    trigger: template_key === "review_recurring" ? "job.recurring_third_visit" : "job.completed", enabled: false, delay_minutes: 1440,
    conditions: template_key === "review_recurring" ? [] : ASK_CONDITIONS["job.completed"],
    actions: [{ type: "request_review", channel: "email" }], ...over,
  });

  it("starts off for a new business, with recurring work and Jobber's reminders ready", () => {
    const { form, onlyRecurring, missing } = askRules([rule("review_after_job"), rule("review_recurring")], {});
    expect(form).toEqual({ enabled: false, when: "job.completed", channel: "email", recurring: true, visits: 3, reminders: 2, days: [3, 5] });
    expect([onlyRecurring, missing]).toEqual([false, false]);
  });

  it("reads on when only recurring work is asked, and says so", () => {
    const { form, onlyRecurring } = askRules([rule("review_after_job"), rule("review_recurring", { enabled: true, actions: [{ type: "request_review", channel: "sms" }] })], {});
    expect(form).toMatchObject({ enabled: true, recurring: true, channel: "sms" });
    expect(onlyRecurring).toBe(true);
    // Saving with it on asks after jobs too; turning it off turns both off (PUT /api/reviews/asks).
    expect(askBody(form)).toMatchObject({ enabled: true, recurring: true });
    expect(askBody({ ...form, enabled: false })).toMatchObject({ enabled: false });
  });

  it("reads what the rules and settings say", () => {
    const visit = rule("review_after_job", { trigger: "visit.completed", conditions: ASK_CONDITIONS["visit.completed"], enabled: true, actions: [{ type: "request_review", channel: "both" }] });
    const { form } = askRules([visit, rule("review_recurring")], { reviews: { recurring_after_visits: 6, reminders: [{ days: 4 }] } });
    expect(form).toEqual({ enabled: true, when: "visit.completed", channel: "both", recurring: false, visits: 6, reminders: 1, days: [4, 5] });
    expect(askBody(form)).toEqual({ enabled: true, when: "visit.completed", channel: "both", recurring: false, recurring_after_visits: 6, reminder_days: [4] });
  });

  it("knows a rule changed in Automations, and one that's gone", () => {
    const custom = rule("review_after_job", { actions: [{ type: "request_review", channel: "email" }, { type: "add_tag", tag: "Asked" }] });
    expect(askRules([custom, rule("review_recurring")], {})).toMatchObject({ afterCustom: true, recurringCustom: false, missing: false });
    expect(askRules([rule("review_after_job")], {})).toMatchObject({ missing: true, recurringCustom: false });
  });

  it("shows a changed rule that's asking as on, and turning it off sends off for it too", () => {
    const custom = rule("review_after_job", { enabled: true, conditions: [{ field: "client.tags", op: "includes", value: ["VIP"] }] });
    const { form, afterCustom } = askRules([custom, rule("review_recurring")], {});
    expect([form.enabled, afterCustom]).toEqual([true, true]);
    // PUT /api/reviews/asks turns the changed rule off with only its switch (apps/api/test/reviews.test.ts).
    expect(askBody({ ...form, enabled: false })).toMatchObject({ enabled: false });
    expect(source("../src/features/marketing/Reviews.tsx")).toContain("so only the switch above turns it on and off here");
  });

  it("keeps Send by for recurring work when the after-job rule was changed in Automations", () => {
    const custom = rule("review_after_job", { enabled: true, actions: [{ type: "request_review", channel: "both" }, { type: "add_tag", tag: "Asked" }] });
    const { form } = askRules([custom, rule("review_recurring", { enabled: true, actions: [{ type: "request_review", channel: "sms" }] })], {});
    // The recurring rule's own channel, not the changed rule's, and Save writes back what's shown.
    expect(form.channel).toBe("sms");
    expect(askBody(form).channel).toBe("sms");
    expect(source("../src/features/marketing/Reviews.tsx")).toContain("const channelShown = !afterCustom || !recurringCustom;");
  });

  it("says when an ask goes out in a whole sentence", () => {
    const reviews = source("../src/features/marketing/Reviews.tsx");
    expect(reviews).toContain('askTiming("after_job", form.when');
    expect(reviews).not.toContain("describeDelay(delay)} after");
  });

  it("wants the second reminder after the first", () => {
    const { form } = askRules([], {});
    expect(daysInOrder({ ...form, days: [5, 3] })).toBe(false);
    expect(daysInOrder({ ...form, days: [3, 3] })).toBe(false);
    expect(daysInOrder({ ...form, reminders: 1, days: [5, 3] })).toBe(true);
    expect(askBody({ ...form, reminders: 0 }).reminder_days).toEqual([]);
  });
});

describe("Marketing's code", () => {
  const dir = fileURLToPath(new URL("../src/features/marketing", import.meta.url));
  const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);

  it("imports core by its subpaths, never the whole of it", () => {
    for (const [file, text] of files) expect(text, file).not.toMatch(/from "@crewtavo\/core"/);
  });

  it("says when the picked client was last asked, right after asking them", () => {
    expect(source("../src/features/marketing/Reviews.tsx")).toContain('queryClient.invalidateQueries({ queryKey: ["review-ask"] })');
    expect(source("../src/features/clients/ClientPage.tsx")).toContain('queryClient.invalidateQueries({ queryKey: ["review-ask", id] })');
  });

  it("lists an ask that failed straight away, saying why", () => {
    const reviews = source("../src/features/marketing/Reviews.tsx");
    const askNow = reviews.slice(reviews.indexOf("function AskNow()"));
    expect(askNow).toMatch(/onSettled: \(\) => \{\s+queryClient\.invalidateQueries\(\{ queryKey: \["review-requests"/);
    expect(reviews).toContain("askError(r)");
    expect(reviews).toContain("reminderLines(r, remindersSet");
  });

  it("offers review asks on the job and client pages only the ways they can go, as Ask a client now does", () => {
    for (const page of ["../src/features/jobs/JobPage.tsx", "../src/features/clients/ClientPage.tsx", "../src/features/marketing/Reviews.tsx"]) {
      const text = source(page);
      expect(text, page).toContain("askRefusal(");
      expect(text, page).toContain("sms: session.config.features.sms");
    }
    expect(source("../src/features/jobs/JobPage.tsx")).toContain("review_opt_out, marketing_opt_out, sms_opt_out_at");
  });

  it("says Skipped once in a rule's runs, and filters to skipped runs", () => {
    const runs = source("../src/features/automations/AutomationsPage.tsx");
    expect(runs).toContain('{ value: "skipped", label: "Skipped", empty: "Nothing skipped" }');
    // The pill says Skipped when every action was; a skipped action in a run that did more says so itself.
    expect(runs).toContain('x.skipped && r.status !== "skipped" ? `Skipped: ${x.detail}` : x.detail');
  });

  it("lets a quote or invoice be texted to a different number for a client who texted STOP", () => {
    const dialog = source("../src/features/quotes/SendDialog.tsx");
    expect(dialog).toContain('channel === "sms" && !textsOffSince ? formatPhoneTyping(phone ?? "") : ""');
    expect(dialog).not.toContain("disabled={Boolean(textsOffSince)}");
  });

  it("says that uninstalling puts scheduled campaigns back to drafts", () => {
    expect(source("../src/features/marketing/useMarketingSwitch.ts")).toContain("Scheduled campaigns go back to drafts, and one that's sending stops where it is.");
  });

  it("doesn't promise the old once-a-month limit", () => {
    for (const [file, text] of files) expect(text.toLowerCase(), file).not.toContain("once a month");
  });

  it("shares the review message with the server, word for word", () => {
    for (const [file, text] of files) expect(text, file).not.toContain("would you leave us a quick review");
    expect(source("../src/features/marketing/Reviews.tsx")).toContain("DEFAULT_REVIEW_MESSAGE");
  });
});

describe("the Referrals tab's credit, offer and email", () => {
  const saved = { referrals: { reward: { kind: "percent", value: 10 }, offer: "10% off your first mow", message: "Hi {{link}} {{rewards}}", extra: "kept" }, marketing: { enabled: true } };

  it("reads settings.referrals into the form, an unset credit as an empty box", () => {
    expect(referralForm(saved)).toEqual({ kind: "percent", value: "10", offer: "10% off your first mow", message: "Hi {{link}} {{rewards}}" });
    expect(referralForm({})).toEqual({ kind: "amount", value: "", offer: "", message: DEFAULT_REFERRAL_MESSAGE });
  });

  it("takes a percentage from 1 to 100 and an amount up to $10,000, to the cent", () => {
    expect(rewardError({ kind: "percent", value: "0.5" })).toBe("Pick a percentage from 1 to 100.");
    expect(rewardError({ kind: "percent", value: "101" })).toBe("Pick a percentage from 1 to 100.");
    expect(rewardError({ kind: "percent", value: "12.5" })).toBeNull();
    expect(rewardError({ kind: "amount", value: "10001" })).toBe("Enter an amount up to $10,000.");
    expect(rewardError({ kind: "amount", value: "1.2.3" })).toBe("Enter an amount up to $10,000.");
    expect(rewardError({ kind: "amount", value: "" })).toBeNull();
    expect(rewardValue({ value: "49.999" })).toBe(50);
    expect(rewardValue({ value: "12.345" })).toBe(12.35);
    expect(rewardValue({ value: "" })).toBe(0);
    expect(messageError({ message: "No link here" })).toBe("Include {{link}} so clients get their own link to share.");
    expect(messageError({ message: "Here: {{link}}" })).toBeNull();
  });

  it("saves settings.referrals in the shape the server reads, keeping the rest", () => {
    const patch = referralPatch({ kind: "amount", value: "25.5", offer: "  A free edge trim ", message: " Share it: {{link}} " }, saved);
    expect(patch).toEqual({ referrals: { reward: { kind: "amount", value: 25.5 }, offer: "A free edge trim", message: "Share it: {{link}}", extra: "kept" } });
    expect(referralSettings({ ...saved, ...patch })).toEqual({ reward: { kind: "amount", value: 25.5 }, offer: "A free edge trim", message: "Share it: {{link}}" });
    // The default isn't written down, and an empty offer is none.
    expect(referralPatch({ kind: "percent", value: "10", offer: " ", message: DEFAULT_REFERRAL_MESSAGE }, {})).toEqual({ referrals: { reward: { kind: "percent", value: 10 }, offer: null, message: null } });
  });

  it("knows when the credit changed, so it can say friends referred already keep theirs", () => {
    expect(rewardChanged(referralForm(saved), saved)).toBe(false);
    expect(rewardChanged({ ...referralForm(saved), value: "15" }, saved)).toBe(true);
    expect(rewardChanged({ ...referralForm(saved), kind: "amount" }, saved)).toBe(true);
    expect(rewardChanged({ ...referralForm(saved), offer: "Something else" }, saved)).toBe(false);
    // Setting the first credit, nobody was offered one to keep.
    expect(rewardChanged({ ...referralForm({}), value: "50" }, {})).toBe(false);
    expect(rewardChanged({ ...referralForm({}), kind: "percent", value: "10" }, { referrals: { reward: { kind: "amount", value: 0 } } })).toBe(false);
  });

  it("writes settings.referrals, and never the old referral_reward or referral_offer", () => {
    const tab = source("../src/features/marketing/Referrals.tsx");
    expect(tab).toContain("save.mutate((current) => referralPatch(form, current))");
    expect(source("../src/features/marketing/MarketingPage.tsx")).toContain("<Referrals />");
    for (const file of ["../src/features/marketing/Referrals.tsx", "../src/features/marketing/referralForm.ts", "../src/features/marketing/MarketingPage.tsx", "../src/features/clients/ClientPage.tsx"]) {
      expect(source(file), file).not.toMatch(/referral_reward|referral_offer|rewards_pending/);
    }
    // Referrals change through the database's functions, never a direct update.
    expect(tab).not.toContain('from("referrals").update');
    expect(tab).toContain('fn: "referral_set_given"');
  });

  it("says in the uninstall copy that referral credits still go on invoices", () => {
    const uninstall = source("../src/features/marketing/useMarketingSwitch.ts");
    expect(uninstall).toContain("review asks, their reminders, referral asks and campaigns");
    expect(uninstall).toContain("Referral credits clients have earned, or earn later from links already shared, still go on their invoices.");
    expect(source("../src/features/marketing/MarketingPage.tsx")).toContain("Referral credits clients have earned, or earn later from links already shared, still go on their invoices.");
  });

  it("is offered in the rule editor and Automations as an email action", () => {
    const rule = source("../src/features/automations/RulePage.tsx");
    expect(rule).toContain('request_referral: "gift"');
    expect(rule).toContain('case "request_referral": return { type };');
    expect(rule).toContain('<Link to="/marketing?tab=referrals">referral settings</Link>');
    expect(source("../src/features/automations/AutomationsPage.tsx")).toContain('a.type === "request_referral"');
  });

  it("pages the referral list, so older referrals and their credits stay in reach", () => {
    const tab = source("../src/features/marketing/Referrals.tsx");
    expect(tab).not.toContain(".limit(200)");
    expect(tab).not.toContain("Show all");
    expect(tab).toContain('{ count: "exact" }');
    expect(tab).toContain("Showing {rows.length.toLocaleString()} of {total.toLocaleString()}");
    expect(tab).toContain(">Load more</Button>");
  });

  it("counts what was given outside Crewtavo apart from what's left", () => {
    const tab = source("../src/features/marketing/Referrals.tsx");
    expect(tab).toContain("given_amount");
    expect(tab).toContain('Number(r.reward_amount) - Number(r.given_amount) - applied');
  });

  it("keeps the pills lined up when a referral has nothing in its menu", () => {
    const tab = source("../src/features/marketing/Referrals.tsx");
    expect(tab).toContain('return <span aria-hidden="true" style={{ width: "var(--control-sm)", flexShrink: 0 }} />;');
    expect(tab).toContain("<RowMenu");
  });

  it("doesn't call a credit given when it's only turned back on", () => {
    const tab = source("../src/features/marketing/Referrals.tsx");
    expect(tab).not.toContain('"Credit given"');
    expect(tab).toContain("${v.referrer} gets the credit when ${v.friend} pays.");
  });

  it("shows top referrers' trouble loading, and every amount in cents", () => {
    const tab = source("../src/features/marketing/Referrals.tsx");
    expect(tab).toContain("{stats.error && <ErrorState compact error={stats.error} onRetry={() => stats.refetch()} />}");
    expect(tab).not.toMatch(/formatMoney\(/);
  });

  it("doesn't let asks be switched on before email is connected", () => {
    const tab = source("../src/features/marketing/Referrals.tsx");
    expect(tab).toContain("disabled={!canSave || save.isPending || (!on && (!ready || !emailReady))}");
    expect(tab).toContain("refusal !== REFERRAL_EMAIL_NOT_CONNECTED");
  });

  it("says one status per referral, in StatusPill's words", () => {
    const tab = source("../src/features/marketing/Referrals.tsx");
    expect(tab).toContain("<EntityStatus kind={pill.kind} status={pill.status} />");
    expect(source("../src/components/ui/StatusPill.tsx")).toContain('credit: { pending: "Pending", earned: "Earned", applied: "Applied", issued: "Given", none: "No credit" }');
  });
});
