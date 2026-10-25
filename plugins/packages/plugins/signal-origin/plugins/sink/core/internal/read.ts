import {
  readJsonlTail,
  readJsonlTailAsync,
} from "@plugins/infra/plugins/file-sink/core";
import { SIGNAL_ORIGIN_FILE, type SignalOriginLine } from "./lines";

/**
 * Every line the host has recorded about a fatal signal, oldest-first.
 *
 * Goes through the sink primitive's bounded reader rather than a hand-rolled
 * `readFileSync` + `split("\n")`: it is positioned (never materializes the whole
 * file), it drops a half-flushed tail line — which this file WILL have, since
 * its writer is a process in the middle of dying — and `includeRotated` stitches
 * `signal-origin.jsonl.1`/`.2` back in. Reading rotations matters here and not
 * for a live tail: the question is always about ONE past run, and a busy host
 * can rotate past it.
 *
 * `missing` is folded to `[]` on one visible line rather than absorbed inside
 * the reader: no op on this host has ever caught a fatal signal, which is a
 * legitimately empty history and not a failure.
 *
 * Synchronous by contract — the same property that lets the writer run from a
 * signal handler, and the reason a caller may use this from any context.
 */
export function readSignalOriginLines(): SignalOriginLine[] {
  return readSignalOriginLinesFrom(SIGNAL_ORIGIN_FILE);
}

/**
 * {@link readSignalOriginLines} without blocking the event loop — for a reader
 * inside the live-resource flush cycle (a loader), where a synchronous read
 * freezes every other loader and every socket send.
 */
export async function readSignalOriginLinesAsync(): Promise<
  SignalOriginLine[]
> {
  const result = await readJsonlTailAsync<SignalOriginLine>(
    SIGNAL_ORIGIN_FILE,
    { includeRotated: true },
  );
  if (result.kind === "missing") return [];
  return result.records;
}

/**
 * The read policy itself, against an explicit file.
 *
 * Deliberately NOT on the barrel: the path is not a caller's choice — there is
 * one sink and reading "some other" signal-origin file is not a thing anyone
 * should be able to ask for. It is split out only so the policy above is
 * testable against a fixture, since `SIGNAL_ORIGIN_FILE` is frozen at module
 * eval and cannot be redirected once the graph is loaded.
 */
export function readSignalOriginLinesFrom(file: string): SignalOriginLine[] {
  const result = readJsonlTail<SignalOriginLine>(file, { includeRotated: true });
  if (result.kind === "missing") return [];
  return result.records;
}
