import { describe, expect, it } from "vitest";
import { repeatText, scheduleText, seasonText } from "../src/features/jobs/repeatText";

// The job page says a recurring job's repeat in sentence case, the way the rest of the app writes.
describe("a job's repeat", () => {
  it("reads weekly rules by their days, in week order", () => {
    expect(repeatText("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO")).toBe("Weekly, Monday");
    expect(repeatText("FREQ=WEEKLY;INTERVAL=1;BYDAY=TH,MO")).toBe("Weekly, Monday and Thursday");
    expect(repeatText("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU")).toBe("Every 2 weeks, Tuesday");
    expect(repeatText("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR")).toBe("Every weekday");
    expect(repeatText("FREQ=WEEKLY;BYDAY=MO,WE,FR")).toBe("Weekly, Monday, Wednesday and Friday");
  });

  it("reads monthly rules by the day of the month or the weekday in it", () => {
    expect(repeatText("FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1")).toBe("Monthly, the 1st");
    expect(repeatText("FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=22")).toBe("Every 3 months, the 22nd");
    expect(repeatText("FREQ=MONTHLY;BYMONTHDAY=11")).toBe("Monthly, the 11th");
    expect(repeatText("FREQ=MONTHLY;BYDAY=1MO")).toBe("Monthly, first Monday");
    expect(repeatText("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1")).toBe("Monthly, last Friday");
    expect(repeatText("RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=3WE")).toBe("Every 2 months, third Wednesday");
  });

  it("falls back to RRule's wording, capitalized, for anything else", () => {
    expect(repeatText("FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=15")).toBe("Every April on the 15th");
    expect(repeatText("FREQ=DAILY;INTERVAL=1")).toBe("Daily");
  });
});

// A quote for recurring work tells the client how often, season and all.
describe("how often, on a quote", () => {
  it("reads a season as a run of months, or names them", () => {
    expect(seasonText([4, 5, 6, 7, 8, 9, 10])).toBe("April to October");
    expect(seasonText([10, 4, 5, 6, 7, 8, 9])).toBe("April to October");
    expect(seasonText([6, 7])).toBe("June and July");
    expect(seasonText([6, 7, 12])).toBe("June, July and December");
    expect(seasonText(null)).toBeNull();
    expect(seasonText([])).toBeNull();
    expect(seasonText([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toBeNull();
  });

  it("says the repeat, then the season", () => {
    expect(scheduleText("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", [4, 5, 6, 7, 8, 9, 10])).toBe("Every 2 weeks, Tuesday, April to October");
    expect(scheduleText("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO", null)).toBe("Weekly, Monday");
  });
});
