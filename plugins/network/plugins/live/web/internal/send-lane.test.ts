import { describe, expect, test } from "bun:test";
import {
  activeSendLaneCount,
  enqueueOnSendLane,
  enqueueOnSendLanes,
  entitySendLaneKey,
  namedSendLaneKey,
  resourceSendLaneKey,
  subjectSendLaneKey,
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

  test("an entity row's key never collides with a resource tuple's", () => {
    expect(entitySendLaneKey("conversations", "c1")).not.toBe(
      resourceSendLaneKey("conversations", { id: "c1" }),
    );
    expect(entitySendLaneKey("a", "b")).not.toBe(entitySendLaneKey("a", "c"));
  });

  test("a subject's and a named lane never collide with a row's", () => {
    const keys = new Set<string>([
      entitySendLaneKey("a", "b"),
      subjectSendLaneKey("a"),
      namedSendLaneKey("a"),
      resourceSendLaneKey("a", {}),
    ]);
    expect(keys.size).toBe(4);
  });
});

describe("enqueueOnSendLanes — one send on several lanes", () => {
  test("it waits for every lane's predecessor, and every lane's successor waits for it", async () => {
    const a = entitySendLaneKey("e", "a");
    const b = entitySendLaneKey("e", "b");
    const order: string[] = [];
    const first = deferred<void>();
    const onA = enqueueOnSendLane(a, () => {
      order.push("a1");
      return first.promise;
    });
    const both = enqueueOnSendLanes([b, a], async () => {
      order.push("ab");
    });
    const onB = enqueueOnSendLane(b, async () => {
      order.push("b2");
    });
    await settle();
    // `ab` waits for a1 (lane a); b2 waits for ab (lane b).
    expect(order).toEqual(["a1"]);
    first.resolve();
    await Promise.all([onA, both, onB]);
    expect(order).toEqual(["a1", "ab", "b2"]);
    await settle();
    expect(activeSendLaneCount()).toBe(0);
  });

  test("idle lanes send synchronously; a rejected predecessor still advances", async () => {
    const a = entitySendLaneKey("f", "a");
    const b = entitySendLaneKey("f", "b");
    let sent = false;
    const run = enqueueOnSendLanes([a, b], async () => {
      sent = true;
    });
    expect(sent).toBe(true);
    await run;
    const failing = enqueueOnSendLane(a, () => Promise.reject(new Error("x")));
    const after = enqueueOnSendLanes([a, b], async () => "ok");
    const outcome = await failing.then(
      () => "resolved",
      (err: unknown) => (err instanceof Error ? err.message : "?"),
    );
    expect(outcome).toBe("x");
    expect(await after).toBe("ok");
    expect(() => enqueueOnSendLanes([], async () => {})).toThrow(/no lane/);
  });
});

describe("enqueueOnSendLane", () => {
  test("an idle lane sends synchronously", async () => {
    let sent = false;
    const run = enqueueOnSendLane(entitySendLaneKey("t", "sync"), () => {
      sent = true;
      return Promise.resolve(1);
    });
    expect(sent).toBe(true);
    expect(await run).toBe(1);
  });

  test("sends on one lane depart in order; another lane does not wait", async () => {
    const order: string[] = [];
    const first = deferred<void>();
    const lane = entitySendLaneKey("t", "order");
    void enqueueOnSendLane(lane, () => {
      order.push("a");
      return first.promise;
    });
    const b = enqueueOnSendLane(lane, () => {
      order.push("b");
      return Promise.resolve();
    });
    void enqueueOnSendLane(entitySendLaneKey("t", "other"), () => {
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
    const lane = entitySendLaneKey("t", "reject");
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
      entitySendLaneKey("t", "reclaim"),
      () => gate.promise,
    );
    expect(activeSendLaneCount()).toBe(idle + 1);
    gate.resolve();
    await run;
    await settle();
    expect(activeSendLaneCount()).toBe(idle);
  });
});
