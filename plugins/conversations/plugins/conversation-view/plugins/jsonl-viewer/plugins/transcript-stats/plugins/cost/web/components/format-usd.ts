const exact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const compact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * A session cost in dollars. `short` stays two-decimal below $1,000 (a
 * session's cost is usually cents to tens of dollars, where compact notation
 * would round $0.04 to $0) and goes compact above; `exact` is always cents.
 */
export function formatUsd(usd: number, form: "short" | "exact"): string {
  if (form === "short" && usd >= 1000) return compact.format(usd);
  return exact.format(usd);
}
