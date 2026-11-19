import { FetchRequestError } from "@plugins/primitives/plugins/networking/plugins/request-guard/core";

/**
 * A request to an endpoint answered non-2xx; `body` is the reply, JSON-parsed
 * when it parses. `readEndpointResponse` words the message to name the request
 * (`HTTP <status> from <route>: <why>` — `describeRefusal`), so an unhandled
 * one says what was refused; a page's toast still prefers the body's own
 * message (`getEndpointErrorMessage`). The bare `HTTP <status>` default is for
 * a caller that has no route to name.
 */
export class EndpointError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message = `HTTP ${status}`,
  ) {
    super(message);
  }
}

/**
 * Main refused the write because the request came from an agent session
 * (`agentWrite` — main is read-only for agents). Not a bug of the endpoint,
 * nor of the caller: the message tells the agent to reproduce on its own
 * build. Nothing files it — `fetchEndpoint` skips `endpointErrorSink`, the
 * crash collector skips it as an unhandled rejection, and an optimistic
 * write's rejection is toasted but not reported — so an agent clicking around
 * main cannot raise a report storm.
 */
export class EndpointAgentWriteRefusedError extends EndpointError {}

/**
 * A request to an endpoint got no answer at all: the sender rejected with a
 * `TypeError` (fetch's network failure — "Failed to fetch", Firefox's
 * "NetworkError when attempting to fetch resource.", Safari's "Load failed").
 * The browser's own error names neither the request nor a stack frame, so an
 * unhandled one used to reach Reports as a bare `TypeError` nobody could place
 * (report-1794609421-fk1a49). This one names the route it was for, and keeps
 * the browser's error as `cause`.
 *
 * It IS a `TypeError`, so every caller that already tells "no answer" from a
 * non-2xx with `err instanceof TypeError` keeps working unchanged. A page's
 * fetch already names its URL (`FetchRequestError`, the request guard's): the
 * route is said once, followed by the browser's own words.
 */
export class EndpointNetworkError extends TypeError {
  override readonly name = "EndpointNetworkError";
  constructor(
    public readonly route: string,
    cause: TypeError,
  ) {
    super(
      `${route}: ${cause instanceof FetchRequestError ? cause.browserMessage : cause.message}`,
      { cause },
    );
    // The page fetch's stack holds the frames of whoever called fetch (this
    // error is built after the await, which lost them): keep those.
    if (cause instanceof FetchRequestError && cause.stack !== undefined) {
      const frames = cause.stack.split("\n").slice(1).join("\n");
      this.stack = `${this.name}: ${this.message}\n${frames}`;
    }
  }
}
