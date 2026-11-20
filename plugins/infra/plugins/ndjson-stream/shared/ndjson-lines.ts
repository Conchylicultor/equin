/** A line of an NDJSON stream that is not JSON. */
export class NdjsonParseError extends Error {
  constructor(
    readonly line: string,
    cause: unknown,
  ) {
    const shown = line.length > 200 ? `${line.slice(0, 200)}…` : line;
    super(`malformed NDJSON line: ${shown}`, { cause });
    this.name = "NdjsonParseError";
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new NdjsonParseError(line, err);
  }
}

/**
 * Every JSON value of an NDJSON body, one per non-blank line, in order —
 * lines split across chunks (and multi-byte characters split across them)
 * joined first. A final line without its newline is still a frame. A line
 * that is not JSON throws `NdjsonParseError`.
 *
 * `signal` ends the read: the body is cancelled and the iteration throws the
 * signal's reason. Leaving the loop early (break, throw) cancels the body too.
 */
export async function* ndjsonFrames(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown, void, undefined> {
  signal?.throwIfAborted();
  const reader = body.getReader();
  const onAbort = () => {
    void reader.cancel(signal?.reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  // The body ended, failed, or was aborted: nothing left to cancel. Only a
  // consumer leaving early cancels it (a failed body's cancel would reject
  // with its own error and hide the first throw).
  let settled = false;
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        settled = true;
        throw err;
      }
      const { done, value } = chunk;
      if (signal?.aborted) {
        settled = true;
        signal.throwIfAborted();
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) yield parseLine(line);
      }
    }
    buffer += decoder.decode();
    settled = true;
    if (buffer.trim()) yield parseLine(buffer);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!settled) await reader.cancel();
    reader.releaseLock();
  }
}
