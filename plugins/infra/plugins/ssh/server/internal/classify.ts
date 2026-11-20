/**
 * Turn an `ssh` process outcome into a {@link SshFailureKind}.
 *
 * We shell out to the system `ssh` (see the plugin's CLAUDE.md for why), so the
 * only signal about *what* went wrong is OpenSSH's own English stderr. That is
 * an unstable contract, and this module treats it as one: matching is
 * conservative and case-insensitive, and anything unmatched becomes `unknown`
 * with the raw stderr carried through — never bucketed into a nearby kind.
 *
 * Deliberately a PURE function of `(exitCode, signalCode, stderr, timedOut)`,
 * with no I/O and no spawn: the classification table is the expensive-to-get-
 * wrong part of this plugin and the cheap-to-test part, and keeping it pure is
 * what makes `classify.test.ts` able to pin every branch against verbatim
 * OpenSSH samples.
 */
import type { SshFailureKind, SshTunnelFailureKind } from "../../core";

/**
 * `ssh` reports ALL of its own failures — DNS, connect, auth, host key — as
 * exit status 255. Any other non-zero status is the remote command's own exit
 * status passed through verbatim.
 */
export const SSH_OWN_FAILURE_EXIT = 255;

/**
 * Ordered stderr patterns. Order is load-bearing where messages overlap:
 * the host-key banner is checked first because it is the most specific and the
 * most security-relevant thing to never mislabel, and `timeout`'s substrings
 * would otherwise catch text that a more specific kind should own.
 */
interface PatternRow<K extends string> {
  kind: K;
  patterns: readonly string[];
}

/** Only kinds both vocabularies have: the tunnel table reuses these rows. */
type SharedKind = Extract<SshFailureKind, SshTunnelFailureKind>;

const HOST_KEY_ROW: PatternRow<SharedKind> = {
  kind: "host-key-mismatch",
  patterns: [
    "host key verification failed",
    "remote host identification has changed",
  ],
};

/** Every shared row after the host-key one, in order. */
const DIAL_ROWS: ReadonlyArray<PatternRow<SharedKind>> = [
  {
    kind: "dns",
    patterns: [
      "could not resolve hostname",
      "name or service not known",
      "nodename nor servname",
    ],
  },
  {
    kind: "unreachable",
    patterns: [
      "connection refused",
      "no route to host",
      "network is unreachable",
      "host is down",
    ],
  },
  {
    kind: "timeout",
    patterns: ["connection timed out", "operation timed out", "timed out"],
  },
  {
    kind: "auth",
    patterns: ["permission denied (publickey", "too many authentication failures"],
  },
];

const STDERR_PATTERNS: ReadonlyArray<PatternRow<SshFailureKind>> = [
  HOST_KEY_ROW,
  ...DIAL_ROWS,
];

/**
 * Classify a FAILED OpenSSH-family invocation. Only ever called once the caller
 * has established the attempt did not succeed — a clean `exit 0` has no kind.
 *
 * @param exitCode process exit status, or `null` when it died on a signal.
 * @param signalCode the signal that killed it, or `null`.
 * @param stderr OpenSSH's diagnostic output, verbatim.
 * @param timedOut whether OUR OWN deadline fired and killed the child.
 * @param opts.ownFailureExit the status the program reserves for its OWN
 *   connection-layer failures — `SSH_OWN_FAILURE_EXIT` (255) for `ssh`, which
 *   is the default. Pass `null` for a program whose exit status carries no such
 *   distinction (`scp` collapses "could not connect" and "could not write the
 *   file" into exit 1): the status is then not evidence of anything and only
 *   stderr is read, so an unrecognized copy failure comes back as `unknown`
 *   with its diagnostic intact instead of mislabelled `command-failed`.
 */
export function classify(
  exitCode: number | null,
  signalCode: string | null,
  stderr: string,
  timedOut: boolean,
  opts: { ownFailureExit: number | null } = { ownFailureExit: SSH_OWN_FAILURE_EXIT },
): SshFailureKind {
  // Our deadline wins over everything: whatever ssh was about to say, the
  // reason the caller has no answer is that time ran out.
  if (timedOut) return "timeout";

  // An exit status ssh never uses for its own failures means we connected AND
  // authenticated and the REMOTE COMMAND exited non-zero. Decided before any
  // stderr matching, so a remote command that happens to print "Connection
  // refused" (curl, a health probe) is not misread as an ssh-layer failure.
  if (
    opts.ownFailureExit !== null &&
    signalCode === null &&
    exitCode !== null &&
    exitCode !== opts.ownFailureExit
  ) {
    return "command-failed";
  }

  const haystack = stderr.toLowerCase();
  for (const { kind, patterns } of STDERR_PATTERNS) {
    if (patterns.some((p) => haystack.includes(p))) return kind;
  }

  // Exit 255 (or a signal) with nothing we recognize. Not a guess, not a
  // silent absorb — the caller carries the raw stderr to the UI.
  return "unknown";
}

/**
 * A one-line, human-readable summary for a classified failure. The UI keys its
 * real remediation copy off the `kind`; this is the fallback sentence that
 * still reads correctly in a log line, a toast, or a stored `failure_message`.
 */
export function failureMessage(kind: SshFailureKind, stderr: string): string {
  switch (kind) {
    case "dns":
      return "The hostname could not be resolved.";
    case "unreachable":
      return "The host refused the connection or is not reachable on this port.";
    case "timeout":
      return "The connection timed out.";
    case "auth":
      return "The server rejected the key — it is not installed for this user yet.";
    case "host-key-mismatch":
      return "The host's SSH identity does not match the pinned host key.";
    case "command-failed":
      return "Connected and authenticated, but the remote command failed.";
    case "unknown":
      // No summary to invent — the diagnostic IS the message.
      return firstMeaningfulLine(stderr) || "SSH failed for an unrecognized reason.";
  }
}

/** First non-empty stderr line, trimmed — OpenSSH puts the diagnosis first. */
function firstMeaningfulLine(stderr: string): string {
  for (const line of stderr.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Long-lived ssh (a tunnel)

/**
 * The tunnel table: the one-shot rows, plus the two kinds only a long-lived
 * `ssh -N -L …` has. `forwarding-refused` sits right after the host-key row —
 * it is as final, and its lines must never be read as a network kind.
 * `disconnected` goes last: its wording ("Connection closed by …") also ends
 * a dial that a more specific row explains.
 */
const TUNNEL_PATTERNS: ReadonlyArray<PatternRow<SshTunnelFailureKind>> = [
  HOST_KEY_ROW,
  {
    kind: "forwarding-refused",
    patterns: [
      // The server forbids forwarding for this user (AllowTcpForwarding no,
      // a `restrict` key option). A local forward is only asked for when a
      // connection arrives, so this comes while ssh keeps running.
      "administratively prohibited",
      // The local listener could not be set up; with ExitOnForwardFailure ssh
      // exits on it.
      "could not request local forwarding",
      "unix_listener:",
      "cannot listen to path",
    ],
  },
  ...DIAL_ROWS,
  {
    kind: "disconnected",
    patterns: [
      // ServerAliveCountMax keep-alives went unanswered.
      "not responding",
      // "Connection to <host> closed by remote host." (a live session) and
      // "Connection closed by <host> port 22" (dropped before auth).
      "closed by remote host",
      "connection closed by",
      "connection reset by",
      "broken pipe",
    ],
  },
];

/**
 * A forward's TARGET refusing one connection — `channel 3: open failed:
 * connect failed: Connection refused` — is not a failure of the ssh session:
 * the tunnel is up, nothing listens on the remote port. The local client
 * sees that as its own connection closing (and tells "the peer is not
 * running" apart there); read here, its "Connection refused" would pass for
 * `unreachable`. So such lines are not evidence of anything.
 */
function isForwardTargetLine(lowerLine: string): boolean {
  return lowerLine.includes("open failed: connect failed");
}

/**
 * Whether ONE stderr line of a long-lived `ssh` says a forward's target
 * refused a connection — positive evidence the session is up (the server
 * answered the channel open) while nothing listens behind the forward.
 */
export function isForwardTargetRefusal(line: string): boolean {
  return isForwardTargetLine(line.toLowerCase());
}

function matchTunnel(lowerText: string): SshTunnelFailureKind | null {
  for (const { kind, patterns } of TUNNEL_PATTERNS) {
    if (patterns.some((p) => lowerText.includes(p))) return kind;
  }
  return null;
}

/**
 * Classify ONE stderr line of a long-lived `ssh`, as it arrives — `null` when
 * the line names no failure (a warning, a forward's target refusing one
 * connection). What a supervisor reads to stop a tunnel that can never work
 * (a non-retryable kind, `tunnelFailureRetryable`) while ssh itself keeps
 * running: a refused forward is reported per connection, never by an exit.
 */
export function classifyTunnelStderrLine(
  line: string,
): SshTunnelFailureKind | null {
  const lower = line.toLowerCase();
  if (isForwardTargetLine(lower)) return null;
  return matchTunnel(lower);
}

/**
 * Classify why a long-lived `ssh` ended, from all of its stderr: the most
 * specific kind any line names (table order), `unknown` when none does —
 * the raw stderr is then the diagnosis, never guessed at.
 */
export function classifyTunnelStderr(stderr: string): SshTunnelFailureKind {
  const evidence = stderr
    .toLowerCase()
    .split("\n")
    .filter((line) => !isForwardTargetLine(line))
    .join("\n");
  return matchTunnel(evidence) ?? "unknown";
}

/** The one-line summary of a tunnel failure — {@link failureMessage}'s twin. */
export function tunnelFailureMessage(
  kind: SshTunnelFailureKind,
  stderr: string,
): string {
  switch (kind) {
    case "dns":
    case "unreachable":
    case "timeout":
    case "auth":
    case "host-key-mismatch":
    case "unknown":
      return failureMessage(kind, stderr);
    case "forwarding-refused":
      return "The server refused the port forward — forwarding is disabled for this user, or the local socket could not be bound.";
    case "disconnected":
      return "The SSH session was lost — the server stopped answering or closed the connection.";
  }
}
