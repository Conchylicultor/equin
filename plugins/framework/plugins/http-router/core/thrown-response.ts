/**
 * The answer a route's throw carries: by default the router answers any throw
 * with a generic `{ error: "Internal server error" }` 500 — right for an
 * endpoint whose caller can do nothing with the cause. A route whose protocol
 * has its own error shape (MCP's JSON-RPC error, read by an agent that must
 * see what failed) attaches that answer to the error and rethrows it: the
 * router still logs and reports the throw through `onError`, the one path
 * every failure takes, then answers with the attached response.
 */
const answers = new WeakMap<Error, Response>();

/** `err`, to be answered with `response` when it reaches the router. */
export function answerThrowWith(err: Error, response: Response): Error {
  answers.set(err, response);
  return err;
}

/** The response attached to `err` by {@link answerThrowWith}, if any. */
export function thrownResponse(err: Error): Response | undefined {
  return answers.get(err);
}
