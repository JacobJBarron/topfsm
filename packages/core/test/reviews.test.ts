/**
 * Google reviews (src/reviews.ts): names folded as the database folds them (the same names as
 * supabase/tests/google_reviews_test.sql; apps/api/test/googleReviews.test.ts reads private.name_key's
 * lists from its migration and compares them with NAME_FOLDS), the reviewer's name forms and who a review is matched
 * to, Google's star words, the Reviews tab's months in the company's time zone, its response rate
 * and time to reply, when a review tells the office and what it says, and the project number
 * Google's access form asks for.
 */
import { describe, expect, it } from "vitest";
import {
  nameKey,
  nameMatch,
  nameShort,
  NOTIFY_WITHIN_DAYS,
  pickMatch,
  projectNumber,
  replyTimeWords,
  responseRate,
  reviewerKey,
  reviewerName,
  reviewNotice,
  reviewTrend,
  shouldNotify,
  starRating,
  starsLabel,
} from "../src/reviews";

describe("names", () => {
  // The same names as supabase/tests/google_reviews_test.sql.
  it("fold to plain letters, apostrophes dropped and punctuation a space", () => {
    const cases: Array<[string | null, string | null]> = [
      ["Ana Smith", "ana smith"], ["  ANA   SMITH ", "ana smith"], ["O’Brien-Núñez, Éric", "obrien nunez eric"], ["ÉRIC Ñúñez", "eric nunez"],
      ["Éric", "eric"], ["Ana S.", "ana s"], ["Straße Æsir Œuvre", "strasse aesir oeuvre"], ["Łukasz Dvořák", "lukasz dvorak"],
      ["Mike's Pizza & Co.", "mikes pizza co"], ["İsmail Işık", "ismail isik"], ["", null], ["...", null], [null, null],
    ];
    for (const [name, key] of cases) expect(nameKey(name), String(name)).toBe(key);
  });

  it("shorten a client's name as Google shortens a reviewer's", () => {
    expect(nameShort("Ana Maria Smith")).toBe("ana s");
    expect(nameShort("ÉRIC NÚÑEZ")).toBe("eric n");
    expect(nameShort("Ana")).toBeNull();
  });

  it("read a reviewer's name: the whole name, the short form, or nothing for an anonymous one", () => {
    expect(reviewerKey("Ana Smith", false)).toEqual({ key: "ana smith", short: false });
    expect(reviewerKey("Ana S.", false)).toEqual({ key: "ana s", short: true });
    expect(reviewerKey("A Google User", true)).toBeNull();
    expect(reviewerKey("  ", false)).toBeNull();
  });

  it("say how a reviewer fits a client", () => {
    const ana = { display_name: "Ana Smith" };
    expect(nameMatch({ name: "ANA SMITH", anonymous: false }, ana)).toBe("full");
    expect(nameMatch({ name: "Ana S.", anonymous: false }, ana)).toBe("short");
    expect(nameMatch({ name: "Ana T.", anonymous: false }, ana)).toBeNull();
    expect(nameMatch({ name: "Ana Smith", anonymous: true }, ana)).toBeNull();
    expect(nameMatch({ name: "Ana & Bob Smith", anonymous: false }, ana)).toBeNull();
  });
});

describe("matching", () => {
  it("picks as review_match does", () => {
    const table: Array<[string, Parameters<typeof pickMatch>[0], string | null]> = [
      ["one whole name, not asked", [{ id: "a", how: "full", asked: false }], "a"],
      ["a short name needs an ask", [{ id: "a", how: "short", asked: false }], null],
      ["a short name with an ask", [{ id: "a", how: "short", asked: true }], "a"],
      ["the asked one of two of the same name", [{ id: "a", how: "full", asked: false }, { id: "b", how: "full", asked: true }], "b"],
      ["two asked: nobody", [{ id: "a", how: "full", asked: true }, { id: "b", how: "full", asked: true }], null],
      ["two not asked: nobody", [{ id: "a", how: "full", asked: false }, { id: "b", how: "full", asked: false }], null],
      ["one already matched elsewhere", [{ id: "a", how: "full", asked: true, taken: true }, { id: "b", how: "full", asked: false }], "b"],
      ["no one", [], null],
    ];
    for (const [what, candidates, want] of table) expect(pickMatch(candidates), what).toBe(want);
  });
});

describe("stars", () => {
  it("reads Google's words, and anything else as no stars", () => {
    expect(["ONE", "TWO", "THREE", "FOUR", "FIVE"].map(starRating)).toEqual([1, 2, 3, 4, 5]);
    for (const junk of ["STAR_RATING_UNSPECIFIED", "five", "6", 5, null, undefined, "toString"]) expect(starRating(junk), String(junk)).toBeNull();
    expect(starsLabel(4)).toBe("4 out of 5 stars");
  });
});

describe("the Reviews tab's numbers", () => {
  it("fills in 12 months up to this one in the company's time zone, averages only where there are stars", () => {
    // 2am on November 1st in UTC is still October in New York.
    const now = new Date("2026-11-01T02:00:00Z");
    const months = reviewTrend([{ month: "2026-10", count: 3, rating_sum: 13, rated: 3 }, { month: "2025-11", count: 1, rating_sum: 0, rated: 0 }], now, "America/New_York");
    expect(months).toHaveLength(12);
    expect(months[0]).toMatchObject({ month: "2025-11", label: "Nov", count: 1, average: null });
    expect(months.at(-1)).toMatchObject({ month: "2026-10", label: "Oct", title: "October 2026", count: 3, average: 4.3 });
    expect(months.filter((m) => m.count === 0).every((m) => m.average === null)).toBe(true);
    expect(reviewTrend([], now, "UTC").at(-1)!.month).toBe("2026-11");
  });

  it("works out the response rate and says how long replies take", () => {
    expect(responseRate(3, 4)).toBe(75);
    expect(responseRate(0, 0)).toBeNull();
    expect([0.2, 0.001, 1, 5, 23.4, 23.6, 30, 50, 24 * 9, 24 * 30, null, -1].map(replyTimeWords)).toEqual([
      "12 min", "1 min", "1 hour", "5 hours", "23 hours", "1 day", "1 day", "2 days", "9 days", "4 weeks", null, null,
    ]);
  });
});

describe("telling the office", () => {
  const now = new Date("2026-10-31T12:00:00Z");
  it("tells of a new review only once the first sync is done, and only of recent ones", () => {
    expect(shouldNotify("2026-10-30T12:00:00Z", { firstSyncedAt: null, now })).toBe(false);
    expect(shouldNotify("2026-10-30T12:00:00Z", { firstSyncedAt: "2026-10-01T00:00:00Z", now })).toBe(true);
    expect(shouldNotify(new Date(now.getTime() - (NOTIFY_WITHIN_DAYS + 1) * 86_400_000), { firstSyncedAt: "2026-10-01T00:00:00Z", now })).toBe(false);
  });

  // The same words as claim_review_notices writes (supabase/tests/google_reviews_test.sql).
  it("says who left how many stars, and what they wrote", () => {
    expect(reviewNotice({ reviewer_name: "Lou New", reviewer_anonymous: false, rating: 5, comment: "Lovely work" })).toEqual({ kind: "review", title: "Lou New left a 5-star review", body: "Lovely work" });
    expect(reviewNotice({ reviewer_name: "Max Low", reviewer_anonymous: false, rating: 1, comment: "Never  showed\nup." })).toEqual({ kind: "review_low", title: "Max Low left a 1-star review", body: "Never showed up." });
    expect(reviewNotice({ reviewer_name: "ÉRIC NÚÑEZ", reviewer_anonymous: false, rating: 1, comment: null }, true)).toMatchObject({ kind: "review_low", title: "ÉRIC NÚÑEZ changed their review to 1 star", body: "No comment, just stars." });
    expect(reviewNotice({ reviewer_name: "A Google User", reviewer_anonymous: true, rating: 2, comment: "" }).title).toBe("Someone left a 2-star review");
    expect(reviewNotice({ reviewer_name: "Kim", reviewer_anonymous: false, rating: null, comment: null })).toEqual({ kind: "review", title: "Kim left a review", body: null });
    expect(reviewNotice({ reviewer_name: "Kim", reviewer_anonymous: false, rating: 4, comment: "x".repeat(300) }).body).toBe(`${"x".repeat(199)}…`);
    // Google may leave a name out: "Someone", never "null".
    expect(reviewNotice({ reviewer_name: null, reviewer_anonymous: false, rating: 5, comment: null }).title).toBe("Someone left a 5-star review");
  });

  it("calls a reviewer by their name, or nothing when they're anonymous or Google sent none", () => {
    expect(reviewerName({ reviewer_name: "  Ana S. ", reviewer_anonymous: false })).toBe("Ana S.");
    expect(reviewerName({ reviewer_name: "A Google User", reviewer_anonymous: true })).toBeNull();
    expect(reviewerName({ reviewer_name: null, reviewer_anonymous: false })).toBeNull();
    expect(reviewerName({ reviewer_name: "   ", reviewer_anonymous: false })).toBeNull();
  });
});

describe("Google's access form", () => {
  it("asks for the project number, which is the start of the OAuth client ID", () => {
    expect(projectNumber("123456789012-abcdef.apps.googleusercontent.com")).toBe("123456789012");
    expect(projectNumber("not-a-google-id")).toBeNull();
    expect(projectNumber(null)).toBeNull();
  });
});
