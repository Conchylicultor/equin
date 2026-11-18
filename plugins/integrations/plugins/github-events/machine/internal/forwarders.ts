import { randomBytes } from "node:crypto";
import { endpointPath } from "@plugins/infra/plugins/endpoints/server";
import { servedGatewayPort } from "@plugins/infra/plugins/launcher/plugins/gateway-port/core";
import { namespaceUrl } from "@plugins/infra/plugins/namespace/core";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import {
  defineDaemon,
  type DaemonInstance,
  type DaemonTransition,
} from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import {
  githubDeliveryEndpoint,
  type ForwarderState,
  type ForwarderStatus,
  type GitHubEventsStatus,
} from "../../core";
import { FORWARDED_EVENTS } from "./events";
import { forwardArgv, type GhTools } from "./gh";
import { signatureMatches } from "./signature";

/**
 * One `gh webhook forward --repo=<repo>` per watched repo: GitHub creates a
 * temporary hook on the repo and streams its deliveries to the forwarder over
 * a WebSocket, which posts each to main's delivery endpoint — nothing has to
 * be reachable from the internet. Main only, on the publisher (the plugin's
 * `onReady` decides).
 */
export const forwarderDaemon = defineDaemon({
  name: "github-events.forwarder",
  description:
    "`gh webhook forward` per watched GitHub repo: streams its workflow_run / workflow_job / release deliveries to main's /api/github-events/deliveries, signed with a secret minted per start. Main only, on the checkout that publishes releases.",
  startedBy: "boot",
  where: "main",
  restart: { kind: "backoff", healthy: "survival" },
});

interface Forwarder {
  /** The secret of the current start; `null` before the first spawn. */
  secret: string | null;
  status: ForwarderStatus;
  /** The forwarder's last stderr line — what a death is explained with. */
  lastLine: string | null;
}

type Setup =
  | { kind: "off" }
  | { kind: "not-set-up"; reason: string; fix: string | null }
  | { kind: "on" };

let setup: Setup = { kind: "off" };
const forwarders = new Map<string, Forwarder>();
const instances = new Map<string, DaemonInstance>();
const listeners = new Set<() => void>();

/** Call `fn` whenever the status changes. Returns the unsubscribe. */
export function onForwarderStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(): void {
  for (const fn of listeners) fn();
}

/** The status the health row reads. */
export function forwarderStatus(): GitHubEventsStatus {
  if (setup.kind !== "on") return setup;
  return {
    kind: "on",
    forwarders: [...forwarders.values()].map((f) => f.status),
  };
}

/** One repo's forwarder status, `null` when no forwarder runs for it. */
export function forwarderStatusOf(repo: string): ForwarderStatus | null {
  return forwarders.get(repo)?.status ?? null;
}

/** This backend runs no forwarder (not the publisher). */
export function markForwardersOff(): void {
  setup = { kind: "off" };
  changed();
}

/** The publisher cannot run forwarders: say why. */
export function markNotSetUp(reason: string, fix: string | null): void {
  setup = { kind: "not-set-up", reason, fix };
  changed();
}

function setState(
  repo: string,
  state: ForwarderState,
  detail: string | null,
): void {
  const f = forwarders.get(repo);
  if (f === undefined) return;
  f.status = { repo, state, detail, since: new Date().toISOString() };
  changed();
}

/** GitHub pinged `repo`'s forwarder: it is connected. */
export function markConnected(repo: string): void {
  setState(repo, "connected", null);
}

function onTransition(repo: string, t: DaemonTransition): void {
  const f = forwarders.get(repo);
  if (f === undefined) return;
  switch (t.state) {
    case "starting":
      setState(repo, "connecting", null);
      return;
    case "running":
      // Running is not connected: GitHub's ping says that.
      return;
    case "respawning":
      setState(repo, "reconnecting", f.lastLine ?? t.lastError);
      return;
    case "gave-up":
    case "exited":
      setState(repo, "failed", f.lastLine ?? t.lastError);
      return;
    case "stopped":
      return;
  }
}

/** The address main's backend receives deliveries on, through the gateway. */
function deliveryUrl(): string {
  return namespaceUrl(
    runtimeNamespace(),
    endpointPath(githubDeliveryEndpoint, {}),
    servedGatewayPort(),
  );
}

/** Start one forwarder per repo (idempotent per repo). */
export function startForwarders(
  tools: GhTools,
  repos: readonly string[],
): void {
  setup = { kind: "on" };
  const url = deliveryUrl();
  for (const repo of repos) {
    if (forwarders.has(repo)) continue;
    const forwarder: Forwarder = {
      secret: null,
      status: {
        repo,
        state: "connecting",
        detail: null,
        since: new Date().toISOString(),
      },
      lastLine: null,
    };
    forwarders.set(repo, forwarder);
    const instance = forwarderDaemon.spawnProcess({
      instance: repo,
      // Read at every spawn: each start signs with a secret of its own, so a
      // delivery from a forwarder that is gone no longer verifies.
      argv: () => {
        forwarder.secret = randomBytes(32).toString("hex");
        forwarder.lastLine = null;
        return forwardArgv({
          tools,
          repo,
          url,
          secret: forwarder.secret,
          events: FORWARDED_EVENTS,
        });
      },
      onStderrLine: (line) => {
        if (line.trim() !== "") forwarder.lastLine = line.trim();
      },
      onState: (t) => onTransition(repo, t),
    });
    instances.set(repo, instance);
  }
  changed();
}

/** Stop every forwarder: SIGTERM, so each deletes its hook on GitHub. */
export async function stopForwarders(): Promise<void> {
  const running = [...instances.values()];
  instances.clear();
  forwarders.clear();
  await Promise.all(running.map((i) => i.stop()));
  setup = { kind: "off" };
  changed();
}

/**
 * The repo whose forwarder signed `body`: the one whose current secret
 * verifies `header`. `null` when none does — not ours, or from a start that
 * is gone.
 */
export function repoSigning(
  body: Uint8Array,
  header: string | null,
): string | null {
  for (const [repo, f] of forwarders) {
    if (f.secret !== null && signatureMatches(f.secret, body, header))
      return repo;
  }
  return null;
}
