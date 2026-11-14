import { describe, expect, test } from "bun:test";
import {
  hasFirstPaintHolds,
  holdFirstPaint,
  takeFirstPaintHolds,
} from "./first-paint-holds";

// One registry per module instance, read once by the boot: the cases run in
// order on it, as one boot would.
describe("first-paint holds", () => {
  test("taking waits for every hold, then closes the registry", async () => {
    expect(hasFirstPaintHolds()).toBe(false);
    let settled = false;
    holdFirstPaint(
      new Promise<void>((resolve) => setTimeout(resolve, 10)).then(() => {
        settled = true;
      }),
    );
    expect(hasFirstPaintHolds()).toBe(true);
    await takeFirstPaintHolds();
    expect(settled).toBe(true);
    expect(hasFirstPaintHolds()).toBe(false);
    // After the first paint there is no frame left to hold.
    holdFirstPaint(Promise.resolve());
    expect(hasFirstPaintHolds()).toBe(false);
  });
});
