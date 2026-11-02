/**
 * Marketing → Reviews: Google reviews per month over the last 12, loaded with the chart library only
 * when there are reviews to chart (GoogleReviews.tsx). Only the counts go in TrendChart: it draws a
 * missing value as 0 from an axis that starts at 0, which would show a month with no reviews as a
 * 0-star dip and squash 4.6 against 4.9. The monthly average is a row of plain figures under it,
 * "—" for a month with none, never 0.
 */
import { reviewTrend, type ReviewMonth } from "@crewtavo/core/reviews";
import { TrendChart } from "../finance/Charts";

export function ReviewTrend({ months, timeZone }: { months: ReviewMonth[]; timeZone: string }) {
  const trend = reviewTrend(months, new Date(), timeZone);
  const buckets = trend.map((m) => {
    const [year, month] = m.month.split("-").map(Number) as [number, number];
    const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    return { key: m.month, label: m.label, title: m.title, from: `${m.month}-01`, to: last };
  });
  return (
    <div className="stack-sm">
      <TrendChart buckets={buckets} values={trend.map((m) => m.count)} format={(n) => `${n} ${n === 1 ? "review" : "reviews"}`} label="Google reviews each month" height={120} />
      <p className="muted small" style={{ margin: 0 }} aria-label="Average stars each month">
        {trend.map((m) => `${m.label} ${m.average === null ? "—" : m.average.toFixed(1)}`).join(" · ")}
      </p>
    </div>
  );
}
