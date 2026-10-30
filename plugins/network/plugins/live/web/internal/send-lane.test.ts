import { describe, expect, test } from "bun:test";
import {
  activeSendLaneCount,
  enqueueOnSendLane,
  resourceSendLaneKey,
} from "./send-lane";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("send lane keys", () => {
  test("a resource tuple's key is canonical over its params' key order", () => {
    expect(resourceSendLaneKey("k", { b: "2", a: "1" })).toBe(
      resourceSendLaneKey("k", { a: "1", b: "2" }),
    );
    expect(resourceSendLaneKey("k", undefined)).toBe(
      resourceSendLaneKey("k", {}),
    );
  });
});

describe("enqueueOnSendLane", () => {
  test("an idle lane sends synchronously", async () => {
    let sent = false;
    const run = enqueueOnSendLane(
      resourceSendLaneKey("t", { id: "sync" }),
      () => {
        sent = true;
        return Promise.resolve(1);
      },
    );
    expect(sent).toBe(true);
    expect(await run).toBe(1);
  });

  test("sends on one lane depart in order; another lane does not wait", async () => {
    const order: string[] = [];
    const first = deferred<void>();
    const lane = resourceSendLaneKey("t", { id: "order" });
    void enqueueOnSendLane(lane, () => {
      order.push("a");
      return first.promise;
    });
    const b = enqueueOnSendLane(lane, () => {
      order.push("b");
      return Promise.resolve();
    });
    void enqueueOnSendLane(resourceSendLaneKey("t", { id: "other" }), () => {
      order.push("other");
      return Promise.resolve();
    });
    await settle();
    expect(order).toEqual(["a", "other"]);
    first.resolve();
    await b;
    expect(order).toEqual(["a", "other", "b"]);
  });

  test("a rejected send advances the lane and keeps its own outcome", async () => {
    const lane = resourceSendLaneKey("t", { id: "reject" });
    const failed = enqueueOnSendLane(lane, () =>
      Promise.reject(new Error("no")),
    );
    const next = enqueueOnSendLane(lane, () => Promise.resolve("ok"));
    const outcome = await failed.then(
      () => "resolved",
      (err: unknown) => (err instanceof Error ? err.message : "non-error"),
    );
    expect(outcome).toBe("no");
    expect(await next).toBe("ok");
  });

  test("an idle lane is reclaimed", async () => {
    const idle = activeSendLaneCount();
    const gate = deferred<void>();
    const run = enqueueOnSendLane(
      resourceSendLaneKey("t", { id: "reclaim" }),
      () => gate.promise,
    );
    expect(activeSendLaneCount()).toBe(idle + 1);
    gate.resolve();
    await run;
    await settle();
    expect(activeSendLaneCount()).toBe(idle);
  });
});
