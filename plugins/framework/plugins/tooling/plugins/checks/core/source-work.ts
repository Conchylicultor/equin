// The per-file work a check does on source text — masking and a TypeScript
// parse — as async calls that give the thread back before they work.
//
// Every check in a pass shares ONE JS thread (`thread-watch.ts`). A loop that
// masks or parses each candidate synchronously holds that thread for the whole
// loop: change-feed's TS parse of every candidate (3.3 s held per build) and
// investigate's re-mask of every candidate on each of its passes (~2 s) were
// exactly that. Here each call first awaits the thread's shared time slice, so
// a loop of them yields about every 10 ms by construction; and each result is
// kept for the process (one check process is one run), so a file masked by
// `grepCode` for one check, or parsed by one pass, is free for the next.
//
// Check code must use these, never `maskSource` / `createSourceFile` directly —
// the `check-thread-safety/no-blocking-check-work` lint rule holds it.

import type TS from "typescript";
import { createTimeSlicer } from "@plugins/packages/plugins/macrotask-yield/core";
import { maskSource } from "@plugins/plugin-meta/plugins/parse-utils/core";

/** A source a check works on: its repo-relative path and its text. */
export interface SourceText {
  rel: string;
  src: string;
}

// ONE budget for the thread, not one per loop: the thread is what every check
// shares, so the run of synchronous work between two yields is bounded across
// all of them, however their continuations interleave.
const threadSlice = createTimeSlicer();

/**
 * Yield a macrotask if ~10 ms of synchronous work has run on the check thread
 * since its last yield; resolve at once otherwise. Await it between units of
 * per-item work a check does itself (a scan over a file it already has).
 */
export function sliceCheckThread(): Promise<void> {
  return threadSlice();
}

/**
 * A per-path memo whose entry is valid only for the exact text it was derived
 * from — a file read off another tree, or edited, recomputes. String equality
 * is a pointer check when both sides are the same read.
 */
function textMemo<T>(): {
  get(source: SourceText): T | undefined;
  set(source: SourceText, value: T): void;
} {
  const entries = new Map<string, { src: string; value: T }>();
  return {
    get(source) {
      const hit = entries.get(source.rel);
      return hit !== undefined && hit.src === source.src
        ? hit.value
        : undefined;
    },
    set(source, value) {
      entries.set(source.rel, { src: source.src, value });
    },
  };
}

const masked = { code: textMemo<string>(), strings: textMemo<string>() };

/**
 * `maskSource(source.src, opts)` — comments (and, by default, string interiors)
 * blanked, offsets kept — after yielding the check thread's slice, and kept for
 * the run.
 */
export async function maskedSource(
  source: SourceText,
  opts?: { strings?: boolean },
): Promise<string> {
  const memo = (opts?.strings ?? true) ? masked.strings : masked.code;
  const hit = memo.get(source);
  if (hit !== undefined) return hit;
  await sliceCheckThread();
  const out = maskSource(source.src, opts);
  memo.set(source, out);
  return out;
}

const parsed = textMemo<TS.SourceFile>();

/**
 * `source` parsed as TypeScript (parent pointers set, `ScriptTarget.Latest`),
 * after yielding the check thread's slice, and kept for the run: every pass of
 * every check that parses the same file shares one tree. `ts` is the caller's
 * own lazily-loaded `typescript`, so loading this module costs no parser.
 */
export async function parsedTsSource(
  ts: typeof TS,
  source: SourceText,
): Promise<TS.SourceFile> {
  const hit = parsed.get(source);
  if (hit !== undefined) return hit;
  await sliceCheckThread();
  const out = ts.createSourceFile(
    source.rel,
    source.src,
    ts.ScriptTarget.Latest,
    true,
  );
  parsed.set(source, out);
  return out;
}
