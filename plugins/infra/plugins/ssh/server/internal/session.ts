/**
 * The ONE hermetic OpenSSH invocation. `sshRun` and `sshUpload` are both thin
 * wrappers over `runHermetic`, and differ only in the program name, the
 * trailing positional arguments, and two documented constants.
 *
 * That is the whole point of this file. The isolation flags below are
 * security-critical — they are what makes "this key reaches this host" a fact
 * the caller proved rather than something the machine's own ambient credentials
 * arranged — and a second copy of them for `scp` would be a second place for
 * one to be dropped. Here there is no second copy: the key materialization, the
 * option block, the host-key policy and the failure classification exist once,
 * so `scp` cannot drift from `ssh`.
 *
 * The key is materialized into a `mkdtemp` scratch dir at mode 0600 and the
 * whole dir is `rm -rf`'d in `finally`, the same shape (and the same lifetime
 * discipline) as the existing `ssh-keygen` helper in deploy/servers.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { classify, failureMessage } from "./classify";
import type { SshFailure, SshTarget } from "./types";

/**
 * What fraction of the total budget OpenSSH's own `ConnectTimeout` gets.
 *
 * Strictly less than 1 on purpose. The two bounds cover different failures —
 * `ConnectTimeout` bounds the TCP connect, the spawn deadline bounds everything
 * (a handshake that wedges past connect) — but if they expired together the
 * race would usually be won by our SIGTERM, leaving an empty stderr and a
 * killed child. Giving ssh the earlier deadline lets it lose first and *say so*
 * ("Operation timed out"), so the classified failure carries OpenSSH's own
 * diagnostic instead of nothing. The spawn deadline stays the real backstop.
 */
const CONNECT_TIMEOUT_FRACTION = 0.6;

/**
 * Absolute ceiling on `ConnectTimeout`, regardless of the total budget.
 *
 * The fraction alone is only right when the budget IS a reachability probe's.
 * A 10-minute upload or a long converge script would otherwise wait minutes on
 * a TCP connect that is never going to complete — the transfer's budget says
 * nothing about how long the *dial* should be allowed to take. No effect on any
 * budget under ~25s, so `sshRun`'s default is unchanged.
 */
const CONNECT_TIMEOUT_CAP_SEC = 15;

/** How long OpenSSH's own `ConnectTimeout` gets, in whole seconds. */
function connectTimeoutSec(timeoutMs: number): number {
  const fromBudget = Math.round((timeoutMs * CONNECT_TIMEOUT_FRACTION) / 1000);
  return Math.max(1, Math.min(CONNECT_TIMEOUT_CAP_SEC, fromBudget));
}

/**
 * The shared option block, passed verbatim to both `ssh` and `scp`.
 *
 * Everything about *where, as whom and with what* the connection is made lives
 * here, in the `-o Keyword=value` form both programs accept — including the
 * port and the login user, which `ssh` also spells `-p`/`-l` and `scp`
 * spells `-P` (and, for `-l`, means something else entirely: a bandwidth cap).
 * Using the config-keyword form for those two keeps this block program-neutral,
 * which is what leaves the callers with nothing to write but positionals.
 */
function isolationOptions(opts: {
  target: SshTarget;
  keyPath: string;
  knownHostsPath: string;
  timeoutMs: number;
}): string[] {
  const { target, keyPath, knownHostsPath, timeoutMs } = opts;
  return [
    // Never prompt for anything: no password, no passphrase, no
    // host-key confirmation. A prompt would block on a TTY read forever.
    "-o",
    "BatchMode=yes",
    // === The isolation flags: load-bearing, NOT hygiene. ===
    // Without these, the machine's own ambient SSH credentials could
    // authenticate the session, and a "test this key works" check would pass
    // green while proving nothing about the key we were handed.
    //   IdentitiesOnly  — offer ONLY the -i key, no other configured identity.
    //   IdentityAgent   — ignore the host's ssh-agent entirely.
    //   -F /dev/null    — ignore ~/.ssh/config AND the system-wide config, so
    //                     no ambient IdentityFile / ProxyJump / ControlMaster
    //                     (a live multiplexed session is the same leak as an
    //                     agent key) can influence or short-circuit the dial.
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-F",
    "/dev/null",
    "-o",
    "PasswordAuthentication=no",
    // The pin is ours alone: the only known_hosts that counts is the scratch
    // file, never the machine's.
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    // Learned lines must be readable back out to be persisted and pinned.
    "-o",
    "HashKnownHosts=no",
    // There is deliberately no "off" here — an unverified host is never a
    // successful connection. `accept-new` is trust-on-first-use; `yes`
    // requires an exact match against the line we pinned.
    "-o",
    `StrictHostKeyChecking=${target.hostKey.mode === "pinned" ? "yes" : "accept-new"}`,
    // Bounds the TCP connect only, and deliberately expires BEFORE the spawn
    // deadline (see CONNECT_TIMEOUT_FRACTION) so ssh gets to report the
    // timeout itself. The handshake past connect is bounded by the spawn
    // deadline below — which is why that deadline exists.
    "-o",
    `ConnectTimeout=${connectTimeoutSec(timeoutMs)}`,
    "-i",
    keyPath,
    "-o",
    `Port=${target.port}`,
    "-o",
    `User=${target.user}`,
  ];
}

/** A successful hermetic invocation. `stdout` is `""` for programs that say nothing. */
export interface HermeticSuccess {
  ok: true;
  stdout: string;
  stderr: string;
  learnedHostKey: string | null;
}

/**
 * Run one hermetic OpenSSH-family program against `target`.
 *
 * Never throws for a remote-side problem — an unreachable host, a rejected key
 * and a changed host key are all expected states of a machine the user is still
 * setting up, so they come back as `{ ok: false, kind }` for the caller to
 * render. A local fault (cannot write the scratch key) still throws.
 *
 * `positionals` is built by the caller because it is the one genuinely
 * program-shaped part: `ssh` takes `-- <host> <command…>`, `scp` takes
 * `<local> <host>:<remote>`.
 *
 * `ownFailureExit` is the exit status the program reserves for its OWN
 * (connection-layer) failures, or `null` when it has none — see the callers.
 */
export async function runHermetic(opts: {
  program: "ssh" | "scp";
  target: SshTarget;
  positionals: (host: string) => string[];
  defaultTimeoutMs: number;
  ownFailureExit: number | null;
  /** Whole-buffer stdin for the child (`ssh` forwards it to the remote command). */
  stdin?: string;
}): Promise<HermeticSuccess | SshFailure> {
  const { program, target, positionals, ownFailureExit } = opts;
  const timeoutMs = target.timeoutMs ?? opts.defaultTimeoutMs;
  const dir = await mkdtemp(join(tmpdir(), "sg-ssh-"));
  try {
    const keyPath = join(dir, "id");
    const knownHostsPath = join(dir, "known_hosts");
    await Promise.all([
      // OpenSSH refuses a private key readable by anyone else, and requires the
      // file to end in a newline.
      writeFile(keyPath, ensureTrailingNewline(target.privateKey), { mode: 0o600 }),
      // In `learn` mode this starts empty and ssh appends what it accepts.
      writeFile(
        knownHostsPath,
        target.hostKey.mode === "pinned"
          ? ensureTrailingNewline(target.hostKey.knownHostsLine)
          : "",
        { mode: 0o600 },
      ),
    ]);

    const argv = [
      program,
      ...isolationOptions({ target, keyPath, knownHostsPath, timeoutMs }),
      ...positionals(target.host),
    ];

    const result = await spawnCaptured(argv, {
      timeoutMs,
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
    });
    // A signal-killed child (including our own deadline) has no exit status of
    // its own — reporting one would be inventing it.
    const exitCode = result.signalCode === null ? result.exitCode : null;

    if (result.exitCode === 0 && !result.timedOut) {
      return {
        ok: true,
        stdout: result.stdout,
        stderr: result.stderr,
        learnedHostKey:
          target.hostKey.mode === "learn" ? await readLearnedHostKey(knownHostsPath) : null,
      };
    }

    const kind = classify(exitCode, result.signalCode, result.stderr, result.timedOut, {
      ownFailureExit,
    });
    return {
      ok: false,
      kind,
      message: failureMessage(kind, result.stderr),
      stderr: result.stderr,
      exitCode,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Read back the host key `accept-new` just learned. `HashKnownHosts=no` keeps
 * the line plain, so the caller can store it and pin it on the next attempt.
 * Returns `null` when ssh wrote nothing — possible for a host that presented no
 * new key (already pinned by a caller that passed `learn` anyway), which is a
 * legitimately-empty success rather than a failure.
 */
async function readLearnedHostKey(knownHostsPath: string): Promise<string | null> {
  const contents = await readFile(knownHostsPath, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) return trimmed;
  }
  return null;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
