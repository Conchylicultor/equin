// The shared shape of a bounded-append file sink.
//
// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: the impl next door owns
// `node:fs`. This plugin must never be imported from `web/`.

import type { JsonlTailResult, TailOptions, TailResult } from "./read";

/**
 * Who reads a durable sink — a required, REVIEWED classification on every
 * declaration, so a durable signal can never again be persisted and consumed by
 * nothing (the 2026-07-17 never-ready boot). `reportKind` / `timelineSource` are
 * opaque strings here (this primitive names neither reports nor the timeline);
 * `durable-signals-accounted` validates them against the live `ReportKind`s and
 * `TIMELINE_SOURCES`. `note` says honestly what reads the file — or that
 * nothing durable does.
 */
export type SinkConsumer =
  /** A failure signal filed as a report (and, optionally, also drawn on the timeline). */
  | {
      kind: "report";
      reportKind: string;
      timelineSource?: string;
      note: string;
    }
  /** A continuous series drawn on the debug timeline — never a report. */
  | { kind: "timeline"; timelineSource: string; note: string }
  /** Read by a specific pane or surface; no failure funnel. */
  | { kind: "rendering-only"; note: string }
  /** Diagnostic prose with no durable consumer. */
  | { kind: "internal"; note: string };

/** Declaration of a file sink. `path` is an ABSOLUTE live-file path the caller owns. */
export interface FileSinkSpec {
  /** Stable, unique id — the registry key and the `file:${id}` growth-bound key. */
  id: string;
  /** Human-readable purpose of the sink (for the undeclared-growth monitor). */
  description: string;
  /** Who reads this file — validated by `durable-signals-accounted`. */
  consumer: SinkConsumer;
  /** Absolute path of the live file. Rotations are `path.1` … `path.N`. */
  path: string;
  /** Rotate once the live file would exceed this. Defaults to 128 MB. */
  maxBytes?: number;
  /** How many rotated files to keep (`path.1` … `path.keep`). Defaults to 3. */
  keep?: number;
}

/**
 * A rotation bound. TRUE by construction: `append()` IS the rotation, so a sink
 * that exists is a sink whose file is bounded — there is no "declared but
 * unbounded" state to represent. Structurally identical to retention's
 * `GrowthBound` `rotate` constructor, so a sink's bound is a growth bound.
 */
export interface RotateBound {
  kind: "rotate";
  maxBytes: number;
  keep: number;
}

/** A live, bounded-append file sink. `append` writes `line + "\n"`, rotating at the cap. */
export interface FileSink {
  id: string;
  path: string;
  bound: RotateBound;
  append(line: string): void;
  /**
   * Append MANY lines as ONE write — the batch form of `append`, and the reason a
   * caller holding an array never has to loop. Semantics are byte-for-byte what
   * `for (const l of lines) append(l)` produces: the size gate runs per ROTATION
   * GROUP, so every `appendFileSync` payload is a whole number of `\n`-terminated
   * lines and a rotation only ever happens BETWEEN two of them. An empty array
   * writes nothing (and creates neither file nor directory).
   *
   * SINGLE-WRITER FILES ONLY. One batched write is not covered by the `O_APPEND`
   * whole-line atomicity that host-global files (`op-log`, `build-progress`,
   * `check-progress`) rely on to interleave lines from concurrent processes —
   * those must keep using `append`, one line per call.
   */
  appendAll(lines: readonly string[]): void;
  /**
   * Bounded tail read of this sink's own file — the read counterpart of `append`.
   * Binding it to the sink removes the chance of reading a sink from the wrong
   * path. Same semantics as the free `readTail(path, opts)`; the read budget comes
   * from `opts` (8 MB default), NOT from `bound.maxBytes`.
   */
  readTail(opts?: TailOptions): TailResult;
  /** `readTail` with each line tolerantly `JSON.parse`d into a `T`. */
  readJsonlTail<T>(opts?: TailOptions): JsonlTailResult<T>;
}
