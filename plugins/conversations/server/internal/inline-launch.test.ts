import { describe, expect, test } from "bun:test";
import {
  inlineLaunchesInFlight,
  inlineLaunchMark,
  withInlineLaunch,
} from "./inline-launch";

describe("withInlineLaunch", () => {
  test("held while the launch runs, released when it settles — a throw included", async () => {
    let seen: ReadonlySet<string> = new Set();
    await withInlineLaunch("conv-a", async () => {
      seen = inlineLaunchesInFlight(["conv-a", "conv-b"], inlineLaunchMark());
    });
    expect(seen).toEqual(new Set(["conv-a"]));
    expect(inlineLaunchesInFlight(["conv-a"], inlineLaunchMark())).toEqual(
      new Set(),
    );

    const failed = withInlineLaunch("conv-a", () =>
      Promise.reject(new Error("create failed")),
    );
    expect(failed).rejects.toThrow("create failed");
    await failed.catch((err: unknown) => {
      if (!(err instanceof Error)) throw err;
    });
    expect(inlineLaunchesInFlight(["conv-a"], inlineLaunchMark())).toEqual(
      new Set(),
    );
  });

  test("re-entrant: an inner hold's release leaves the outer one held", async () => {
    await withInlineLaunch("conv-c", async () => {
      await withInlineLaunch("conv-c", async () => {});
      expect(inlineLaunchesInFlight(["conv-c"], inlineLaunchMark())).toEqual(
        new Set(["conv-c"]),
      );
    });
    expect(inlineLaunchesInFlight(["conv-c"], inlineLaunchMark())).toEqual(
      new Set(),
    );
  });

  test("a launch that settled after the reader's mark still counts: the rows it read may be stale", async () => {
    const mark = inlineLaunchMark(); // taken before the rows are read
    await withInlineLaunch("conv-d", async () => {}); // settles in between
    expect(inlineLaunchesInFlight(["conv-d"], mark)).toEqual(
      new Set(["conv-d"]),
    );
    // The next round's mark is after it: judged on its rows again.
    expect(inlineLaunchesInFlight(["conv-d"], inlineLaunchMark())).toEqual(
      new Set(),
    );
  });
});
