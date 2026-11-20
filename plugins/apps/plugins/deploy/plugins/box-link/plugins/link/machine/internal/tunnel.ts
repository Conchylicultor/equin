import { rm } from "node:fs/promises";
import { lstat } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  classifyTunnelStderr,
  classifyTunnelStderrLine,
  materializeHermetic,
  sshTunnelArgv,
  tunnelFailureMessage,
  type HermeticHandle,
  type SshTarget,
} from "@plugins/infra/plugins/ssh/server";
import {
  tunnelFailureRetryable,
  type SshTunnelFailureKind,
} from "@plugins/infra/plugins/ssh/core";
import {
  defineDaemon,
  type DaemonTransition,
  type ProcessSpawnContext,
  type SupervisedDaemonInstance,
} from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import type { LinkDeployment } from "./targets";

/**
 * One SSH tunnel per server, forwarding one local socket per deployment to
 * its box gateway's loopback port. Main only (the real boxes are main's to
 * link); respawned forever, 2 s doubling to 2 min (`respawnNow` on a wake or
 * a Retry skips the wait). Ready = every forward's socket appeared — ssh
 * binds them only after it authenticated.
 */
export const boxLinkTunnelDaemon = defineDaemon({
  name: "deploy.box-link.tunnel",
  description:
    "Holds an SSH tunnel to a deployed site's server, so this computer hears its site live: one forward per site on that server, carrying the box link's stream.",
  startedBy: "boot",
  where: "main",
  restart: {
    kind: "backoff",
    healthy: "ready",
    giveUp: "never",
    minMs: 2_000,
    maxMs: 2 * 60_000,
  },
});

/** Hears a tunnel's sockets appear: the tunnel's ready signal. */
export const boxLinkSocketWatcher = defineFileWatcher({
  name: "deploy.box-link.tunnel-sockets",
  description:
    "Notices a box-link tunnel's local sockets appear, which is how the link knows ssh authenticated and its forwards are up.",
  extensions: [".sock"],
  debounceMs: 0,
  mainOnly: true,
});

/** What a tunnel tells its owner. */
export interface TunnelEvents {
  /** Every forward's socket is bound: the streams may connect. */
  ready(): void;
  /** An incarnation ended; the daemon respawns it. */
  lost(kind: SshTunnelFailureKind, message: string): void;
  /** ssh said something a respawn cannot fix: the tunnel is stopped for good. */
  refused(kind: SshTunnelFailureKind, message: string): void;
}

export interface Tunnel {
  /** Each deployment's local socket. */
  readonly sockets: ReadonlyMap<string, string>;
  /** Spawn now if no incarnation is alive (a wake, a Retry). No-op once refused. */
  respawnNow(): void;
  close(): Promise<void>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Open the tunnel to `target` carrying `deployments`. The hermetic scratch
 * dir (key, pinned known_hosts, sockets `d<n>.sock`) lives until `close()`
 * or a refusal — never per incarnation, since every respawn reuses it.
 */
export async function openTunnel(
  serverId: string,
  target: SshTarget,
  deployments: readonly LinkDeployment[],
  events: TunnelEvents,
): Promise<Tunnel> {
  const handle: HermeticHandle = await materializeHermetic(target);
  const sockets = new Map<string, string>(
    deployments.map((d, i) => [
      d.deploymentId,
      join(handle.dir, `d${String(i)}.sock`),
    ]),
  );
  const forwards = deployments.map((d) => ({
    localSocket: sockets.get(d.deploymentId)!,
    remotePort: d.loopbackPort,
  }));
  const argv = sshTunnelArgv(handle, forwards);

  let ctx: ProcessSpawnContext | null = null;
  let stderr: string[] = [];
  let finished = false;
  let instance: SupervisedDaemonInstance | null = null;
  let watcher: FileWatcher | null = null;

  async function finish(): Promise<void> {
    if (finished) return;
    finished = true;
    ctx = null;
    await instance?.stop();
    await watcher?.stop();
    await handle.dispose();
  }

  function refuse(kind: SshTunnelFailureKind, message: string): void {
    if (finished) return;
    void runTracked("box-link: stop a refused tunnel", finish);
    events.refused(kind, message);
  }

  /** Ready once every socket is bound by the live incarnation. */
  async function checkReady(): Promise<void> {
    const pending = ctx;
    if (pending === null) return;
    for (const path of sockets.values()) {
      if (!(await exists(path))) return;
    }
    if (ctx !== pending) return;
    ctx = null;
    pending.ready();
    events.ready();
  }

  function onState(t: DaemonTransition): void {
    if (
      t.state !== "respawning" &&
      t.state !== "exited" &&
      t.state !== "gave-up"
    ) {
      return;
    }
    ctx = null;
    const text = stderr.join("\n");
    stderr = [];
    // The dead incarnation's sockets go before the next binds, so the next
    // appearance is the next incarnation's.
    void runTracked("box-link: clear a dead tunnel's sockets", async () => {
      for (const path of sockets.values()) await rm(path, { force: true });
    });
    const kind = classifyTunnelStderr(text);
    const message = tunnelFailureMessage(kind, text);
    if (!tunnelFailureRetryable(kind)) refuse(kind, message);
    else events.lost(kind, message);
  }

  try {
    watcher = await boxLinkSocketWatcher.start({
      dirs: [handle.dir],
      label: serverId,
      onChange: () => checkReady(),
    });
    instance = boxLinkTunnelDaemon.spawnProcess({
      instance: serverId,
      argv,
      onStderrLine: (line) => {
        stderr.push(line);
        // A forbidden forward does not end ssh: it says so per connection.
        const kind = classifyTunnelStderrLine(line);
        if (kind !== null && !tunnelFailureRetryable(kind)) {
          refuse(kind, tunnelFailureMessage(kind, line));
        }
      },
      onSpawn: (spawned) => {
        ctx = spawned;
        // The sockets may have been bound before this incarnation was handed
        // over (a dead one's were removed at its exit, so any found are its).
        void runTracked("box-link: check a fresh tunnel's sockets", checkReady);
      },
      onState,
    });
  } catch (err) {
    await finish();
    throw err;
  }

  return {
    sockets,
    respawnNow() {
      if (finished || instance === null) return;
      instance.respawnNow();
    },
    close: finish,
  };
}
