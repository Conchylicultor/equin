import { describe, expect, test } from "bun:test";
import type {
  BoxLink,
  LinkState,
} from "@plugins/apps/plugins/deploy/plugins/box-link/core";
import {
  LINK_GRACE_MS,
  initialLink,
  linkStateChanged,
  reduceLink,
  type LinkEnv,
  type LinkEvent,
} from "./reducer";

const T0 = 1_000_000;
const quiet: LinkEnv = { sleptMs: 0, deployRunning: false };
const slept: LinkEnv = { sleptMs: 60_000, deployRunning: false };
const deploying: LinkEnv = { sleptMs: 0, deployRunning: true };

function linkIn(state: LinkState, since = T0): BoxLink {
  return { ...initialLink("dpl-1", since, null), state };
}

const live = linkIn({ kind: "live" });
type Reconnecting = Extract<LinkState, { kind: "reconnecting" }>;
const reconnecting = (
  graceUntil: number,
  then: "down" | "unreachable" = "down",
): Reconnecting => ({
  kind: "reconnecting",
  cause: "network",
  graceUntil,
  then,
  sshKind: null,
});

const down = (at: number): LinkEvent => ({
  kind: "failure",
  at,
  failure: "down",
  sshKind: null,
  error: "HTTP 502",
});
const unreachable = (at: number): LinkEvent => ({
  kind: "failure",
  at,
  failure: "unreachable",
  sshKind: "timeout",
  error: "ssh: connect timed out",
});

describe("reduceLink", () => {
  const cases: {
    name: string;
    prev: BoxLink;
    ev: LinkEvent;
    env: LinkEnv;
    expect: LinkState;
  }[] = [
    {
      name: "hello on a connecting link → live",
      prev: linkIn({ kind: "connecting" }),
      ev: {
        kind: "hello",
        at: T0 + 1,
        hello: { v: 1, buildId: "abc", startedAt: 1 },
      },
      env: quiet,
      expect: { kind: "live" },
    },
    {
      name: "hello with an unsupported v → outdated (protocol)",
      prev: linkIn({ kind: "connecting" }),
      ev: {
        kind: "hello",
        at: T0 + 1,
        hello: { v: 2, buildId: null, startedAt: 1 },
      },
      env: quiet,
      expect: { kind: "outdated", reason: "protocol" },
    },
    {
      name: "live, lost (network) → reconnecting within grace",
      prev: live,
      ev: unreachable(T0 + 10),
      env: quiet,
      expect: {
        kind: "reconnecting",
        cause: "network",
        graceUntil: T0 + 10 + LINK_GRACE_MS,
        then: "unreachable",
        sshKind: "timeout",
      },
    },
    {
      name: "live, lost after a sleep → reconnecting (slept)",
      prev: live,
      ev: down(T0 + 10),
      env: slept,
      expect: {
        kind: "reconnecting",
        cause: "slept",
        graceUntil: T0 + 10 + LINK_GRACE_MS,
        then: "down",
        sshKind: null,
      },
    },
    {
      name: "live, stream ended while a deploy runs → reconnecting (restarting)",
      prev: live,
      ev: down(T0 + 10),
      env: deploying,
      expect: {
        kind: "reconnecting",
        cause: "restarting",
        graceUntil: T0 + 10 + LINK_GRACE_MS,
        then: "down",
        sshKind: null,
      },
    },
    {
      name: "a failure inside the grace keeps its deadline, takes the new class",
      prev: linkIn(reconnecting(T0 + 100)),
      ev: unreachable(T0 + 50),
      env: quiet,
      expect: { ...reconnecting(T0 + 100, "unreachable"), sshKind: "timeout" },
    },
    {
      name: "a failure past the grace, nothing excusing it → down",
      prev: linkIn(reconnecting(T0 + 100)),
      ev: down(T0 + 100),
      env: quiet,
      expect: { kind: "down" },
    },
    {
      name: "a failure past the grace while a deploy runs → a fresh grace",
      prev: linkIn(reconnecting(T0 + 100)),
      ev: down(T0 + 200),
      env: deploying,
      expect: {
        kind: "reconnecting",
        cause: "restarting",
        graceUntil: T0 + 200 + LINK_GRACE_MS,
        then: "down",
        sshKind: null,
      },
    },
    {
      name: "grace-check one ms early → unchanged",
      prev: linkIn(reconnecting(T0 + 100)),
      ev: { kind: "grace-check", at: T0 + 99 },
      env: quiet,
      expect: reconnecting(T0 + 100),
    },
    {
      name: "grace-check at the deadline → its class (down)",
      prev: linkIn(reconnecting(T0 + 100)),
      ev: { kind: "grace-check", at: T0 + 100 },
      env: quiet,
      expect: { kind: "down" },
    },
    {
      name: "grace-check at the deadline → its class (unreachable, ssh kind kept)",
      prev: linkIn({
        ...reconnecting(T0 + 100, "unreachable"),
        sshKind: "dns",
      }),
      ev: { kind: "grace-check", at: T0 + 100 },
      env: quiet,
      expect: { kind: "unreachable", sshKind: "dns" },
    },
    {
      name: "grace-check while a deploy still runs → extended, restarting",
      prev: linkIn(reconnecting(T0 + 100)),
      ev: { kind: "grace-check", at: T0 + 100 },
      env: deploying,
      expect: {
        ...reconnecting(T0 + 100 + LINK_GRACE_MS),
        cause: "restarting",
      },
    },
    {
      name: "connecting, the stream refused → down at once",
      prev: linkIn({ kind: "connecting" }),
      ev: down(T0 + 5),
      env: quiet,
      expect: { kind: "down" },
    },
    {
      name: "connecting, ssh unreachable → unreachable at once",
      prev: linkIn({ kind: "connecting" }),
      ev: unreachable(T0 + 5),
      env: quiet,
      expect: { kind: "unreachable", sshKind: "timeout" },
    },
    {
      name: "connecting just after a sleep → reconnecting (slept)",
      prev: linkIn({ kind: "connecting" }),
      ev: unreachable(T0 + 5),
      env: slept,
      expect: {
        kind: "reconnecting",
        cause: "slept",
        graceUntil: T0 + 5 + LINK_GRACE_MS,
        then: "unreachable",
        sshKind: "timeout",
      },
    },
    {
      name: "down, the stream refused again → still down",
      prev: linkIn({ kind: "down" }),
      ev: down(T0 + 5),
      env: quiet,
      expect: { kind: "down" },
    },
    {
      name: "down while a deploy runs → reconnecting (restarting)",
      prev: linkIn({ kind: "down" }),
      ev: down(T0 + 5),
      env: deploying,
      expect: {
        kind: "reconnecting",
        cause: "restarting",
        graceUntil: T0 + 5 + LINK_GRACE_MS,
        then: "down",
        sshKind: null,
      },
    },
    {
      name: "a refused key → refused",
      prev: live,
      ev: {
        kind: "refused",
        at: T0 + 5,
        reason: "auth",
        error: "Permission denied",
      },
      env: quiet,
      expect: { kind: "refused", reason: "auth" },
    },
    {
      name: "refused is sticky: a network failure does not hide it",
      prev: linkIn({ kind: "refused", reason: "forwarding-refused" }),
      ev: unreachable(T0 + 5),
      env: quiet,
      expect: { kind: "refused", reason: "forwarding-refused" },
    },
    {
      name: "a 404 → outdated (route-missing)",
      prev: linkIn({ kind: "connecting" }),
      ev: { kind: "route-missing", at: T0 + 5, error: "HTTP 404" },
      env: quiet,
      expect: { kind: "outdated", reason: "route-missing" },
    },
    {
      name: "wake on a down link → reconnecting (slept), fresh grace",
      prev: linkIn({ kind: "down" }),
      ev: { kind: "wake", at: T0 + 5 },
      env: quiet,
      expect: {
        kind: "reconnecting",
        cause: "slept",
        graceUntil: T0 + 5 + LINK_GRACE_MS,
        then: "down",
        sshKind: null,
      },
    },
    {
      name: "wake on a live link → unchanged",
      prev: live,
      ev: { kind: "wake", at: T0 + 5 },
      env: quiet,
      expect: { kind: "live" },
    },
    {
      name: "wake on a refused link → unchanged",
      prev: linkIn({ kind: "refused", reason: "auth" }),
      ev: { kind: "wake", at: T0 + 5 },
      env: quiet,
      expect: { kind: "refused", reason: "auth" },
    },
    {
      name: "restart (Retry) → connecting",
      prev: linkIn({ kind: "refused", reason: "auth" }),
      ev: { kind: "restart", at: T0 + 5 },
      env: quiet,
      expect: { kind: "connecting" },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(reduceLink(c.prev, c.ev, c.env).state).toEqual(c.expect);
    });
  }

  test("since moves with the state's kind, not within it", () => {
    const lost = reduceLink(live, down(T0 + 10), quiet);
    expect(lost.since).toBe(T0 + 10);
    const again = reduceLink(lost, unreachable(T0 + 20), quiet);
    expect(again.since).toBe(T0 + 10);
  });

  test("a beat keeps the meters and the last-heard instant, not the state", () => {
    const beat = {
      at: 5,
      seq: 0,
      host: {
        cpu: { busyPct: null, cores: 2, load1: 0.1 },
        mem: { used: 1, total: 2 },
        disk: { used: 1, total: 2 },
        uptimeSec: 9,
      },
    };
    const next = reduceLink(
      live,
      { kind: "beat", at: T0 + 15_000, beat },
      quiet,
    );
    expect(next.state).toEqual({ kind: "live" });
    expect(next.lastHeardAt).toBe(T0 + 15_000);
    expect(next.lastBeat).toEqual(beat);
  });

  test("a hello clears the last error; a failure records it", () => {
    const failed = reduceLink(live, down(T0 + 1), quiet);
    expect(failed.lastError).toBe("HTTP 502");
    const back = reduceLink(
      failed,
      {
        kind: "hello",
        at: T0 + 2,
        hello: { v: 1, buildId: null, startedAt: 1 },
      },
      quiet,
    );
    expect(back.lastError).toBeNull();
  });
});

describe("linkStateChanged", () => {
  test("a later grace deadline is not a change", () => {
    expect(linkStateChanged(reconnecting(1), reconnecting(2))).toBe(false);
  });
  test("a new cause is", () => {
    expect(
      linkStateChanged(reconnecting(1), { ...reconnecting(1), cause: "slept" }),
    ).toBe(true);
  });
});
