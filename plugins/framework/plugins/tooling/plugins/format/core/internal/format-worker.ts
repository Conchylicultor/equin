// The format thread's entry: a worker thread spawned by `./format-thread`. It
// loads prettier and answers "what does prettier make of these bytes?".
//
// Every request gets exactly one reply. A throw becomes an `error` reply
// carrying this thread's stack, so a prettier failure surfaces as the calling
// check's own thrown error — never as a caller waiting on a worker that died
// quietly.

import { parentPort } from "node:worker_threads";
import type { FormatReply, FormatRequest } from "./format-thread";
import { FormatSyntaxError } from "./format-error";
import { formatSource } from "./prettier";

if (!parentPort) {
  throw new Error("format-worker: must run as a worker thread (no parentPort)");
}
const port = parentPort;

async function handle(request: FormatRequest): Promise<FormatReply> {
  try {
    const formatted: string[] = [];
    // One file after another: a request has this whole thread to itself.
    for (const source of request.sources) {
      formatted.push(await formatSource(source));
    }
    return { id: request.id, type: "formatted", formatted };
  } catch (err) {
    // Not swallowed: handed to the caller, which rejects with it.
    return err instanceof Error
      ? {
          id: request.id,
          type: "error",
          message: err.message,
          stack: err.stack,
          syntax: err instanceof FormatSyntaxError,
        }
      : {
          id: request.id,
          type: "error",
          message: String(err),
          stack: undefined,
          syntax: false,
        };
  }
}

port.on("message", (request: FormatRequest) => {
  void handle(request).then((reply) => port.postMessage(reply));
});
