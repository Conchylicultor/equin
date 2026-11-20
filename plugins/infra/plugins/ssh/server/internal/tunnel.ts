/**
 * The argv of a long-lived, hermetic `ssh` that only forwards: local Unix
 * sockets to TCP ports on the remote host's loopback.
 *
 * Built on a `HermeticHandle` (`session.ts`), so the isolation flags are the
 * same block every one-shot `sshRun` uses — a tunnel cannot drift from them.
 * Pure: it spawns nothing. The caller runs the argv under a supervisor (a
 * `defineDaemon` process, respawned with backoff) and keeps the handle alive
 * — the key and the sockets live in its dir — for as long as it may respawn.
 */
import type { HermeticHandle } from "./session";

/**
 * macOS's `sun_path` is 104 bytes, its terminating NUL included (Linux:
 * 108). A longer path cannot be bound at all, and OpenSSH reports it only as
 * a forward failure at connect time — so it is refused here, up front.
 */
const SUN_PATH_BYTES = 104;

/**
 * One forward: connections to `localSocket` on this machine are carried to
 * `127.0.0.1:<remotePort>` on the remote host (`-L <socket>:127.0.0.1:<port>`).
 */
export interface SshForward {
  /** Absolute path of the Unix socket ssh binds (and re-binds on respawn). */
  localSocket: string;
  /** The TCP port on the remote host's loopback. */
  remotePort: number;
}

/**
 * The tunnel options, after the isolation block:
 *
 * - `-N` — no remote command: the session exists only to carry the forwards.
 * - `ExitOnForwardFailure=yes` — a forward that cannot be set up ends ssh
 *   instead of leaving a session up that carries nothing.
 * - `ServerAliveInterval=15` / `ServerAliveCountMax=3` — a peer that stops
 *   answering (a laptop's network gone, a box powered off) ends ssh within
 *   ~45 s, instead of a TCP session that looks alive for hours.
 * - `StreamLocalBindUnlink=yes` — a respawn re-binds its socket over the one
 *   a dead incarnation left behind, instead of failing on "Address already
 *   in use".
 */
const TUNNEL_OPTIONS: readonly string[] = [
  "-N",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "StreamLocalBindUnlink=yes",
];

/**
 * The `ssh` argv that holds `forwards` open to `handle`'s host. Throws on a
 * forward that can never work — a relative, colon-bearing or too-long socket
 * path, a port outside 1–65535, or no forward at all — because each is a
 * caller bug, not a state of the remote host.
 */
export function sshTunnelArgv(
  handle: HermeticHandle,
  forwards: readonly SshForward[],
): string[] {
  if (forwards.length === 0) {
    throw new Error(
      "[ssh] sshTunnelArgv: a tunnel with no forward carries nothing",
    );
  }
  const specs = forwards.flatMap((f) => ["-L", forwardSpec(f)]);
  // `--` then the host: with `-N` there is no command after it.
  return handle.argv("ssh", [...TUNNEL_OPTIONS, ...specs], ["--", handle.host]);
}

function forwardSpec({ localSocket, remotePort }: SshForward): string {
  if (!localSocket.startsWith("/")) {
    throw new Error(
      `[ssh] tunnel socket "${localSocket}" must be an absolute path`,
    );
  }
  // `-L` splits its spec on ':' — a socket path holding one would be read as
  // a host and port.
  if (localSocket.includes(":")) {
    throw new Error(
      `[ssh] tunnel socket "${localSocket}" must not contain ':'`,
    );
  }
  const bytes = new TextEncoder().encode(localSocket).length;
  if (bytes >= SUN_PATH_BYTES) {
    throw new Error(
      `[ssh] tunnel socket "${localSocket}" is ${String(bytes)} bytes — a Unix socket path must be under ${String(SUN_PATH_BYTES)} (macOS sun_path, NUL included); use a shorter name or a shorter dir`,
    );
  }
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
    throw new Error(
      `[ssh] tunnel remote port ${String(remotePort)} is not a TCP port`,
    );
  }
  return `${localSocket}:127.0.0.1:${String(remotePort)}`;
}
