import { describe, expect, test } from "bun:test";
import {
  freeLaunchSlots,
  releasedLaunchSlot,
  takeLaunchable,
} from "./launch-slots";

describe("freeLaunchSlots", () => {
  test("max minus busy", () => {
    expect(freeLaunchSlots(0, 6)).toBe(6);
    expect(freeLaunchSlots(4, 6)).toBe(2);
    expect(freeLaunchSlots(6, 6)).toBe(0);
  });
  test("never negative when user launches push busy past the cap", () => {
    expect(freeLaunchSlots(9, 6)).toBe(0);
  });
});

describe("releasedLaunchSlot", () => {
  test("busy → at rest releases a slot", () => {
    expect(releasedLaunchSlot("working", "waiting")).toBe(true);
    expect(releasedLaunchSlot("starting", "gone")).toBe(true);
    expect(releasedLaunchSlot("working", "done")).toBe(true);
  });
  test("busy → busy and rest → anything do not", () => {
    expect(releasedLaunchSlot("starting", "working")).toBe(false);
    expect(releasedLaunchSlot("waiting", "working")).toBe(false);
    expect(releasedLaunchSlot("waiting", "gone")).toBe(false);
    expect(releasedLaunchSlot("gone", "done")).toBe(false);
  });
});

describe("takeLaunchable", () => {
  const blocked = new Set(["a", "c"]);
  const launchable = (id: string) => Promise.resolve(!blocked.has(id));

  test("oldest launchable first, skipping blocked ones", async () => {
    expect(
      await takeLaunchable(["a", "b", "c", "d", "e"], 2, launchable),
    ).toEqual(["b", "d"]);
  });
  test("stops checking once the slots are filled", async () => {
    const checked: string[] = [];
    await takeLaunchable(["b", "d", "e"], 1, (id) => {
      checked.push(id);
      return Promise.resolve(true);
    });
    expect(checked).toEqual(["b"]);
  });
  test("zero slots picks nothing; fewer candidates than slots picks all", async () => {
    expect(await takeLaunchable(["b"], 0, launchable)).toEqual([]);
    expect(await takeLaunchable(["a", "b"], 5, launchable)).toEqual(["b"]);
  });
});
