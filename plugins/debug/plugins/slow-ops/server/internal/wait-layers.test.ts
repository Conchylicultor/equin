import { describe, expect, test } from "bun:test";
import { describeWaits } from "./wait-layers";

describe("describeWaits", () => {
  test("names the dominant layer, its share and its hint, then every layer by size", () => {
    const [head, all] = describeWaits({
      durationMs: 2000,
      waits: {
        transport: 100,
        "server-notice": 1500,
        "server-deliver": 300,
        "client-apply": 100,
      },
    });
    expect(head).toStartWith(
      "**Where the time went:** `server-notice` — 1500ms, 75% of this trip.",
    );
    expect(head).toContain("long-held transaction");
    expect(all).toBe(
      "All layers: `server-notice` 1500ms, `server-deliver` 300ms, `transport` 100ms, `client-apply` 100ms.",
    );
  });

  test("an unknown layer is still named, without a hint", () => {
    const [head] = describeWaits({ durationMs: 100, waits: { "my-gate": 80 } });
    expect(head).toBe(
      "**Where the time went:** `my-gate` — 80ms, 80% of this trip.",
    );
  });

  test("nothing without a positive wait", () => {
    expect(describeWaits({ durationMs: 100 })).toEqual([]);
    expect(describeWaits({ durationMs: 100, waits: { retry: 0 } })).toEqual([]);
  });
});
