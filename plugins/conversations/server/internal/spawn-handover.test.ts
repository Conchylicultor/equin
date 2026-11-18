import { describe, expect, test } from "bun:test";
import { handOverStarting, spawnsHoldingStarting } from "./spawn-handover";

describe("spawnsHoldingStarting", () => {
  test("a handed-over spawn stops holding its row while its run is still queued", () => {
    handOverStarting("conv-a");
    const held = spawnsHoldingStarting(
      ["conv-a", "conv-b"],
      new Set(["conv-a", "conv-b"]),
      [],
    );
    expect([...held]).toEqual(["conv-b"]);
  });

  test("the mark is forgotten once the queue no longer holds the run", () => {
    handOverStarting("conv-c");
    spawnsHoldingStarting(["conv-c"], new Set(), []);
    // A later spawn of the same conversation (a Retry launch) holds again.
    expect([
      ...spawnsHoldingStarting(["conv-c"], new Set(["conv-c"]), []),
    ]).toEqual(["conv-c"]);
  });

  test("the mark is forgotten once its row is no longer starting", () => {
    handOverStarting("conv-d");
    spawnsHoldingStarting([], new Set(), ["conv-d"]);
    expect([
      ...spawnsHoldingStarting(["conv-d"], new Set(["conv-d"]), []),
    ]).toEqual(["conv-d"]);
  });
});
