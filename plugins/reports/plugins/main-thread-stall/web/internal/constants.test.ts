import { describe, expect, test } from "bun:test";
import { prefixOfWorkerName, watchdogWorkerName } from "./constants";

describe("watchdog worker name", () => {
  test("the worker reads its prefix back from every generation's name", () => {
    expect(watchdogWorkerName("eq", 0)).toBe("eq:main-thread-stall");
    expect(watchdogWorkerName("eq", 2)).toBe("eq:main-thread-stall#relaunch-2");
    for (const g of [0, 1, 12])
      expect(prefixOfWorkerName(watchdogWorkerName("eq:x", g))).toBe("eq:x");
  });

  test("a name of another shape is refused", () => {
    expect(() => prefixOfWorkerName("eq:shared-ws")).toThrow(
      /unexpected worker name/,
    );
    expect(() => prefixOfWorkerName("eq:main-thread-stall#relaunch-0")).toThrow(
      /unexpected worker name/,
    );
  });
});
