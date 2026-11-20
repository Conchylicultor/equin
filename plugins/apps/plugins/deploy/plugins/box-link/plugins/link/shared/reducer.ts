import {
  BOX_LINK_PROTOCOL_VERSION,
  type BoxBeat,
  type BoxHelloInfo,
  type BoxLink,
  type LinkFailureClass,
  type LinkRefusal,
  type LinkState,
  type ReconnectCause,
} from "@plugins/apps/plugins/deploy/plugins/box-link/core";
import type { SshTunnelFailureKind } from "@plugins/infra/plugins/ssh/core";

// The link's state machine, per deployment, as a PURE function: what the
// driver (`server/internal/link-manager.ts`) observed, plus the facts it read
// from the world at that instant (`LinkEnv`), in; the next record out. No
// clock, no I/O — every edge is table-tested (`reducer.test.ts`).

/** How long a lost link reads `reconnecting` before it settles on its class. */
export const LINK_GRACE_MS = 2 * 60_000;

/** Something the driver observed about one deployment's link, at `at` (epoch ms). */
export type LinkEvent =
  /** The stream's hello (its `v` judged here). */
  | { kind: "hello"; at: number; hello: BoxHelloInfo }
  /** A heartbeat. */
  | { kind: "beat"; at: number; beat: BoxBeat }
  /** Any other frame (a signal): the box is still talking. */
  | { kind: "heard"; at: number }
  /**
   * The link failed in a way a retry may fix: `down` (the tunnel is up, the
   * stream refused / 502 / closed / timed out) or `unreachable` (the SSH
   * transport failed, `sshKind` when ssh said why).
   */
  | {
      kind: "failure";
      at: number;
      failure: LinkFailureClass;
      sshKind: SshTunnelFailureKind | null;
      error: string;
    }
  /** A failure only the user can fix: nothing retries it. */
  | { kind: "refused"; at: number; reason: LinkRefusal; error: string | null }
  /** The box has no stream route (404). */
  | { kind: "route-missing"; at: number; error: string }
  /** The driver's grace timer: settle a `reconnecting` link whose grace ran out. */
  | { kind: "grace-check"; at: number }
  /** This computer woke from sleep. */
  | { kind: "wake"; at: number }
  /** The link is (re)started from scratch: a Retry, a changed target. */
  | { kind: "restart"; at: number };

/** What the driver read of the world when the event happened. */
export interface LinkEnv {
  /**
   * ms this computer slept between the box last being heard (or the state's
   * `since`, when it never was) and the event; `null` where the platform
   * cannot tell (read as "did not sleep").
   */
  sleptMs: number | null;
  /** A deploy run of this deployment is active (its box restarts as part of it). */
  deployRunning: boolean;
}

/** A link's first record: `connecting`, with what the side-table kept from before. */
export function initialLink(
  deploymentId: string,
  at: number,
  kept: Pick<
    BoxLink,
    "lastHeardAt" | "lastBeat" | "lastError" | "hello"
  > | null,
): BoxLink {
  return {
    deploymentId,
    state: { kind: "connecting" },
    since: at,
    lastHeardAt: kept?.lastHeardAt ?? null,
    lastBeat: kept?.lastBeat ?? null,
    lastError: kept?.lastError ?? null,
    hello: kept?.hello ?? null,
  };
}

function withState(prev: BoxLink, state: LinkState, at: number): BoxLink {
  return {
    ...prev,
    state,
    since: prev.state.kind === state.kind ? prev.since : at,
  };
}

/** The settled state a failure class stands for once no grace holds it. */
function settled(
  failure: LinkFailureClass,
  sshKind: SshTunnelFailureKind | null,
): LinkState {
  return failure === "down"
    ? { kind: "down" }
    : { kind: "unreachable", sshKind };
}

/** Why the link is being re-established, or `null` when nothing excuses the loss. */
function excuse(env: LinkEnv): ReconnectCause | null {
  if (env.deployRunning) return "restarting";
  if (env.sleptMs !== null && env.sleptMs > 0) return "slept";
  return null;
}

function onFailure(
  prev: BoxLink,
  ev: Extract<LinkEvent, { kind: "failure" }>,
  env: LinkEnv,
): BoxLink {
  const next = { ...prev, lastError: ev.error };
  const s = prev.state;
  // The user must act: a transport failure does not hide that.
  if (s.kind === "refused") return next;
  const cause = excuse(env);
  if (s.kind === "live" || s.kind === "reconnecting") {
    const inGrace = s.kind === "live" || ev.at < s.graceUntil;
    if (!inGrace && cause === null) {
      return withState(next, settled(ev.failure, ev.sshKind), ev.at);
    }
    const graceUntil =
      s.kind === "reconnecting" && inGrace
        ? s.graceUntil
        : ev.at + LINK_GRACE_MS;
    return withState(
      next,
      {
        kind: "reconnecting",
        // Once excused, the excuse names it; a plain loss is the network.
        cause: cause ?? (s.kind === "reconnecting" ? s.cause : "network"),
        graceUntil,
        then: ev.failure,
        sshKind: ev.failure === "unreachable" ? ev.sshKind : null,
      },
      ev.at,
    );
  }
  // Never live since it (re)started, or already settled: a deploy run
  // excuses the failure, a sleep excuses a first connect; otherwise it is
  // what it is, at once (a wake gives a settled link its grace — `wake`).
  if (
    cause === "restarting" ||
    (cause === "slept" && s.kind === "connecting")
  ) {
    return withState(
      next,
      {
        kind: "reconnecting",
        cause,
        graceUntil: ev.at + LINK_GRACE_MS,
        then: ev.failure,
        sshKind: ev.failure === "unreachable" ? ev.sshKind : null,
      },
      ev.at,
    );
  }
  return withState(next, settled(ev.failure, ev.sshKind), ev.at);
}

/** The next record of one deployment's link. */
export function reduceLink(
  prev: BoxLink,
  ev: LinkEvent,
  env: LinkEnv,
): BoxLink {
  switch (ev.kind) {
    case "hello": {
      const heard = { ...prev, lastHeardAt: ev.at, hello: ev.hello };
      if (ev.hello.v !== BOX_LINK_PROTOCOL_VERSION) {
        return withState(
          {
            ...heard,
            lastError: `the box speaks box-link protocol v${String(ev.hello.v)}, this computer v${String(BOX_LINK_PROTOCOL_VERSION)}`,
          },
          { kind: "outdated", reason: "protocol" },
          ev.at,
        );
      }
      return withState({ ...heard, lastError: null }, { kind: "live" }, ev.at);
    }
    case "beat":
      return { ...prev, lastHeardAt: ev.at, lastBeat: ev.beat };
    case "heard":
      return { ...prev, lastHeardAt: ev.at };
    case "failure":
      return onFailure(prev, ev, env);
    case "refused":
      return withState(
        { ...prev, lastError: ev.error ?? prev.lastError },
        { kind: "refused", reason: ev.reason },
        ev.at,
      );
    case "route-missing":
      return withState(
        { ...prev, lastError: ev.error },
        { kind: "outdated", reason: "route-missing" },
        ev.at,
      );
    case "grace-check": {
      const s = prev.state;
      if (s.kind !== "reconnecting" || ev.at < s.graceUntil) return prev;
      if (env.deployRunning) {
        return withState(
          prev,
          { ...s, cause: "restarting", graceUntil: ev.at + LINK_GRACE_MS },
          ev.at,
        );
      }
      return withState(prev, settled(s.then, s.sshKind), ev.at);
    }
    case "wake": {
      const s = prev.state;
      // A link lost before (or while) this computer slept may only be
      // waiting for the network to come back: give it a fresh grace.
      if (
        s.kind === "down" ||
        s.kind === "unreachable" ||
        s.kind === "reconnecting"
      ) {
        const then: LinkFailureClass =
          s.kind === "reconnecting" ? s.then : s.kind;
        const sshKind =
          s.kind === "unreachable" || s.kind === "reconnecting"
            ? s.sshKind
            : null;
        return withState(
          prev,
          {
            kind: "reconnecting",
            cause: "slept",
            graceUntil: ev.at + LINK_GRACE_MS,
            then,
            sshKind,
          },
          ev.at,
        );
      }
      return prev;
    }
    case "restart":
      return withState(prev, { kind: "connecting" }, ev.at);
  }
}

/**
 * Whether the side-table must be written: the state moved, not just a beat
 * or a later deadline. `graceUntil` is ignored (a deadline, not a state).
 */
export function linkStateChanged(a: LinkState, b: LinkState): boolean {
  const strip = (s: LinkState) =>
    s.kind === "reconnecting" ? { ...s, graceUntil: 0 } : s;
  return JSON.stringify(strip(a)) !== JSON.stringify(strip(b));
}
