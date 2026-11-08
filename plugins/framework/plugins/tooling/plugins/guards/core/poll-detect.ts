import {
  parseShell,
  type ShellCall,
  type ShellParseResult,
  type ShellRedirection,
} from "./parse-shell";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";

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
  // One subject per log FILE, never one per family. A family subject
  // (`log:build` once stood for every build's log AND the host-wide build
  // timeline) makes reading three finished builds' logs, one after another,
  // the same "thing" — and the looks then disagree on mtime, so nothing about
  // any one of them could ever be answered (task-1794163688-i0vy9o was blocked
  // twice this way, mid-investigation).
  //
  // A supervised run's transcript (`runs/<kind>-<run>.log`) keeps the path as
  // written: the guard answers it from the run's terminal marker beside it,
  // and the command often names it through a variable (`L=…/x.log; rg … $L`)
  // that no operand parse resolves.
  add(RUN_TRANSCRIPT_RE, (m) => `${RUN_SUBJECT}${m[1]}`);
  add(
    /(?<!runs\/)(?<![A-Za-z0-9_-])((?:build|check)-[A-Za-z0-9_-]+)\.log\b/,
    (m) => `log-file:${m[1]}`,
  );
  if (/build-progress\.jsonl/.test(cmd)) out.add("log:build-progress");
  add(/logs\/([a-z0-9-]+)\.jsonl/, (m) => `log:${m[1]}`);

  // Process probes read their target off the PARSED call: a pattern is routinely
  // quoted (`pgrep -f "equin push"`), and a regex over the raw text stops
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

/**
 * A supervised run's transcript as the command spells it: everything up to
 * `runs/<kind>-<run>`, the `.log` suffix cut off. The path text is the subject
 * so the guard can find the run's terminal marker beside it.
 */
const RUN_TRANSCRIPT_RE =
  /((?:~|\$\{?HOME\}?)?[^\s"'|;&()<>=$`]*?runs\/[A-Za-z0-9_-]+)\.log\b/;

/** The prefix of a run-transcript subject; what follows it is the path stem. */
export const RUN_SUBJECT = "run:";

/**
 * Subjects naming an append-only timeline — a JSONL log whose lines are only
 * ever added at its end, each stamped with when it was written (the build
 * timeline, a `logs/<channel>.jsonl`). A flat build log (`log-file:`) is not
 * one: its lines carry no time to select by. A slice of one that
 * ended in the past can no longer change, however busy its writers are.
 */
export function isTimelineSubject(s: WatchSubject): boolean {
  return s.startsWith(TIMELINE_SUBJECT);
}

const TIMELINE_SUBJECT = "log:";

/**
 * The end of the time window this command pins, when it reads a timeline only
 * through timestamps that are all in the past: `rg '"t":"2026-11-08T18:4[67]'
 * build-progress.jsonl` reads the lines written at 18:40–18:49 UTC, a slice an
 * append-only log can no longer grow, however many builds append to it now.
 *
 * Read off the LITERAL prefix of each timestamp — digits up to the first
 * character that is not part of one (`[`, `.`, `*`). That prefix spans at least
 * the window the pattern selects (a `[67]` after it only narrows it), so its
 * end is an upper bound. UTC, as every timeline here writes.
 *
 * `null` — the window is open, or not known to be a window — unless every
 * date-looking word in the command is a parsed timestamp in a positive `rg` /
 * `grep` pattern, and every one is closed. A date anywhere else (`rg -v`, an
 * `echo`, a flag of another tool) selects nothing, and one live alternative
 * still matches new lines.
 */
export function closedWindowEnd(
  parsed: ShellParseResult,
  now: number,
): number | null {
  let latest: number | null = null;
  for (const call of parsed.calls) {
    for (const arg of call.args) {
      const dates = arg.match(DATE_LIKE_RE)?.length ?? 0;
      if (dates === 0) continue;
      const stamps = [...arg.matchAll(ISO_PREFIX_RE)];
      if (stamps.length !== dates || !filtersBy(call)) return null;
      for (const m of stamps) {
        const end = windowEnd(m);
        if (end > now) return null;
        latest = Math.max(latest ?? 0, end);
      }
    }
  }
  return latest;
}

/** A search whose pattern selects the lines it prints. */
function filtersBy(call: ShellCall): boolean {
  if (call.name !== "rg" && call.name !== "grep") return false;
  return !call.args.some(
    (a) =>
      a === "--invert-match" || (/^-[A-Za-z]+$/.test(a) && a.includes("v")),
  );
}

/** Anything that starts like a date — parsed or not. */
const DATE_LIKE_RE = /\b\d{4}-\d/g;

const ISO_PREFIX_RE =
  /\b(\d{4})-(\d{2})-(\d{2})(?:T(\d)(\d)?(?::(\d)(\d)?(?::(\d)(\d)?)?)?)?/g;

/** One past the last instant of the window a timestamp prefix names, in ms. */
function windowEnd(m: RegExpMatchArray): number {
  const [, y, mo, d, h1, h2, mi1, mi2, s1, s2] = m;
  const n = (v: string | undefined) => Number(v ?? 0);
  const startOf = (h: number, mi: number, s: number) =>
    Date.UTC(n(y), n(mo) - 1, n(d), h, mi, s);
  if (h1 === undefined) return startOf(0, 0, 0) + DAY;
  if (h2 === undefined) return startOf(n(h1) * 10, 0, 0) + 10 * HOUR;
  const h = n(h1) * 10 + n(h2);
  if (mi1 === undefined) return startOf(h, 0, 0) + HOUR;
  if (mi2 === undefined) return startOf(h, n(mi1) * 10, 0) + 10 * MINUTE;
  const mi = n(mi1) * 10 + n(mi2);
  if (s1 === undefined) return startOf(h, mi, 0) + MINUTE;
  if (s2 === undefined) return startOf(h, mi, n(s1) * 10) + 10 * SECOND;
  return startOf(h, mi, n(s1) * 10 + n(s2)) + SECOND;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function isNoOp(parsed: ShellParseResult): boolean {
  return (
    parsed.calls.length > 0 &&
    parsed.calls.every(
      (c) => NO_OPS.has(c.name) && !c.args.some((a) => a.includes("$")),
    )
  );
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
