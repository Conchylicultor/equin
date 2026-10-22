/**
 * A request to an endpoint answered non-2xx; `body` is the reply, JSON-parsed
 * when it parses. The message defaults to `HTTP <status>` (a page's toast
 * prefers the body's own message); a caller off the page names the request.
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
