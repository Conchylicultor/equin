import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import {
  isMain,
  runtimeNamespace,
} from "@plugins/infra/plugins/runtime-identity/core";
import { namespaceUrl } from "@plugins/infra/plugins/namespace/core";
import { servedGatewayPort } from "@plugins/infra/plugins/launcher/plugins/gateway-port/core";
import {
  onSleepReadingChanged,
  sleptDuring,
} from "@plugins/infra/plugins/host/plugins/machine-sleep/server";
import { armAwakeDeadline } from "@plugins/packages/plugins/deadline/core";
import {
  latestDeployRun,
  onDeployRunChanged,
} from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import type {
  BoxLink,
  LinkRefusal,
} from "@plugins/apps/plugins/deploy/plugins/box-link/core";
import type { SshTunnelFailureKind } from "@plugins/infra/plugins/ssh/core";
import {
  initialLink,
  linkStateChanged,
  reduceLink,
  type LinkEnv,
  type LinkEvent,
} from "../../shared/reducer";
import {
  onLinkTargetsChanged,
  readKeptBoxLinks,
  writeBoxLinkState,
  type KeptBoxLink,
} from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/link/server";
import {
  readLinkTargets,
  type LinkDeployment,
  type LinkTarget,
} from "./targets";
import { openTunnel, type Tunnel } from "./tunnel";
import {
  createStreamClient,
  type StreamClient,
  type StreamFailure,
  type StreamTransport,
} from "./stream-client";
import { createTunnelEvidence, type TunnelEvidence } from "./tunnel-evidence";
import { dispatchBoxHello, dispatchBoxSignal } from "../../shared/signals";
import { dropLink, linkOf, linkedDeploymentIds, setLink } from "./store";
import { boxLinksServed, siteHealthServed } from "./served";

// The driver of every link this instance holds: it opens what the targets
// say (one tunnel per real server, one stream client per deployment), turns
// what the tunnels and streams report into the reducer's events, keeps the
// records (store), pushes the two live values and persists a state change.
// Every reaction is push-based: the targets' NOTIFY, the tunnel's daemon
// transitions and socket watch, the stream's frames, a wake, a deploy run.

/** One server's links: how its deployments are reached, and their streams. */
interface ServerEntry {
  target: LinkTarget;
  /** The SSH tunnel (`ssh` targets only); `null` once it refused. */
  tunnel: Tunnel | null;
  streams: Map<string, StreamClient>;
  /** What the tunnel's live incarnation showed of itself (`ssh` targets). */
  evidence: TunnelEvidence;
}

const servers = new Map<string, ServerEntry>();
/** Servers a Retry asked to reopen whatever their target says. */
const forceReopen = new Set<string>();
const graceTimers = new Map<string, { until: number; cancel: () => void }>();
const persistLock = createKeyedMutex();
let kept = new Map<string, KeptBoxLink>();
let stops: (() => void)[] = [];
let started = false;

// ── records ────────────────────────────────────────────────────────────────

function envOf(prev: BoxLink, at: number): LinkEnv {
  return {
    sleptMs: sleptDuring(prev.lastHeardAt ?? prev.since, at),
    deployRunning: latestDeployRun(prev.deploymentId)?.status === "running",
  };
}

/** The ONE way a link's record changes. */
function dispatch(deploymentId: string, ev: LinkEvent): void {
  const prev = linkOf(deploymentId);
  if (prev === undefined) return; // dropped meanwhile
  const needsEnv =
    ev.kind === "failure" || ev.kind === "grace-check" || ev.kind === "wake";
  const env: LinkEnv = needsEnv
    ? envOf(prev, ev.at)
    : { sleptMs: null, deployRunning: false };
  const next = reduceLink(prev, ev, env);
  if (next === prev) return;
  setLink(next);
  boxLinksServed.notify();
  if (linkStateChanged(prev.state, next.state)) {
    persist(deploymentId);
    siteHealthServed.notify();
  }
  armGrace(next);
}

function armGrace(link: BoxLink): void {
  const id = link.deploymentId;
  const current = graceTimers.get(id);
  if (link.state.kind !== "reconnecting") {
    current?.cancel();
    graceTimers.delete(id);
    return;
  }
  const until = link.state.graceUntil;
  if (current?.until === until) return;
  current?.cancel();
  graceTimers.set(id, {
    until,
    cancel: armAwakeDeadline(Math.max(0, until - Date.now()), () => {
      graceTimers.delete(id);
      dispatch(id, { kind: "grace-check", at: Date.now() });
    }),
  });
}

/** Write the link's CURRENT record (so writes landing out of order cannot regress it). */
function persist(deploymentId: string): void {
  void runTracked("box-link: persist a link's state", () =>
    persistLock.run(deploymentId, async () => {
      const link = linkOf(deploymentId);
      if (link === undefined) return;
      await writeBoxLinkState(link);
    }),
  );
}

// ── servers ────────────────────────────────────────────────────────────────

function sameTarget(a: LinkTarget, b: LinkTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "ssh" && b.kind === "ssh") return a.signature === b.signature;
  if (a.kind === "blocked" && b.kind === "blocked" && a.reason !== b.reason)
    return false;
  return JSON.stringify(a.deployments) === JSON.stringify(b.deployments);
}

/** Through this instance's own gateway: a demo's stand-in box is this instance. */
const throughOwnGateway: StreamTransport = (path, signal) =>
  fetch(namespaceUrl(runtimeNamespace(), path, servedGatewayPort()), {
    signal,
  });

/** Through the tunnel's socket to the box gateway's loopback port. */
function throughSocket(socket: string, d: LinkDeployment): StreamTransport {
  return (path, signal) =>
    fetch(`http://127.0.0.1:${String(d.loopbackPort)}${path}`, {
      unix: socket,
      signal,
    });
}

function downFailure(deploymentId: string, error: string): void {
  dispatch(deploymentId, {
    kind: "failure",
    at: Date.now(),
    failure: "down",
    sshKind: null,
    error,
  });
}

/**
 * A stream's failure, on evidence: the box answered → `down`. With no answer
 * there is no tunnel to doubt on a stand-in (this instance's own gateway did
 * not answer: `down`); through a tunnel it is `down` only once ssh shows it
 * answered — until then it concludes nothing, and the tunnel's exit names it.
 */
function onStreamFailed(
  deploymentId: string,
  evidence: TunnelEvidence | null,
  f: StreamFailure,
): void {
  if (f.answered || evidence === null) {
    evidence?.heard(deploymentId);
    downFailure(deploymentId, f.error);
    return;
  }
  if (evidence.unanswered(deploymentId, f.startedAt, f.error) === "down") {
    downFailure(deploymentId, f.error);
    return;
  }
  dispatch(deploymentId, {
    kind: "unanswered",
    at: Date.now(),
    error: f.error,
  });
}

function streamFor(
  deploymentId: string,
  transport: StreamTransport,
  evidence: TunnelEvidence | null,
): StreamClient {
  return createStreamClient(deploymentId, transport, {
    hello(frame) {
      evidence?.heard(deploymentId);
      const hello = {
        buildId: frame.buildId,
        startedAt: frame.startedAt,
        v: frame.v,
      };
      dispatch(deploymentId, { kind: "hello", at: Date.now(), hello });
      if (linkOf(deploymentId)?.state.kind === "live") {
        dispatchBoxHello(deploymentId, hello);
      }
    },
    beat(frame) {
      const { kind: _kind, ...beat } = frame;
      dispatch(deploymentId, { kind: "beat", at: Date.now(), beat });
    },
    signal(source, payload) {
      dispatch(deploymentId, { kind: "heard", at: Date.now() });
      dispatchBoxSignal(deploymentId, source, payload);
    },
    routeMissing(error) {
      dispatch(deploymentId, { kind: "route-missing", at: Date.now(), error });
    },
    failed(failure) {
      onStreamFailed(deploymentId, evidence, failure);
    },
  });
}

function refusalOf(kind: SshTunnelFailureKind): LinkRefusal {
  switch (kind) {
    case "auth":
    case "host-key-mismatch":
    case "forwarding-refused":
      return kind;
    case "dns":
    case "unreachable":
    case "timeout":
    case "disconnected":
    case "unknown":
      throw new Error(
        `box-link: a retryable ssh failure (${kind}) reported as refused`,
      );
  }
}

async function openServer(target: LinkTarget): Promise<void> {
  const at = Date.now();
  for (const d of target.deployments) {
    const existing = linkOf(d.deploymentId);
    if (existing === undefined) {
      setLink(
        initialLink(d.deploymentId, at, kept.get(d.deploymentId) ?? null),
      );
    } else {
      dispatch(d.deploymentId, { kind: "restart", at });
    }
  }
  const entry: ServerEntry = {
    target,
    tunnel: null,
    streams: new Map(),
    evidence: createTunnelEvidence(),
  };
  servers.set(target.serverId, entry);
  switch (target.kind) {
    case "stand-in":
      for (const d of target.deployments) {
        const stream = streamFor(d.deploymentId, throughOwnGateway, null);
        entry.streams.set(d.deploymentId, stream);
        stream.enable();
      }
      return;
    case "blocked":
      for (const d of target.deployments) {
        dispatch(d.deploymentId, {
          kind: "refused",
          at,
          reason: target.reason,
          error: null,
        });
      }
      return;
    case "ssh": {
      const ids = target.deployments.map((d) => d.deploymentId);
      const tunnel = await openTunnel(
        target.serverId,
        target.target,
        target.deployments,
        {
          ready() {
            entry.evidence.reset();
            for (const s of entry.streams.values()) {
              s.enable();
              s.kick();
            }
          },
          answered() {
            for (const { deploymentId, error } of entry.evidence.sshAnswered(
              Date.now(),
            )) {
              downFailure(deploymentId, error);
            }
          },
          lost(kind, message) {
            entry.evidence.reset();
            for (const s of entry.streams.values()) s.disable();
            for (const id of ids) {
              dispatch(id, {
                kind: "failure",
                at: Date.now(),
                failure: "unreachable",
                sshKind: kind,
                error: message,
              });
            }
          },
          refused(kind, message) {
            entry.tunnel = null;
            for (const s of entry.streams.values()) s.disable();
            for (const id of ids) {
              dispatch(id, {
                kind: "refused",
                at: Date.now(),
                reason: refusalOf(kind),
                error: message,
              });
            }
          },
        },
      );
      entry.tunnel = tunnel;
      for (const d of target.deployments) {
        const socket = tunnel.sockets.get(d.deploymentId)!;
        entry.streams.set(
          d.deploymentId,
          streamFor(d.deploymentId, throughSocket(socket, d), entry.evidence),
        );
      }
      return;
    }
  }
}

async function closeServer(serverId: string): Promise<void> {
  const entry = servers.get(serverId);
  if (entry === undefined) return;
  servers.delete(serverId);
  for (const s of entry.streams.values()) s.disable();
  await entry.tunnel?.close();
}

/** Bring what is open in line with what the targets say. */
const reconcile = createCoalescer({
  name: "box-link.reconcile",
  async run() {
    if (!started) return;
    const targets = await readLinkTargets({ realBoxes: isMain() });
    const wanted = new Map(targets.map((t) => [t.serverId, t]));
    for (const [serverId, entry] of [...servers]) {
      const t = wanted.get(serverId);
      if (
        t === undefined ||
        !sameTarget(entry.target, t) ||
        forceReopen.has(serverId)
      ) {
        await closeServer(serverId);
      }
    }
    forceReopen.clear();
    const linked = new Set(
      targets.flatMap((t) => t.deployments.map((d) => d.deploymentId)),
    );
    let dropped = false;
    for (const id of linkedDeploymentIds()) {
      if (linked.has(id)) continue;
      graceTimers.get(id)?.cancel();
      graceTimers.delete(id);
      dropped = dropLink(id) || dropped;
    }
    for (const t of targets) {
      if (!servers.has(t.serverId)) await openServer(t);
    }
    boxLinksServed.notify();
    if (dropped) siteHealthServed.notify();
  },
});

// ── reactions ──────────────────────────────────────────────────────────────

/** This computer woke: every link gets a fresh grace and reconnects now. */
function onWake(): void {
  const at = Date.now();
  for (const id of linkedDeploymentIds()) dispatch(id, { kind: "wake", at });
  for (const entry of servers.values()) {
    entry.tunnel?.respawnNow();
    for (const s of entry.streams.values()) s.kick();
  }
}

function streamOf(
  deploymentId: string,
): { entry: ServerEntry; stream: StreamClient | undefined } | null {
  for (const entry of servers.values()) {
    if (entry.target.deployments.some((d) => d.deploymentId === deploymentId)) {
      return { entry, stream: entry.streams.get(deploymentId) };
    }
  }
  return null;
}

/** A successful deploy run of an `outdated` box: it may serve the stream now. */
function onRun(run: { deploymentId: string; status: string }): void {
  if (run.status !== "succeeded") return;
  if (linkOf(run.deploymentId)?.state.kind !== "outdated") return;
  dispatch(run.deploymentId, { kind: "restart", at: Date.now() });
  streamOf(run.deploymentId)?.stream?.kick();
}

/** What a Retry did, for its endpoint. */
export type RetryOutcome = "retried" | "not-linked";

/**
 * Retry now: a refused or blocked server is reopened from its current
 * target (a fixed key, a new pin); otherwise the tunnel respawns without its
 * backoff and the stream reconnects. A sticky state (`refused`, `outdated`)
 * starts over as `connecting`; a live or retrying link is not reset.
 */
export async function retryLink(deploymentId: string): Promise<RetryOutcome> {
  const found = streamOf(deploymentId);
  const link = linkOf(deploymentId);
  if (found === null || link === undefined) return "not-linked";
  const kind = link.state.kind;
  if (kind === "refused" || kind === "outdated") {
    dispatch(deploymentId, { kind: "restart", at: Date.now() });
  }
  const { entry, stream } = found;
  if (
    entry.target.kind === "blocked" ||
    (entry.target.kind === "ssh" && entry.tunnel === null)
  ) {
    forceReopen.add(entry.target.serverId);
    await reconcile.run();
    return "retried";
  }
  entry.tunnel?.respawnNow();
  stream?.kick();
  return "retried";
}

// ── lifecycle ──────────────────────────────────────────────────────────────

/** Open every link this instance holds, and follow what changes them. */
export async function startBoxLinks(): Promise<void> {
  kept = await readKeptBoxLinks();
  started = true;
  stops = [
    await onLinkTargetsChanged(() => reconcile.trigger()),
    onSleepReadingChanged(onWake),
    onDeployRunChanged(onRun),
  ];
  await reconcile.run();
}

/** Close every tunnel and stream (the backend is stopping). */
export async function stopBoxLinks(): Promise<void> {
  started = false;
  for (const stop of stops) stop();
  stops = [];
  for (const { cancel } of graceTimers.values()) cancel();
  graceTimers.clear();
  for (const serverId of [...servers.keys()]) await closeServer(serverId);
}
