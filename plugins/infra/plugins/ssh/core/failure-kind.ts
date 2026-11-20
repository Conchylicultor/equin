/**
 * The classified reason an SSH attempt failed.
 *
 * This lives in `core/` (web-safe — no node-only imports) because the UI keys
 * its remediation copy off the kind: "the key isn't installed for this user
 * yet" and "the host's identity changed" need completely different words and
 * completely different next actions, and only the server can tell them apart.
 *
 * `unknown` is a first-class variant on purpose. Classification comes from
 * matching OpenSSH's own English stderr, which no contract guarantees; when a
 * message doesn't match anything we know, the raw stderr is carried to the UI
 * verbatim rather than guessed at or collapsed into a neighbouring kind. An
 * unrecognized failure must stay visibly unrecognized.
 */
import { z } from "zod";

export const SshFailureKindSchema = z.enum([
  /** The hostname does not resolve. */
  "dns",
  /** Refused / no route / network unreachable — nothing listening or no path. */
  "unreachable",
  /** The connect or the whole attempt exceeded its deadline. */
  "timeout",
  /** Publickey rejected — the key is not installed for this user. */
  "auth",
  /** The pinned host key no longer matches what the host presented. */
  "host-key-mismatch",
  /** Connected AND authenticated; the remote command itself exited non-zero. */
  "command-failed",
  /** Unclassified — carries raw stderr, never silently absorbed. */
  "unknown",
]);

export type SshFailureKind = z.infer<typeof SshFailureKindSchema>;

/**
 * Why a long-lived `ssh` (a tunnel: `-N` and local forwards, no remote
 * command) failed or is failing, read from its stderr.
 *
 * Its own vocabulary rather than more members of {@link SshFailureKindSchema}:
 * a one-shot run can never report a refused forward or a dropped session, and
 * a tunnel can never report `command-failed` (it runs none) — sharing one enum
 * would make every consumer of either handle a kind that cannot happen.
 */
export const SshTunnelFailureKindSchema = z.enum([
  "dns",
  "unreachable",
  "timeout",
  "auth",
  "host-key-mismatch",
  /**
   * A forward could not be set up or was refused: the local socket could not
   * be bound, or the server forbids TCP forwarding for this user
   * (`administratively prohibited`). Retrying cannot fix it.
   */
  "forwarding-refused",
  /**
   * An established session was lost: keep-alives unanswered (`Timeout, server
   * … not responding`), the peer closed or reset it, the pipe broke.
   */
  "disconnected",
  /** Unclassified — carries raw stderr, never silently absorbed. */
  "unknown",
]);

export type SshTunnelFailureKind = z.infer<typeof SshTunnelFailureKindSchema>;

/**
 * Whether respawning the tunnel can fix a failure of this kind. A rejected
 * key, a changed host key and a forbidden forward need the user to act;
 * respawning would only hammer the host with the same refused attempt. The
 * network kinds pass on their own; `unknown` is retried (with backoff) and
 * stays visible as what it is.
 */
export function tunnelFailureRetryable(kind: SshTunnelFailureKind): boolean {
  switch (kind) {
    case "auth":
    case "host-key-mismatch":
    case "forwarding-refused":
      return false;
    case "dns":
    case "unreachable":
    case "timeout":
    case "disconnected":
    case "unknown":
      return true;
  }
}
