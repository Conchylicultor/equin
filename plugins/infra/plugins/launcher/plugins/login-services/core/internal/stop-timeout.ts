/**
 * How long a login service has to stop, as ONE number every party derives its
 * own bound from — so none of them can disagree with another.
 *
 * - The manager kills at it: launchd's `ExitTimeOut`, systemd's
 *   `TimeoutStopSec` (`launchd-plist.ts`, `systemd-unit.ts`) — SIGTERM, then
 *   SIGKILL once this has passed. Measured on macOS 26: a booted-out job that
 *   ignores SIGTERM is dead at ExitTimeOut + ~0.5 s, and `launchctl bootstrap`
 *   of its label fails (EIO) until then.
 * - The service finishes its own shutdown inside it: the gateway's
 *   `-shutdown-timeout` is {@link SERVICE_SHUTDOWN_BUDGET_S}, so it exits on
 *   its own rather than being killed mid-teardown.
 * - A restart waits for the old process past it
 *   ({@link SERVICE_STOP_WAIT_MS}): by then the manager has killed it, so a
 *   process still alive survived SIGKILL.
 *
 * They used to be three literals — 15 s (the gateway), 20 s (ExitTimeOut) and
 * 20 s (the wait) — and the wait equal to the kill made every slow stop a
 * race between `start --force` giving up and launchd killing the old gateway;
 * the CLI lost on 2026-11-08 and the machine was left with no gateway.
 */
export const SERVICE_STOP_TIMEOUT_S = 20;

/**
 * What the service's own shutdown must fit in: the stop timeout minus a margin
 * for the steps after its budgeted teardown (process exit, the gateway's
 * supervisor detach).
 */
export const SERVICE_SHUTDOWN_BUDGET_S = SERVICE_STOP_TIMEOUT_S - 5;

/**
 * How long a restart waits for the old process to be gone: the stop timeout
 * plus a margin for the kernel to reap a SIGKILLed process on a loaded host.
 */
export const SERVICE_STOP_WAIT_MS = (SERVICE_STOP_TIMEOUT_S + 10) * 1000;
