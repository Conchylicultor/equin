/**
 * Run one command on a remote host over SSH, hermetically.
 *
 * "Hermetically" is the whole point: the connection is made with EXACTLY the
 * host, port, user and private key the caller passed, and with nothing else the
 * machine happens to have lying around. The isolation flags that achieve that,
 * and the scratch-key lifetime, live in `session.ts` — shared verbatim with
 * `sshUpload` so the two can never drift.
 */
import { SSH_OWN_FAILURE_EXIT } from "./classify";
import { runHermetic } from "./session";
import type { SshRunResult, SshTarget } from "./types";

/** Wall-clock ceiling for a whole attempt when the caller doesn't set one. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Open an SSH session to `target`, run `command`, and return a discriminated
 * result. Never throws for a remote-side problem — an unreachable host, a
 * rejected key and a changed host key are all expected states of a machine the
 * user is still setting up, so they come back as `{ ok: false, kind }` for the
 * caller to render. A local fault (cannot write the scratch key) still throws.
 *
 * `command` is an argv array, joined with spaces for the remote login shell —
 * OpenSSH has no argv-preserving remote exec, so callers should keep commands
 * simple and shell-metacharacter-free.
 */
export async function sshRun(
  target: SshTarget,
  command: string[],
  opts?: {
    /**
     * Whole-buffer input for the remote command's stdin — the one channel for
     * a value that must not appear in any argv (local `ps`, the remote's
     * process list, the remote shell's history): a deploy secret. Never echoed
     * or logged here.
     */
    stdin?: string;
  },
): Promise<SshRunResult> {
  return await runHermetic({
    program: "ssh",
    target,
    stdin: opts?.stdin,
    // End of options BEFORE the host: everything after the hostname is the
    // remote command, so a `--` placed after it would be sent to the remote
    // shell as a literal word.
    positionals: (host) => ["--", host, ...command],
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    ownFailureExit: SSH_OWN_FAILURE_EXIT,
  });
}
