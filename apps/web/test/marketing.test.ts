/**
 * Crewtavo - Marketing as a built-in app (features/marketing, features/apps): who has it in the
 * menu (only while it's installed, only the office with the marketing area), its listing in Apps,
 * the "Ask automatically" form read from the starter rules (features/marketing/askForm.ts),
 * Marketing's code keeping to core's subpaths and today's wording, review asks offered only the
 * ways they can go, alike on every page, the Referrals tab's credit form
 * (features/marketing/referralForm.ts) and what it saves, and the Campaigns tab's automated
 * campaign cards (features/marketing/automatedForm.ts) and results.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { AUTOMATED_CAMPAIGNS } from "@crewtavo/core/campaigns";
import { ASK_CONDITIONS, DEFAULT_REFERRAL_MESSAGE, referralSettings } from "@crewtavo/core/marketing";
import { ROLES, STAFF } from "@crewtavo/core/roles";
import { describe, expect, it } from "vitest";
import { NAV_GROUPS, navVisible } from "../src/components/shell/nav";
import { APP_INFO, CATEGORY_LABELS, MORE_LABELS } from "../src/features/apps/catalog";
import {
  canReply,
  canSync,
  countHint,
  filterReviews,
  filtersOn,
  hasNumbers,
  initials,
  locationSavedWords,
  NO_FILTERS,
  problemCopy,
  progressWords,
  rankSuggestions,
  repliedWords,
  showsList,
  tooSoon,
  type GoogleState,
} from "../src/features/marketing/googleReviewData";
import { ApiError } from "../src/lib/errors";
import { askBody, askRules, daysInOrder, type AskRuleRow } from "../src/features/marketing/askForm";
import {
  automatedBody,
  automatedRules,
  dayChoices,
  daysError,
  emailsSentHint,
  lowerWords,
  sampleVars,
  timingLine,
  turnOffWords,
  waitingLine,
  waitingWords,
  type AutomatedRuleRow,
} from "../src/features/marketing/automatedForm";
import { previewParagraphs } from "../src/features/marketing/EmailEditor";
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
    expect(source("../src/features/marketing/useMarketingSwitch.tsx")).toContain('api.post<{ enabled: boolean }>("/marketing/enabled"');
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
    expect(source("../src/features/marketing/useMarketingSwitch.tsx")).toContain("Campaigns: scheduled ones go back to drafts, and one that's sending stops where it is");
  });

  it("doesn't promise the old once-a-month limit", () => {
    for (const [file, text] of files) expect(text.toLowerCase(), file).not.toContain("once a month");
  });

  it("shares the review message with the server, word for word", () => {
    for (const [file, text] of files) expect(text, file).not.toContain("would you leave us a quick review");
    expect(source("../src/features/marketing/Reviews.tsx")).toContain("DEFAULT_REVIEW_MESSAGE");
  });
});

describe("the automated campaign cards", () => {
  const rule = (key: keyof typeof AUTOMATED_CAMPAIGNS, over: Partial<AutomatedRuleRow> = {}): AutomatedRuleRow => {
    const { template_key, name, description, trigger, delay_minutes, conditions, actions, enabled } = AUTOMATED_CAMPAIGNS[key].starter;
    return { id: `rule-${key}`, template_key, name, description, trigger, delay_minutes, conditions, actions, enabled, ...over };
  };

  it("read the starter rules: Re-engage and Win back off, Close pending quotes on, each at its own days", () => {
    const cards = automatedRules([rule("reengage"), rule("win_back"), rule("close_quotes")]);
    expect(cards.reengage).toMatchObject({ custom: false, missing: false, form: { enabled: false, days: 365, subject: "It's been a while, {{client.first_name}}" } });
    expect(cards.win_back.form).toMatchObject({ enabled: false, days: 30 });
    expect(cards.close_quotes.form).toMatchObject({ enabled: true, days: 3, subject: "Following up on your quote from {{company.name}}" });
    expect(timingLine("reengage", 365)).toBe("Emails clients who haven't had a visit in 1 year, on the day they reach it.");
    expect(timingLine("close_quotes", 3)).toBe("Emails the client 3 days after you send a quote they haven't answered.");
  });

  it("know a rule changed in Automations, which only its switch changes, and one that's gone", () => {
    const changed = rule("win_back", { enabled: true, conditions: [{ field: "amount", op: "gte", value: 5000 }] });
    const cards = automatedRules([rule("reengage"), changed]);
    expect(cards.win_back).toMatchObject({ custom: true, missing: false, form: { enabled: true } });
    expect(cards.close_quotes).toMatchObject({ custom: false, missing: true, form: { enabled: false, days: 3 } });
    expect(source("../src/features/marketing/AutomatedCampaigns.tsx")).toContain("so only the switch above turns it on and off here");
  });

  it("save the email and days without the switch, and keep the days in range", () => {
    expect(automatedBody({ days: 90, subject: " We miss you ", body: "Hi {{client.first_name}} {{link}} \n" })).toEqual({ days: 90, subject: "We miss you", body: "Hi {{client.first_name}} {{link}}" });
    expect(daysError("reengage", 20)).toBe("Pick from 30 to 730 days.");
    expect(daysError("win_back", 30)).toBeNull();
    expect(daysError("close_quotes", 31)).toBe("Pick from 1 to 30 days.");
    // Months and years for Re-engage, with a value set in Automations as its own choice.
    expect(dayChoices("reengage", 365).map((c) => c.label)).toEqual(["1 month", "2 months", "3 months", "6 months", "9 months", "1 year", "18 months", "2 years"]);
    expect(dayChoices("reengage", 200).find((c) => c.days === 200)?.label).toBe("200 days");
    expect(dayChoices("close_quotes", 3)).toHaveLength(30);
  });

  it("preview with the person signed in as the client and a made-up quote", () => {
    const vars = sampleVars("win_back", { name: "Mia Owner", email: "mia@acme.example", company: "Acme Lawn" }, 30, "https://ops.example.com", new Date("2026-10-27T15:00:00Z"));
    expect(vars).toMatchObject({ "client.first_name": "Mia", title: "Spring cleanup", number: "1042", link: "https://ops.example.com", last_visit: "September 27, 2026" });
    // Re-engage is about a client, whose name the engine puts in {{title}}.
    expect(sampleVars("reengage", { name: "Mia Owner", email: null, company: "Acme Lawn" }, 365, "https://ops.example.com").title).toBe("Mia Owner");
    expect(sampleVars("reengage", { name: "", email: null, company: "Acme Lawn" }, 365, "https://ops.example.com").title).toBe("Jordan Rivera");
  });

  it("ask before emailing past clients who already qualify, waiting for the count, and say so to the server", () => {
    const cards = source("../src/features/marketing/AutomatedCampaigns.tsx");
    // The switch waits for a fresh count, asks when anyone qualifies, and the server checks again.
    expect(cards).toContain('const counting = key === "reengage" && !on && (!backlog.isSuccess || backlog.isFetching);');
    expect(cards).toContain("disabled={!canSave || save.isPending || counting");
    expect(cards).toContain('if (next && key === "reengage" && waiting > 0) return setChoosing(true);');
    expect(cards).toContain("Couldn't count the past clients who already qualify, so it can't be turned on yet.");
    // A rule changed in Automations is counted at its own days, not skipped.
    expect(cards).toContain("const days = custom && rule ? inactiveDays(rule.conditions) : form.days;");
    expect(cards).toContain('enabled: key === "reengage",');
  });

  it("say so when a count they need fails, instead of doing nothing or skipping the warning", () => {
    const cards = source("../src/features/marketing/AutomatedCampaigns.tsx");
    // Edit email's lowered-wait count shows its error under the form.
    expect(cards).toContain("return setCounted(error);");
    expect(cards).toContain("<FormError error={save.error ?? counted} />");
    // Turning Win back or Close pending quotes off still warns when the waiting count fails.
    expect(turnOffWords("win_back", null)).toBe("Any quotes waiting for a win-back email are cancelled, and turning it back on won't send them.");
    expect(cards).toContain("if ((error || count) && !(await confirm(");
    expect(cards).toContain("turnOffWords(key, error ? null : (count ?? 0))");
  });

  it("show their results loading and failing, not \"Nothing sent yet\"", () => {
    const cards = source("../src/features/marketing/AutomatedCampaigns.tsx");
    expect(cards).toContain("if (results.isPending) return <Skeleton");
    expect(cards).toContain("Couldn't load its results.");
  });

  it("show office staff without Automations whether each is on and when it goes, from its rule", () => {
    const cards = source("../src/features/marketing/AutomatedCampaigns.tsx");
    expect(cards).toContain('rpc("automated_campaign_states"');
    expect(cards).toContain('<StatusPill label={on ? "On" : "Off"}');
    expect(cards).toContain("timingLine(card.key, state.days)");
    expect(cards).not.toContain("card.campaign.starter.description");
  });

  it("say on uninstalling that win-back emails waiting are lost and re-engage ones aren't", () => {
    expect(waitingWords(3)).toBe("3 win-back emails are waiting: they're cancelled and not sent later. Past clients still due a re-engage email get it once Marketing is back.");
    expect(waitingWords(1)).toBe("1 win-back email is waiting: it's cancelled and not sent later. Past clients still due a re-engage email get it once Marketing is back.");
    expect(waitingWords(0)).toBe("Past clients still due a re-engage email get it once Marketing is back.");
    expect(waitingWords(null)).toContain("Win-back emails that are waiting are cancelled and aren't sent later.");
    expect(source("../src/features/marketing/useMarketingSwitch.tsx")).toContain("{waitingWords(winBacks)}");
  });

  it("say what each leaves out, and that Close pending quotes isn't marketing", () => {
    const cards = source("../src/features/marketing/AutomatedCampaigns.tsx");
    expect(cards).toContain("so it isn't a marketing email: it keeps going while Marketing is uninstalled, reaches clients who unsubscribed from marketing, and has no unsubscribe link.");
    expect(cards).toContain("A year by default, so it reaches them at the same time of year as their last visit");
    expect(turnOffWords("close_quotes", 3)).toBe("3 quotes are waiting for a follow-up. Turning this off cancels them, and turning it back on won't send them.");
    expect(turnOffWords("win_back", 1)).toBe("1 quote is waiting for a win-back email. Turning this off cancels it, and turning it back on won't send it.");
    expect(cards).toContain("Only clients who reach it from now on");
    expect(cards).toContain("Add a link so clicks and bookings can be counted.");
    // Saving the email never sends the switch.
    expect(cards).toContain("api.put(`/campaigns/automated/${key}`, automatedBody(draft))");
  });
});

describe("the automated campaign cards' words", () => {
  it("say when a backlog goes in words that fit, one client or many", () => {
    expect(lowerWords(182, 1, 1)).toBe("Lowering it to 6 months adds 1 client, who gets it within a day.");
    expect(lowerWords(90, 250, 300)).toBe("Lowering it to 3 months adds 250 clients, who get it 100 a day over the next 3 days.");
    expect(waitingLine(1)).toBe("1 email waiting");
    expect(waitingLine(12)).toBe("12 emails waiting");
    const cards = source("../src/features/marketing/AutomatedCampaigns.tsx");
    expect(cards).not.toContain("over the next {backlogWords");
    expect(cards).toContain("{qualifyWords(count)}: they get it {backlogWords(count)}.");
    expect(cards).toContain('paced ? `Email them too, ${REENGAGE_DAILY_CAP} a day` : "Email them too"');
  });

  it("keep the card short: who it leaves out folded away, the wait's note in Edit email, one link to a changed rule", () => {
    const cards = source("../src/features/marketing/AutomatedCampaigns.tsx");
    expect(cards).toContain('<summary>Who gets it</summary>');
    expect(cards).not.toContain('" Quotes already waiting move to the new wait."');
    expect(cards).toContain('win_back: "Quotes already waiting move to the new wait."');
    expect(cards).toContain("hint={DAYS_HINTS[key]}");
    expect(cards).toContain("{canSave && !custom && (");
    expect(cards).toContain("{queued > 0 && <p className=\"small\" style={{ margin: 0 }}>{waitingLine(queued)}</p>}");
  });

  it("say why the switch and Send a test are off without email, and say a test went inside the dialog", () => {
    const cards = source("../src/features/marketing/AutomatedCampaigns.tsx");
    expect(cards).toContain("{canSave && !on && !emailReady && <p className=\"muted small\" style={{ margin: 0 }}>Email isn't connected yet.<ConnectEmailHint /></p>}");
    expect(cards).toContain("Email isn't connected yet, so a test can't be sent.");
    expect(cards).toContain("onSent={setTestedTo}");
    expect(source("../src/features/marketing/EmailEditor.tsx")).toContain("if (onSent) onSent(r.to);");
  });

  it("preview {{link}} on its own line as the button clients get, named for where it goes", () => {
    const vars = { "client.first_name": "Mia", link: "https://ops.example.com", "company.name": "Acme", "company.phone": "" };
    expect(previewParagraphs("Hi {{client.first_name}},\n\nAsk online:\n\n{{link}}\n\nThanks,\n{{company.name}}\n{{company.phone}}", vars, "Request work")).toEqual([
      { text: "Hi Mia," },
      { text: "Ask online:" },
      { text: "https://ops.example.com", button: "Request work" },
      { text: "Thanks,\nAcme\n" },
    ]);
    expect(previewParagraphs("See https://acme.example/fall for more\n\nhttps://acme.example/book", vars, "Request work").map((p) => p.button)).toEqual([undefined, "Open"]);
    expect(source("../src/features/marketing/AutomatedCampaigns.tsx")).toContain("linkLabel={linkButton(key)}");
    expect(source("../src/features/marketing/CampaignPage.tsx")).toContain("linkLabel={HUB_HOME_BUTTON}");
  });

  it("say on the overview how many of the month's emails were automated", () => {
    expect(emailsSentHint({ emails_sent_30d: 106, automated_sent_30d: 102, opted_out: 2 })).toBe("102 automated, 4 from one-off campaigns · 2 unsubscribed");
    expect(emailsSentHint({ emails_sent_30d: 4, automated_sent_30d: 0, opted_out: 1 })).toBe("4 from one-off campaigns · 1 unsubscribed");
    expect(emailsSentHint({ emails_sent_30d: 0, automated_sent_30d: 0, opted_out: 0 })).toBe("None sent yet · 0 unsubscribed");
    expect(source("../src/features/marketing/MarketingPage.tsx")).toContain("{emailsSentHint(s)}");
  });

  it("say on uninstalling that following up on quotes keeps going only while it's on, in short lists", () => {
    const uninstall = source("../src/features/marketing/useMarketingSwitch.tsx");
    expect(uninstall).toContain('followUp ? "Following up on sent quotes, which isn\'t marketing"');
    expect(uninstall).toContain('<ul className="app-steps">');
    expect(uninstall).not.toContain("Following up on sent quotes keeps going.");
  });

  it("call a notify-only rule on client.inactive part of Re-engage, not a marketing email", () => {
    const rule = source("../src/features/automations/RulePage.tsx");
    expect(rule).toContain('const emailsClient = draft.actions.some((a) => a.type === "send_email");');
    expect(rule).toContain("Nothing is emailed to the client unless you add Email the client.");
  });

  it("list who got a campaign narrowed to those who opened, clicked or booked, each a stronger pill", () => {
    const results = source("../src/features/marketing/CampaignResults.tsx");
    expect(results).toContain("p_filter: filter");
    expect(results).toContain('{ value: "booked", label: "Booked", empty: "No bookings yet" }');
    expect(source("../src/components/ui/StatusPill.tsx")).toContain('recipient: { pending: "muted", sending: "info", sent: "muted", failed: "danger", skipped: "muted", opened: "info", clicked: "good" }');
  });

  it("show a sent campaign's numbers across the page, and its preview as someone who got it", () => {
    const page = source("../src/features/marketing/CampaignPage.tsx");
    expect(page.indexOf("<CampaignStats")).toBeLessThan(page.indexOf('<div className="two-col">'));
    expect(page).toContain('queryKey: ["campaign-first-recipient", id]');
    expect(page).toContain("options={choices.data?.cities}");
  });
});

describe("the Campaigns tab and a campaign's page", () => {
  it("lists only one-off campaigns under the automated ones, with New campaign in its own heading", () => {
    const page = source("../src/features/marketing/MarketingPage.tsx");
    expect(page).toContain('.eq("kind", "one_off")');
    expect(page.indexOf("<AutomatedCampaigns")).toBeLessThan(page.indexOf("One-off campaigns"));
    expect(page).toContain("Revenue from campaigns");
    // Only while the follow-up rule is on.
    expect(page).toContain('{followUp?.enabled && <>{" "}Following up on sent quotes keeps going.</>}');
  });

  it("pages through every recipient from where the last page left off", () => {
    const results = source("../src/features/marketing/CampaignResults.tsx");
    expect(results).toContain("useInfiniteQuery");
    expect(results).toContain("p_limit: RECIPIENT_PAGE, p_offset: pageParam");
    expect(results).not.toContain("p_offset: 0");
  });

  it("shows a sent campaign's cities and services as the business writes them", () => {
    const page = source("../src/features/marketing/CampaignPage.tsx");
    expect(page).toContain("audienceSummary(draft.audience, choices.data)");
    // Their labels load for a sent campaign too, not only while it's a draft.
    expect(page).toContain('enabled: Boolean(c) && c?.kind !== "automated",');
  });

  it("shows an automated campaign as its results, and says opens are approximate", () => {
    expect(source("../src/features/marketing/CampaignPage.tsx")).toContain('c?.kind === "automated"');
    expect(source("../src/features/marketing/CampaignResults.tsx")).toContain("Opens are approximate: Apple Mail and some others load images to protect privacy");
  });

  it("writes both kinds of email with the same editor", () => {
    for (const page of ["../src/features/marketing/CampaignPage.tsx", "../src/features/marketing/AutomatedCampaigns.tsx"]) {
      const text = source(page);
      expect(text, page).toContain('from "./EmailEditor"');
      expect(text, page).toContain("<MessageField");
      expect(text, page).toContain("<EmailPreview");
    }
  });

  it("names statuses with the glossary's words", () => {
    for (const page of ["../src/features/marketing/MarketingPage.tsx", "../src/features/marketing/CampaignPage.tsx", "../src/features/marketing/CampaignResults.tsx"]) {
      const text = source(page);
      expect(text, page).not.toContain("CAMPAIGN_LABELS");
      expect(text, page).not.toMatch(/pending: "Queued"/);
    }
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
    const uninstall = source("../src/features/marketing/useMarketingSwitch.tsx");
    expect(uninstall).toContain("Review asks and their reminders");
    expect(uninstall).toContain("Referral credits clients have earned, or earn later from links already shared, on their invoices");
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

describe("Google Business Profile in Apps", () => {
  it("is a Marketing app that shows reviews in Marketing, and says what it can't do", () => {
    const info = APP_INFO.google_business!;
    expect([CATEGORY_LABELS.Marketing, MORE_LABELS.Marketing]).toEqual(["Marketing", "More marketing apps"]);
    expect(info.tagline).toBe("Your Google reviews in Crewtavo");
    expect(info.open).toBe("/marketing?tab=reviews");
    expect(info.highlights.map((h) => h.title)).toEqual(["Reviews in Marketing", "Reply with a suggestion", "Asks stop once they've reviewed"]);
    expect(info.access).toEqual(expect.arrayContaining([
      "Post, change and delete the replies you write here, publicly on Google",
      "It can't change or remove your reviews",
      "Needs Crewtavo - Marketing",
      "Uninstalling stops bringing reviews in and keeps the ones already here",
    ]));
    // Google's own pages until Crewtavo's docs page is written.
    expect(info.website).toBe("https://www.google.com/business/");
    expect(source("../src/features/apps/AppIcon.tsx")).toContain("google_business: googleBusinessLogo");
    expect(APPS.keywords).toContain("google reviews google business profile");
  });

  it("waits for Marketing, and never signs in straight from Install: Google's access request comes first", () => {
    const page = source("../src/features/apps/AppDetailPage.tsx");
    expect(page).toContain("Install Crewtavo - Marketing first: your Google reviews show in Marketing → Reviews.");
    expect(page).toContain('app.id !== "google_calendar" && app.id !== "google_business" && !keysFirst(app)');
    expect(page).toContain('{ label: "Waiting on Google", tone: "warning" }');
    expect(page).toContain('{ label: "Paused", tone: "warning" }');
    expect(page).toContain("Also remove the {count.toLocaleString(\"en-US\")} {count === 1 ? \"review\" : \"reviews\"} brought in (asks start again for clients they matched)");
    const panel = source("../src/features/apps/GoogleBusinessPanel.tsx");
    const before = panel.slice(panel.indexOf("export function GoogleBeforeSignIn"));
    expect(before.indexOf("GOOGLE_ACCESS_FORM")).toBeLessThan(before.indexOf("Sign in with Google"));
    expect(panel).toContain("Marketing is off, so reviews aren't brought in and replies can't be posted. Reviews already here are kept.");
    expect(panel).toContain("Crewtavo brings in one location's reviews.");
    expect(panel).toContain("asks start again for the clients they matched");
    // Signed in with no location in use, the picker shows: also after reconnecting to an account
    // without the location the kept reviews came from, or one with no Business Profile at all.
    expect(panel).toContain('const pick = listable && (picking || problem === "pick" || !g.location);');
    expect(panel).toContain("if (kept && kept !== chosen.location && reviewCount > 0)");
    expect(panel).toContain("Sign in with another Google account");
    expect(page).toContain('(pending === "pick" && app.google_business?.problem_detail === "none")');
    // A business's own Google app: Google's form comes before the keys, and its own approval is said.
    const keys = source("../src/features/apps/AppKeysCard.tsx");
    const steps = keys.slice(keys.indexOf("export function GoogleSteps"));
    expect(steps.indexOf("GOOGLE_ACCESS_FORM")).toBeLessThan(steps.indexOf("Client secret"));
    expect(keys).toContain("even if this server's project is approved already");
    expect(steps).toContain("In production");
    // With no Google app of the server's, the own-app card is the only way in and says so.
    const intro = keys.slice(keys.indexOf("function googleIntro"), keys.indexOf("function IntuitSteps"));
    expect(intro).toContain("if (app.available && !app.app_keys)");
    expect(intro).toContain("Google Business Profile connects through a Google Cloud project you make for your business.");
  });

  it("has one setup anchor, says the wait one way, and doesn't repeat the callout when back from signing in", () => {
    const page = source("../src/features/apps/AppDetailPage.tsx");
    expect(page).toContain("connecting={connect.isPending} anchor={false} />");
    expect(page).toContain('anchor={app.id !== "google_business"}');
    expect(source("../src/features/apps/AppKeysCard.tsx")).toContain('const setupId = anchor ? "app-setup" : undefined;');
    for (const file of ["../src/features/apps/GoogleBusinessPanel.tsx", "../src/features/apps/AppKeysCard.tsx", "../src/features/apps/catalog.ts", "../src/features/marketing/GoogleReviews.tsx", "../src/features/marketing/googleReviewData.ts"]) {
      expect(source(file), file).not.toMatch(/about (two weeks|14 days)/);
    }
    expect(source("../src/features/apps/GoogleBusinessPanel.tsx")).toContain("You can sign in before Google approves");
    expect(page).toContain('if (pending === "approval") return "Reviews start coming in once Google approves access.";');
    expect(page).not.toContain("Signed in. Google hasn't approved");
  });

  it("offers nothing that can't work yet: no Open while paused, no location or link offer while signed out, a status while Google errs", () => {
    const page = source("../src/features/apps/AppDetailPage.tsx");
    expect(page).toContain('const opens = !(app.id === "google_business" && app.google_business?.marketing_on === false);');
    expect(page).toContain('{ label: "Not syncing", tone: "warning" }');
    const panel = source("../src/features/apps/GoogleBusinessPanel.tsx");
    expect(panel).toContain('{listable && <Button size="sm" onClick={() => setPicking(true)}>Change location</Button>}');
    expect(panel).toContain('{g.review_url?.suggested && g.location && app.status === "connected" && <ReviewLinkOffer');
    expect(panel).toContain("{g.review_count && g.marketing_on ?");
    expect(panel).toContain("{!waiting && <Button");
  });

  it("says Google hasn't approved access the same way on the app page and the Reviews tab, with Google's form", () => {
    const panel = source("../src/features/apps/GoogleBusinessPanel.tsx");
    expect(panel).toContain("APPROVAL_MESSAGE");
    expect(panel).toContain('href={GOOGLE_ACCESS_FORM}');
    expect(panel).toContain("Project number:");
    expect(source("../src/features/marketing/GoogleReviews.tsx")).toContain("<ApprovalCallout");
  });
});

describe("Google reviews on the Reviews tab", () => {
  const g = (over: Partial<GoogleState> = {}): GoogleState => ({
    state: "ok", marketing_on: true, can_connect: true, available: true, location: { id: "locations/9", title: "Radford Lawn Care", address: null, maps_uri: null },
    problem_detail: null, problem_message: null, next_sync_at: null, last_synced_at: null, first_synced_at: "2026-10-01T00:00:00Z", syncing: false, progress: null,
    google: { average_rating: 4.7, total_reviews: 120 }, reviews: 118, review_link: { current: null, suggested: null }, own_app: false, project_number: "123456789012", ...over,
  });

  it("filters the list the way the query reads it", () => {
    const calls: string[] = [];
    const builder = { eq: (c: string, v: unknown) => (calls.push(`eq ${c} ${v}`), builder), is: (c: string, v: unknown) => (calls.push(`is ${c} ${v}`), builder), not: (c: string, o: string, v: unknown) => (calls.push(`not ${c} ${o} ${v}`), builder) };
    filterReviews(builder, { needsReply: true, stars: 2, matched: "unmatched", client: null });
    expect(calls).toEqual(["is reply_comment null", "eq rating 2", "is client_id null"]);
    calls.length = 0;
    filterReviews(builder, { ...NO_FILTERS, matched: "matched", client: "c1" });
    expect(calls).toEqual(["not client_id is null", "eq client_id c1"]);
    expect([filtersOn(NO_FILTERS), filtersOn({ ...NO_FILTERS, stars: 5 })]).toEqual([false, true]);
  });

  it("tells office staff who can act, and admins what to do", () => {
    const waiting = g({ state: "approval", problem_message: "Google hasn't approved this server's access to reviews yet." });
    expect(problemCopy(waiting, "UTC")!.body).toContain("Whoever owns this server's Google Cloud project");
    expect(problemCopy({ ...waiting, own_app: true }, "UTC")!.body).toContain("your Google app's Google Cloud project");
    expect(problemCopy({ ...waiting, can_connect: false }, "UTC")!.body).toBe("Review asks keep working meanwhile. An owner or admin can request access in Apps.");
    expect(problemCopy(g({ state: "signin", can_connect: false }), "UTC")!.body).toBe("An owner or admin can reconnect it in Apps.");
    expect(problemCopy(g({ state: "error", problem_message: "Reviews couldn't be brought in: Internal error.", next_sync_at: "2026-10-31T19:30:00Z" }), "America/New_York")!.body).toBe("Crewtavo tries again at 3:30 PM.");
    expect(problemCopy(g(), "UTC")).toBeNull();
  });

  it("gives owners and admins a way back to Apps for each problem, and says who can act otherwise", () => {
    expect(problemCopy(g({ state: "location", problem_message: "x" }), "UTC")!.link).toBe("Open in Apps");
    expect(problemCopy(g({ state: "location", problem_message: "x", can_connect: false }), "UTC")!.link).toBeNull();
    // Disconnected with the reviews kept: connecting again, or who can.
    const off = g({ state: "disconnected" });
    expect(problemCopy(off, "UTC")).toMatchObject({ link: "Connect Google Business Profile", body: "The reviews already here stay, and keep their clients from being asked again." });
    expect(problemCopy({ ...off, can_connect: false }, "UTC")).toMatchObject({ link: null, body: "The reviews already here stay, and keep their clients from being asked again. Ask an owner or admin to connect it in Apps." });
    // A Google account with no Business Profile has nothing to pick: another account signs in.
    const none = g({ state: "pick", problem_detail: "none", problem_message: "The Google account signed in doesn't manage a Business Profile." });
    expect(problemCopy(none, "UTC")).toMatchObject({ tone: "warning", body: "Sign in with the Google account that manages it, in Apps → Google Business Profile.", link: "Open in Apps" });
    expect(problemCopy({ ...none, can_connect: false }, "UTC")!.body).toBe("An owner or admin can sign in with the Google account that manages it, in Apps.");
    expect(problemCopy(g({ state: "pick" }), "UTC")!.body).toBe("Pick it in Apps → Google Business Profile.");
    const tab = source("../src/features/marketing/GoogleReviews.tsx");
    expect(tab).toContain('{copy.link && <Link to="/apps/google_business" style={{ fontWeight: 400 }}>{copy.link}</Link>}');
  });

  it("shows the numbers only once there's something to count, and says where the count is from", () => {
    const waiting = g({ state: "approval", first_synced_at: null, google: { average_rating: null, total_reviews: null }, reviews: 0 });
    expect([hasNumbers(waiting), hasNumbers(g({ state: "not_connected" })), hasNumbers(undefined)]).toEqual([false, false, false]);
    expect([hasNumbers(g()), hasNumbers({ ...waiting, reviews: 3 }), hasNumbers({ ...waiting, google: { average_rating: 4.8, total_reviews: 130 } })]).toEqual([true, true, true]);
    expect(countHint(g(), 0)).toBe("On Google");
    expect(countHint(g({ google: { average_rating: null, total_reviews: null } }), 0)).toBe("Brought in from Google");
    expect(countHint(g(), 4)).toBe("4 not matched to a client");
  });

  it("checks back often only while a sync runs, not while it waits on Google or a person", () => {
    // The server gives no progress while something's in the way (apps/api/test/googleReviews.test.ts).
    expect(source("../src/features/marketing/GoogleReviews.tsx")).toContain("refetchInterval: (q) => (q.state.data?.syncing ? 5000 : q.state.data?.progress ? 30_000 : false)");
  });

  it("says reviews are on their way only when they are", () => {
    expect(locationSavedWords({ syncing: true })).toBe("Location saved. Your reviews are on their way.");
    expect(locationSavedWords({ syncing: false })).toBe("Location saved.");
    expect(source("../src/features/apps/GoogleBusinessPanel.tsx")).toContain("meta: { inline: true, success: locationSavedWords }");
  });

  it("says how far the first sync has got, who replied, and whose names fit", () => {
    expect(progressWords({ seen: 250, total: 1240 })).toBe("Bringing in your reviews: 250 of 1,240");
    expect(progressWords({ seen: 50, total: null })).toBe("Bringing in your reviews: 50 so far");
    expect(repliedWords({ reply_updated_at: new Date().toISOString(), replied_by: null }, new Map())).toBe("Replied on Google just now");
    expect(repliedWords({ reply_updated_at: new Date().toISOString(), replied_by: "u1" }, new Map([["u1", "Mia"]]))).toBe("Replied just now by Mia");
    expect(initials("Ana Smith")).toBe("AS");
    const clients = [{ id: "1", display_name: "Ana Stone" }, { id: "2", display_name: "Anabel Ruiz" }, { id: "3", display_name: "Ana Smith" }];
    expect(rankSuggestions({ name: "Ana Smith", anonymous: false }, clients).map((c) => c.id)).toEqual(["3", "1", "2"]);
    expect(rankSuggestions({ name: "Ana S.", anonymous: false }, clients).map((c) => c.id)).toEqual(["1", "3", "2"]);
  });

  it("keeps the ask settings first, and the list under them, whether or not Google is connected", () => {
    const tab = source("../src/features/marketing/Reviews.tsx");
    const body = tab.slice(tab.indexOf("export function Reviews()"), tab.indexOf("/** A starter rule changed"));
    expect(body.indexOf("<AskAutomatically")).toBeLessThan(body.indexOf("<GoogleReviewList"));
    expect(body).toContain("<ReviewLink google={g} />");
    expect(body).toContain("<AskNow />");
    expect(body).toContain("{showsList(g) && <GoogleReviewList g={g!} />}");
    expect(body).toContain("const numbers = hasNumbers(g) && <GoogleNumbers g={g!} stats={stats} />;");
    // Across the top on a wide screen; on a phone, under the forms and just above the list.
    expect(body.indexOf("{!stacked && numbers}")).toBeLessThan(body.indexOf("<AskAutomatically"));
    expect(body.indexOf("{stacked && numbers}")).toBeGreaterThan(body.indexOf("<AskNow />"));
    expect(body.indexOf("{stacked && numbers}")).toBeLessThan(body.indexOf("<GoogleReviewList"));
    expect(tab).toContain('const STACKED = "(max-width: 900px)";');
    expect(source("../src/features/marketing/GoogleReviews.tsx")).toContain("Ask an owner or admin to connect it in Apps.");
  });

  it("shows one average, Google's, and charts only counts", () => {
    const reviews = source("../src/features/marketing/GoogleReviews.tsx");
    expect(reviews).toContain("const average = g.google.average_rating ?? s.average;");
    expect(source("../src/features/marketing/ReviewTrend.tsx")).toContain("values={trend.map((m) => m.count)}");
  });

  it("confirms a reply before it goes on Google, an edit too, and counts its characters", () => {
    const reviews = source("../src/features/marketing/GoogleReviews.tsx");
    expect(reviews).toContain('updating ? "Update your reply on Google?" : "Post this reply on Google?"');
    expect(reviews).toContain("Everyone can read it on Google");
    expect(reviews).toContain("REPLY_MAX.toLocaleString");
    expect(reviews).toContain("An admin can add a Claude key on the Apps page to draft replies.");
    expect(reviews).toContain('referrerPolicy="no-referrer"');
  });

  it("opens the review a notification links to, and one client's reviews from their page", () => {
    const reviews = source("../src/features/marketing/GoogleReviews.tsx");
    expect(reviews).toContain('params.get("review")');
    expect(reviews).toContain('params.get("client")');
    expect(reviews).toContain("Show all reviews");
    expect(source("../src/features/clients/ClientPage.tsx")).toContain("/marketing?tab=reviews&client=${clientId}");
    // The reply opens when the notification's review turns up after the list, a cached one too.
    const reply = reviews.slice(reviews.indexOf("function Reply("));
    expect(reply).toMatch(/useEffect\(\(\) => \{\s+if \(open\) setEditing\(true\);\s+\}, \[open\]\);/);
    // See their review on the Reviews tab itself changes the list: ?client= follows the address.
    const list = reviews.slice(reviews.indexOf("export function GoogleReviewList"));
    expect(list).toMatch(/setFilters\(\{ \.\.\.NO_FILTERS, client: forClientParam \}\);[\s\S]*\}, \[forClientParam\]\);/);
  });

  it("gives a review's words and reply the row's whole width beside the photo, on a phone too", () => {
    const reviews = source("../src/features/marketing/GoogleReviews.tsx");
    const row = reviews.slice(reviews.indexOf("function ReviewRow("), reviews.indexOf("function Reply("));
    // The status and the menu are on the name's line, inside the column, not columns of their own.
    expect(row.indexOf("<EntityStatus")).toBeGreaterThan(row.indexOf("<strong>{name}</strong>"));
    expect(row.indexOf("<Menu")).toBeLessThan(row.indexOf("{text && ("));
    expect(row.lastIndexOf("</div>\n    </div>\n  );")).toBeGreaterThan(row.indexOf("<Reply"));
  });

  it("never calls a reviewer Google sent without a name null", () => {
    const reviews = source("../src/features/marketing/GoogleReviews.tsx");
    expect(reviews).not.toContain("${r.reviewer_name}'s review");
    expect(reviews).not.toContain("${review.reviewer_name}'s review");
    expect(reviews).toContain('under {reviewer ? `${reviewer}\'s review` : "the review"}');
    expect(reviews).toContain('`Who left ${reviewer ? `${reviewer}\'s review` : "this review"}?');
  });

  it("reads whether a client already left a review wherever asks are offered", () => {
    for (const page of ["../src/features/jobs/JobPage.tsx", "../src/features/clients/ClientPage.tsx", "../src/features/marketing/Reviews.tsx"]) {
      expect(source(page), page).toContain("sms_opt_out_at, reviewed_at");
    }
    expect(source("../src/features/marketing/Reviews.tsx")).toContain("reminder_error, reviewed_at, client:clients");
  });

  it("offers the Google reviews notification to everyone it reaches, while Marketing is on", () => {
    // Who that is: packages/core/test/subOffers.test.ts (reviewNoticesFor).
    const settings = source("../src/features/settings/NotificationSettings.tsx");
    expect(settings).toContain('(t.key !== "reviews" || reviews)');
    expect(settings).toContain("reviewNoticesFor(session, marketingOn(session.company.settings))");
    expect(settings).toContain('t.key === "reviews" && reviews === "access" ? { ...t, hint: REVIEW_ACCESS_HINT }');
  });

  it("offers Sync now and replies only when they can work, and says a second Sync now is too soon as news", () => {
    for (const state of ["approval", "not_enabled", "signin", "disconnected"] as const) {
      expect([canSync(g({ state })), canReply(g({ state }))], state).toEqual([false, false]);
    }
    for (const state of ["ok", "error", "location", "pick"] as const) expect([canSync(g({ state })), canReply(g({ state }))], state).toEqual([true, true]);
    expect([tooSoon(new ApiError("Google was checked a moment ago.", 429)), tooSoon(new ApiError("Marketing is off", 409)), tooSoon(new Error("x"))]).toEqual([true, false, false]);
    const panel = source("../src/features/apps/GoogleBusinessPanel.tsx");
    expect(panel).toContain('meta: { inline: true, success: "Checking Google for new reviews" }');
    expect(panel).toContain("if (tooSoon(error)) toast.info((error as Error).message);");
    const reviews = source("../src/features/marketing/GoogleReviews.tsx");
    expect(reviews).toContain("{canSync(g) && <Button");
    expect(reviews).toContain("<FormError error={tooSoon(sync.error) ? null : sync.error} />");
    expect(reviews).not.toContain("Bringing in your reviews\")");
  });

  it("lists reviews once there are some or they're on their way, and filters only what's there", () => {
    const waiting = g({ state: "approval", first_synced_at: null, google: { average_rating: null, total_reviews: null }, reviews: 0, progress: null });
    expect([showsList(waiting), showsList(g({ state: "not_connected" })), showsList(undefined)]).toEqual([false, false, false]);
    expect([showsList({ ...waiting, reviews: 12 }), showsList(g({ state: "ok", first_synced_at: null, reviews: 0 })), showsList(g({ state: "disconnected" }))]).toEqual([true, true, true]);
    expect(source("../src/features/marketing/GoogleReviews.tsx")).toContain('{g.reviews > 0 && <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Show">');
  });

  it("gives Check again on the tab to owners and admins, keeps the trend under what's in the way, and says replies wait only when they can post", () => {
    const side = source("../src/features/marketing/GoogleReviews.tsx").slice(source("../src/features/marketing/GoogleReviews.tsx").indexOf("export function GoogleSide"));
    expect(side).toContain("onCheck={g.can_connect ? () => check.mutate() : undefined}");
    expect(side.indexOf("<ApprovalCallout")).toBeLessThan(side.indexOf("Reviews each month"));
    expect(side).not.toMatch(/if \(g\.state === "approval" \|\| g\.state === "not_enabled"\) \{\s+return/);
    expect(side).toContain("{s.needs_reply > 0 && canReply(g) &&");
  });

  it("keeps the reply's character count on one line, and gives a reviewer without a name an icon, not initials", () => {
    const reviews = source("../src/features/marketing/GoogleReviews.tsx");
    expect(reviews).toContain('style={{ textAlign: "right", whiteSpace: "nowrap" }}');
    expect(reviews).toContain(': known ? initials(known) : <Icon name="user" size={16} />}');
  });

  it("says a client who already reviewed isn't asked, once, with the way to undo it on the tab itself", () => {
    const ask = source("../src/features/marketing/Reviews.tsx").slice(source("../src/features/marketing/Reviews.tsx").indexOf("function AskNow()"));
    expect(ask).toContain("already left a Google review, so they aren't asked again. Not them?");
    expect(ask).toContain("See their review</Link> and undo the match.");
    // The last-asked line and the button are in the other branch.
    expect(ask.indexOf("{reviewed ? (")).toBeLessThan(ask.indexOf("Last asked"));
    expect(ask.indexOf("{reviewed ? (")).toBeLessThan(ask.indexOf("Ask for a review</Button>"));
    const client = source("../src/features/clients/ClientPage.tsx");
    expect(client).toContain("checked={!c.review_opt_out && !c.marketing_opt_out && !c.reviewed_at}");
    expect(client).toContain("Left a Google review, so not asked");
  });

  it("names a review's reply status in the glossary's words", () => {
    expect(source("../src/components/ui/StatusPill.tsx")).toContain('review: { needs_reply: "Needs a reply", replied: "Replied" }');
  });
});
