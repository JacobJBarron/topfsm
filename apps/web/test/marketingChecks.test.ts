/**
 * Follow-ups to the Marketing app from checking it end to end (docs/marketing-plan.md): review asks
 * (fewer reminders said first, an ask that half went said as a warning, Copy link's button, tracked
 * links shortened in the office, the tab strip on a phone), referrals (the earned card's hint, a paid
 * invoice a credit covered), campaigns (the preview's subject, phone and address, a sent campaign's
 * numbers and preview, the list's rows and copy), Google reviews (same-name clients in Match, the
 * first sync's progress on the app page, the banner after a pick, Change location's words), social
 * (Share elsewhere from the composer, a refusal said before Post now, a finished post, Instagram kept
 * as chosen, copy, 4-star reviews said everywhere they post), and the whole app (disabled dropdowns,
 * admins without Marketing, search, each doc comment above what it describes).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { NOTIFICATION_TOPICS, SOCIAL_ACCESS_HINT } from "@crewtavo/core/notifications";
import { describe, expect, it } from "vitest";
import { NAV_GROUPS, navVisible, OTHER_SCREENS } from "../src/components/shell/nav";
import { googleBusinessNext } from "../src/features/apps/AppDetailPage";
import { APP_INFO, appsPollMs, usesMarketing } from "../src/features/apps/catalog";
import { NAME_BASIS } from "../src/features/apps/MetaPanel";
import { paidWords } from "../src/features/invoices/creditRules";
import { askToastKind, reminderDropWords, remindersDroppedWords } from "../src/features/marketing/askForm";
import { campaignTokens } from "../src/features/marketing/automatedForm";
import { companyAddressLine, previewFooter } from "../src/features/marketing/EmailEditor";
import { changeLocationWords, clientDetail, reviewCountWords, sharedNames } from "../src/features/marketing/googleReviewData";
import { campaignRowWhen } from "../src/features/marketing/MarketingPage";
import { GOOGLE_FIRST_PHOTO, INSTAGRAM_CAROUSEL_PADDED, INSTAGRAM_PHOTO_PADDED } from "../src/features/marketing/SocialComposer";
import { effectiveNetworks, finishedPosting, networkChoices, postNowWords, startingNetworks, type SocialState } from "../src/features/marketing/socialData";
import { moreEdges, scrollToTab } from "../src/lib/tabStrip";
import { messageParts } from "../src/lib/trackedLinks";

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const ON = { marketing: { enabled: true } };
const person = (role: string, permissions: string[] = ["marketing"], settings: Record<string, unknown> = ON) => ({ role, permissions, company: { settings } });

describe("review asks", () => {
  it("say before saving how many waiting reminders fewer reminders stop for good, naming both buttons", () => {
    expect(reminderDropWords(2, 0, 3)).toEqual({
      title: "Turn reminders off?",
      body: "3 clients are waiting on a reminder. Turning reminders off stops them for good: turning them back on later won't send them.",
      confirmLabel: "Turn off",
      cancelLabel: "Keep them",
    });
    expect(reminderDropWords(2, 1, 1)!.body).toBe("1 client is waiting on a second reminder. Saving stops it for good: going back to two later won't send it.");
    // Nothing lost: no question.
    expect(reminderDropWords(2, 0, 0)).toBeNull();
    expect(reminderDropWords(1, 2, 5)).toBeNull();
    expect(remindersDroppedWords(4)).toBe("Saved. 4 waiting reminders were stopped.");
    expect(remindersDroppedWords(0)).toBeNull();
    const reviews = source("../src/features/marketing/Reviews.tsx");
    expect(reviews).toContain('.gte("reminders_sent", form.reminders)');
    expect(reviews).toContain("if (words && !(await confirm({ ...words, danger: true }))) return;");
  });

  it("say an ask that went one way but not the other as a warning, on every page that asks", () => {
    expect(askToastKind({ warning: true })).toBe("warning");
    expect(askToastKind({})).toBe("success");
    for (const page of ["../src/features/marketing/Reviews.tsx", "../src/features/clients/ClientPage.tsx", "../src/features/jobs/JobPage.tsx"]) {
      expect(source(page), page).toContain("toast[askToastKind(r)](r.detail)");
    }
    expect(source("../src/lib/toast.ts")).toContain('warning: (title: string, options?: ToastOptions) => push("warning", title, options),');
  });

  it("label Ask a client now's button by what it does: Copy review link copies, sending nothing", () => {
    const ask = source("../src/features/marketing/Reviews.tsx");
    expect(ask).toContain('{channel === "link" ? "Copy review link" : "Ask for a review"}');
    expect(ask).toContain('icon={channel === "link" ? "link" : "star"}');
  });

  it("say under the message that texts end with how to opt out", () => {
    expect(source("../src/features/marketing/Reviews.tsx")).toContain("Texts end with “${STOP_LINE}” unless yours says STOP.");
  });

  it("show a client's tracked links in the office as a short label, so opening one there isn't the client's open", () => {
    const body = "Hi Pete, a quick review?\n\nhttps://crm.example.test/api/public/r/AbCdEf123456\n\nThanks";
    expect(messageParts(body)).toEqual([{ text: "Hi Pete, a quick review?\n\n" }, { label: "Review link", host: "crm.example.test" }, { text: "\n\nThanks" }]);
    // A signed link of before, a campaign's tracked link and an unsubscribe link too; other links stay.
    expect(messageParts("https://crm.example.test/api/public/r/eyJjIjoiYSJ9.c2ln")).toEqual([{ label: "Review link", host: "crm.example.test" }]);
    expect(messageParts("See https://crm.example.test/api/public/c/00000000-0000-4000-8000-000000000001/0 now")[1]).toEqual({ label: "Tracked link", host: "crm.example.test" });
    expect(messageParts("Stop: https://crm.example.test/u/abc.def")[1]).toEqual({ label: "Unsubscribe link", host: "crm.example.test" });
    expect(messageParts("Our site: https://lawn.example.test/spring")).toEqual([{ text: "Our site: https://lawn.example.test/spring" }]);
    expect(messageParts(null)).toEqual([{ text: "" }]);
    expect(source("../src/features/clients/Timeline.tsx")).toContain("<MessageBody body={m.body} />");
    expect(source("../src/features/messages/MessagesPage.tsx")).toContain("<MessageBody body={m.body} />");
  });

  it("keep the picked tab in view on a phone, with the strip's clipped edge faded", () => {
    expect(scrollToTab(349, 429, 0, 358)).toBe(95);
    expect(scrollToTab(0, 90, 120, 358)).toBe(0);
    expect(scrollToTab(100, 200, 0, 358)).toBeNull();
    expect(moreEdges(0, 358, 540)).toBe("right");
    expect(moreEdges(182, 358, 540)).toBe("left");
    expect(moreEdges(90, 358, 540)).toBe("both");
    expect(moreEdges(0, 358, 358)).toBeNull();
    const page = source("../src/features/marketing/MarketingPage.tsx");
    expect(page).toContain("const tabs = useTabStrip<HTMLDivElement>(tab);");
    expect(page).toContain('<div ref={tabs} className="underline-tabs underline-tabs-compact" role="tablist">');
    const css = source("../src/styles/components.css");
    expect(css).toContain('.underline-tabs[data-more="right"]');
    expect(css).toContain(".underline-tabs-compact > * > svg { display: none; }");
  });
});

describe("referrals", () => {
  it("say what credits earned counts, as Marketing's overview does, with friends still to pay on a line of their own", () => {
    const tab = source("../src/features/marketing/Referrals.tsx");
    expect(tab).toContain('export const EARNED_HINT = "Not on an invoice yet";');
    expect(tab).toContain("<div className=\"hint\">{EARNED_HINT}</div>\n        <div className=\"hint\">{pending}</div>");
    expect(source("../src/features/marketing/MarketingPage.tsx")).toContain("<div className=\"hint\">{EARNED_HINT}</div>");
  });

  it("say a paid invoice a referral credit covered whole is covered, not paid in full with no payments", () => {
    // The credit paid what was owed: it doesn't say nothing was.
    expect(paidWords(0, 15, null)).toBe("Covered by a referral credit.");
    expect(paidWords(0, 15, null)).not.toMatch(/nothing/i);
    expect(paidWords(0, 0, null)).toBe("Nothing to pay.");
    expect(paidWords(15.8, 0, "Oct 31, 2026")).toBe("Paid in full on Oct 31, 2026.");
    expect(source("../src/features/invoices/InvoicePage.tsx")).toContain("{paidWords(paid, Number(inv.credit_amount),");
  });
});

describe("campaigns", () => {
  it("preview the subject in fixed dark colours on the always-white sheet, in both themes", () => {
    const editor = source("../src/features/marketing/EmailEditor.tsx");
    expect(editor).not.toContain("var(--ink)");
    expect(editor).toContain('<div className="email-subject small" style={{ marginBottom: 6 }}>Subject: <strong>');
    const css = source("../src/styles/features.css");
    expect(css).toContain(".email-preview .sheet-inner .email-subject, .email-preview .sheet-inner .email-placeholder { color: #5f6f76; }");
    expect(css).toContain(".email-preview .sheet-inner .email-subject strong { color: #0f2a35; }");
  });

  it("preview the footer the email has: the company's name and address, then Unsubscribe", () => {
    const address = companyAddressLine({ line1: "130 Campaign Way", city: "Radford", region: "VA", postal_code: "24141" });
    expect(address).toBe("130 Campaign Way, Radford, VA, 24141");
    expect(previewFooter("Campaigns check Lawn Co", address, true)).toBe("Campaigns check Lawn Co · 130 Campaign Way, Radford, VA, 24141 · Unsubscribe");
    expect(previewFooter("Lawn Co", "", false)).toBe("Lawn Co");
    expect(companyAddressLine(null)).toBe("");
    for (const page of ["../src/features/marketing/CampaignPage.tsx", "../src/features/marketing/AutomatedCampaigns.tsx"]) {
      expect(source(page), page).toContain("address={companyAddressLine(session.company.address)}");
    }
  });

  it("get the company's phone from GET /me, so previews show {{company.phone}} as the email does", () => {
    expect(source("../../api/src/routes/account.ts")).toContain("company:companies(id, name, slug, trade_preset, timezone, currency, address, phone, settings)");
  });

  it("read a campaign's numbers and list once more when it finishes sending, and keep the page's own copy saved", () => {
    const page = source("../src/features/marketing/CampaignPage.tsx");
    expect(page).toContain('const ended = was.status === "sending" && c?.status !== "sending";');
    // An email that was going out at Stop is counted after it: the page keeps looking for half a
    // minute and reads the numbers again when they change.
    expect(page).toContain('const settling = d?.status === "cancelled" && d.finished_at && Date.now() - Date.parse(d.finished_at) < 30_000;');
    expect(page).toContain('const late = was.status === "cancelled" && c?.status === "cancelled" && (was.sent !== c.sent_count || was.failed !== c.failed_count);');
    expect(page).toContain("if (ended || late) {");
    expect(page).toContain('[["campaign-results", session.company.id, id], ["campaign-recipients", id], ["campaign-results", session.company.id]]');
    expect(page).toContain('queryClient.setQueryData<typeof c>(["campaign", id], (old) =>');
    expect(page).toContain("await campaign.refetch();\n            setDraft(null);");
  });

  it("say a sent campaign's count once in the list: its date on the first line, the results line the count", () => {
    const c = { status: "sent", sent_count: 8, failed_count: 0, recipients_count: 8, finished_at: "2026-10-31T15:00:00Z", scheduled_at: null, created_at: "2026-10-30T15:00:00Z" };
    expect(campaignRowWhen(c, true)).toMatch(/^Sent Oct 31, 2026$/);
    expect(campaignRowWhen({ ...c, failed_count: 2 }, true)).toMatch(/^Sent Oct 31, 2026 · 2 failed$/);
    expect(campaignRowWhen(c, false)).toMatch(/^8 sent · Oct 31, 2026$/);
    expect(campaignRowWhen({ ...c, status: "sending", sent_count: 3 }, true)).toBe("3 of 8 sent…");
  });

  it("name Close pending quotes' link the quote's page, the button it becomes", () => {
    const tokens = [{ token: "client.first_name", label: "First name" }, { token: "link", label: "Client Hub link" }];
    expect(campaignTokens("close_quotes", tokens)[1]).toEqual({ token: "link", label: "Quote link (View online)" });
    expect(campaignTokens("win_back", tokens)[1]).toEqual({ token: "link", label: "Client Hub link" });
  });
});

describe("Google reviews", () => {
  it("tell two clients of the same name apart in Match, and match one only after Match is pressed", () => {
    expect(clientDetail({ id: "a", display_name: "Sam Carter", email: "sam.one@example.test", phone: "+12025550108" })).toBe("sam.one@example.test");
    expect(clientDetail({ id: "b", display_name: "Sam Carter", email: null, phone: "+12025550109" })).toBe("(202) 555-0109");
    expect(clientDetail({ id: "c", display_name: "Sam Carter", properties: [{ line1: "9 Oak Ln" }] })).toBe("9 Oak Ln");
    expect(clientDetail({ id: "d", display_name: "Sam Carter", company_name: "Carter Farms" })).toBe("Carter Farms");
    expect(clientDetail({ id: "e", display_name: "Sam Carter" })).toBeNull();
    expect([...sharedNames([{ id: "a", display_name: "Sam Carter" }, { id: "b", display_name: "sam carter " }, { id: "c", display_name: "Sam Carver" }])]).toEqual(["a", "b"]);
    const dialog = source("../src/features/marketing/GoogleReviews.tsx");
    expect(dialog).toContain('select("id, display_name, company_name, email, phone, properties(line1)")');
    expect(dialog).toContain("onClick={() => (twin ? setPicked({ id: c.id, display_name: c.display_name }) : onPick(c))}");
  });

  it("follow the first sync on the app page, and move the banner on once a location is picked or Google lets Crewtavo in", () => {
    const syncing = { stripe: undefined, google_business: { progress: { seen: 50, total: 145 } } } as never;
    expect(appsPollMs([syncing])).toBe(5000);
    expect(appsPollMs([{ stripe: undefined, google_business: { progress: null } } as never])).toBe(false);
    expect(appsPollMs(undefined)).toBe(false);
    const app = (g: Record<string, unknown> | undefined) => ({ google_business: g ? { location: null, problem: null, marketing_on: true, ...g } : undefined }) as never;
    expect(googleBusinessNext("pick", app({ problem: "pick" }))).toBe("Now pick your business's location.");
    expect(googleBusinessNext("pick", app({ location: { id: "locations/1", title: "Main", address: null, maps_uri: null } }))).toBe("Your reviews are on their way to Marketing → Reviews.");
    expect(googleBusinessNext("approval", app({ problem: "approval" }))).toBe("Reviews start coming in once Google approves access.");
    expect(googleBusinessNext("approval", app({}))).toBe("Your reviews are on their way to Marketing → Reviews.");
    expect(googleBusinessNext("not_enabled", app({ problem: "not_enabled" }))).toBe("Reviews start coming in once the Business Profile APIs are turned on.");
  });

  it("say Change location's confirm in words that fit the count", () => {
    expect(changeLocationWords(1, "Greviews Check Lawn - Blacksburg")).toBe("The 1 review from Greviews Check Lawn - Blacksburg is removed, and asks start again for any client it matched.");
    expect(changeLocationWords(12, null)).toBe("The 12 reviews from the old location are removed, and asks start again for any clients they matched.");
  });
});

describe("social posts", () => {
  const state = (): SocialState => ({
    marketing_on: true, can_connect: true, ai: true, images_public: true, auto: { enabled: false, networks: [] },
    networks: {
      facebook: { connected: true, page_name: "Social Check Lawn", problem: null, live_confirmed: false, missing: [] },
      instagram: { connected: true, username: "social_check_lawn", problem: null, missing: [], needs_business_permissions: false },
      google: { ready: true, reason: null, message: null },
    },
  });

  it("open Share elsewhere over the composer, which stays open with what's written", () => {
    const composer = source("../src/features/marketing/SocialComposer.tsx");
    expect(composer).toContain("<Dialog open={open} onClose={() => { if (!sharing) onClose(); }}");
    expect(composer).not.toContain("open={open && !sharing}");
  });

  it("check a post before the public-post confirm, and bring a refusal into view", () => {
    const composer = source("../src/features/marketing/SocialComposer.tsx");
    expect(composer).toContain('api.post<{ ok: true; warnings: string[] }>("/social/posts/check", body("now"))');
    expect(composer.indexOf("await dryRun.mutateAsync();")).toBeLessThan(composer.indexOf('confirm({ title: "Post this now?"'));
    expect(composer).toContain('errorRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })');
    expect(source("../../api/src/routes/social.ts")).toContain('social.post("/social/posts/check"');
  });

  it("move a post that finished posting to Posts without a reload", () => {
    expect(finishedPosting([{ id: "p1", status: "posting" }], [])).toBe(true);
    expect(finishedPosting([{ id: "p1", status: "posting" }], [{ id: "p1", status: "posting" }])).toBe(false);
    expect(finishedPosting([{ id: "p1", status: "scheduled" }], [])).toBe(false);
    expect(source("../src/features/marketing/socialData.ts")).toContain('queryKey: [...socialKey(session.company.id), "posts", "done"]');
  });

  it("keep Instagram as chosen after a words-alone post, and put it back when photos are picked again", () => {
    const photos = networkChoices(state(), "photos");
    const text = networkChoices(state(), "text");
    const wanted = startingNetworks(photos, ["facebook", "instagram", "google"]);
    expect(effectiveNetworks(wanted, text)).toEqual(["facebook", "google"]);
    expect(effectiveNetworks(wanted, photos)).toEqual(["facebook", "instagram", "google"]);
    const composer = source("../src/features/marketing/SocialComposer.tsx");
    expect(composer).toContain('startingNetworks(networkChoices(state, "photos"), rememberedNetworks())');
    expect(composer).toContain("rememberNetworks(wanted);");
  });

  it("say who sees a post until the Meta app is Live, without calling it public or 'only you'", () => {
    expect(postNowWords(["facebook", "google"], true)).toBe(
      "This posts publicly on Google. On Facebook it stays hidden from the public until your Meta app is Live: only people with a role on your Meta app can see it.",
    );
    expect(postNowWords(["facebook", "instagram"], true)).toBe(
      "This posts to Facebook and Instagram, where it stays hidden from the public until your Meta app is Live: only people with a role on your Meta app can see it.",
    );
    expect(postNowWords(["facebook", "instagram", "google"], false)).toBe("This posts publicly on Facebook, Instagram and Google.");
    expect(postNowWords(["google"], true)).toBe("This posts publicly on Google.");
  });

  it("say Instagram's padding plainly, that Google shows only the first photo, and bring a picked review into view", () => {
    expect(INSTAGRAM_PHOTO_PADDED).toBe("Instagram gets this photo padded to fit, never cropped.");
    expect(INSTAGRAM_CAROUSEL_PADDED).toBe("Instagram shows a carousel's photos square, so they're padded to fit, never cropped.");
    expect(GOOGLE_FIRST_PHOTO).toBe("Google Business Profile shows only the first photo.");
    const composer = source("../src/features/marketing/SocialComposer.tsx");
    expect(composer).toContain('{networks.includes("google") && pickedPhotos.length > 1 && <span className="muted small">{GOOGLE_FIRST_PHOTO}</span>}');
    expect(composer).toContain('pickedReviewRef.current.scrollIntoView({ block: "nearest" });');
  });

  it("list 4-star reviews as cards too, with automatic posts 5-star only", () => {
    const meta = APP_INFO.meta!;
    expect(meta.about).toContain("4 and 5-star Google reviews as a square picture");
    expect(meta.highlights.find((h) => h.title === "Reviews as pictures")!.text).toContain("A 4 or 5-star review becomes a square card");
    expect(APP_INFO.marketing!.highlights.find((h) => h.title === "Social")!.text).toContain("4 and 5-star reviews");
    expect(source("../src/features/apps/MarketingPanel.tsx")).toContain("photos marked OK to share and 4 and 5-star Google reviews");
    expect(source("../src/features/marketing/Social.tsx")).toContain('"Post job photos, a 4 or 5-star review or an update, now or later."');
  });

  it("never says only 5-star reviews post, outside automatic posts, anywhere in Marketing's words", () => {
    // Each "5-star review" that isn't "4 and 5-star" or "4 or 5-star" has to be about automatic posts
    // (new 5-star reviews posting by themselves).
    const fiveStarOnly = (text: string) => {
      const flat = text.replace(/\s+/g, " ");
      return [...flat.matchAll(/5-star (Google )?reviews?/g)]
        .map((m) => ({ before: flat.slice(Math.max(0, m.index - 40), m.index), after: flat.slice(m.index, m.index + m[0].length + 20) }))
        .filter(({ before, after }) => !/4 (and|or) $/.test(before) && !/\b(new|automatic(ally)?|another)\b/i.test(before + after))
        .map(({ before, after }) => before + after);
    };
    expect(fiveStarOnly("post job photos marked OK to share and 5-star reviews to your Page")).toHaveLength(1);
    expect(fiveStarOnly("Post job photos, a 5-star review or an update")).toHaveLength(1);
    expect(fiveStarOnly("4 and 5-star reviews, or have new 5-star reviews post by themselves. Post 5-star reviews automatically")).toEqual([]);
    const said: string[] = [];
    for (const root of ["../src/features/marketing", "../src/features/apps"]) {
      const dir = fileURLToPath(new URL(root, import.meta.url));
      for (const file of readdirSync(dir, { recursive: true }) as string[]) {
        if (/\.tsx?$/.test(file)) said.push(...fiveStarOnly(readFileSync(join(dir, file), "utf8")).map((s) => `${root}/${file}: ${s}`));
      }
    }
    for (const file of ["../../api/src/integrations/registry.ts", "../../api/src/routes/social.ts", "../../api/src/services/social.ts"]) {
      said.push(...fiveStarOnly(source(file)).map((s) => `${file}: ${s}`));
    }
    expect(said).toEqual([]);
  });

  it("keep a Page's and a location's name on its line on a phone, the buttons wrapping under it", () => {
    expect(NAME_BASIS).toBe("12rem");
    expect(source("../src/features/apps/MetaPanel.tsx")).toContain("<span style={{ flex: `1 1 ${NAME_BASIS}`, minWidth: 0 }}>");
    expect(source("../src/features/apps/GoogleBusinessPanel.tsx")).toContain("<span style={{ flex: `1 1 ${NAME_BASIS}`, minWidth: 0 }}>");
  });
});

describe("the whole app", () => {
  it("puts each doc comment right above what it describes, never one above another's", () => {
    // A declaration put between a doc comment and its code leaves two in a row: editors show the
    // first on nothing and the second on the wrong symbol.
    const stacked: string[] = [];
    for (const root of ["../../api/src", "../../../packages/core/src", "../src/features/marketing", "../src/features/apps", "../src/features/invoices", "../src/lib", "../src/components"]) {
      const dir = fileURLToPath(new URL(root, import.meta.url));
      for (const file of readdirSync(dir, { recursive: true }) as string[]) {
        if (!/\.tsx?$/.test(file)) continue;
        const text = readFileSync(join(dir, file), "utf8");
        for (const m of text.matchAll(/\*\/[ \t]*\n[ \t]*\/\*\*/g)) stacked.push(`${root}/${file}:${text.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(stacked).toEqual([]);
  });

  it("keeps a disabled dropdown's one chevron in both themes", () => {
    const css = source("../src/styles/components.css");
    expect(css).toContain(".input:disabled, .select:disabled, .textarea:disabled { background-color: var(--fill); color: var(--text-3); cursor: not-allowed; }");
    expect(css).not.toMatch(/\.select:disabled[^{]*\{ background: /);
  });

  it("offers an admin without the marketing area no Open or tab links that lead to 'no access'", () => {
    expect(usesMarketing(person("admin", ["apps"]))).toBe(false);
    expect(usesMarketing(person("admin", ["apps", "marketing"]))).toBe(true);
    expect(usesMarketing(person("owner", []))).toBe(true);
    expect(usesMarketing(person("estimator", ["marketing"]))).toBe(false);
    const page = source("../src/features/apps/AppDetailPage.tsx");
    expect(page).toContain('const OPENS_MARKETING = new Set(["marketing", "google_business", "meta"]);');
    expect(page).toContain("!opens || !metaOpens || !marketingOpens ? null");
    expect(source("../src/features/apps/MarketingPanel.tsx")).toContain("{opens ? (");
    expect(reviewCountWords(5, true)).toBe(" · 5 reviews in Marketing → Reviews");
    expect(reviewCountWords(1, false)).toBe(" · 1 review brought in");
    expect(reviewCountWords(0, true)).toBe("");
  });

  it("gives an admin without the marketing area the Social posts topic's own hint", () => {
    expect(SOCIAL_ACCESS_HINT).toBe("When Facebook & Instagram needs signing in again");
    expect(NOTIFICATION_TOPICS.some((t) => t.key === "social")).toBe(true);
    expect(source("../src/features/settings/NotificationSettings.tsx")).toContain('t.key === "social" && reviews === "access" ? { ...t, hint: SOCIAL_ACCESS_HINT }');
  });

  it("finds Marketing's own tabs by search, each opening its tab, only for those who have Marketing", () => {
    const marketing = NAV_GROUPS.flat().find((item) => item.to === "/marketing")!;
    for (const word of ["google reviews", "promo", "coupons", "discounts", "automated campaigns", "website visits"]) expect(marketing.keywords, word).toContain(word);
    const tabs = OTHER_SCREENS.filter((s) => s.to.startsWith("/marketing?tab="));
    expect(tabs.map((s) => [s.to, s.label])).toEqual([
      ["/marketing?tab=reviews", "Reviews"],
      ["/marketing?tab=referrals", "Referrals"],
      ["/marketing?tab=social", "Social posts"],
      ["/marketing?tab=promos", "Promo codes"],
    ]);
    for (const tab of tabs) {
      expect(navVisible(person("office"), tab), tab.to).toBe(true);
      expect(navVisible(person("admin", ["apps"]), tab), tab.to).toBe(false);
      expect(navVisible(person("owner", [], {}), tab), tab.to).toBe(false);
    }
    expect(tabs.find((s) => s.label === "Promo codes")!.keywords).toContain("coupons");
  });
});
