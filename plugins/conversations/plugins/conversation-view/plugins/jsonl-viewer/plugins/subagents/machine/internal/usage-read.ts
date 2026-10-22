import { emptyUsageFold, foldUsageLine, type UsageFold } from "../../core";

/**
 * How far into one sub-agent transcript its token total has been read, and the
 * total so far.
 *
 * Unlike what it last did — a bounded tail read — a total needs every line.
 * So the read is incremental instead: a transcript is append-only, and each
 * change reads only the bytes appended since `offset`. A sub-agent that has run
 * for an hour costs one whole-file read when the conversation is first opened,
 * then a few kilobytes per append.
 */
export interface UsageScan {
  /** Byte offset of the first line not yet folded — always a line start. */
  offset: number;
  fold: UsageFold;
}

const NEWLINE = 0x0a;
const decoder = new TextDecoder();

/**
 * `prev` advanced over the complete lines `path` holds up to `size`.
 *
 * A trailing line with no newline yet is torn (Claude is mid-append): it is
 * left for the next read, which starts at its first byte. A file SHORTER than
 * the offset was replaced, not appended to, so the total starts over.
 */
export async function readUsageSince(
  path: string,
  size: number,
  prev: UsageScan | undefined,
): Promise<UsageScan> {
  if (prev !== undefined && size === prev.offset) return prev;
  // A copy, never `prev` itself: a read that throws halfway must not leave the
  // remembered total holding lines its offset says are still to be read.
  const scan =
    prev === undefined || size < prev.offset
      ? { offset: 0, fold: emptyUsageFold() }
      : {
          offset: prev.offset,
          fold: {
            totals: { ...prev.fold.totals },
            counted: new Set(prev.fold.counted),
          },
        };

  const bytes = await Bun.file(path).slice(scan.offset, size).bytes();
  const end = bytes.lastIndexOf(NEWLINE);
  if (end < 0) return scan;

  for (const raw of decoder.decode(bytes.subarray(0, end)).split("\n")) {
    if (raw === "") continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch (err) {
      // A complete line that is not JSON is not something this total can
      // count; it is the transcript reader's to report, not this one's.
      if (!(err instanceof SyntaxError)) throw err;
      continue;
    }
    if (typeof line === "object" && line !== null) {
      foldUsageLine(scan.fold, line as Record<string, unknown>);
    }
  }
  return { offset: scan.offset + end + 1, fold: scan.fold };
}
