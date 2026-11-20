/**
 * The ONE hermetic OpenSSH invocation. `sshRun` and `sshUpload` are both thin
 * wrappers over `runHermetic`, and differ only in the program name, the
 * trailing positional arguments, and two documented constants; a long-lived
 * `ssh` (a tunnel, `sshTunnelArgv`) is built from the same handle.
 *
 * That is the whole point of this file. The isolation flags below are
 * security-critical — they are what makes "this key reaches this host" a fact
 * the caller proved rather than something the machine's own ambient credentials
 * arranged — and a second copy of them for `scp` would be a second place for
 * one to be dropped. Here there is no second copy: the key materialization, the
 * option block, the host-key policy and the failure classification exist once,
 * so `scp` cannot drift from `ssh`.
 *
 * The key is materialized into a `mkdtemp` scratch dir at mode 0600 by
 * `materializeHermetic`, whose handle owns that dir until `dispose()` — a
 * one-shot `runHermetic` disposes in `finally`, the same shape (and the same
 * lifetime discipline) as the existing `ssh-keygen` helper in deploy/servers;
 * a tunnel holds it for as long as it may respawn.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
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

/**
 * How long OpenSSH's own `ConnectTimeout` gets, in whole seconds. With no
 * whole-attempt budget (a long-lived `ssh`, which no spawn deadline bounds)
 * the dial gets the cap.
 */
function connectTimeoutSec(budgetMs: number | null): number {
  if (budgetMs === null) return CONNECT_TIMEOUT_CAP_SEC;
  const fromBudget = Math.round((budgetMs * CONNECT_TIMEOUT_FRACTION) / 1000);
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
  budgetMs: number | null;
}): string[] {
  const { target, keyPath, knownHostsPath, budgetMs } = opts;
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
    `ConnectTimeout=${connectTimeoutSec(budgetMs)}`,
    "-i",
    keyPath,
    "-o",
    `Port=${target.port}`,
    "-o",
    `User=${target.user}`,
  ];
}

/**
 * A materialized hermetic session: the scratch dir holding the 0600 key and
 * the pinned (or, in `learn` mode, empty) `known_hosts`, and the one way to
 * build an OpenSSH-family argv that uses them. The CALLER owns the lifetime:
 * the dir lives until `dispose()` — a one-shot run disposes in `finally`, a
 * long-lived `ssh` (a tunnel) when it will never be respawned again.
 */
export interface HermeticHandle {
  /**
   * The private scratch dir (mode 0700, `mkdtemp`). A caller may put its own
   * per-session files beside the key — a tunnel's local sockets — and they
   * go with it on `dispose()`.
   */
  readonly dir: string;
  /** The host the session dials, for the caller's positionals. */
  readonly host: string;
  /**
   * `[program, …isolation options, …extra, …positionals]`. `extra` comes
   * AFTER the isolation block on purpose: OpenSSH keeps the FIRST value it
   * reads for an option, so nothing in `extra` can override an isolation
   * flag. Throws after `dispose()` (the key it names is gone).
   */
  argv(
    program: "ssh" | "scp",
    extra: readonly string[],
    positionals: readonly string[],
  ): string[];
  /**
   * The `known_hosts` line `accept-new` learned (`learn` mode), or `null`
   * when ssh wrote none — see `readLearnedHostKey`.
   */
  learnedHostKey(): Promise<string | null>;
  /** Remove the scratch dir (key included). Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Write `target`'s key and host-key pin into a fresh scratch dir and return
 * the handle that owns it. A local fault (cannot write the scratch key)
 * throws, with nothing left behind.
 *
 * `budgetMs` is the whole attempt's wall-clock budget, from which OpenSSH's
 * `ConnectTimeout` is derived (see `CONNECT_TIMEOUT_FRACTION`); omit it for a
 * long-lived `ssh` that no deadline bounds, and the dial gets the cap.
 */
export async function materializeHermetic(
  target: SshTarget,
  opts: { budgetMs?: number } = {},
): Promise<HermeticHandle> {
  const dir = await mkdtemp(join(tmpdir(), "sg-ssh-"));
  const keyPath = join(dir, "id");
  const knownHostsPath = join(dir, "known_hosts");
  try {
    await Promise.all([
      // OpenSSH refuses a private key readable by anyone else, and requires the
      // file to end in a newline.
      writeFile(keyPath, ensureTrailingNewline(target.privateKey), {
        mode: 0o600,
      }),
      // In `learn` mode this starts empty and ssh appends what it accepts.
      writeFile(
        knownHostsPath,
        target.hostKey.mode === "pinned"
          ? ensureTrailingNewline(target.hostKey.knownHostsLine)
          : "",
        { mode: 0o600 },
      ),
    ]);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  const options = isolationOptions({
    target,
    keyPath,
    knownHostsPath,
    budgetMs: opts.budgetMs ?? null,
  });
  let disposed = false;
  return {
    dir,
    host: target.host,
    argv(program, extra, positionals) {
      if (disposed) {
        throw new Error(
          `[ssh] the hermetic session in ${dir} was disposed — its key is gone; materialize a new one`,
        );
      }
      return [program, ...options, ...extra, ...positionals];
    },
    learnedHostKey: async () =>
      target.hostKey.mode === "learn"
        ? await readLearnedHostKey(knownHostsPath)
        : null,
    async dispose() {
      disposed = true;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A successful hermetic invocation. `stdout` is `""` for programs that say nothing. */
export interface HermeticSuccess {
  ok: true;
  stdout: string;
  stderr: string;
  learnedHostKey: string | null;
}

/**
 * Run one hermetic OpenSSH-family program against `target`, on a session
 * materialized for this run and disposed in `finally`.
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
  const session = await materializeHermetic(target, { budgetMs: timeoutMs });
  try {
    const argv = session.argv(program, [], positionals(session.host));

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
        learnedHostKey: await session.learnedHostKey(),
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
    await session.dispose();
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
