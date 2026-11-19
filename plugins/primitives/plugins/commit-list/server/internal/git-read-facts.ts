import type { WaitDetail } from "@plugins/infra/plugins/runtime-profiler/core";

// What a git child read, told to the profiler as its wait ends
// (`beginDescribedWait`), so a slow `wait git:<subcommand>` names the checkout
// and whether git's fsmonitor spared it the scan — not only the layer.
//
// - The CHECKOUT KIND is the variant: a closed set, so slow-ops' per-variant
//   aggregate splits a layer's slow time by where it was read (main's served
//   slots have no fsmonitor; agent checkouts do; main's root does since D12).
// - For a subcommand that reads the index, git's own trace2 says whether the
//   fsmonitor answered the index token (`answered`: git stats only what it
//   names), answered "everything" (`trivial`: a token the daemon did not issue
//   — a resync, a dead daemon — so a full scan), or was not asked (`off`), and
//   how many files the read stat'ed (`lstats`): the cost the fsmonitor exists
//   to remove, ~26k on this repo for a full scan, a handful when it answered.
// - The checkout path is the subject (kept off the aggregate, on the trace).
//
// Pure string work on purpose: this runs on `server/`, which reaches no
// filesystem. The kind is read off the path's layout, plus — for an index read
// — the index file git names in its trace (`<root>/.git/index` is a
// repository's own main checkout; a linked one's sits under `.git/worktrees/`).

/** Where a git child read. */
export type CheckoutKind =
  "main slot" | "main root" | "agent checkout" | "spare" | "other checkout";

/** Whether git asked its fsmonitor, and what it answered. */
export type FsmonitorAnswer = "answered" | "trivial" | "off";

// The subcommands that read (and refresh) the index — the reads fsmonitor can
// spare a scan. Others (rev-parse, merge-base, log, …) read objects and refs
// only: no trace2 for them, nothing to learn.
const INDEX_READERS = new Set([
  "status",
  "diff",
  "diff-files",
  "diff-index",
  "ls-files",
]);

/** The env additions that make git report its index read (`null`: none). */
export function indexTraceEnv(
  subcommand: string,
): Record<string, string> | null {
  if (!INDEX_READERS.has(subcommand)) return null;
  return {
    // trace2's event stream on stderr (fd 2), split back out below. Brief
    // (no file / line / time fields) and only two regions deep: the fsmonitor
    // query and the stat counts sit at depth ≤ 2, ~10 KB a status. A daemon
    // git auto-starts inherits it, with its stdio on /dev/null.
    GIT_TRACE2_EVENT: "2",
    GIT_TRACE2_EVENT_BRIEF: "1",
    GIT_TRACE2_EVENT_NESTING: "2",
  };
}

const TRACE_LINE_PREFIX = '{"event":';

/** What git's trace2 stream said about one index read. */
export interface IndexReadFacts {
  fsmonitor: FsmonitorAnswer;
  /** lstat calls the read made (preload + refresh). */
  lstats: number;
  /** The index file it read (`do_read_index`) — relative to the checkout for a main root. */
  indexPath: string;
}

interface Trace2Event {
  event?: string;
  key?: string;
  value?: string;
  label?: string;
  msg?: string;
}

// One trace line, or null when it is not one: a line cut short or interleaved
// (a nested git child shares fd 2) is git's stderr to keep, never a throw out
// of a read that worked.
function parseTraceLine(line: string): Trace2Event | null {
  if (!line.startsWith(TRACE_LINE_PREFIX)) return null;
  try {
    return JSON.parse(line) as Trace2Event;
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/**
 * Split a traced child's stderr: git's own messages back as `stderr` (what a
 * `GitError` quotes), and the facts its trace2 events carried — `null` when
 * the command read no index (a tree-to-tree `diff A B`, `--no-index`).
 */
export function splitIndexTrace(stderr: string): {
  stderr: string;
  facts: IndexReadFacts | null;
} {
  const kept: string[] = [];
  let queried = false;
  let trivial = false;
  let lstats = 0;
  let indexPath: string | null = null;
  for (const line of stderr.split("\n")) {
    const event = parseTraceLine(line);
    if (event === null) {
      kept.push(line);
      continue;
    }
    if (event.event === "region_enter" && event.label === "do_read_index") {
      indexPath ??= event.msg ?? null;
      continue;
    }
    if (event.event !== "data") continue;
    if (event.key === "query/command") queried = true;
    else if (event.key === "query/trivial-response" && event.value !== "0")
      trivial = true;
    else if (
      event.key === "preload/sum_lstat" ||
      event.key === "refresh/sum_lstat"
    )
      lstats += Number(event.value);
  }
  return {
    stderr: kept.join("\n"),
    facts:
      indexPath === null
        ? null
        : {
            fsmonitor: !queried ? "off" : trivial ? "trivial" : "answered",
            lstats,
            indexPath,
          },
  };
}

/** `path`'s segments, `.` and trailing slashes dropped. */
function segments(path: string): string[] {
  return path.split("/").filter((s) => s !== "" && s !== ".");
}

/**
 * Which kind of checkout `cwd` is, from its path: a main slot
 * (`…/main-slots/slot-<n>`, main-slots' layout), an agent checkout or a spare
 * (a direct child of `…/.claude/worktrees/`, a spare named `spare-…`), a
 * repository's own main checkout when the index git read is its `.git/index`
 * (git names it relative to the checkout, `.git/index`; a linked checkout's is
 * absolute, under `.git/worktrees/`), else another checkout.
 */
export function checkoutKindOf(
  cwd: string,
  indexPath: string | null,
): CheckoutKind {
  const seg = segments(cwd);
  const name = seg.at(-1) ?? "";
  const parent = seg.at(-2);
  if (parent === "main-slots" && /^slot-\d+$/.test(name)) return "main slot";
  if (parent === "worktrees" && seg.at(-3) === ".claude") {
    return name.startsWith("spare-") ? "spare" : "agent checkout";
  }
  if (indexPath !== null) {
    const index = indexPath.startsWith("/")
      ? segments(indexPath)
      : [...seg, ...segments(indexPath)];
    if (index.join("/") === [...seg, ".git", "index"].join("/")) {
      return "main root";
    }
  }
  return "other checkout";
}

/** The wait's detail: the checkout kind, and the index read's facts when traced. */
export function gitWaitDetail(
  cwd: string,
  facts: IndexReadFacts | null,
): WaitDetail {
  const kind = checkoutKindOf(cwd, facts?.indexPath ?? null);
  if (facts === null) return { variant: kind, subject: cwd };
  return {
    variant: `${kind} · fsmonitor ${facts.fsmonitor}`,
    measures: { lstats: facts.lstats },
    subject: cwd,
  };
}
