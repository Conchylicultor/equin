/**
 * Resolving `(composition, --server)` into everything both verbs act on, and the
 * ssh plumbing they act through. Split out of the command bodies because
 * `converge` and `ship` must resolve a target the SAME way — every refusal below
 * is one a half-done deploy would otherwise discover on the host.
 *
 * The two transports (HTTP to this checkout's backend for the deployment row,
 * the DB directly for the server + its health row) and the reason they differ
 * are documented on the command declaration, `../index.ts`.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, or } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  namespaceUrl,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import {
  REPO_ROOT,
  checkoutNamespace,
} from "@plugins/infra/plugins/paths/core";
import { openShortLivedClient } from "@plugins/database/plugins/admin/server";
import {
  _deployServers,
  getServerSshPrivateKey,
} from "@plugins/apps/plugins/deploy/plugins/servers/server";
import { serverHealth } from "@plugins/apps/plugins/deploy/plugins/health/server";
import { deployServerIdKind } from "@plugins/apps/plugins/deploy/plugins/servers/core";
import {
  DEFAULT_LOOPBACK_PORT,
  createDeployment,
  deriveInstall,
  listDeployments,
  type Deployment,
  type InstallLayout,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import {
  sshRun,
  sshUpload,
  type SshTarget,
} from "@plugins/infra/plugins/ssh/server";
import { isPlatformTag, type PlatformTag } from "@plugins/release/core";
import { assertCompositionName } from "@plugins/plugin-meta/plugins/composition/core";
import { callEndpoint } from "@plugins/infra/plugins/endpoints/server";
import { EndpointError } from "@plugins/infra/plugins/endpoints/core";

// ── Budgets ───────────────────────────────────────────────────────────────────
//
// `sshRun`'s 15s default is a reachability probe's budget. Each of these is a
// bound on a DIFFERENT external wait, so they are separate constants rather
// than one shared "ssh timeout": the dial itself stays tightly bounded inside
// the ssh primitive regardless, so a dead host still fails fast under any of
// them.

/** A single short remote command (mkdir, readlink, curl one URL). */
export const SSH_SHORT_MS = 30_000;
/** The whole converge script: `apt-get update` + a Caddy install on a cold box. */
export const CONVERGE_MS = 15 * 60_000;
/** One ~100MB+ bundle over a domestic uplink. */
export const UPLOAD_MS = 30 * 60_000;
/**
 * The activate script, INCLUDING the health gate below — so this must exceed
 * `READY_ATTEMPTS × READY_INTERVAL_SEC` (a bundle's first run extracts ~200MB
 * and initdb's a Postgres cluster) or the ssh deadline would kill the script
 * mid-gate, i.e. after the flip and before the revert.
 */
export const ACTIVATE_MS = 20 * 60_000;

/** Health-gate bound: attempts × interval is the whole "not up yet" window. */
export const READY_ATTEMPTS = 150;
export const READY_INTERVAL_SEC = 4;

/**
 * A named refusal: the user's problem, stated once, with no stack trace. Every
 * guard in this file exits through here, so "the command refused" and "the
 * command crashed" stay visibly different things.
 */
export function refuse(message: string): never {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

// ── Which namespace this command acts on ──────────────────────────────────────
//
// The CHECKOUT's own namespace, minted from git — not a runtime namespace. This
// is a CLI process: it declares no runtime namespace, and the value it wants is
// "which app does the checkout I was invoked from own", which is exactly what
// `checkoutNamespace` answers. It used to read the environment, which answered
// `singularity` from every worktree — so a deploy launched from a worktree read
// main's deployment rows and main's server registry.
//
// Memoized because it costs one `git` spawn and is asked on every endpoint call.
let namespacePromise: Promise<Namespace> | undefined;
export function deployNamespace(): Promise<Namespace> {
  namespacePromise ??= checkoutNamespace(REPO_ROOT);
  return namespacePromise;
}

// ── Resolution ────────────────────────────────────────────────────────────────

type ServerRow = typeof _deployServers.$inferSelect;

/** Everything both verbs need, resolved once, with every refusal already made. */
export interface DeployTarget {
  deployment: Deployment;
  server: ServerRow;
  /** DISCOVERED by the health probe — never a flag, never a stored field. */
  platform: PlatformTag;
  install: InstallLayout;
  privateKey: string;
  /** TOFU-pinned `known_hosts` line from the last successful probe. */
  knownHostsLine: string;
}

/** One short-lived pool against this namespace's DB, released in `finally`. */
async function withDb<T>(fn: (db: NodePgDatabase) => Promise<T>): Promise<T> {
  const pool = openShortLivedClient(await deployNamespace());
  try {
    return await fn(drizzle(pool));
  } finally {
    await pool.end();
  }
}

/** This checkout's own backend, through the gateway. */
async function backendBase(): Promise<string> {
  return namespaceUrl(await deployNamespace());
}

/**
 * One request to this namespace's backend (`callEndpoint`, so the method, path,
 * body and answer come off the contract). A non-2xx carries the server's own
 * message through verbatim — those messages (unknown composition, duplicate
 * deployment, port taken) are the validation this transport exists to keep as
 * the single writer.
 */
async function toBackend<T>(send: (origin: string) => Promise<T>): Promise<T> {
  const origin = await backendBase();
  try {
    return await send(origin);
  } catch (err) {
    if (err instanceof TypeError) {
      return refuse(
        `cannot reach ${origin} — the "${await deployNamespace()}" backend is not serving. ` +
          `Run \`./singularity build\` first; deploy reads its deployment records from it.`,
      );
    }
    if (err instanceof EndpointError) return refuse(err.message);
    throw err;
  }
}

/**
 * The deployment row for `(composition, server)`, created with defaults when
 * absent — via the endpoint, so the composition name is validated and the two
 * unique constraints are enforced by the DB that owns them.
 */
async function ensureDeployment(
  compositionId: string,
  serverId: string,
): Promise<Deployment> {
  const existing = (
    await toBackend((origin) => callEndpoint(listDeployments, {}, { origin }))
  ).find((d) => d.compositionId === compositionId && d.serverId === serverId);
  if (existing) return existing;

  console.log(
    `  • no deployment for "${compositionId}" on this server — creating one ` +
      `(no hostnames, loopback port ${DEFAULT_LOOPBACK_PORT})`,
  );
  return toBackend((origin) =>
    callEndpoint(
      createDeployment,
      {},
      { origin, body: { compositionId, serverId } },
    ),
  );
}

/**
 * Resolve `--server` to one registered server. Documented as an id because that
 * is the identity, but a NAME is accepted too: nobody types an `srv-…` id.
 * Ambiguity is a refusal, never a silent first-match.
 */
async function resolveServer(
  db: NodePgDatabase,
  ref: string,
): Promise<ServerRow> {
  const rows = await db
    .select()
    .from(_deployServers)
    .where(
      or(
        eq(_deployServers.id, deployServerIdKind.key(ref)),
        eq(_deployServers.name, ref),
      ),
    );
  if (rows.length === 1) return rows[0]!;
  if (rows.length > 1) {
    refuse(
      `"${ref}" matches ${rows.length} servers (${rows.map((r) => r.id).join(", ")}) — pass the id.`,
    );
  }
  const all = await db.select().from(_deployServers);
  refuse(
    all.length === 0
      ? `no servers are registered in the "${await deployNamespace()}" namespace. Add one in the Deploy app first.`
      : `no server matches "${ref}". Registered: ${all
          .map((r) => `${r.name} (${r.id})`)
          .join(", ")}`,
  );
}

/**
 * The platform, read off the server's health row — the four states of
 * `(ok, platform)` become four distinct refusals rather than one null check.
 * "Never probed" is a real state: it means we have never reached this box.
 */
function requirePlatform(
  server: ServerRow,
  health: typeof serverHealth.table.$inferSelect | undefined,
): PlatformTag {
  if (!health) {
    refuse(
      `server "${server.name}" has never been verified — run "Verify connection" on it in ` +
        `the Deploy app first. The platform a deploy needs is discovered by that probe.`,
    );
  }
  if (!health.ok) {
    refuse(
      `server "${server.name}" failed its last reachability check ` +
        `(${health.failureKind ?? "unknown"}: ${health.failureMessage ?? "no message"}). ` +
        `Fix it and run "Verify connection" again.`,
    );
  }
  if (health.platform === null) {
    refuse(
      `server "${server.name}" is reachable but reported a platform no release targets. ` +
        `Deploy supports only the platforms a bundle can be built for.`,
    );
  }
  if (!isPlatformTag(health.platform)) {
    refuse(
      `server "${server.name}" has an unrecognised recorded platform "${health.platform}" — ` +
        `run "Verify connection" again to refresh it.`,
    );
  }
  return health.platform;
}

export async function resolveTarget(opts: {
  composition: string;
  serverRef: string;
}): Promise<DeployTarget> {
  // The composition name becomes a unix user, a path segment, a systemd
  // instance and part of every remote path this file interpolates into a shell
  // script — so its shape is asserted with the canonical helper BEFORE it is
  // used anywhere, not trusted because a config held it.
  try {
    assertCompositionName(opts.composition);
  } catch (err) {
    refuse(err instanceof Error ? err.message : String(err));
  }

  const { server, health } = await withDb(async (db) => {
    const found = await resolveServer(db, opts.serverRef);
    const [row] = await db
      .select()
      .from(serverHealth.table)
      .where(eq(serverHealth.table.serverId, found.id));
    return { server: found, health: row };
  });

  const platform = requirePlatform(server, health);
  // A pin is what makes "this key reached THIS host" a fact; a successful probe
  // always learns one, so a missing pin is a state to fix, not to fall back on.
  if (health?.hostKeyLine == null) {
    refuse(
      `server "${server.name}" has no pinned SSH host key — run "Verify connection" again. ` +
        `Deploy will not connect with trust-on-first-use.`,
    );
  }

  const secret = await getServerSshPrivateKey(server.id);
  if (!secret.configured) {
    refuse(
      `no SSH key is configured for server "${server.name}" — generate one in the Deploy app first.`,
    );
  }

  const deployment = await ensureDeployment(opts.composition, server.id);
  return {
    deployment,
    server,
    platform,
    install: deriveInstall(opts.composition),
    privateKey: secret.privateKey,
    knownHostsLine: health.hostKeyLine,
  };
}

/** An `SshTarget` for this deployment, with the budget for ONE operation. */
export function sshTargetFor(
  target: DeployTarget,
  timeoutMs: number,
): SshTarget {
  return {
    host: target.server.host,
    port: target.server.port,
    user: target.server.sshUser,
    privateKey: target.privateKey,
    hostKey: { mode: "pinned", knownHostsLine: target.knownHostsLine },
    timeoutMs,
  };
}

/**
 * Run one remote command, refusing with OpenSSH's own diagnostic on failure.
 * Returns stdout so callers can read a value (`readlink`, `curl`) off it.
 */
export async function remote(
  target: DeployTarget,
  command: string[],
  opts: { timeoutMs: number; what: string },
): Promise<string> {
  const result = await sshRun(sshTargetFor(target, opts.timeoutMs), command);
  if (!result.ok) {
    refuse(
      `${opts.what} failed on ${target.server.name} (${result.kind}): ${result.message}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

/**
 * Upload a generated script to `/tmp` and run it with `bash`.
 *
 * The script is left on the box deliberately: it is overwritten by the next
 * converge/ship (so it cannot go stale), `/tmp` is transient, and after a
 * failure it is the exact thing an operator wants to read. A cleanup pass would
 * have to either swallow its own failure or mask the real one.
 */
export async function runScript(
  target: DeployTarget,
  opts: { script: string; remoteName: string; timeoutMs: number; what: string },
): Promise<void> {
  const localPath = join(tmpdir(), opts.remoteName);
  writeFileSync(localPath, opts.script, { mode: 0o700 });
  const remotePath = `/tmp/${opts.remoteName}`;

  const upload = await sshUpload(
    sshTargetFor(target, SSH_SHORT_MS),
    localPath,
    remotePath,
  );
  if (!upload.ok) {
    refuse(
      `uploading the ${opts.what} script to ${target.server.name} failed ` +
        `(${upload.kind}): ${upload.message}\n${upload.stderr}`,
    );
  }

  const result = await sshRun(sshTargetFor(target, opts.timeoutMs), [
    "bash",
    remotePath,
  ]);
  // Both scripts send ALL their progress to stderr (`exec 1>&2`), because
  // `sshRun`'s FAILURE result carries stderr only — on stdout the record of
  // what ran would be dropped on exactly the path where it matters most.
  if (result.ok) {
    if (result.stderr !== "") console.log(result.stderr.trimEnd());
    return;
  }
  refuse(
    `${opts.what} failed on ${target.server.name} (${result.kind}): ${result.message}\n` +
      `${result.stderr}\n(the script is left at ${remotePath} on the host)`,
  );
}
