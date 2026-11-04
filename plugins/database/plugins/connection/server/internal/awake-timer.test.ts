import { describe, expect, test } from "bun:test";
import { armAwakeDeadline } from "./awake-timer";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("armAwakeDeadline", () => {
  test("expires once the bound of awake time has passed", async () => {
    let fired = 0;
    armAwakeDeadline(performance.now(), 20, () => fired++);
    await wait(60);
    expect(fired).toBe(1);
  });

  test("a timer that fires while the awake clock has not reached the bound re-arms", async () => {
    // The awake clock advances only when the test says so: the real timer
    // firing stands for the machine waking from a sleep the clock did not see.
    let awake = 0;
    let fired = 0;
    armAwakeDeadline(
      0,
      30,
      () => fired++,
      () => awake,
    );
    await wait(60); // the timer fired (wall time passed), awake time is still 0
    expect(fired).toBe(0);
    awake = 25; // 5 ms of the bound left
    await wait(60);
    expect(fired).toBe(0); // re-armed for 30 ms at the first fire, now for 5
    awake = 30;
    await wait(40);
    expect(fired).toBe(1);
  });

  test("cancel stops it", async () => {
    let fired = 0;
    const cancel = armAwakeDeadline(performance.now(), 20, () => fired++);
    cancel();
    await wait(50);
    expect(fired).toBe(0);
  });
});
