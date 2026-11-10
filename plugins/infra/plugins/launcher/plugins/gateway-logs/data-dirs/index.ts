import { defineDataDir } from "@plugins/infra/plugins/paths/core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// The gateway's log directory, in a leaf of its own: the database plugins the
// launcher boots name their daemons' log files here (`PG_LOG_FILE`,
// `PGBOUNCER_LOG_FILE`), and the launcher imports them, so the declaration
// cannot live in the launcher without a cycle. The `-log-dir` flag the gateway
// is handed is this directory.

/**
 * The subdir of {@link gatewayLogs} holding each supervised service's output
 * channel (`services/<service>.log`) — Postgres's and PgBouncer's stdout/stderr,
 * written by the gateway's per-start log relay (`gateway/logrelay.go`). A
 * subdir, so a service can never collide with a namespace's `<name>.log`.
 * Pinned to the Go constant by `gateway-logs:in-sync`.
 */
export const SERVICE_LOGS_SUBDIR = "services";

/**
 * The subdir of {@link gatewayLogs} holding the output of main's convergence
 * runs (`deploy/main.log`), which the gateway starts on every advance of
 * `refs/heads/main` (`gateway/main_deploy.go`). A subdir for the reason
 * `services/` is one: the boot sweep deletes a top-level `<name>.log` whose
 * namespace has no registry dir, and a namespace may take any name. Pinned to
 * the Go constant by `gateway-logs:in-sync`.
 */
export const DEPLOY_LOGS_SUBDIR = "deploy";

/**
 * The gateway's log directory: its own rotating slog sink (`gateway.log`), the
 * per-worktree channel logs it writes, and the raw stdout/stderr capture the
 * launcher opens for the daemon (`gateway-stdio.log`).
 *
 * Declared as its own entry rather than left to the bare `logs` kind: the kind
 * is a reclaim class, not an owner, and these files have one.
 */
export const gatewayLogs = defineDataDir({
  kind: "logs",
  name: "gateway",
  owner: "infra/launcher/gateway-logs",
  description:
    "Gateway daemon logs: its rotating slog sink, per-worktree channel logs, and the raw stdio capture",
  // Observability output. Losing it costs the record of a past boot, never
  // anything the running system needs.
  reclaim: { kind: "safe" },
  // First match wins: the stdio capture before the channel family.
  logs: [
    {
      pattern: "gateway-stdio.log",
      bound: {
        kind: "truncate-on-start",
        reason:
          "the daemon's raw stdout/stderr: emptied by `./equin start` and by the login service's install, and only a Go panic or a pre-logging crash lands here",
      },
    },
    // gateway.log and each namespace's channel (deleted with the namespace).
    { pattern: "*.log", bound: { kind: "gateway-rotating" } },
    // Each supervised service's output, through the log relay.
    {
      pattern: `${SERVICE_LOGS_SUBDIR}/*.log`,
      bound: { kind: "gateway-rotating" },
    },
    // Main's convergence runs. Written by the run itself through a descriptor
    // the gateway opens (so it outlives the gateway), hence not the rotating
    // writer: the gateway rotates it before starting a run.
    {
      pattern: `${DEPLOY_LOGS_SUBDIR}/*.log`,
      bound: {
        kind: "rotates-itself",
        how: "the gateway renames it to <file>.1 before starting a run once it is past mainDeployLogMax (16 MB), so at most two files of ~16 MB plus one run",
      },
    },
  ],
});

/**
 * Every gateway channel's bound (`gateway/logwriter.go` `maxLogBytes` /
 * `maxLogBackups`): the live file rotates at `maxBytes`, `keep` rotations kept.
 * Pinned to the Go constants by `gateway-logs:in-sync`.
 */
export const GATEWAY_LOG_BOUND = { maxBytes: 50 * 1024 * 1024, keep: 5 };

/** A supervised service's output channel, inside {@link gatewayLogs}. */
export function serviceLogFile(service: string): AppPath {
  return gatewayLogs.file(SERVICE_LOGS_SUBDIR, `${service}.log`);
}

export {
  adoptLegacyLogSync,
  type LegacyLogAdoption,
} from "./internal/legacy-log";

export default [gatewayLogs];
