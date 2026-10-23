import {
  parseShell,
  type ShellParseResult,
  type ShellRedirection,
} from "./parse-shell";
import { CLI_NAME } from "@plugins/framework/plugins/cli/core";

/**
 * Polling detection, as pure functions over a command string and a window.
 *
 * Separated from the guard so it can be replayed over recorded transcripts
 * (`e2e/replay-transcripts.ts`) without the hook, the filesystem or a session.
 * The catch rate of this rule is measured, not asserted — keep it that way.
 */

/** What a command is *watching*. The identity a polling loop is keyed on. */
export type WatchSubject = string;

export type CommandClass = "observe" | "mutate" | "neutral";

/** Commands that only look. Anything absent is not assumed safe — see classify. */
const READ_ONLY = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "jq",
  "wc",
  "ls",
  "stat",
  "file",
  "du",
  "df",
  "echo",
  "printf",
  "date",
  "test",
  "[",
  "true",
  "false",
  "sleep",
  "pgrep",
  "pgrep -f",
  "ps",
  "sed",
  "awk",
  "cut",
  "sort",
  "uniq",
  "tr",
  "column",
  "nl",
  "tac",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "uptime",
  "whoami",
  "hostname",
  "pwd",
  "env",
  "printenv",
  "which",
  "type",
  "command",
  "seq",
  "expr",
  "xargs",
  "curl",
  "lsof",
  "diff",
  "md5",
  "shasum",
  "openssl",
  "less",
  "more",
  "fd",
  "tree",
  "yes",
  "read",
  ":",
]);

/**
 * Commands that do nothing but print the words they were given. A command made
 * of only these, with no expansion to read, cannot observe anything.
 */
const NO_OPS = new Set(["echo", "printf", "true", ":"]);

/** Read-only `git` subcommands. */
const GIT_READ_ONLY = new Set([
  "log",
  "status",
  "ls-remote",
  "branch",
  "show",
  "diff",
  "rev-parse",
  "rev-list",
  "describe",
  "cat-file",
  "ls-files",
  "remote",
  "shortlog",
  "blame",
  "merge-base",
  "for-each-ref",
  "config",
  "count-objects",
  "reflog",
  "symbolic-ref",
  "var",
]);

/**
 * Binaries that change the world. Presence of any makes the command progress.
 *
 * Migration tooling is deliberately absent: `migrationsGuard` sits ahead of this
 * one in the registry and the runner returns on the first deny, so such a command
 * never reaches `classify`.
 */
const MUTATORS = new Set([
  CLI_NAME,
  "bun",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "node",
  "tsc",
  "rm",
  "mv",
  "cp",
  "mkdir",
  "rmdir",
  "touch",
  "chmod",
  "chown",
  "ln",
  "tee",
  "patch",
  "make",
  "cargo",
  "go",
  "python",
  "python3",
  "pip",
  "docker",
  "psql",
  "createdb",
  "dropdb",
  "killall",
  "pkill",
  "vite",
  "esbuild",
  "prettier",
  "eslint",
]);

/**
 * Does this redirection actually persist anything? `>/dev/null` discards, and
 * treating that as a write would classify every `pgrep … >/dev/null 2>&1` waiter
 * as progress.
 *
 * Fd duplication is no longer this function's problem: the parser gives it its
 * own arm, so there is nothing here to remember. This used to test the target
 * for a leading `&` — knowledge one consumer held and the main-writes guard did
 * not, which is exactly how it came to block `… 2>&1`.
 */
function writesAFile(r: ShellRedirection): boolean {
  if (r.kind !== "file") return false;
  return (
    r.path !== "/dev/null" &&
    r.path !== "/dev/stderr" &&
    r.path !== "/dev/stdout"
  );
}

/**
 * Which of the three kinds this command is.
 *
 * The `neutral` arm is load-bearing. An unrecognised command must NOT count as
 * progress: an earlier version of this rule reset the window on anything it
 * could not classify, and so missed the largest loop in the corpus — 163 `pgrep`
 * calls whose only company was `uptime`. Unknown means unknown: neither a poll
 * nor a reason to forget the polls already seen.
 */
export function classify(cmd: string): CommandClass {
  const parsed = parseShell(cmd);
  const { calls, redirections } = parsed;
  if (redirections.some(writesAFile)) return "mutate";

  let allReadOnly = calls.length > 0;
  for (const call of calls) {
    if (call.name === "git") {
      const sub = call.args.find((a) => !a.startsWith("-"));
      if (sub && !GIT_READ_ONLY.has(sub)) return "mutate";
      continue;
    }
    if (call.name === "kill") {
      // `kill -0 <pid>` asks whether a process exists; every other form signals.
      if (!call.args.includes("-0")) return "mutate";
      continue;
    }
    if (MUTATORS.has(call.name)) return "mutate";
    if (!READ_ONLY.has(call.name)) allReadOnly = false;
  }

  if (allReadOnly && watchSubjectsFrom(parsed).length > 0) return "observe";
  return "neutral";
}

/**
 * The set of things this command is watching.
 *
 * Digits are normalised out so `tail -25` and `tail -40` name the same watch,
 * and two commands count as the same poll when their sets INTERSECT rather than
 * match. That is the whole fix: the guard this replaces keyed on the command
 * bytes, and real loops drift every call — `tail -25` → `-30` → `-35`, an extra
 * `pgrep` appended — so byte-equality caught 2 of 47 recorded loops.
 */
export function watchSubjects(cmd: string): WatchSubject[] {
  return watchSubjectsFrom(parseShell(cmd));
}

/** As `watchSubjects`, for a caller that has already parsed the command. */
export function watchSubjectsFrom(parsed: ShellParseResult): WatchSubject[] {
  // `code`, never the raw command: a research note that merely MENTIONS
  // `build-status.json` is not something the agent is watching, and a heredoc
  // body full of log paths is a document being written.
  const cmd = parsed.code;
  const out = new Set<WatchSubject>();
  const add = (re: RegExp, make: (m: RegExpMatchArray) => string) => {
    for (const m of cmd.matchAll(new RegExp(re.source, "g"))) out.add(make(m));
  };

  // A harness background task's captured output.
  add(/tasks\/([A-Za-z0-9_-]+)\.output/, (m) => `task:${m[1]}`);
  // A build's deploy receipt.
  if (/build-status\.json/.test(cmd)) {
    const wt = cmd.match(/worktrees\/([A-Za-z0-9_-]+)\/build-status/);
    out.add(`receipt:build:${wt?.[1] ?? "self"}`);
  }
  if (/build-[A-Za-z0-9_-]*\.log\b|build-progress\.jsonl/.test(cmd))
    out.add("log:build");
  add(/logs\/([a-z0-9-]+)\.jsonl/, (m) => `log:${m[1]}`);

  // Process probes read their target off the PARSED call: a pattern is routinely
  // quoted (`pgrep -f "singularity push"`), and a regex over the raw text stops
  // at the first space inside the quotes, splitting one watch into two.
  for (const call of parsed.calls) {
    if (call.name === "pgrep" || call.name === "pkill") {
      const pattern = call.args.find((a) => !a.startsWith("-"));
      if (pattern) out.add(`proc:${normalise(pattern)}`);
      continue;
    }
    if (call.name === "kill" && call.args.includes("-0")) {
      for (const a of call.args) if (/^\d+$/.test(a)) out.add(`pid:${a}`);
      continue;
    }
    if (call.name === "ps") {
      const pFlag = call.args.indexOf("-p");
      if (pFlag !== -1) {
        // `ps -p 94000,27674` — each pid is its own watch.
        for (const pid of (call.args[pFlag + 1] ?? "").split(",")) {
          if (/^\d+$/.test(pid)) out.add(`pid:${pid}`);
        }
      } else if (call.args.some((a) => a === "aux" || a === "-ef")) {
        out.add("proc:table");
      }
    }
  }
  // Remote git state — "has my push landed yet".
  if (
    /\bgit ls-remote\b|git branch -r --contains|git rev-parse origin\//.test(
      cmd,
    )
  ) {
    out.add("git:remote");
  }
  add(
    /(https?:\/\/[^\s"'|;&)]+)/,
    (m) => `url:${normalise(m[1]!).slice(0, 60)}`,
  );

  // A command that only sleeps is watching the clock. It names no file and no
  // process, so without this it has no subject at all and reads as `neutral` —
  // which let `sleep 300; echo TICK` repeat indefinitely. Only when nothing else
  // was found: `sleep 5 && curl …` is already identified by the thing it polls.
  if (out.size === 0 && parsed.calls.some((c) => c.name === "sleep")) {
    out.add("time:sleep");
  }

  // A command that does nothing at all is passing time too. Once `sleep` was
  // refused, the wait moved to `echo w1`, `echo w2`, … — 3,125 calls over six
  // hours in conv-1787490197-3p4n, each a full turn, none of them seen, because
  // naming no subject made them `neutral`. The counter in the text is why the
  // subject cannot be the words: every call differs.
  if (out.size === 0 && isNoOp(parsed)) out.add("time:no-op");

  return [...out];
}

function isNoOp(parsed: ShellParseResult): boolean {
  return (
    parsed.calls.length > 0 &&
    parsed.calls.every(
      (c) => NO_OPS.has(c.name) && !c.args.some((a) => a.includes("$")),
    )
  );
}

/**
 * True when every subject names no thing: the command waits on the clock or does
 * nothing. There is no file, process or task to ask "still running?", so no
 * further look can differ from the last one.
 */
export function watchesNothing(subjects: WatchSubject[]): boolean {
  return subjects.length > 0 && subjects.every((s) => s.startsWith("time:"));
}

function normalise(s: string): string {
  return s.replace(/\d+/g, "#").trim().slice(0, 48);
}

export interface WindowEntry {
  /** Epoch ms. */
  t: number;
  /** Subjects watched by that call. */
  s: WatchSubject[];
  /**
   * Newest mtime among the local files that call named, as of that call.
   *
   * What makes "is it still being written to" an exact question rather than a
   * timing guess: if every look in the window saw the same mtime, nothing
   * appended between the first look and this one. Absent when the command named
   * no file, named one that did not exist, or named an empty one — none of
   * which is evidence that a finished artefact is being read.
   */
  m?: number;
}

/** Calls remembered. Long enough to span a loop that interleaves other work. */
export const WINDOW_SIZE = 20;
/** Matching calls (including the incoming one) that constitute a loop. */
export const THRESHOLD = 4;
/** Two looks at the same file an hour apart are not a loop. */
export const WINDOW_MS = 30 * 60 * 1000;

export interface PollDecision {
  /** Subjects shared with the window — non-empty only when tripped. */
  repeated: WatchSubject[];
  tripped: boolean;
}

/**
 * Decide whether an incoming observation closes a polling loop, given the
 * window of prior observations. Pure: the caller owns the window.
 */
export function detectPoll(
  subjects: WatchSubject[],
  window: WindowEntry[],
  now: number,
): PollDecision {
  const live = window.filter((e) => now - e.t <= WINDOW_MS).slice(-WINDOW_SIZE);
  const repeated = new Set<WatchSubject>();
  let matches = 0;
  for (const entry of live) {
    const shared = entry.s.filter((s) => subjects.includes(s));
    if (shared.length === 0) continue;
    matches++;
    for (const s of shared) repeated.add(s);
  }
  return { repeated: [...repeated], tripped: matches + 1 >= THRESHOLD };
}

/** Prune a window to what `detectPoll` would still consider. */
export function pruneWindow(window: WindowEntry[], now: number): WindowEntry[] {
  return window.filter((e) => now - e.t <= WINDOW_MS).slice(-WINDOW_SIZE);
}
