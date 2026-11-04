/**
 * How a supervised service's start command learns where its daemon's output
 * goes. The gateway's supervisor appends `--log-fd <n>` to the start command
 * (`gateway/logrelay.go`) and hands it fd `<n>`, the write end of a detached
 * log relay's pipe; the start script gives that fd to the daemon as
 * stdout/stderr, so the daemon never owns a log file — its log is bounded by
 * the relay's rotating writer. On argv, not in the environment: the daemon
 * would inherit an environment variable for its whole life.
 *
 * Pinned to the Go constant by `gateway-logs:in-sync`.
 */
export const SERVICE_LOG_FD_FLAG = "--log-fd";

/**
 * Where the daemon's output goes: the relay's fd, or `absent` — the start
 * command was run by a gateway that predates the relay (the gateway binary is
 * only rebuilt by `./equin start`), so there is no relay to hand it.
 */
export type ServiceLogTarget =
  { kind: "relay"; fd: number } | { kind: "absent" };

/** Reads `--log-fd <n>` off a start command's argv. A malformed value throws. */
export function serviceLogTarget(argv: readonly string[]): ServiceLogTarget {
  const i = argv.indexOf(SERVICE_LOG_FD_FLAG);
  if (i === -1) return { kind: "absent" };
  const raw = argv[i + 1];
  const fd = Number(raw);
  if (raw === undefined || !Number.isInteger(fd) || fd < 3) {
    throw new Error(
      `${SERVICE_LOG_FD_FLAG} wants an inherited file descriptor >= 3, got ${JSON.stringify(raw)}`,
    );
  }
  return { kind: "relay", fd };
}
