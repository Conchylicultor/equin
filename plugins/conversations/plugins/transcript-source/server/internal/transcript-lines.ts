import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import type { JsonlEvent } from "../../core";
import { slimApiRequestLine } from "./api-request";
import {
  base64ImageSize,
  encodeImageKey,
  visitInlineImages,
} from "./image-key";
import { buildJsonlEvents, type TranscriptImageReader } from "./parse-jsonl";
import { transcriptSlicer } from "./slicing";

const NEWLINE = 0x0a;

/** The whole chain: every catch-up and event build takes this one lock. */
const CHAIN = "chain";

/**
 * Bytes `[from, to)` of a chain file, from the host's storage — what
 * `TranscriptLines.catchUp` reads a file's unconsumed tail through.
 */
export type TranscriptByteRead = (
  from: number,
  to: number,
) => Promise<Uint8Array>;

/**
 * A session chain's lines, read a file at a time and a chunk at a time: what a
 * host keeps between two reads of a transcript, so a change costs the bytes it
 * appended rather than the whole chain.
 *
 * - **Append-only, in chain order.** `catchUp(file, size, read)` reads the
 *   bytes of `file` it has not consumed yet, up to `size`, decodes their
 *   complete lines and leaves an incomplete last line for the next call (the
 *   CLI terminates every line). The lines track what they consumed, so a host
 *   only says how big the file is now — two reads racing over one file cannot
 *   decode the same bytes twice. A file caught up for the first time goes after
 *   every line already held, so only the chain's LAST file may grow, or a new
 *   file follow it. Anything else (a file that shrank or was replaced, an
 *   earlier file that grew) is a new `TranscriptLines`: the host's call, since
 *   only it sees the files.
 * - **One at a time, never in one block.** Catch-ups and event builds run in
 *   call order under one lock, so `events()` sees every catch-up asked for
 *   before it and never a half-decoded chunk; and each yields the thread about
 *   every 10 ms (`transcriptSlicer`), so a cold read of a 50 MB chain — or of
 *   every chain a server boot opens — never holds the event loop.
 * - **Merged as a chain.** A uuid already held is skipped — a forked session
 *   copies its ancestor's lines verbatim (`mergeChainLines`' rule).
 * - **Held slim.** A line is held without what no event reads: its inline
 *   images become keys (`image-key.ts`: the page loads them by URL), a tool
 *   result's images (never shown) and `toolUseResult` (read only for an
 *   AskUserQuestion answer) are dropped, and so is a line with neither a uuid
 *   nor a timestamp (`api-request-blob`, `mode`, …: not in the branch forest,
 *   and skipped by the event builder). In a 52 MB transcript that is most of it.
 * - **Events from the held lines**, built once per change (`events()`): the
 *   builder's cross-line state — the live branch, a tool call and its later
 *   result, a message split over lines — always sees the whole chain, so an
 *   incremental read can never answer differently from a full one.
 */
export class TranscriptLines {
  private readonly held: Record<string, unknown>[] = [];
  private readonly seenUuids = new Set<string>();
  private readonly consumedByFile = new Map<string, number>();
  private built: { version: number; events: Promise<JsonlEvent[]> } | null =
    null;
  private version = 0;
  private readonly lock = createKeyedMutex();

  constructor(private readonly readImage: TranscriptImageReader) {}

  /** The files appended so far, in chain order. */
  files(): string[] {
    return [...this.consumedByFile.keys()];
  }

  /** How many bytes of `file` were consumed — the offset its next append starts at. */
  consumed(file: string): number {
    return this.consumedByFile.get(file) ?? 0;
  }

  /** The held lines, in chain order — as of the catch-ups that have settled. */
  lines(): readonly Record<string, unknown>[] {
    return this.held;
  }

  /**
   * Catch `file` up to `size` bytes: read what was not consumed of it yet
   * through `read` and decode its complete lines. Returns how many lines it
   * added (a line already held, or one no event reads, adds none; a file
   * already consumed to `size` reads nothing).
   */
  catchUp(
    file: string,
    size: number,
    read: TranscriptByteRead,
  ): Promise<number> {
    return this.lock.run(CHAIN, async () => {
      const from = this.consumed(file);
      if (size <= from) return 0;
      return this.decode(file, from, await read(from, size));
    });
  }

  /** The transcript's events, built from the held lines (once per change). */
  events(): Promise<JsonlEvent[]> {
    return this.lock.run(CHAIN, () => {
      if (this.built?.version !== this.version) {
        this.built = {
          version: this.version,
          events: buildJsonlEvents(this.held, this.readImage),
        };
      }
      return this.built.events;
    });
  }

  /** Decode the complete lines of `bytes` — `file`'s bytes from `offset`. Runs under the lock. */
  private async decode(
    file: string,
    offset: number,
    bytes: Uint8Array,
  ): Promise<number> {
    const slice = transcriptSlicer();
    const decoder = new TextDecoder();
    let added = 0;
    let start = 0;
    for (;;) {
      const end = bytes.indexOf(NEWLINE, start);
      if (end === -1) break;
      if (end > start) {
        const line = decodeLine(decoder.decode(bytes.subarray(start, end)));
        if (line && this.keep(line, file, offset + start, end - start)) {
          added += 1;
        }
      }
      start = end + 1;
      await slice();
    }
    this.consumedByFile.set(file, offset + start);
    if (added > 0) this.version += 1;
    return added;
  }

  private keep(
    line: Record<string, unknown>,
    file: string,
    offset: number,
    length: number,
  ): boolean {
    const uuid = typeof line.uuid === "string" ? line.uuid : null;
    if (uuid) {
      if (this.seenUuids.has(uuid)) return false;
      this.seenUuids.add(uuid);
    } else if (typeof line.timestamp !== "string") {
      return false;
    }
    let n = 0;
    visitInlineImages(line, (image) => {
      image.replace({
        key: encodeImageKey({ kind: "line", file, offset, length, uuid, n }),
        mime: image.mime,
        ...base64ImageSize(image.base64),
      });
      n += 1;
    });
    dropUnreadPayloads(line);
    slimApiRequestLine(line);
    this.held.push(line);
    return true;
  }
}

/** One line's JSON, or null for a line that is not JSON (skipped, as `mergeChainLines` always has). */
function decodeLine(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
}

/**
 * Drop what the event builder never reads: a tool result's image blocks
 * (`extractText` keeps text only — the first one's size is kept, as the
 * block's `image_size`, for `ToolCallResult.imageSize`) and `toolUseResult`,
 * but for the answer an answered AskUserQuestion carries in it
 * (`extractQuestionAnswer`).
 */
function dropUnreadPayloads(line: Record<string, unknown>): void {
  const message = line.message as { content?: unknown } | undefined;
  if (Array.isArray(message?.content)) {
    for (const block of message.content as ({
      type?: unknown;
      content?: unknown;
      image_size?: unknown;
    } | null)[]) {
      if (block?.type === "tool_result" && Array.isArray(block.content)) {
        const parts = block.content as ({
          type?: unknown;
          source?: { type?: unknown; data?: unknown };
        } | null)[];
        const first = parts.find(
          (part) =>
            part?.type === "image" &&
            part.source?.type === "base64" &&
            typeof part.source.data === "string",
        );
        if (first) {
          const size = base64ImageSize(first.source!.data as string);
          if (size.width !== undefined) block.image_size = size;
        }
        block.content = parts.filter((part) => part?.type !== "image");
      }
    }
  }
  const result = line.toolUseResult;
  if (result === undefined) return;
  if (
    typeof result === "object" &&
    result !== null &&
    "questions" in result &&
    "answers" in result
  ) {
    const { answers, annotations, response } = result as Record<
      string,
      unknown
    >;
    line.toolUseResult = { questions: null, answers, annotations, response };
  } else {
    delete line.toolUseResult;
  }
}

const noImages: TranscriptImageReader = () => Promise.resolve(null);

/**
 * Merge a conversation's chained transcript files — each read whole — into one
 * line array, in chain order, keeping the first copy of each `uuid`: a one-off
 * read through `TranscriptLines`, so it holds exactly what an incremental read
 * would.
 *
 * A conversation spans several Claude session files: the session id changes when
 * Claude forks or restarts a session, and each id gets its own file. A forked
 * session copies its ancestor's lines *verbatim, `uuid` included*, so first-wins
 * uuid dedup collapses the overlap and preserves the ancestor's original
 * timestamps. A fresh session shares no uuids and lands as a disjoint root tree,
 * which `activeLineUuids` keeps whole. Lines with no `uuid` are not in the
 * forest: those with a timestamp all survive, those without one (`mode`,
 * `permission-mode`, `ai-title`, `api-request-blob`, …) are read by no event and
 * are dropped.
 *
 * CAVEAT — this is the one place the merge can hide a line. A fork taken from a
 * *midpoint* (just before a prompt) leaves the ancestor's post-fork prompt and
 * the fork's own next prompt as siblings in ONE tree, and the `activeLineUuids`
 * pass the callers run drops the ancestor's as a rewound branch. Arguably
 * correct (it was abandoned), but it is a loss the per-file parse would not have
 * had. Pinned by a test in `parse-jsonl.test.ts`.
 */
export async function mergeChainLines(
  files: readonly { path: string; raw: string }[],
): Promise<readonly Record<string, unknown>[]> {
  const lines = new TranscriptLines(noImages);
  const encoder = new TextEncoder();
  for (const { path, raw } of files) {
    // A whole file read as text: its last line is complete even when the text
    // does not end in a newline (a test's literal).
    const bytes = encoder.encode(raw.endsWith("\n") ? raw : `${raw}\n`);
    await lines.catchUp(path, bytes.length, wholeBytes(bytes));
  }
  return lines.lines();
}

/** A `TranscriptByteRead` over bytes already in memory. */
export function wholeBytes(bytes: Uint8Array): TranscriptByteRead {
  return (from, to) => Promise.resolve(bytes.subarray(from, to));
}
