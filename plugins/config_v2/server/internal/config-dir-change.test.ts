import { describe, expect, test } from "bun:test";
import { notifyConfigDirChange, onConfigDirChange } from "./config-dir-change";

describe("onConfigDirChange", () => {
  test("every listener hears a change until it unsubscribes", () => {
    const heard: string[] = [];
    const offA = onConfigDirChange(() => heard.push("a"));
    const offB = onConfigDirChange(() => heard.push("b"));
    notifyConfigDirChange();
    offA();
    notifyConfigDirChange();
    offB();
    notifyConfigDirChange();
    expect(heard).toEqual(["a", "b", "b"]);
  });

  test("a throwing listener does not starve the others, and still throws", () => {
    let heard = false;
    const offBad = onConfigDirChange(() => {
      throw new Error("listener bug");
    });
    const offGood = onConfigDirChange(() => {
      heard = true;
    });
    try {
      expect(() => notifyConfigDirChange()).toThrow("listener bug");
      expect(heard).toBe(true);
    } finally {
      offBad();
      offGood();
    }
  });
});
