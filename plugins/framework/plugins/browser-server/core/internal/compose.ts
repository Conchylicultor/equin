// Several browser servers behind ONE transport, routed by resource key. Every
// live-state frame names its key (resource-protocol), so a composed server can
// hand each subscription, and each `/api/resources/:key` read, to the server
// that serves that key, without the client knowing there is more than one. The
// first user is a demo scope whose real server code runs in a worker while the
// rest is still answered in the page; it is a host option, like `unserved`,
// never demo policy.

import { isUnsupportedEndpointRefusal } from "@plugins/infra/plugins/endpoints/core";
import type {
  ClientFrame,
  ServerFrame,
} from "@plugins/packages/plugins/resource-protocol/core";
import type {
  BrowserServer,
  BrowserServerPeer,
  BrowserServerSocket,
} from "./browser-server";

/** One server of a composition and the keys it answers. */
export interface ComposedServer {
  server: BrowserServer;
  keys: ReadonlySet<string>;
}

const RESOURCE_PATH = /^\/api\/resources\/([^/]+)$/;

type BatchFrame = Extract<ClientFrame, { op: "sub-batch" }>;

/**
 * One server over `parts` and `fallback`: a key belongs to the first part whose
 * `keys` hold it, every other key to `fallback`. Reads and subscriptions go to
 * the key's server; a `sub-batch` is split per server (each part a batch of its
 * own entries, a `complete` replay reaching every server so each releases what
 * the tab dropped); `unsub-tab` reaches every server. Any other request goes to
 * `fallback` first and, while the answer is an unsupported-endpoint refusal,
 * to each part in turn. Pings come from `fallback` alone, so the client keeps
 * one heartbeat.
 */
export function composeBrowserServers(
  parts: readonly ComposedServer[],
  fallback: BrowserServer,
): BrowserServer {
  // A server may appear as a part and as the fallback (the keys it serves
  // first, then everything left): one socket each, whatever the count.
  const servers = [...new Set([...parts.map((p) => p.server), fallback])];
  const ownerOf = (key: string): BrowserServer =>
    parts.find((p) => p.keys.has(key))?.server ?? fallback;

  async function request(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    const resource = RESOURCE_PATH.exec(pathname);
    if (resource !== null) {
      return ownerOf(decodeURIComponent(resource[1]!)).request(req);
    }
    let answer = await fallback.request(req.clone());
    for (const part of parts) {
      if (part.server === fallback) continue;
      if (!(await isUnsupported(answer))) return answer;
      const next = await part.server.request(req.clone());
      // A part's router answers an unknown path 404: not this part's either.
      if (next.status !== 404) answer = next;
    }
    return answer;
  }

  function connect(peer: BrowserServerPeer): BrowserServerSocket {
    let closed = false;
    const ends = new Map<BrowserServer, BrowserServerSocket>();
    for (const server of servers) {
      ends.set(
        server,
        server.connect({
          deliver(frame) {
            if (server !== fallback && isPing(frame)) return;
            peer.deliver(frame);
          },
          closed(code, reason) {
            // One server closing closes the composition: a socket the client
            // still sends on would silently lose that server's keys.
            if (closed) return;
            closed = true;
            for (const [other, end] of ends) {
              if (other !== server) end.close(code, reason);
            }
            peer.closed(code, reason);
          },
        }),
      );
    }
    const endOf = (server: BrowserServer) => ends.get(server)!;

    return {
      send(raw) {
        if (closed) throw new Error("browser-server: send on a closed socket");
        const frame = JSON.parse(raw) as ClientFrame;
        switch (frame.op) {
          case "sub":
          case "unsub":
          case "sub-acks":
            endOf(ownerOf(frame.key)).send(raw);
            return;
          case "unsub-tab":
            for (const end of ends.values()) end.send(raw);
            return;
          case "sub-batch":
            for (const [server, batch] of splitBatch(frame, servers, ownerOf)) {
              endOf(server).send(JSON.stringify(batch));
            }
            return;
        }
      },
      close(code, reason) {
        if (closed) return;
        closed = true;
        for (const end of ends.values()) end.close(code, reason);
      },
    };
  }

  return {
    id: fallback.id,
    request,
    connect,
    dispose() {
      for (const server of servers) server.dispose();
    },
  };
}

async function isUnsupported(res: Response): Promise<boolean> {
  if (res.status !== 409) return false;
  const body: unknown = await res.clone().json();
  return isUnsupportedEndpointRefusal(res.status, body);
}

function isPing(raw: string): boolean {
  return (JSON.parse(raw) as ServerFrame).kind === "ping";
}

/**
 * A tab's replay, cut per server: each server gets the entries it owns. A
 * `complete` batch reaches every server, entries or not — it is also how a
 * server learns which of the tab's subs to release.
 */
function splitBatch(
  frame: BatchFrame,
  servers: readonly BrowserServer[],
  ownerOf: (key: string) => BrowserServer,
): Map<BrowserServer, BatchFrame> {
  const out = new Map<BrowserServer, BatchFrame>();
  for (const server of servers) {
    const entries = frame.entries.filter((e) => ownerOf(e.key) === server);
    if (entries.length === 0 && !frame.complete) continue;
    out.set(server, { ...frame, entries });
  }
  return out;
}
