import { describe, expect, it } from "bun:test";
import { LIVE_QUERY_MAX_BYTES } from "@plugins/network/plugins/live/core";
import {
  DEPLOYMENT_ID_MAX_LENGTH,
  FILTERS_MAX_BYTES,
  deploymentAnalytics,
  filtersFit,
} from "./analytics";

/** The longest filters that still fit the budget: one value padded to it. */
function filtersAtBudget() {
  const filters = [{ dimension: "referrer_path" as const, value: "" }];
  while (filtersFit([{ ...filters[0]!, value: filters[0]!.value + "é" }])) {
    filters[0] = { ...filters[0]!, value: filters[0]!.value + "é" };
  }
  return filters;
}

describe("deploy-analytics.report question", () => {
  it("always fits LIVE_QUERY_MAX_BYTES when its filters fit their budget", () => {
    const filters = filtersAtBudget();
    expect(filtersFit(filters)).toBe(true);
    // The worst case: the longest id, the longest range and compare fields.
    const { q } = deploymentAnalytics.query.encode({
      deploymentId: "d".repeat(DEPLOYMENT_ID_MAX_LENGTH),
      query: { range: "today", compare: false, filters },
    });
    expect(new TextEncoder().encode(q).length).toBeLessThanOrEqual(
      LIVE_QUERY_MAX_BYTES,
    );
  });

  it("refuses filters over their budget in the schema itself", () => {
    const over = [
      { dimension: "page" as const, value: "x".repeat(FILTERS_MAX_BYTES) },
    ];
    expect(filtersFit(over)).toBe(false);
    expect(() =>
      deploymentAnalytics.query.encode({
        deploymentId: "dpl-1",
        query: { range: "7d", compare: true, filters: over },
      }),
    ).toThrow(/over 1536 bytes/);
  });
});
