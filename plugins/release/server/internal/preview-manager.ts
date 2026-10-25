import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  teardownSelfContainedApp,
  gatewayPidFile,
} from "@plugins/infra/plugins/launcher/server";
import { defineDaemon } from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import {
  asNamespace,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import { _releaseRuns } from "./tables";
import { releaseLog } from "./release-log";
import { previews, releasePreviewsServed } from "./preview-state-resource";
import { releaseRunIdKind } from "@plugins/release/plugins/bundles/core";

/**
 * One release preview: a self-contained stack (gateway, backend, PgBouncer,
 * embedded Postgres) started detached by the artifact's `launch` bootstrap,
 * which exits right after boot — so the daemon follows the stack's gateway by
 * its pid file. Never restarted: a dead preview is started again by hand.
 */
export const releasePreviewDaemon = defineDaemon({
  name: "release.preview",
  description:
    "A local preview of a finished release: the artifact's whole self-contained stack (gateway, backend, PgBouncer, embedded Postgres) running isolated beside the dev environment on its own ports, until it is stopped.",
  startedBy: "on-demand",
  where: "every-worktree",
  restart: { kind: "never" },
});

// Never collide with the dev gateway (9000) or the baked release port (9100).
const PREVIEW_PORT_FLOOR = 9101;
// Per-instance embedded-PG port floor. PG binds no TCP listener, but the port
// still names its Unix socket file and defaults to the dev cluster's 5433, so
// each preview gets a free port from here up.
const PREVIEW_PG_PORT_FLOOR = 5500;
// Where preview data roots live. Literal `/tmp` (NOT os.tmpdir(), the long
// /var/folders/... path on macOS): the embedded PG/gateway open Unix sockets under
// this root, capped at 104 bytes, so the prefix must be short.
const PREVIEW_TMP_DIR = "/tmp";
const PREVIEW_DIR_PREFIX = "sgp-";

/**
 * Probe upward from `from` for a free TCP port. Uses a connect attempt: a refused
 * connection means nothing is listening, so the port is free. Skips 9000/9100.
 */
async function pickFreePort(from: number): Promise<number> {
  for (let port = from; port < from + 500; port++) {
    if (port === 9000 || port === 9100) continue;
    const free = await new Promise<boolean>((resolve) => {
      const sock = connect({ host: "127.0.0.1", port });
      sock.once("connect", () => {
        sock.destroy();
        resolve(false); // something is listening → taken
      });
      sock.once("error", () => {
        sock.destroy();
        resolve(true); // connection refused → free
      });
    });
    if (free) return port;
  }
  throw new Error(`No free preview port found from ${from}`);
}

/**
 * Start a local preview of a finished release artifact. Spawns the staged
 * `launch` binary, which self-roots EQUIN_DIR under the data dir we hand it
 * and binds its embedded PG to the free `EQUIN_PG_PORT` we pick — so the
 * whole stack runs isolated alongside the dev environment. The data root MUST be
 * short because the embedded PG/gateway open Unix sockets under it (104-byte path
 * limit) — `/tmp/sgp-XXXXXX` is short by construction, the canonical mitigation.
 */
export async function startPreview(runId: string): Promise<void> {
  if (previews.get(runId)?.status === "running") return;

  const [run] = await db
    .select({
      composition: _releaseRuns.composition,
      status: _releaseRuns.status,
      artifactPath: _releaseRuns.artifactPath,
    })
    .from(_releaseRuns)
    .where(eq(_releaseRuns.id, releaseRunIdKind.key(runId)))
    .limit(1);

  if (!run) throw new Error(`No release run ${runId}`);
  if (run.status !== "succeeded" || !run.artifactPath) {
    throw new Error(`Release ${runId} is not a succeeded artifact`);
  }

  const port = await pickFreePort(PREVIEW_PORT_FLOOR);
  const pgPort = await pickFreePort(PREVIEW_PG_PORT_FLOOR);
  const dataRoot = mkdtempSync(join(PREVIEW_TMP_DIR, PREVIEW_DIR_PREFIX));

  // The composition comes off a DB row, and a preview listens on its own port.
  const url = namespaceUrl(asNamespace(run.composition), "", port);
  // The launcher's output goes to the release log so the UI surfaces preview
  // boot progress / socket errors.
  const daemon = releasePreviewDaemon.launchDetached({
    instance: runId,
    argv: [join(run.artifactPath, "launch")],
    env: {
      ...process.env,
      ...envEntries({ DIR: dataRoot }),
      // Loopback only (127.0.0.1 and [::1]), on the preview's own port. A
      // preview must pin its port: falling through to `manifest.port` would
      // bind every concurrent preview to the same one.
      ...envEntries({ LISTEN: `loopback:${port}`, PG_PORT: String(pgPort) }),
    },
    pidFile: gatewayPidFile(dataRoot),
    onOutputLine: (line, stream) => {
      releaseLog.publish(`[preview ${runId}] ${line}`, stream);
    },
  });

  previews.set(runId, {
    runId,
    daemon,
    port,
    pgPort,
    url,
    dataRoot,
    status: "running",
  });
  releaseLog.publish(
    `Preview ${runId} started on ${url} (pg :${pgPort}, data: ${dataRoot})`,
  );
  releasePreviewsServed.notify();
}

/**
 * Stop a running preview: tear down its entire self-contained stack (gateway,
 * backend, PgBouncer, embedded PG — all detached into their own sessions, so this
 * goes through the launcher's pidfile-based teardown rather than a process-group
 * kill), remove the data root, and drop it from the `release.previews` value.
 * Idempotent — a missing or already-dead preview is a no-op.
 */
export async function stopPreview(runId: string): Promise<void> {
  const entry = previews.get(runId);
  if (!entry) return;
  await teardownSelfContainedApp({
    root: entry.dataRoot,
    httpPort: entry.port,
    pgPort: entry.pgPort,
  });
  rmSync(entry.dataRoot, { recursive: true, force: true });
  await entry.daemon.stop();
  previews.delete(runId);
  releaseLog.publish(`Preview ${runId} stopped`);
  releasePreviewsServed.notify();
}

/**
 * Reap orphan previews on boot. Two passes:
 *   1. In-memory entries whose gateway died → drop and remove their data dir.
 *   2. Filesystem sweep: any leftover `/tmp/sgp-*` data root NOT backing an active
 *      entry is an orphan stack from a prior backend lifetime (the previews map is
 *      in-memory, so a dev restart leaves running gateways/PG holding ports with no
 *      record). Tear each down via the launcher and remove the dir.
 */
export async function reconcileOrphanPreviews(): Promise<void> {
  let changed = false;
  const activeRoots = new Set<string>();
  for (const [runId, entry] of previews) {
    // Keyed on the stack's LONG-LIVED gateway (the `launch` bootstrap exits
    // right after boot); a stack still booting reads `starting`, not dead.
    if (entry.daemon.state !== "exited") {
      activeRoots.add(entry.dataRoot);
      continue;
    }
    rmSync(entry.dataRoot, { recursive: true, force: true });
    await entry.daemon.stop();
    previews.delete(runId);
    changed = true;
  }

  let dirs: string[];
  try {
    dirs = readdirSync(PREVIEW_TMP_DIR).filter((n) =>
      n.startsWith(PREVIEW_DIR_PREFIX),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") dirs = [];
    else throw err;
  }
  for (const name of dirs) {
    const root = join(PREVIEW_TMP_DIR, name);
    if (activeRoots.has(root)) continue;
    // Ports unknown for an orphan dir — pidfile-based teardown suffices.
    await teardownSelfContainedApp({ root });
    rmSync(root, { recursive: true, force: true });
    releaseLog.publish(`Reaped orphan preview stack at ${root}`);
  }

  if (changed) releasePreviewsServed.notify();
}
