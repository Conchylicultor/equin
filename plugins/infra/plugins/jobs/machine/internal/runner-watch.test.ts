import { describe, expect, test } from "bun:test";
import type { WorkerEvents } from "graphile-worker";
import { EventEmitter } from "node:events";
import { watchRunner } from "./runner-watch";

function harness(stopping = false) {
  const events = new EventEmitter();
  const deaths: string[] = [];
  let settle!: () => void;
  let fail!: (err: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  watchRunner({
    runner: { promise },
    events: events as WorkerEvents,
    isStopping: () => stopping,
    onDeath: (reason) => deaths.push(reason),
  });
  return { events, deaths, settle, fail };
}

describe("watchRunner", () => {
  test("a promise that RESOLVES is a death: graphile swallows the pool's error", async () => {
    const h = harness();
    h.events.emit("pool:fatalError", {
      action: "completeJob",
      error: new Error("deadlock detected"),
    });
    h.settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.deaths).toEqual(["completeJob: Error: deadlock detected"]);
  });

  test("a death with no fatal event still counts", async () => {
    const h = harness();
    h.settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.deaths).toHaveLength(1);
  });

  test("a rejection is a death too, naming the error", async () => {
    const h = harness();
    h.fail(new Error("cron exploded"));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.deaths).toEqual(["Error: cron exploded"]);
  });

  test("our own shutdown is not a death", async () => {
    const h = harness(true);
    h.settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.deaths).toEqual([]);
  });
});
