import { describe, expect, test } from "bun:test";
import type { HostReach } from "./client";
import { createSocketDownWatch } from "./socket-down-watch";
import { createVisibleDeadlines } from "./visible-deadline";

const URL = "wss://equin.ai/ws/notifications";
const DOWN_MS = 15_000;
const RECOVERY_MS = 20_000;
const ANSWERED: HostReach = {
  kind: "answered",
  status: 200,
  health: { startedAt: 0 } as never,
};

// A hand-driven clock + timer queue, a host whose reachability the test sets,
// and the wedges the watch files.
function harness() {
  let now = 1_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let host: HostReach = ANSWERED;
  let probes = 0;
  const wedges: { at: number; status: string }[] = [];
  const deadlines = createVisibleDeadlines({
    now: () => now,
    isHidden: () => false,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
  });
  const watch = createSocketDownWatch({
    deadlines,
    downMs: DOWN_MS,
    recoveryMs: RECOVERY_MS,
    reach: () => {
      probes += 1;
      return Promise.resolve(host);
    },
    onWedge: (_url, status) => wedges.push({ at: now, status }),
  });
  // Advance in 1 s steps, letting each probe's answer settle.
  const advance = async (ms: number) => {
    for (let i = 0; i < ms / 1_000; i++) {
      now += 1_000;
      for (;;) {
        const due = [...timers].find(([, t]) => t.at <= now);
        if (!due) break;
        timers.delete(due[0]);
        due[1].fn();
      }
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return {
    watch,
    advance,
    wedges,
    probes: () => probes,
    setHost: (r: HostReach) => {
      host = r;
    },
  };
}

describe("socket-down watch", () => {
  test("a socket that stays down a whole recovery window after its host answered is a wedge", async () => {
    const h = harness();
    h.watch.status(URL, "reconnecting");
    await h.advance(15_000);
    expect(h.wedges).toEqual([]);
    expect(h.probes()).toBe(1);
    await h.advance(RECOVERY_MS - 1_000);
    expect(h.wedges).toEqual([]);
    await h.advance(1_000);
    // asked again at the end of the window: the host still answers
    expect(h.probes()).toBe(2);
    expect(h.wedges).toEqual([
      { at: 16_000 + RECOVERY_MS, status: "reconnecting" },
    ]);
  });

  // equin.ai 2026-11-19 05:13:18–05:13:38 UTC: a visitor's link dropped. The
  // health request hung and was answered the instant the link came back
  // (.281), 170 ms before the socket reopened (.450) — filed as socket-down.
  test("a socket that reopens once its host answers — the link came back — files nothing", async () => {
    const h = harness();
    h.watch.status(URL, "reconnecting");
    await h.advance(15_000); // the host answers: the link is back
    expect(h.probes()).toBe(1);
    await h.advance(1_000);
    h.watch.status(URL, "open");
    await h.advance(60_000);
    expect(h.wedges).toEqual([]);
    expect(h.probes()).toBe(1);
  });

  test("a link that drops again during the recovery window restarts the judgement", async () => {
    const h = harness();
    h.watch.status(URL, "reconnecting");
    await h.advance(15_000); // answered
    h.setHost({ kind: "no-answer" });
    await h.advance(RECOVERY_MS); // asked again: no answer
    expect(h.wedges).toEqual([]);
    expect(h.probes()).toBe(2);
    h.watch.status(URL, "open");
    await h.advance(60_000);
    expect(h.wedges).toEqual([]);
  });

  test("a socket that reopens within the window files nothing", async () => {
    const h = harness();
    h.watch.status(URL, "reconnecting");
    await h.advance(10_000);
    h.watch.status(URL, "open");
    await h.advance(30_000);
    expect(h.wedges).toEqual([]);
    expect(h.probes()).toBe(0);
  });

  // equin.ai 2026-11-18 00:31:32–00:35:16 UTC: the visitor's link dropped,
  // every handshake hung and every fetch failed for 3 m 44 s while the box
  // ran on; the socket reopened the moment the link came back.
  test("the visitor's network down (no answer from the host) files nothing", async () => {
    const h = harness();
    h.setHost({ kind: "no-answer" });
    h.watch.status(URL, "reconnecting");
    await h.advance(224_000);
    expect(h.wedges).toEqual([]);
    // judged once per window while the outage lasts — never a poll
    expect(h.probes()).toBe(Math.floor(224_000 / DOWN_MS));
    h.setHost(ANSWERED);
    h.watch.status(URL, "open");
    await h.advance(60_000);
    expect(h.wedges).toEqual([]);
  });

  test("a socket still down once the network is back is reported, one window later", async () => {
    const h = harness();
    h.setHost({ kind: "no-answer" });
    h.watch.status(URL, "reconnecting");
    await h.advance(40_000);
    expect(h.wedges).toEqual([]);
    h.setHost(ANSWERED); // the link is back, the socket is not
    await h.advance(DOWN_MS + RECOVERY_MS);
    expect(h.wedges.length).toBe(1);
    expect(h.wedges[0]!.at).toBeLessThanOrEqual(
      1_000 + 40_000 + DOWN_MS + RECOVERY_MS + 5_000,
    );
  });

  test("a host answering with an error status is reachable: the wedge files", async () => {
    const h = harness();
    h.setHost({ kind: "answered", status: 502, health: null });
    h.watch.status(URL, "connecting");
    await h.advance(DOWN_MS + RECOVERY_MS);
    expect(h.wedges).toEqual([
      { at: 16_000 + RECOVERY_MS, status: "connecting" },
    ]);
  });

  test("a socket that reopens while the host is being asked files nothing", async () => {
    let answer: (r: HostReach) => void = () => {};
    let now = 0;
    const timers: (() => void)[] = [];
    const wedges: string[] = [];
    const watch = createSocketDownWatch({
      deadlines: createVisibleDeadlines({
        now: () => now,
        isHidden: () => false,
        setTimeout: (fn) => timers.push(fn),
        clearTimeout: () => {},
      }),
      downMs: DOWN_MS,
      recoveryMs: RECOVERY_MS,
      reach: () => new Promise((resolve) => (answer = resolve)),
      onWedge: (_u, s) => wedges.push(s),
    });
    watch.status(URL, "reconnecting");
    now = DOWN_MS;
    timers.shift()!();
    watch.status(URL, "open");
    answer(ANSWERED);
    await Promise.resolve();
    await Promise.resolve();
    expect(wedges).toEqual([]);
  });

  test("a probe in flight across a reopen and a new drop judges nothing", async () => {
    let answer: (r: HostReach) => void = () => {};
    let now = 0;
    const timers: (() => void)[] = [];
    const wedges: string[] = [];
    const watch = createSocketDownWatch({
      deadlines: createVisibleDeadlines({
        now: () => now,
        isHidden: () => false,
        setTimeout: (fn) => timers.push(fn),
        clearTimeout: () => {},
      }),
      downMs: DOWN_MS,
      recoveryMs: RECOVERY_MS,
      reach: () => new Promise((resolve) => (answer = resolve)),
      onWedge: (_u, s) => wedges.push(s),
    });
    watch.status(URL, "reconnecting");
    now = DOWN_MS;
    timers.shift()!(); // the down window ends: the host is asked
    watch.status(URL, "open");
    watch.status(URL, "reconnecting"); // a new drop, its own window armed
    expect(timers.length).toBe(1);
    answer(ANSWERED); // the first episode's probe lands
    await Promise.resolve();
    await Promise.resolve();
    expect(wedges).toEqual([]);
    expect(timers.length).toBe(1); // no recovery window for the old episode
  });
});
