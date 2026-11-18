import { describe, expect, test } from "bun:test";
import type { Hold } from "@plugins/infra/plugins/deps/plugins/hold/core";
import { heldWaiting } from "./hold";

const one: Hold = {
  names: ["a"],
  version: "3",
  reason: "r",
  reviewBy: "2026-11-01",
};

describe("heldWaiting", () => {
  test("a held row says whether its review is overdue", () => {
    expect(heldWaiting(one, "2026-11-02")).toEqual({
      kind: "held",
      reason: "r",
      reviewBy: "2026-11-01",
      lapsed: true,
    });
    expect(heldWaiting(one, "2026-10-17").lapsed).toBe(false);
  });
});
