/**
 * Social posting (src/social.ts): what each network takes in a caption, how a reviewer is named on a
 * post, what a post mustn't say about a client, the review card's words, colours and fit, when
 * automatic 5-star posts go (as private.next_auto_post_slot picks), and a post's status from its
 * networks (as private.social_post_status says it). apps/api/test/social.test.ts compares the
 * automatic post's words with its migration.
 */
import { describe, expect, it } from "vitest";
import {
  autoPostWhen,
  canShareType,
  CAPTION_MAX,
  captionLimit,
  captionProblems,
  cardColors,
  cardDropsEmoji,
  cardSupported,
  cardText,
  clockWords,
  fitCardText,
  firstNameLastInitial,
  hasWords,
  measureFigtree,
  mentionsClient,
  missingPermissionWords,
  needsCaption,
  networkWords,
  nextAutoSlot,
  padColor,
  PAD_GREY,
  postStatusOf,
  socialSettings,
  timeZoneWords,
} from "../src/social";

const NY = "America/New_York";

describe("captions", () => {
  it("fit the strictest network chosen, never more than Crewtavo keeps", () => {
    expect(captionLimit(["facebook"])).toBe(CAPTION_MAX);
    expect(captionLimit(["facebook", "instagram"])).toBe(2200);
    expect(captionLimit(["facebook", "google"])).toBe(1500);
    expect(captionLimit(["instagram", "google"])).toBe(1500);
  });

  it("say which network a caption is too long for", () => {
    const caption = "a".repeat(1600);
    expect(captionProblems(caption, ["facebook", "instagram"])).toEqual([]);
    expect(captionProblems(caption, ["facebook", "google"])).toEqual([{ network: "google", kind: "too_long", limit: 1500 }]);
    expect(captionProblems("a".repeat(2201), ["instagram"])).toEqual([{ network: "instagram", kind: "too_long", limit: 2200 }]);
  });

  it("keep Instagram to 30 hashtags", () => {
    const tags = Array.from({ length: 31 }, (_, i) => `#lawn${i}`).join(" ");
    expect(captionProblems(tags, ["instagram"])).toEqual([{ network: "instagram", kind: "hashtags", limit: 30 }]);
    expect(captionProblems(tags, ["facebook"])).toEqual([]);
    expect(captionProblems(Array.from({ length: 30 }, (_, i) => `#lawn${i}`).join(" "), ["instagram"])).toEqual([]);
  });

  it("keep phone numbers off Google", () => {
    for (const phone of ["Call 540-555-0100", "(540) 555 0100 today", "+1 540.555.0100"]) {
      expect(captionProblems(phone, ["google"]), phone).toEqual([{ network: "google", kind: "phone_google", limit: 0 }]);
      expect(captionProblems(phone, ["facebook"]), phone).toEqual([]);
    }
    expect(captionProblems("Spring cleanups for 2026, 12 crews ready", ["google"])).toEqual([]);
  });

  it("need words for Google, and only for Google", () => {
    expect(needsCaption("", ["facebook", "google"])).toBe(true);
    expect(needsCaption("  ", ["google"])).toBe(true);
    expect(needsCaption("", ["facebook", "instagram"])).toBe(false);
    expect(needsCaption("Fresh mulch", ["google"])).toBe(false);
  });

  it("names the networks in their order", () => {
    expect(networkWords(["google", "facebook"])).toBe("Facebook and Google");
    expect(networkWords(["instagram", "google", "facebook"])).toBe("Facebook, Instagram and Google");
    expect(networkWords(["instagram"])).toBe("Instagram");
  });
});

describe("a reviewer's name on a post", () => {
  it("is the first name and last initial", () => {
    expect(firstNameLastInitial("Ana Maria Smith")).toBe("Ana S.");
    expect(firstNameLastInitial("  Élodie   dupont ")).toBe("Élodie D.");
    expect(firstNameLastInitial("Óscar Núñez")).toBe("Óscar N.");
  });

  it("keeps Google's own short form, and one word", () => {
    expect(firstNameLastInitial("Ana S.")).toBe("Ana S.");
    expect(firstNameLastInitial("ana")).toBe("Ana");
    expect(firstNameLastInitial("McKenzie")).toBe("McKenzie");
  });

  it("drops titles and suffixes", () => {
    expect(firstNameLastInitial("Dr. Maya Patel")).toBe("Maya P.");
    expect(firstNameLastInitial("Mrs Jones")).toBe("Jones");
    expect(firstNameLastInitial("John Smith Jr.")).toBe("John S.");
  });

  it("is nobody for an empty or anonymous name", () => {
    for (const name of [null, undefined, "", "   ", "Anonymous", "A Google user"]) expect(firstNameLastInitial(name), String(name)).toBeNull();
  });
});

describe("what a post mustn't say", () => {
  const client = { names: ["Ana Green", "Bob Stone"], addresses: ["14 Oak St", "200 N Main Street Apt 4"] };

  it("refuses a client's whole name, folded for case and accents", () => {
    expect(mentionsClient("Thanks ANA GREEN for having us!", client).blocked).toEqual(["Ana Green"]);
    expect(mentionsClient("Merci à Ána Gréen", client).blocked).toEqual(["Ana Green"]);
    expect(mentionsClient("Great day with the crew", client)).toEqual({ blocked: [], warnings: [] });
  });

  it("refuses their street address, written however", () => {
    expect(mentionsClient("They redid the lawn at 14 Oak St", client).blocked).toEqual(["14 Oak St"]);
    expect(mentionsClient("14 oak street looks great.", client).blocked).toEqual(["14 Oak St"]);
    expect(mentionsClient("Fresh mulch at 14 Oak, done!", client).blocked).toEqual(["14 Oak St"]);
    expect(mentionsClient("We planted 14 oak trees", client).blocked).toEqual([]);
    expect(mentionsClient("New sod on 200 N Main St", client).blocked).toEqual(["200 N Main Street Apt 4"]);
  });

  it("only warns about a last name on its own, and not as an everyday word", () => {
    expect(mentionsClient("A green lawn and stone path", client)).toEqual({ blocked: [], warnings: [] });
    expect(mentionsClient("Thanks to the Greens", client).warnings).toEqual([]);
    expect(mentionsClient("Thanks, Green family!", client)).toEqual({ blocked: [], warnings: ["Green"] });
  });

  it("doesn't match a short common first name", () => {
    expect(mentionsClient("Ana loved it", { names: ["Ana Li"], addresses: [] })).toEqual({ blocked: [], warnings: [] });
  });
});

describe("the review card", () => {
  const fixed = (text: string, size: number) => text.length * size * 0.5;

  it("sets the words as large as they fit", () => {
    expect(fitCardText("Great work", { measure: fixed, width: 600 })).toEqual({ size: 56, lines: ["Great work"], truncated: false });
    const long = "word ".repeat(60);
    const fit = fitCardText(long, { measure: fixed, width: 600 });
    expect(fit.size).toBeLessThan(56);
    expect(fit.lines.length).toBeLessThanOrEqual(7);
  });

  it("steps down in size before it cuts, then ends with an ellipsis", () => {
    const sizes = [56, 50, 44, 40];
    const seen = new Set<number>();
    for (let n = 2; n < 100; n++) seen.add(fitCardText("ab ".repeat(n), { measure: fixed, width: 600, sizes }).size);
    expect([...seen].sort((a, b) => b - a)).toEqual(sizes);
    const cut = fitCardText("lawn ".repeat(400), { measure: fixed, width: 600 });
    expect(cut).toMatchObject({ size: 40, truncated: true });
    expect(cut.lines).toHaveLength(7);
    expect(cut.lines.at(-1)).toMatch(/…$/);
    expect(cut.lines.every((l) => fixed(l, 40) <= 600)).toBe(true);
  });

  it("breaks one very long word over lines", () => {
    const fit = fitCardText("a".repeat(100), { measure: fixed, width: 600, maxLines: 7 });
    expect(fit.lines.join("")).toBe("a".repeat(100));
    expect(fit.lines.every((l) => fixed(l, fit.size) <= 600)).toBe(true);
  });

  it("measures with Figtree's own widths", () => {
    expect(measureFigtree("i", 100)).toBeLessThan(measureFigtree("W", 100));
    expect(measureFigtree("Ana", 50)).toBeCloseTo(((677 + 558 + 510) / 1000) * 50, 5);
  });

  it("takes Latin words and common punctuation, without emoji", () => {
    expect(cardSupported("Great job — thank you! 😀")).toBe(true);
    expect(cardSupported("Très bien, “parfait”…")).toBe(true);
    expect(cardSupported("素晴らしい")).toBe(false);
    expect(cardSupported("Отлично")).toBe(false);
    expect(cardSupported("👍👍")).toBe(false);
    expect(hasWords("🔥🔥 !!")).toBe(false);
    expect(cardText(" Great 👍  job ")).toBe("Great job");
  });

  it("says when it leaves emoji out, so the words don't change quietly", () => {
    expect(cardDropsEmoji("Loved it 🌿🌿 the best crew 👍")).toBe(true);
    expect(cardText("Loved it 🌿🌿 the best crew 👍")).toBe("Loved it the best crew");
    expect(cardDropsEmoji("Loved it,\n  the best crew!")).toBe(false);
    expect(cardDropsEmoji(null)).toBe(false);
  });

  it("fits a height too: larger words take fewer lines, and a short review is set large", () => {
    const short = fitCardText("Great crew", { measure: fixed, width: 860, sizes: [72, 64, 56], maxLines: 8, maxHeight: 500 });
    expect(short).toMatchObject({ size: 72, truncated: false });
    // At 72 px, 500 px holds 5 lines of 93.6: six lines' worth steps down to where they fit.
    const words = "lawn ".repeat(60);
    const fit = fitCardText(words, { measure: fixed, width: 860, sizes: [72, 64, 56, 50, 44, 40], maxLines: 8, maxHeight: 500 });
    expect(fit.lines.length * fit.size * 1.3).toBeLessThanOrEqual(500);
    const cut = fitCardText("lawn ".repeat(400), { measure: fixed, width: 860, sizes: [72, 40], maxLines: 8, maxHeight: 300 });
    expect(cut).toMatchObject({ size: 40, truncated: true });
    expect(cut.lines).toHaveLength(5);
  });

  it("is in the brand colour, with the words that read best on it, else Crewtavo's", () => {
    expect(cardColors(null)).toMatchObject({ background: "#0f2a35", text: "#ffffff", brand: false });
    expect(cardColors("#F7E9A0")).toMatchObject({ background: "#f7e9a0", text: "#182430", brand: true });
    expect(cardColors("#1f4e79")).toMatchObject({ text: "#ffffff", brand: true });
    expect(cardColors("navy").brand).toBe(false);
    expect([padColor(null), padColor("#1F4E79")]).toEqual([PAD_GREY, "#1f4e79"]);
  });
});

describe("photos OK to share", () => {
  it("are JPEG or PNG", () => {
    for (const type of ["image/jpeg", "IMAGE/JPG", "image/png"]) expect(canShareType(type), type).toBe(true);
    for (const type of ["image/heic", "image/webp", "image/gif", "application/pdf", null]) expect(canShareType(type), String(type)).toBe(false);
  });
});

describe("automatic 5-star posts", () => {
  const at = (iso: string) => new Date(iso);

  it("read their switch and networks as the database does", () => {
    expect(socialSettings({})).toEqual({ auto: { enabled: false, networks: [] } });
    expect(socialSettings({ social: { auto: { enabled: true, networks: ["google", "facebook", "x"] } } })).toEqual({ auto: { enabled: true, networks: ["facebook", "google"] } });
  });

  it("go at 10 AM the next day, or the same day before 8 AM", () => {
    // 9 PM in New York on Oct 31: 10 AM on Nov 1, after the clocks go back.
    expect(nextAutoSlot(at("2026-11-01T01:00:00Z"), NY, [])).toEqual(at("2026-11-01T15:00:00Z"));
    // 7 AM on Nov 2 (EST): the same day.
    expect(nextAutoSlot(at("2026-11-02T12:00:00Z"), NY, [])).toEqual(at("2026-11-02T15:00:00Z"));
    // 8 AM sharp: tomorrow.
    expect(nextAutoSlot(at("2026-11-02T13:00:00Z"), NY, [])).toEqual(at("2026-11-03T15:00:00Z"));
  });

  it("take the next slot, at most 3 a day, then the next day", () => {
    const now = at("2026-11-02T18:00:00Z");
    const ten = at("2026-11-03T15:00:00Z");
    const one = at("2026-11-03T18:00:00Z");
    const four = at("2026-11-03T21:00:00Z");
    expect(nextAutoSlot(now, NY, [ten])).toEqual(one);
    expect(nextAutoSlot(now, NY, [ten, one])).toEqual(four);
    expect(nextAutoSlot(now, NY, [ten, one, four])).toEqual(at("2026-11-04T15:00:00Z"));
    // One moved to 11 AM by the office still counts toward the day's three.
    expect(nextAutoSlot(now, NY, [at("2026-11-03T16:00:00Z"), one, four])).toEqual(at("2026-11-04T15:00:00Z"));
  });

  it("keep to local time across daylight saving", () => {
    // Clocks go back on Nov 1, 2026: 10 AM is 14:00Z before and 15:00Z after.
    expect(nextAutoSlot(at("2026-10-31T15:00:00Z"), NY, [])).toEqual(at("2026-11-01T15:00:00Z"));
    expect(nextAutoSlot(at("2026-10-30T15:00:00Z"), NY, [])).toEqual(at("2026-10-31T14:00:00Z"));
  });

  it("say when they go", () => {
    const now = at("2026-11-02T18:00:00Z");
    expect(autoPostWhen(at("2026-11-03T15:00:00Z"), NY, now)).toBe("tomorrow at 10 AM");
    expect(autoPostWhen(at("2026-11-02T21:00:00Z"), NY, now)).toBe("today at 4 PM");
    // A date past tomorrow, as the Social tab lists it: an automatic post can be weeks out.
    expect(autoPostWhen(at("2026-11-05T18:00:00Z"), NY, now)).toBe("Nov 5 at 1 PM");
    expect(autoPostWhen(at("2026-12-01T15:00:00Z"), NY, now)).toBe("Dec 1 at 10 AM");
    expect(clockWords(at("2026-11-05T18:30:00Z"), NY)).toBe("1:30 PM");
    expect(timeZoneWords(NY)).toBe("Eastern Time");
  });
});

describe("permissions Meta wasn't given", () => {
  it("are named for the network, with how to fix it", () => {
    expect(missingPermissionWords("facebook", ["pages_manage_posts"])).toBe("Facebook is missing the pages_manage_posts permission. Reconnect Facebook & Instagram in Apps and allow it.");
    expect(missingPermissionWords("instagram", ["instagram_basic", "instagram_content_publish"])).toBe("Instagram is missing the instagram_basic and instagram_content_publish permissions. Reconnect Facebook & Instagram in Apps and allow them.");
  });
});

describe("a post's status", () => {
  const n = (status: string, error_kind: string | null = null) => ({ status, error_kind });

  it("comes from its networks", () => {
    expect(postStatusOf([])).toBeNull();
    expect(postStatusOf([n("posted"), n("retry")])).toBe("posting");
    expect(postStatusOf([n("posted"), n("posted")])).toBe("posted");
    expect(postStatusOf([n("posted"), n("failed", "rate")])).toBe("partly_posted");
    expect(postStatusOf([n("posted"), n("unknown")])).toBe("partly_posted");
    expect(postStatusOf([n("unknown")])).toBe("check");
    expect(postStatusOf([n("failed", "signin"), n("unknown")])).toBe("check");
    expect(postStatusOf([n("failed", "signin"), n("skipped", "not_connected")])).toBe("failed");
    expect(postStatusOf([n("skipped", "cancelled"), n("skipped", "cancelled")])).toBe("cancelled");
  });
});
