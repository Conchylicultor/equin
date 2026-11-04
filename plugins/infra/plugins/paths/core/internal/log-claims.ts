// Log claims: which log files a data dir holds, and what keeps each finite.
//
// A log file grows by construction: something appends to it forever. The
// repo's answer is a writer that rotates as it appends — `defineFileSink`
// (`infra/file-sink`), the gateway's `rotatingWriter` — so the bound is how the
// file is written, not a sweep after the fact. But nothing used to tie a FILE on
// disk to such a writer, so a daemon handed a log path (Postgres's `pg_ctl -l`,
// PgBouncer's `logfile`) grew to gigabytes unnoticed, and so did the per-file
// bounded but never-deleted logs of every reaped namespace.
//
// A claim is that tie, declared on the data dir that holds the file:
// `paths:logs-claimed` fails on every log file under a scanned data dir that no
// claim matches. The writer side is not re-verified — a `file-sink` claim
// trusts that the sink is one — but a NEW unbounded writer can no longer appear
// without someone writing down what bounds it, at review.
//
// Design: research/2026-11-04-global-unclaimed-log-files.md.

/** What keeps a claimed log file finite. */
export type LogBound =
  /** Appended through `defineFileSink` / `openDynamicSink`: the append rotates. */
  | { kind: "file-sink" }
  /** Written by the gateway's `rotatingWriter` (`gateway/logwriter.go`), the service log relay included. */
  | { kind: "gateway-rotating" }
  /** Rotated by its own writer, outside the repo's primitives (a host script): how. */
  | { kind: "rotates-itself"; how: string }
  /** Truncated each time its writer starts; unbounded within one run, and says why that is acceptable. */
  | { kind: "truncate-on-start"; reason: string }
  /** Not bounded yet: the reason, and the task that bounds it. */
  | { kind: "debt"; reason: string; task: string };

/**
 * One family of log files inside a data dir. `pattern` is relative to the dir,
 * `/`-separated: `*` matches within one path segment, `**` across segments.
 * A file's rotations (`<file>.1`, `<file>.2`, …) match the pattern implicitly.
 */
export interface LogClaim {
  pattern: string;
  bound: LogBound;
}

/** A file the scan treats as a log: `*.log` / `*.jsonl`, and their numbered rotations. */
export const LOG_FILE_RE = /\.(log|jsonl)(\.[0-9]+)?$/;

/** A log path with its rotation suffix dropped (`a/b.log.3` → `a/b.log`). */
export function liveLogPath(rel: string): string {
  return rel.replace(/(\.(?:log|jsonl))\.[0-9]+$/, "$1");
}

const compiled = new Map<string, RegExp>();

/** Whether `rel` (relative to the claiming dir, `/`-separated) is in `pattern`'s family. */
export function logPatternMatches(pattern: string, rel: string): boolean {
  let re = compiled.get(pattern);
  if (!re) {
    const body = pattern
      .split("**")
      .map((part) =>
        part
          .split("*")
          .map((lit) => lit.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*"),
      )
      .join(".*");
    re = new RegExp(`^${body}$`);
    compiled.set(pattern, re);
  }
  return re.test(liveLogPath(rel));
}

/**
 * A claim as the per-namespace data-dirs manifest publishes it, so the audit in
 * another checkout honours a claim this branch declares and that one does not
 * yet: `<kind>/<name>:<pattern>`.
 */
export function publishedLogClaim(key: string, pattern: string): string {
  return `${key}:${pattern}`;
}
