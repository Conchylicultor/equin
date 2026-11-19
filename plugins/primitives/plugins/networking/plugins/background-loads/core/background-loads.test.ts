import { describe, expect, it } from "bun:test";
import {
  backgroundLoadsHeld,
  holdBackgroundLoads,
  startBackgroundLoad,
  subscribeBackgroundLoads,
} from "./background-loads";

describe("background loads", () => {
  it("start at once when nothing holds them", () => {
    let started = 0;
    startBackgroundLoad(() => started++);
    expect(started).toBe(1);
    expect(backgroundLoadsHeld()).toBe(false);
  });

  it("wait for the last hold, then all start", () => {
    const releaseA = holdBackgroundLoads();
    const releaseB = holdBackgroundLoads();
    const started: string[] = [];
    startBackgroundLoad(() => started.push("x"));
    startBackgroundLoad(() => started.push("y"));
    releaseA();
    expect(started).toEqual([]);
    expect(backgroundLoadsHeld()).toBe(true);
    releaseB();
    expect(started).toEqual(["x", "y"]);
    expect(backgroundLoadsHeld()).toBe(false);
  });

  it("a release called twice releases once", () => {
    const releaseA = holdBackgroundLoads();
    const releaseB = holdBackgroundLoads();
    releaseA();
    releaseA();
    expect(backgroundLoadsHeld()).toBe(true);
    releaseB();
    expect(backgroundLoadsHeld()).toBe(false);
  });

  it("tells listeners when held and when free", () => {
    const seen: boolean[] = [];
    const stop = subscribeBackgroundLoads(() =>
      seen.push(backgroundLoadsHeld()),
    );
    const release = holdBackgroundLoads();
    const second = holdBackgroundLoads();
    second();
    release();
    stop();
    expect(seen).toEqual([true, false]);
  });
});
