import { expect, test } from "bun:test";
import { billingMonth } from "./billing-month";

test("the month is Pacific time: UTC's 1st morning is still last month", () => {
  const m = billingMonth(new Date("2026-11-01T05:00:00Z"));
  expect(m.key).toBe("2026-10");
  // Midnight Pacific (PDT, UTC−7) on Nov 1.
  expect(m.resetsAt.toISOString()).toBe("2026-11-01T07:00:00.000Z");
});

test("December rolls over to January", () => {
  const m = billingMonth(new Date("2026-12-15T12:00:00Z"));
  expect(m.key).toBe("2026-12");
  expect(m.resetsAt.toISOString()).toBe("2027-01-01T08:00:00.000Z");
});
