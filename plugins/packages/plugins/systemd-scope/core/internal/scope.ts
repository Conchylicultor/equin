// A command in a systemd user scope of its own, and the one fact about how
// that scope was ended that nothing else records: systemd-oomd killed it.
//
// systemd-oomd (on by default on Ubuntu desktop) acts on CGROUPS: under memory
// pressure it SIGKILLs every process of the leaf cgroup reclaiming the most.
// It does not go through the kernel's OOM killer, so `/proc/vmstat`'s
// `oom_kill` never moves (`host-memory`'s `readOomKillCount`), and the
// waiting parent sees a plain SIGKILL — the same as `kill -9`. Two things
// follow, both measured on Ubuntu 24.04 / systemd 255 (2026-11-19):
//
// - A child left in its parent's cgroup dies WITH the parent's whole unit:
//   oomd picked the gateway's service (the leaf holding the deploy) and
//   killed gateway, Postgres, every backend and the build at once. In a scope
//   of its own the child is its own leaf, and oomd — which picks the leaf
//   reclaiming the most — took the scope alone while the gateway kept
//   serving. (A leaf, not a shield: the gateway's service is still a
//   candidate when it is the one reclaiming most.)
// - The user manager then writes one structured record to the user's journal
//   (`unit_check_oomd_kill`): `MESSAGE_ID` {@link OOMD_KILL_MESSAGE_ID},
//   `USER_UNIT=<the scope>`, `N_PROCESSES`. It is written whatever the
//   scope's `OOMPolicy` is, and the user can read it (`journalctl --user`, no
//   `adm` group needed). The scope's `Result=oom-kill` is NOT a usable
//   signal: with `OOMPolicy=continue` (required, below) a scope ends
//   `success`.
//
// The scope's `OOMPolicy=continue`: systemd's default (`stop`) stops the whole
// scope on ANY OOM kill in it — so a kernel OOM kill of one step (a type-check
// worker) would SIGTERM the build, which then records itself `killed` instead
// of judging the step it lost (`framework/cli/build`'s `failure-end.ts`).

/** systemd's `SD_MESSAGE_UNIT_OOMD_KILL`: "systemd-oomd killed N process(es) in this unit". */
export const OOMD_KILL_MESSAGE_ID = "d989611b15e44c9dbf31e3c81256e4ed";

/**
 * Records the manager writes when a unit that ran stops. In systemd 255 the
 * oomd-kill record comes first: the manager checks for oomd's kill when it
 * hears the cgroup emptied, before the unit's state change logs these (one
 * sender, written in order — measured on every oomd kill of 2026-11-19). So
 * one of these with no oomd-kill record means the unit ended some other way.
 *
 * - `SD_MESSAGE_UNIT_RESOURCES` — "Consumed …" (every unit that used CPU).
 * - `SD_MESSAGE_UNIT_FAILURE_RESULT` — "Failed with result …".
 * - `SD_MESSAGE_UNIT_SUCCESS` — "Deactivated successfully".
 */
export const UNIT_STOPPED_MESSAGE_IDS: readonly string[] = [
  "ae8f7b866b0347b9af31fe1c80b127c0",
  "d9b373ed55a64feb8242e02dbe79a49c",
  "7ad2d189f7e94e70a38c781354912448",
];

/**
 * Whether this process can start transient units in its user's systemd
 * manager, and how to reach it.
 *
 * - `systemd` — Linux, with the user manager's private socket at
 *   `<runtimeDir>/systemd/private` (`runtimeDir` = `/run/user/<uid>`, the
 *   directory logind makes for a logged-in or lingering user).
 * - `none` — anything else (macOS, a container with no user manager): the
 *   command runs where it is, and no scope record exists to read.
 *
 * Derived from the uid rather than read from `XDG_RUNTIME_DIR`: the runtime
 * tree starts from a declared environment that does not carry it
 * (`infra/launcher/runtime-env`), and `/run/user/<uid>` is where systemd puts
 * it on every distribution.
 */
export type UserScopeHost =
  { kind: "systemd"; runtimeDir: string } | { kind: "none"; why: string };

export function userScopeHost(i: {
  platform: string;
  uid: number;
  /** Does a path exist (the caller's fs; `core/` reads nothing itself). */
  exists: (path: string) => boolean;
}): UserScopeHost {
  if (i.platform !== "linux")
    return { kind: "none", why: `${i.platform} has no systemd` };
  const runtimeDir = `/run/user/${i.uid}`;
  const socket = `${runtimeDir}/systemd/private`;
  if (!i.exists(socket))
    return {
      kind: "none",
      why: `no systemd user manager for uid ${i.uid} (${socket} is missing)`,
    };
  return { kind: "systemd", runtimeDir };
}

/** A command wrapped to run in a transient scope named {@link ScopedCommand.unit}. */
export interface ScopedCommand {
  argv: string[];
  env: Record<string, string | undefined>;
  /** The scope's unit name, `<name>.scope` — what {@link readScopeOomdKill} asks about. */
  unit: string;
}

/** A unit name systemd accepts, kept to the characters a run id uses. */
const SCOPE_UNIT_RE = /^[A-Za-z0-9_.-]+\.scope$/;

/**
 * Wrap `argv` to run in a transient user scope `unit` (`<name>.scope`):
 * `systemd-run --user --scope` registers the scope with the user manager and
 * then EXECS the command, so the caller's child is still the command itself
 * (same pid, same stdio, signals reach it).
 *
 * - `--collect`: the unit is unloaded once it ends, failed or not — nothing
 *   is read from the unit afterwards (its `Result` says nothing, see the
 *   header), only from the journal, which keeps the record.
 * - `-p OOMPolicy=continue`: see the header.
 * - `XDG_RUNTIME_DIR` is how `systemd-run` finds the user manager. It is
 *   handed to `systemd-run` only: when the caller's environment did not carry
 *   it, `env -u` takes it back out before the command starts, so the command
 *   gets exactly the environment it was given.
 *
 * A `systemd-run` that cannot start the scope exits non-zero with its reason
 * on stderr, before the command runs — a failed command, said loudly.
 */
export function inOwnScope(
  host: Extract<UserScopeHost, { kind: "systemd" }>,
  cmd: {
    argv: readonly string[];
    env: Record<string, string | undefined>;
    unit: string;
    /** The scope's description in `systemctl --user status` and the journal. */
    description: string;
  },
): ScopedCommand {
  if (!SCOPE_UNIT_RE.test(cmd.unit))
    throw new Error(
      `[systemd-scope] ${JSON.stringify(cmd.unit)} is not a scope unit name (<name>.scope, [A-Za-z0-9_.-])`,
    );
  if (cmd.argv.length === 0)
    throw new Error("[systemd-scope] an empty command has nothing to scope");
  const hadRuntimeDir = cmd.env["XDG_RUNTIME_DIR"] !== undefined;
  return {
    unit: cmd.unit,
    env: hadRuntimeDir
      ? cmd.env
      : { ...cmd.env, XDG_RUNTIME_DIR: host.runtimeDir },
    argv: [
      "systemd-run",
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--unit=${cmd.unit}`,
      `--description=${cmd.description}`,
      "--property=OOMPolicy=continue",
      "--",
      ...(hadRuntimeDir ? [] : ["env", "-u", "XDG_RUNTIME_DIR"]),
      ...cmd.argv,
    ],
  };
}

/**
 * Whether systemd-oomd killed a scope, read from the user journal.
 *
 * - `oomd-killed` — the manager recorded oomd's kill of the unit (`processes`:
 *   how many it killed, null when the record's count did not parse).
 * - `not-oomd` — the unit's stop is recorded with no oomd kill before it.
 * - `unknown` — no record settles it (the journal unreadable or not
 *   persistent for this user, the stop not written within the wait): never
 *   read as `not-oomd` by a caller that wants to tell the user.
 */
export type ScopeOomdKill =
  | { kind: "oomd-killed"; processes: number | null }
  | { kind: "not-oomd" }
  | { kind: "unknown"; why: string };

/**
 * What one read of the unit's journal records say: settled (one of the
 * {@link ScopeOomdKill} arms but `unknown`) or `pending` — neither an oomd
 * kill nor the unit's stop recorded yet. `journalJson` is `journalctl -o json`
 * output: one JSON object per line.
 */
export function scopeOomdKillFromJournal(
  journalJson: string,
): Exclude<ScopeOomdKill, { kind: "unknown" }> | { kind: "pending" } {
  let stopped = false;
  for (const line of journalJson.split("\n")) {
    if (line.trim() === "") continue;
    const record: unknown = JSON.parse(line);
    if (typeof record !== "object" || record === null)
      throw new Error(
        `[systemd-scope] a journal line is not an object: ${line.slice(0, 200)}`,
      );
    const id = (record as Record<string, unknown>)["MESSAGE_ID"];
    if (id === OOMD_KILL_MESSAGE_ID) {
      const n = Number((record as Record<string, unknown>)["N_PROCESSES"]);
      // The record is the fact; a count that does not parse only loses the number.
      return {
        kind: "oomd-killed",
        processes: Number.isInteger(n) ? n : null,
      };
    }
    if (typeof id === "string" && UNIT_STOPPED_MESSAGE_IDS.includes(id))
      stopped = true;
  }
  return stopped ? { kind: "not-oomd" } : { kind: "pending" };
}

/** How long {@link readScopeOomdKill} waits for the unit's stop to be written. */
export const SCOPE_RECORD_WAIT_MS = 10_000;
/** The pause between two reads while the stop is not written yet. */
export const SCOPE_RECORD_REREAD_MS = 250;

/**
 * Runs one command to completion — its exit code and output (the caller's
 * spawn). `env` holds the variables to set on top of the caller's own;
 * `timeoutMs` bounds the one run (the caller kills it past that). A rejection
 * is read as `unknown`, never thrown on.
 */
export type ScopeCommandRunner = (
  argv: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

/**
 * Read whether systemd-oomd killed `unit`, once the command run in it ended.
 *
 * The manager writes its records when it hears the scope's cgroup emptied,
 * which can land a moment after the caller's own wait for its child
 * returned, and journald writes them a moment after that. So the journal is
 * re-read every {@link SCOPE_RECORD_REREAD_MS} until it settles (an oomd
 * kill, or the unit's stop with none) — bounded by
 * {@link SCOPE_RECORD_WAIT_MS}, a bound on two processes we do not control
 * (the user manager, journald), past which the answer is `unknown`. There is
 * no change signal to wait on instead: a follow (`journalctl -f`) is a
 * streaming child, which the spawn chokepoint does not offer.
 *
 * Total, like `readOomKillCount`: its caller reads it beside work it explains
 * (and closes that work's record after it), so a journalctl that cannot be
 * spawned, fails or prints something unreadable is `unknown`, never a throw.
 * Each read is bounded by what is left of the wait, so the whole call is.
 * `wait` is the caller's timer (tests pass an instant one).
 */
export async function readScopeOomdKill(
  host: Extract<UserScopeHost, { kind: "systemd" }>,
  unit: string,
  deps: {
    run: ScopeCommandRunner;
    wait: (ms: number) => Promise<void>;
    now: () => number;
  },
): Promise<ScopeOomdKill> {
  const argv = [
    "journalctl",
    "--user",
    "--quiet",
    "--no-pager",
    "--output=json",
    `USER_UNIT=${unit}`,
  ];
  const env = { XDG_RUNTIME_DIR: host.runtimeDir, LC_ALL: "C" };
  const deadline = deps.now() + SCOPE_RECORD_WAIT_MS;
  // Why the last read did not settle, for the `unknown` past the deadline.
  let unsettled = "nothing recorded yet";
  for (;;) {
    const left = deadline - deps.now();
    if (left <= 0)
      return {
        kind: "unknown",
        why: `the journal recorded neither an oomd kill nor the stop of ${unit} within ${SCOPE_RECORD_WAIT_MS / 1000}s (${unsettled})`,
      };
    let read: Awaited<ReturnType<ScopeCommandRunner>>;
    try {
      read = await deps.run(argv, env, left);
    } catch (err) {
      return {
        kind: "unknown",
        why: `journalctl could not run: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (read.exitCode !== 0) {
      // A journalctl that printed nothing may only be saying "no entries"
      // (some versions exit 1 for an empty match) — read again until the
      // deadline; one that printed records failed some other way.
      const why = `journalctl exited ${read.exitCode}: ${read.stderr.trim().slice(0, 300)}`;
      if (read.stdout.trim() !== "") return { kind: "unknown", why };
      unsettled = why;
    } else {
      let said: ReturnType<typeof scopeOomdKillFromJournal>;
      try {
        said = scopeOomdKillFromJournal(read.stdout);
      } catch (err) {
        if (!(err instanceof Error)) throw err;
        return { kind: "unknown", why: err.message };
      }
      if (said.kind !== "pending") return said;
      unsettled = "nothing recorded yet";
    }
    await deps.wait(Math.min(SCOPE_RECORD_REREAD_MS, deadline - deps.now()));
  }
}
