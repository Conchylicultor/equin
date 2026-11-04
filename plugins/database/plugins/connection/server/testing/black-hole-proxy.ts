import net from "node:net";

// Test support: a call whose bytes vanish, against a REAL Postgres.
//
// The incident the deadline guards
// (research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md) is a
// call whose bytes disappear: the socket stays "open" from pg's side, no
// `error`/`end` ever arrives, and the promise waits forever. This proxy
// reproduces exactly that — a TCP server in front of the cluster whose
// forwarding can be switched off, so bytes are swallowed rather than refused.
// Switched off BEFORE a connection opens, it accepts the TCP connection and
// never answers the startup packet: a connect that hangs.
//
// Exported so a suite that owns a connection (the job queue's enqueue pool, …)
// can prove its own wiring carries the deadline, without a copy of this.

export interface BlackHoleProxy {
  /** The loopback TCP port to point a connection string at. */
  port: number;
  /** false ⇒ every byte in either direction is silently dropped. */
  setForwarding(on: boolean): void;
  /** Destroys every proxied socket and stops listening. */
  close(): Promise<void>;
}

/** Start a black-hole proxy on 127.0.0.1 forwarding to `upstream` (e.g. the cluster's Unix socket). */
export async function startBlackHoleProxy(
  upstream: net.NetConnectOpts,
): Promise<BlackHoleProxy> {
  let forwarding = true;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((down) => {
    const up = net.connect(upstream);
    sockets.add(down);
    sockets.add(up);
    down.on("data", (chunk) => {
      if (forwarding) up.write(chunk);
    });
    up.on("data", (chunk) => {
      if (forwarding) down.write(chunk);
    });
    const teardown = () => {
      sockets.delete(down);
      sockets.delete(up);
      down.destroy();
      up.destroy();
    };
    down.on("close", teardown);
    up.on("close", teardown);
    down.on("error", teardown);
    up.on("error", teardown);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("proxy has no TCP address");
  return {
    port: address.port,
    setForwarding(on) {
      forwarding = on;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
