import { expect, test } from "bun:test";
import { mapsUsageConfig } from "../../core";
import { usageRows } from "./usage-rows";

const october = new Date("2026-10-20T12:00:00Z");
const usage = {
  month: "2026-10",
  resetsAt: "2026-11-01T07:00:00.000Z",
  calls: {
    "text-search-enterprise": 950,
    "text-search-pro": 4000,
    "place-details-ids": 3,
  },
};

test("each budgeted SKU's state, and a called free SKU", () => {
  const rows = usageRows(usage, mapsUsageConfig.defaults, october);
  const bySku = new Map(rows.map((r) => [r.sku, r]));
  expect(bySku.get("text-search-enterprise")?.state).toBe("spent");
  expect(bySku.get("text-search-pro")?.state).toBe("near");
  expect(bySku.get("autocomplete")).toMatchObject({ calls: 0, state: "ok" });
  expect(bySku.get("place-details-ids")).toMatchObject({
    budget: null,
    state: "free",
    label: "Place Details IDs only",
  });
  // A free SKU never called is not listed.
  expect(bySku.has("text-search-ids")).toBe(false);
  expect(bySku.get("autocomplete")?.label).toBe("Autocomplete requests");
});

test("past the reset every count is zero", () => {
  const rows = usageRows(
    usage,
    mapsUsageConfig.defaults,
    new Date("2026-11-02T00:00:00Z"),
  );
  expect(rows.every((r) => r.calls === 0)).toBe(true);
});
