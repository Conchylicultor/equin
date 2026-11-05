import { describe, expect, test } from "bun:test";
import { ordinalLabels } from "./use-direction-labels";

describe("ordinalLabels", () => {
  test("an ordinal field names the ends of its declared order, by option label", () => {
    expect(
      ordinalLabels({
        valueOrder: ["new", "in_progress", "dropped"],
        options: [
          { value: "dropped", label: "Dropped" },
          { value: "new", label: "New" },
        ],
      }),
    ).toEqual({ asc: "New → Dropped", desc: "Dropped → New" });
  });

  test("an end with no option is named by its value", () => {
    expect(ordinalLabels({ valueOrder: ["low", "high"] })).toEqual({
      asc: "low → high",
      desc: "high → low",
    });
  });

  test("a field without a declared order has none", () => {
    expect(ordinalLabels({ options: [{ value: "a", label: "A" }] })).toBeNull();
  });
});
