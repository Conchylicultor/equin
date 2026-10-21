// A server that runs in the page's realm or across a port: the third host of
// the unified live API, beside the Bun server and central. A host contributes
// only what a host does — its runtime instance, its socket and request entry
// points; declarations, the client, the wire protocol, serving
// (`serveValueOn` / `serveCollectionOn`) and routing (`http-router`) are the
// one code path every host runs. Two implementations: `runtimeBrowserServer`
// over a runtime booted in this realm (`runtime-socket.ts`, a worker's booted
// graph) and `portBrowserServer` over a worker's port (`port.ts`). See
// `research/2026-10-13-framework-browser-server-host-v2.md` (D).

/** The client side of an in-memory socket: where the server's frames go. */
export interface BrowserServerPeer {
  deliver(frame: string): void;
  /**
   * The SERVER closed the socket (`dispose`) — the twin of a real socket's
   * close event: the client must stop sending (its end now throws).
   */
  closed(code: number, reason: string): void;
}

/** The server side of an in-memory socket, as `connect` hands it to the client. */
export interface BrowserServerSocket {
  /** A client frame (`sub`, `sub-batch`, `unsub`, …) into the runtime. Throws once closed. */
  send(frame: string): void;
  /** Release the socket's subscriptions and stop its heartbeat. Idempotent. */
  close(code?: number, reason?: string): void;
}

export interface BrowserServer {
  /** Unique per server — what a transport names its sockets and assets by. */
  readonly id: string;
  /** One HTTP request through the shared router (`/api/resources/:key` included). */
  request(req: Request): Promise<Response>;
  /** Open an in-memory notifications socket on the runtime. */
  connect(peer: BrowserServerPeer): BrowserServerSocket;
  /** Close every socket. */
  dispose(): void;
}
