/**
 * `awaitResourceWrite`'s confirmation arms, on a harness pipeline: the exact
 * ack (a standalone ack frame — no cache write), the snapshot-watermark floor
 * strictly past the write, the already-reflected fast path, and the reject arm
 * (a read that fails before confirming rejects instead of hanging).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { queryKeyFor } from "@plugins/primitives/plugins/live-state/web";
import {
  createLiveStateHarness,
  noteResourceTxAcks,
  noteResourceWatermark,
} from "@plugins/primitives/plugins/live-state/web/testing";
import { awaitWriteOn } from "../internal/await-resource-write";

// The page's registries are module-global: each test names its own tuple.
let n = 0;
function setup() {
  const h = createLiveStateHarness();
  const key = `await-write.test-${n++}`;
  const pipeline = {
    registries: h.notifications.registries,
    queryCache: h.queryClient.getQueryCache(),
  };
  return { h, key, pipeline };
}

/** Settles to "resolved" / "rejected: <message>" / "pending" after a tick. */
async function stateOf(p: Promise<void>): Promise<string> {
  let state = "pending";
  void p.then(
    () => (state = "resolved"),
    (err: unknown) => (state = `rejected: ${(err as Error).message}`),
  );
  await Promise.resolve();
  await Promise.resolve();
  return state;
}

describe("awaitResourceWrite", () => {
  it("resolves at once when the write is already reflected", async () => {
    const { key, pipeline } = setup();
    noteResourceTxAcks(key, undefined, ["100"]);
    expect(await stateOf(awaitWriteOn(pipeline, key, undefined, "100"))).toBe(
      "resolved",
    );
  });

  it("resolves on a standalone ack naming the write (no cache write)", async () => {
    const { key, pipeline } = setup();
    const p = awaitWriteOn(pipeline, key, undefined, "200");
    expect(await stateOf(p)).toBe("pending");
    noteResourceTxAcks(key, undefined, ["199"]);
    expect(await stateOf(p)).toBe("pending");
    noteResourceTxAcks(key, undefined, ["200"]);
    expect(await stateOf(p)).toBe("resolved");
  });

  it("resolves only once a snapshot watermark is strictly past the write", async () => {
    const { h, key, pipeline } = setup();
    const p = awaitWriteOn(pipeline, key, undefined, "300");
    // Equal proves nothing: the snapshot may predate the commit.
    noteResourceWatermark(key, undefined, "300");
    h.queryClient.setQueryData(queryKeyFor(key, undefined), ["a"]);
    expect(await stateOf(p)).toBe("pending");
    noteResourceWatermark(key, undefined, "301");
    h.queryClient.setQueryData(queryKeyFor(key, undefined), ["a", "b"]);
    expect(await stateOf(p)).toBe("resolved");
  });

  it("keys the ack on the params tuple", async () => {
    const { key, pipeline } = setup();
    const p = awaitWriteOn(pipeline, key, { id: "x" }, "400");
    noteResourceTxAcks(key, { id: "y" }, ["400"]);
    expect(await stateOf(p)).toBe("pending");
    noteResourceTxAcks(key, { id: "x" }, ["400"]);
    expect(await stateOf(p)).toBe("resolved");
  });

  it("rejects when the read fails before confirming", async () => {
    const { h, key, pipeline } = setup();
    const p = awaitWriteOn(pipeline, key, undefined, "500");
    expect(await stateOf(p)).toBe("pending");
    await h.queryClient
      .fetchQuery({
        queryKey: queryKeyFor(key, undefined),
        queryFn: () => Promise.reject(new Error("loader failed")),
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.message !== "loader failed")
          throw err;
      });
    expect(await stateOf(p)).toBe("rejected: loader failed");
  });

  it("rejects at once when the read is already failed", async () => {
    const { h, key, pipeline } = setup();
    await h.queryClient
      .fetchQuery({
        queryKey: queryKeyFor(key, undefined),
        queryFn: () => Promise.reject(new Error("down")),
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.message !== "down") throw err;
      });
    expect(await stateOf(awaitWriteOn(pipeline, key, undefined, "600"))).toBe(
      "rejected: down",
    );
  });
});
