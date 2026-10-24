import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * How many bytes of ONE run's transcript reach the log channel.
 *
 * The bound is on what is PUBLISHED, not on what the child writes, and the
 * distinction is the honest one: the transcript file is a plain kernel fd the
 * child owns, so nothing this process does can cap it mid-run without racing
 * the writer. What this ceiling protects is the thing a runaway run would
 * otherwise take down with it — the channel's in-memory ring and its durable
 * `.jsonl` sink, which every OTHER channel shares a rotation budget with.
 *
 * 16 MiB is far above any real build, release or deploy transcript (a full
 * `./equin build` is low single-digit MB) and far below the point where
 * publishing it costs anything. The transcript FILE's own bound is the artifact
 * prune: the newest 50 runs per kind per worktree, reaped when the next run
 * starts. A single pathological run's file is bounded only by that run.
 */
export const TRANSCRIPT_CEILING_BYTES = 16 * 1024 * 1024;

/** Bytes read per `readSync`, so one pump of a large backlog stays chunked. */
const READ_CHUNK_BYTES = 256 * 1024;

/** The one line that tells a reader the rest of this run's output is on disk only. */
const TRUNCATED_NOTICE =
  "(transcript truncated — this run has produced more output than the live log " +
  "will carry; the full transcript is on disk)";

export interface TranscriptTail {
  /**
   * Read whatever the child has appended since the last call and publish the
   * complete lines. Synchronous and cheap when nothing moved (one `fstat`), so
   * it is safe to call from a watcher callback.
   */
  pump(): void;
  /**
   * Drain the file one last time, flush a trailing partial line, and stop.
   * Idempotent — settling a run and tearing down the watcher both reach it.
   */
  stop(): void;
}

/**
 * Publish a supervised run's output by tailing its transcript file.
 *
 * **This is the whole design, not an implementation detail.** The child's
 * stdout and stderr go to a file descriptor rather than a pipe, and this is the
 * only thing that turns those bytes into log-channel lines. A pipe belongs to
 * the process that created it, so a pipe-shaped live path needs a second,
 * artifact-shaped recovery path beside it — and the recovery path is the one
 * that rots, because nothing exercises it until something has already gone
 * wrong. That is precisely what happened to release, whose recovery artifact
 * only the parent ever wrote, so a genuinely orphaned release had nothing to
 * read and got stamped `-1`.
 *
 * With one path there is nothing to fall back to, so nothing can be
 * under-maintained: a backend restart stops being a special case and becomes
 * "the same tailer, started again". Both current callers start at offset 0 —
 * the spawn-time caller because the file is new, and the boot re-attach caller
 * because the channel's ring buffer is process memory and is empty again, so
 * republishing from the top is what puts the output back on the user's screen.
 * `fromOffset` stays in the contract because it is a genuine property of a
 * tail, not because either caller needs a different value today.
 *
 * Change detection is NOT this module's business — it holds no timer and
 * subscribes to nothing. The supervisor owns one `@parcel/watcher`
 * subscription over the run-artifact directory and calls `pump()`; the repo
 * bans polling, and one watcher for every live run of every kind is the shape
 * that keeps it banned. That watcher must report writes to a file the child
 * still holds open (`writesWhileOpen`): macOS FSEvents otherwise reports them
 * only at close, which is the child's exit. The cost is the watcher's debounce
 * — at most about a second under continuous output — which is imperceptible
 * against a build log.
 */
export function createTranscriptTail(opts: {
  path: string;
  fromOffset: number;
  /** Publish complete lines, in order. Called with at least one line. */
  publish: (lines: readonly string[]) => void;
  ceilingBytes?: number;
}): TranscriptTail {
  const { path, publish } = opts;
  const ceilingBytes = opts.ceilingBytes ?? TRANSCRIPT_CEILING_BYTES;

  let offset = opts.fromOffset;
  let publishedBytes = 0;
  let stopped = false;
  let truncated = false;
  // Held across pumps so a multi-byte character split across a read boundary is
  // reassembled rather than turned into two replacement characters.
  const decoder = new TextDecoder("utf-8");
  // The tail of the file when it does not end in a newline: a line the child is
  // still writing. Held back until its newline arrives, or flushed by `stop()`.
  let partial = "";

  /**
   * Publish every COMPLETE line in `text`, holding the rest back.
   *
   * A blank line in the transcript is published as a blank line rather than
   * dropped: with the partial carried across pumps, an empty piece is genuine
   * content, not the artefact of splitting a chunk. (The pipe-shaped loops this
   * replaces had to drop empties, because every chunk ended in a spurious one.)
   */
  function emit(text: string): void {
    partial += text;
    const pieces = partial.split("\n");
    partial = pieces.pop() ?? "";
    if (pieces.length > 0) publish(pieces);
  }

  function pump(): void {
    if (stopped || truncated) return;
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (err) {
      // The transcript is created before the child is spawned, so ENOENT here
      // means the artifact prune reaped it (a run outlived 50 newer runs of its
      // own kind) or someone removed it by hand. Nothing to read; the run still
      // settles from its exit marker or its pid.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < offset) {
        // The file got shorter, which an append-only transcript cannot do. A
        // run id was reused, or something truncated the file underneath us.
        // Re-read from the top rather than silently publishing nothing: a
        // duplicated stretch of output is legible, a stalled log is not.
        console.warn(
          `[supervised-run] transcript shrank (${size} < ${offset}), re-reading from the start: ${path}`,
        );
        offset = 0;
        partial = "";
      }
      while (offset < size) {
        const want = Math.min(READ_CHUNK_BYTES, size - offset);
        const buf = Buffer.allocUnsafe(want);
        const read = readSync(fd, buf, 0, want, offset);
        if (read <= 0) break;
        offset += read;
        publishedBytes += read;
        emit(decoder.decode(buf.subarray(0, read), { stream: true }));
        if (publishedBytes >= ceilingBytes) {
          truncated = true;
          // Whatever is half-written stays unpublished: the notice has to be
          // the last thing on the channel, or a reader sees output after being
          // told there is none.
          partial = "";
          publish([TRUNCATED_NOTICE]);
          return;
        }
      }
    } finally {
      closeSync(fd);
    }
  }

  return {
    pump,
    stop(): void {
      if (stopped) return;
      pump();
      stopped = true;
      // A child killed mid-line leaves its last line without a newline. Flush
      // it: the final line of a failing run is usually the one that says why.
      if (!truncated && partial !== "") publish([partial]);
      partial = "";
    },
  };
}
