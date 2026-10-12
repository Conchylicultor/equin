import { describe, expect, test } from "bun:test";
import { createTreeChangeSignal } from "./tree-change-signal";

describe("createTreeChangeSignal", () => {
  test("a bump moves the token and tells every listener", () => {
    const signal = createTreeChangeSignal();
    const before = signal.token();
    let heard = 0;
    signal.on(() => heard++);
    signal.on(() => heard++);
    expect(signal.token()).toBe(before);
    signal.bump();
    expect(heard).toBe(2);
    expect(signal.token()).not.toBe(before);
  });

  test("the unsubscribe stops a listener, and only that one", () => {
    const signal = createTreeChangeSignal();
    const heard: string[] = [];
    const offA = signal.on(() => heard.push("a"));
    signal.on(() => heard.push("b"));
    offA();
    signal.bump();
    expect(heard).toEqual(["b"]);
  });

  test("two signals (two processes) never mint the same token", () => {
    // generation 0 in both: only the boot id keeps an old-boot ETag from
    // matching a new-boot tree.
    expect(createTreeChangeSignal().token()).not.toBe(
      createTreeChangeSignal().token(),
    );
  });

  test("a throwing listener does not starve the others, and still throws", () => {
    const signal = createTreeChangeSignal();
    let heard = false;
    signal.on(() => {
      throw new Error("listener bug");
    });
    signal.on(() => {
      heard = true;
    });
    const before = signal.token();
    expect(() => signal.bump()).toThrow("listener bug");
    expect(heard).toBe(true);
    // The generation moved even though a listener failed.
    expect(signal.token()).not.toBe(before);
  });
});
