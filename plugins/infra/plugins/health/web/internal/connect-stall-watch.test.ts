import { describe, expect, test } from "bun:test";
import type { HostReach } from "./client";
import { createConnectStallWatch } from "./connect-stall-watch";

const URL = "wss://equin.ai/ws/notifications";
const ANSWERED: HostReach = { kind: "answered", status: 200, health: null };

function harness() {
  let now = 0;
  let host: HostReach = ANSWERED;
  const watch = createConnectStallWatch({
    now: () => now,
    reach: () => Promise.resolve(host),
  });
  return {
    watch,
    at: (t: number) => {
      now = t;
    },
    setHost: (r: HostReach) => {
      host = r;
    },
  };
}

describe("connect-stall watch", () => {
  // equin.ai 2026-11-19 05:21:47–05:22:02 UTC: attempt 3 was dialed into the
  // visitor's dead link; its health check was answered as the link came back.
  test("a stall dialed before the host was shown answering files nothing", async () => {
    const h = harness();
    h.at(15_000);
    expect(await h.watch.stalled(URL, 0)).toBeNull();
  });

  test("the next attempt opening — the link was the visitor's — files nothing", async () => {
    const h = harness();
    h.at(15_000);
    expect(await h.watch.stalled(URL, 0)).toBeNull();
    h.watch.opened(URL);
    // a later, unrelated stall starts over: dialed before any answer since
    h.at(100_000);
    expect(await h.watch.stalled(URL, 85_000)).toBeNull();
  });

  test("an attempt dialed after the host answered that stalls too is established", async () => {
    const h = harness();
    h.at(15_000);
    expect(await h.watch.stalled(URL, 0)).toBeNull();
    h.at(37_000);
    expect(await h.watch.stalled(URL, 22_000)).toEqual({
      reach: ANSWERED as Extract<HostReach, { kind: "answered" }>,
      hostAnsweredAt: 15_000,
    });
  });

  test("a stall whose host gives no answer is the visitor's network and forgets the earlier answer", async () => {
    const h = harness();
    h.at(15_000);
    await h.watch.stalled(URL, 0);
    h.setHost({ kind: "no-answer" });
    h.at(37_000);
    expect(await h.watch.stalled(URL, 22_000)).toBeNull();
    h.setHost(ANSWERED);
    h.at(59_000);
    // dialed after the answer the outage voided: the link is unproven again
    expect(await h.watch.stalled(URL, 44_000)).toBeNull();
    h.at(81_000);
    expect(await h.watch.stalled(URL, 66_000)).not.toBeNull();
  });

  test("an attempt dialed before the first answer never counts, even after one", async () => {
    const h = harness();
    h.at(15_000);
    await h.watch.stalled(URL, 0);
    // a second attempt that was already in flight when the host answered
    h.at(20_000);
    expect(await h.watch.stalled(URL, 5_000)).toBeNull();
  });

  test("a probe answered after the socket opened records nothing", async () => {
    let answer: (r: HostReach) => void = () => {};
    let now = 0;
    const watch = createConnectStallWatch({
      now: () => now,
      reach: () => new Promise((resolve) => (answer = resolve)),
    });
    now = 15_000;
    const first = watch.stalled(URL, 0);
    watch.opened(URL); // the link came back: the next attempt opened
    answer(ANSWERED); // the probe held through the outage lands after
    expect(await first).toBeNull();
    // much later, an attempt dialed into a new outage
    now = 500_000;
    const second = watch.stalled(URL, 485_000);
    answer(ANSWERED);
    expect(await second).toBeNull();
  });
});
